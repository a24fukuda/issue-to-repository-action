import * as core from "@actions/core";
import * as github from "@actions/github";
import { commitAndPush } from "./git";
import { fetchIssues } from "./github";
import { createOctokit } from "./octokit";
import { syncIssueFiles } from "./sync";

export async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const issuesDir = core.getInput("issues-dir") || "issues";
    const commitMessage = core.getInput("commit-message") || "chore: sync issues";
    const committerName = core.getInput("committer-name") || "github-actions[bot]";
    const committerEmail =
      core.getInput("committer-email") ||
      "41898282+github-actions[bot]@users.noreply.github.com";

    const { owner, repo } = github.context.repo;
    const octokit = createOctokit(token);

    core.info(`Fetching issues for ${owner}/${repo}...`);
    const issues = await fetchIssues(octokit, owner, repo);
    core.info(`Fetched ${issues.length} issue(s).`);

    const { written, deleted } = await syncIssueFiles(issuesDir, issues);
    core.info(`${written.length} file(s) written, ${deleted.length} file(s) deleted.`);

    const hasFileChanges = written.length > 0 || deleted.length > 0;
    if (!hasFileChanges) {
      core.info("No changes to commit.");
      core.setOutput("changed", false);
      return;
    }

    // Only report `changed`/`commit-sha` once the commit has actually
    // landed — setting them from the file diff alone would report a
    // change even if the push below fails or turns out to be a no-op.
    const sha = await commitAndPush({
      dir: issuesDir,
      message: commitMessage,
      committerName,
      committerEmail,
    });

    if (sha) {
      core.info(`Committed and pushed ${sha}.`);
      core.setOutput("changed", true);
      core.setOutput("commit-sha", sha);
    } else {
      core.info("Working tree already matched staged changes; nothing to commit.");
      core.setOutput("changed", false);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
