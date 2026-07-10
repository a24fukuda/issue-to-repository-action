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
      "Could not resolve the current branch — cannot push a sync commit. This " +
        "usually means the checkout is in detached HEAD state (checked out a " +
        `fixed ref/SHA instead of a branch): ${branchCheck.stderr.trim() || "(no error output)"}`,
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

  // No retry-on-rejection here by design: the batch model assumes exclusive
  // ownership of the branch for this sync, enforced by the concurrency
  // group in sync.yml/self-sync.yml (see README's Design section). If a
  // push is still rejected — e.g. an external commit landed, or a caller
  // used the direct-action path without its own concurrency group — fail
  // clearly and let the next run's full regeneration reconcile state,
  // rather than layering retry/rebase logic onto a single batch commit.
  assertSuccess(await git(["push"]), "git push");

  const rev = await git(["rev-parse", "HEAD"]);
  assertSuccess(rev, "git rev-parse");
  return rev.stdout.trim();
}
