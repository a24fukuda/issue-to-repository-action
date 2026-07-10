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

// Dependencies are injectable (rather than imported and called directly)
// so tests can exercise the output-setting orchestration below without
// mocking modules — module mocks apply process-wide in Bun's test runner
// and leak across unrelated test files.
export async function run(deps: RunDependencies = defaultDependencies): Promise<void> {
  // Tracks whether `changed` has already been reported so the catch block
  // below never overwrites a true result: setOutput appends to the
  // GITHUB_OUTPUT file, last-write-wins, so if `changed=true` is reported
  // and a later statement (e.g. the commit-sha setOutput call) throws, the
  // catch block must not report changed=false for a push that genuinely
  // landed.
  let changedReported = false;

  try {
    const token = core.getInput("github-token", { required: true });
    const issuesDir = core.getInput("issues-dir") || "issues";
    const commitMessage = core.getInput("commit-message") || "chore: sync issues";
    const committerName = core.getInput("committer-name") || "github-actions[bot]";
    const committerEmail =
      core.getInput("committer-email") ||
      "41898282+github-actions[bot]@users.noreply.github.com";

    // Check this before any API calls: a checkout that can't be pushed to
    // (e.g. detached HEAD) means the whole run is going to fail anyway, so
    // there's no point spending the API/time budget on fetching and
    // syncing first.
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

    // Only report `changed`/`commit-sha` once the commit has actually
    // landed — setting them from the file diff alone would report a
    // change even if the push below fails or turns out to be a no-op.
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
    // Report an explicit `changed=false` on failure — nothing was
    // committed — rather than leaving the output unset. A caller reading
    // `steps.<id>.outputs.changed` (e.g. via the reusable workflow's
    // `jobs.sync.outputs`) would otherwise see an empty string rather than
    // "false" when this action fails, which breaks strict `== 'true'` /
    // `fromJSON(...)` checks downstream. Skipped if `changed` was already
    // reported (a real push landed before a later step failed), and
    // wrapped in its own try/catch so a broken output channel can't
    // prevent setFailed from running below.
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
