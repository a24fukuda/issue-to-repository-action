import * as exec from "@actions/exec";

export interface CommitOptions {
  dir: string;
  message: string;
  committerName: string;
  committerEmail: string;
}

/**
 * Stages the synced directory and, if it differs from HEAD, commits and
 * pushes it. Returns the new commit SHA, or null if there was nothing to
 * commit.
 */
export async function commitAndPush(
  options: CommitOptions,
): Promise<string | null> {
  await exec.exec("git", ["config", "user.name", options.committerName]);
  await exec.exec("git", ["config", "user.email", options.committerEmail]);
  await exec.exec("git", ["add", "--", options.dir]);

  const diffExitCode = await exec.exec(
    "git",
    ["diff", "--cached", "--quiet"],
    { ignoreReturnCode: true },
  );
  if (diffExitCode === 0) {
    return null;
  }

  await exec.exec("git", ["commit", "-m", options.message]);
  await exec.exec("git", ["push"]);

  let sha = "";
  await exec.exec("git", ["rev-parse", "HEAD"], {
    listeners: {
      stdout: (data: Buffer) => {
        sha += data.toString();
      },
    },
  });

  return sha.trim();
}
