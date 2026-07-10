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

    // API呼び出しの前にこれを確認する: pushできないチェックアウト状態
    // （例えばdetached HEAD）の場合、どのみち実行全体が失敗するため、
    // 先にfetchや同期にAPI/時間を費やす意味がない。
    const branch = await deps.getCurrentBranch();

    const { owner, repo } = github.context.repo;
    const octokit = deps.createOctokit(token);

    core.info(`Fetching issues for ${owner}/${repo}...`);
    const issues = await deps.fetchIssues(octokit, owner, repo);
    core.info(`Fetched ${issues.length} issue(s).`);

    const { written, deleted } = await deps.syncIssueFiles(issuesDir, issues);
    core.info(`${written.length} file(s) written, ${deleted.length} file(s) deleted.`);

    const hasFileChanges = written.length > 0 || deleted.length > 0;
    if (!hasFileChanges) {
      core.info("No changes to commit.");
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
      core.info(`Committed and pushed ${sha}.`);
      deps.setOutput("changed", true);
      changedReported = true;
      deps.setOutput("commit-sha", sha);
    } else {
      core.info("Working tree already matched staged changes; nothing to commit.");
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
          `Failed to set the "changed" output: ${outputError instanceof Error ? outputError.message : String(outputError)}`,
        );
      }
    }
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
