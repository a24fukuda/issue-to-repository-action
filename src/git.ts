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
 * Stages the synced directory and, if it differs from HEAD, commits and
 * pushes it. Returns the new commit SHA, or null if there was nothing to
 * commit.
 */
export async function commitAndPush(
  options: CommitOptions,
): Promise<string | null> {
  const branchCheck = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (branchCheck.exitCode !== 0) {
    throw new Error(
      "Could not resolve the current branch — cannot push a sync commit. This " +
        "usually means the checkout is in detached HEAD state (checked out a " +
        `fixed ref/SHA instead of a branch): ${branchCheck.stderr.trim() || "(no error output)"}`,
    );
  }
  const branch = branchCheck.stdout.trim();

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

  assertSuccess(
    await git(["commit", "-m", options.message]),
    "git commit",
  );

  // A concurrency group (sync.yml/self-sync.yml) only serializes runs of
  // this action against each other — it does nothing to stop an unrelated
  // commit (a merged PR, another bot) landing on the same branch while
  // this run was fetching from the GitHub API. Since our commit's tree is
  // always this run's full regenerated snapshot of `options.dir` (not an
  // incremental diff), a rejected push can be recovered by rebasing onto
  // the new tip and retrying once — the rebase only needs to replay a
  // change confined to `options.dir`, which nothing outside this action is
  // expected to touch, so a genuine textual conflict here is a real
  // anomaly worth surfacing, not something to retry further.
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

  // Assert last, with `sha` already captured: `git push` doesn't move the
  // local HEAD it reads from, so nothing below this point can fail and
  // cause a successful push to be reported as if it never happened.
  assertSuccess(push, "git push");
  return sha;
}
