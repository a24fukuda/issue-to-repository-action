import * as core from "@actions/core";
import * as exec from "@actions/exec";

export interface CommitOptions {
  dir: string;
  message: string;
  committerName: string;
  committerEmail: string;
}

async function git(
  args: string[],
  options?: Parameters<typeof exec.getExecOutput>[2],
) {
  return exec.getExecOutput("git", args, {
    ignoreReturnCode: true,
    ...options,
  });
}

function assertSuccess(
  result: { exitCode: number; stderr: string },
  action: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

async function currentSha(): Promise<string> {
  const rev = await git(["rev-parse", "HEAD"]);
  assertSuccess(rev, "git rev-parse");
  return rev.stdout.trim();
}

/**
 * 現在のブランチ名を解決する。チェックアウトがdetached HEAD状態の場合は
 * 例外を投げる。低コストで副作用がないため、呼び出し元は決してpushできない
 * チェックアウトに無駄な高コストの処理（GitHub APIへのfetchなど）を
 * 費やす前にこれをチェックすべきである。
 */
export async function getCurrentBranch(): Promise<string> {
  const branchCheck = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (branchCheck.exitCode !== 0) {
    throw new Error(
      "Could not resolve the current branch — cannot push a sync commit. This " +
        "usually means the checkout is in detached HEAD state (checked out a " +
        `fixed ref/SHA instead of a branch): ${branchCheck.stderr.trim() || "(no error output)"}`,
    );
  }
  return branchCheck.stdout.trim();
}

/**
 * 同期対象のディレクトリをステージし、HEADと差分があればコミットして
 * pushする。新しいコミットのSHAを返す。コミットするものが何もなければ
 * nullを返す。
 */
export async function commitAndPush(
  options: CommitOptions & { branch: string },
): Promise<string | null> {
  const { branch } = options;

  assertSuccess(
    await git(["config", "user.name", options.committerName]),
    "git config user.name",
  );
  assertSuccess(
    await git(["config", "user.email", options.committerEmail]),
    "git config user.email",
  );
  assertSuccess(await git(["add", "--", options.dir]), "git add");

  const diff = await git(["diff", "--cached", "--quiet"]);
  if (diff.exitCode === 0) {
    return null;
  }
  if (diff.exitCode !== 1) {
    // 0 = ステージされた差分なし、1 = 差分あり — それ以外の終了コードは
    // 「差分あり」のシグナルではなく実際のgitエラー（インデックス破損など）
    // であり、そのままステージ済みの内容をコミットする処理に流れて
    // はならない。
    assertSuccess(diff, "git diff --cached --quiet");
  }

  assertSuccess(
    await git(["commit", "-m", options.message]),
    "git commit",
  );

  // `concurrency` グループ（sync.yml/self-sync.yml）は、このアクションの
  // 実行同士を直列化するだけであり、このアクションがGitHub APIから
  // fetchしている間に無関係なコミット（マージされたPR、他のボット）が
  // 同じブランチに乗ることは防げない。このアクションのコミットのツリーは
  // 常に `options.dir` を完全に再生成したこの実行のスナップショットで
  // あり（差分ではない）、拒否されたpushは最新のtipにrebaseして1回だけ
  // リトライすれば復旧できる — このrebaseは `options.dir` に限定された
  // 変更を再適用するだけでよく、このアクション以外がそのディレクトリに
  // 触れることは想定されていないため、ここで実際にテキスト競合が発生
  // するのは報告に値する本物の異常事態であり、それ以上リトライすべき
  // ものではない。
  let sha = await currentSha();
  let push = await git(["push"]);
  if (push.exitCode !== 0) {
    assertSuccess(await git(["fetch", "origin", branch]), "git fetch");
    const rebase = await git(["rebase", `origin/${branch}`]);
    if (rebase.exitCode !== 0) {
      const abort = await git(["rebase", "--abort"]);
      if (abort.exitCode !== 0) {
        core.warning(`git rebase --abort also failed: ${abort.stderr.trim()}`);
      }
      throw new Error(
        `git push was rejected and rebasing onto origin/${branch} failed ` +
          `(likely a real content conflict, not just a transient race): ${rebase.stderr.trim()}`,
      );
    }
    sha = await currentSha();
    push = await git(["push"]);
  }

  // `sha` を既に取得した後で最後にアサートする: `git push` は参照元の
  // ローカルHEADを動かさないため、これ以降の処理が失敗しても、成功した
  // pushがなかったことにされることはない。
  assertSuccess(push, "git push");
  return sha;
}
