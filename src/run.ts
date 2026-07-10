import * as core from "@actions/core";
import * as github from "@actions/github";
import { commitAndPush } from "./git";
import { fetchIssues } from "./github";
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
    const octokit = github.getOctokit(token);

    core.info(`Fetching issues for ${owner}/${repo}...`);
    const issues = await fetchIssues(octokit, owner, repo);
    core.info(`Fetched ${issues.length} issue(s).`);

    const { written, deleted } = await syncIssueFiles(issuesDir, issues);
    core.info(`${written.length} file(s) written, ${deleted.length} file(s) deleted.`);

    const changed = written.length > 0 || deleted.length > 0;
    core.setOutput("changed", changed);

    if (!changed) {
      core.info("No changes to commit.");
      return;
    }

    const sha = await commitAndPush({
      dir: issuesDir,
      message: commitMessage,
      committerName,
      committerEmail,
    });

    if (sha) {
      core.info(`Committed and pushed ${sha}.`);
      core.setOutput("commit-sha", sha);
    } else {
      core.info("Working tree already matched staged changes; nothing to commit.");
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
