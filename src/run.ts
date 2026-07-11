import { realpath } from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { commitAndPush as defaultCommitAndPush, getCurrentBranch as defaultGetCurrentBranch } from "./git";
import { fetchIssues as defaultFetchIssues } from "./github";
import { createOctokit as defaultCreateOctokit } from "./octokit";
import { syncIssueFiles as defaultSyncIssueFiles } from "./sync";

export interface RunDependencies {
  fetchIssues: typeof defaultFetchIssues;
  syncIssueFiles: typeof defaultSyncIssueFiles;
  commitAndPush: typeof defaultCommitAndPush;
  createOctokit: typeof defaultCreateOctokit;
  getCurrentBranch: typeof defaultGetCurrentBranch;
  setOutput: typeof core.setOutput;
}

const defaultDependencies: RunDependencies = {
  fetchIssues: defaultFetchIssues,
  syncIssueFiles: defaultSyncIssueFiles,
  commitAndPush: defaultCommitAndPush,
  createOctokit: defaultCreateOctokit,
  getCurrentBranch: defaultGetCurrentBranch,
  setOutput: core.setOutput,
};

// `relative`（path.relativeの結果）が、基準ディレクトリ自体か、その外側を
// 指しているかどうかを判定する。
function escapesOrIsRoot(relative: string): boolean {
  return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * `target` に到達可能な、実際に存在する最も深い祖先ディレクトリを
 * シンボリックリンク解決込みで返す（`target` 自身が存在すればそれを、
 * 存在しなければ存在する親を遡って探す）。`lexical` はそのディレクトリの
 * シンボリックリンク解決前のパス、`real` は解決後のパス。
 *
 * `issues-dir` はこのアクションがこれから `mkdir` する典型的なケースでは
 * まだ存在しないため、`fs.realpath(target)` を直接呼ぶだけでは不十分
 * （ENOENTになる）であり、存在しない部分はシンボリックリンクではあり
 * 得ないことを利用して、存在する祖先までの解決に留める。
 */
async function resolveExistingAncestor(target: string): Promise<{ lexical: string; real: string }> {
  let lexical = target;
  while (true) {
    try {
      return { lexical, real: await realpath(lexical) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(lexical);
      if (parent === lexical) return { lexical, real: lexical };
      lexical = parent;
    }
  }
}

/**
 * `issues-dir` がチェックアウトのルート（カレントディレクトリ）配下の
 * 真のサブディレクトリを指していることを検証する。検証しないと、
 * `../outside` や絶対パスはチェックアウト外へのファイルの作成・削除を
 * 実行してから `git add` が失敗するまで気づけず、`"."` は
 * `git add -- <dir>` が作業ツリー全体（他のステップが残した無関係な
 * 変更まで含む）をステージしてしまう。どちらも破壊的な副作用が起きる
 * *前*に検出できるよう、他のどの処理よりも先にこれを呼び出す。
 *
 * レキシカルな検証（文字列としてのpath.resolve/path.relative）だけでは、
 * `issues-dir` 自体（またはその祖先のパス構成要素）がチェックアウト外を
 * 指すシンボリックリンクであるケースを見逃す — path.resolveはシンボリック
 * リンクを辿らない文字列操作でしかないが、実際のファイルシステム操作
 * （mkdir/readdir/writeFile/rm）はシンボリックリンクを辿るため、実在する
 * パスをrealpathで解決し直して同じ包含チェックをもう一度行う。
 */
async function assertIssuesDirIsSafe(issuesDir: string): Promise<void> {
  const resolved = path.resolve(issuesDir);
  const cwd = process.cwd();

  if (escapesOrIsRoot(path.relative(cwd, resolved))) {
    throw new Error(
      `issues-dir（"${issuesDir}"）はチェックアウトのルート自体か、その外側を指しています — ` +
        "チェックアウト内の専用サブディレクトリを指定してください。",
    );
  }

  const realCwd = await realpath(cwd);
  const { lexical: ancestorLexical, real: ancestorReal } = await resolveExistingAncestor(resolved);
  const remainder = path.relative(ancestorLexical, resolved);
  const effectiveReal = path.join(ancestorReal, remainder);

  if (escapesOrIsRoot(path.relative(realCwd, effectiveReal))) {
    throw new Error(
      `issues-dir（"${issuesDir}"）はシンボリックリンク経由でチェックアウトの外側を指しています — ` +
        "チェックアウト内の専用サブディレクトリを指定してください。",
    );
  }
}

// 依存関係はインポートして直接呼び出すのではなく注入可能にしている。
// これにより、テストは以下の出力設定のオーケストレーションを、モジュールを
// モックせずに検証できる — モジュールモックはBunのテストランナーでは
// プロセス全体に適用され、無関係な他のテストファイルにも漏れ出してしまう。
export async function run(deps: RunDependencies = defaultDependencies): Promise<void> {
  // `changed` が既に報告済みかどうかを追跡し、下のcatchブロックが
  // trueの結果を上書きしないようにする: setOutputはGITHUB_OUTPUTファイルに
  // 追記する方式で、最後に書き込んだ値が優先されるため、`changed=true` が
  // 報告された後に別の文（例えばcommit-shaのsetOutput呼び出し）が例外を
  // 投げた場合、catchブロックは実際にはpushが成功しているのに
  // changed=falseを報告してはならない。
  let changedReported = false;

  try {
    const token = core.getInput("github-token", { required: true });
    const issuesDir = core.getInput("issues-dir") || "issues";
    const commitMessage = core.getInput("commit-message") || "chore: sync issues";
    const committerName = core.getInput("committer-name") || "github-actions[bot]";
    const committerEmail =
      core.getInput("committer-email") ||
      "41898282+github-actions[bot]@users.noreply.github.com";

    // 他のどの処理（APIやgit呼び出し）よりも先に検証する: 不正な
    // issues-dirはファイルシステムへの破壊的な副作用を起こしてから
    // 初めて失敗するのではなく、何もしないうちに拒否されるべきである。
    await assertIssuesDirIsSafe(issuesDir);

    // API呼び出しの前にこれを確認する: pushできないチェックアウト状態
    // （例えばdetached HEAD）の場合、どのみち実行全体が失敗するため、
    // 先にfetchや同期にAPI/時間を費やす意味がない。
    const branch = await deps.getCurrentBranch();

    const { owner, repo } = github.context.repo;
    const octokit = deps.createOctokit(token);

    core.info(`${owner}/${repo} のIssueを取得しています...`);
    const issues = await deps.fetchIssues(octokit, owner, repo);
    core.info(`${issues.length}件のIssueを取得しました。`);

    const { written, deleted } = await deps.syncIssueFiles(issuesDir, issues);
    core.info(`${written.length}件のファイルを書き込み、${deleted.length}件のファイルを削除しました。`);

    const hasFileChanges = written.length > 0 || deleted.length > 0;
    if (!hasFileChanges) {
      core.info("コミットする変更はありません。");
      deps.setOutput("changed", false);
      changedReported = true;
      return;
    }

    // コミットが実際に完了したときにのみ `changed`/`commit-sha` を
    // 報告する — ファイル差分だけを基準にすると、下のpushが失敗したり
    // 実質何もしなかった場合でも変更ありと報告してしまう。
    const sha = await deps.commitAndPush({
      dir: issuesDir,
      message: commitMessage,
      committerName,
      committerEmail,
      branch,
    });

    if (sha) {
      core.info(`${sha} をコミットしてpushしました。`);
      deps.setOutput("changed", true);
      changedReported = true;
      deps.setOutput("commit-sha", sha);
    } else {
      core.info("作業ツリーはステージ済みの変更と既に一致していたため、コミットするものはありませんでした。");
      deps.setOutput("changed", false);
      changedReported = true;
    }
  } catch (error) {
    // 失敗時は出力を未設定のままにするのではなく、明示的に
    // `changed=false` を報告する — 何もコミットされなかったということ。
    // そうしないと、`steps.<id>.outputs.changed` を読み取る呼び出し元
    // （例えば再利用可能なワークフローの `jobs.sync.outputs` 経由）は、
    // このアクションが失敗したときに "false" ではなく空文字列を見ることに
    // なり、下流の厳密な `== 'true'` / `fromJSON(...)` チェックが
    // 壊れてしまう。`changed` が既に報告済みの場合（後続のステップが
    // 失敗する前に実際のpushが成功していた場合）はスキップされ、
    // 壊れた出力チャネルが下のsetFailedの実行を妨げないよう、独自の
    // try/catchで囲んでいる。
    if (!changedReported) {
      try {
        deps.setOutput("changed", false);
      } catch (outputError) {
        core.warning(
          `"changed" 出力の設定に失敗しました: ${outputError instanceof Error ? outputError.message : String(outputError)}`,
        );
      }
    }
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
