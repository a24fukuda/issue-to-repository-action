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
      "Not currently on a branch (detached HEAD) — cannot push a sync commit. " +
        "Make sure the workflow checks out a branch, not a fixed ref/SHA.",
    );
  }

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

  let push = await git(["push"]);
  if (push.exitCode !== 0) {
    // The batch design assumes exclusive ownership of the branch (enforced
    // by the concurrency group in sync.yml/self-sync.yml), but an external
    // push landing between checkout and push can still reject a
    // non-fast-forward update. Rebase onto the latest remote state and
    // retry once before giving up.
    const branch = branchCheck.stdout.trim();
    assertSuccess(await git(["fetch", "origin", branch]), "git fetch");
    const rebase = await git(["rebase", `origin/${branch}`]);
    if (rebase.exitCode !== 0) {
      await git(["rebase", "--abort"]);
      throw new Error(
        `git push was rejected and rebasing onto origin/${branch} failed ` +
          `(likely a real content conflict): ${rebase.stderr.trim()}`,
      );
    }
    push = await git(["push"]);
  }
  assertSuccess(push, "git push");

  const rev = await git(["rev-parse", "HEAD"]);
  assertSuccess(rev, "git rev-parse");
  return rev.stdout.trim();
}
