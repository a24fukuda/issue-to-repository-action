import * as github from "@actions/github";
import type { Endpoints } from "@octokit/types";
import { mapWithConcurrency } from "./concurrency";
import type { IssueComment, IssueRecord } from "./types";

type Octokit = ReturnType<typeof github.getOctokit>;
type Issue = Endpoints["GET /repos/{owner}/{repo}/issues"]["response"]["data"][number];
type Label = Issue["labels"][number];
type Assignee = NonNullable<Issue["assignees"]>[number];
type Comment =
  Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"]["data"][number];

// Bounds how many issues' comment threads are fetched concurrently. Kept
// modest (rather than e.g. 8+) because GitHub's secondary rate limit is
// triggered by concurrent request volume — the throttling plugin on the
// Octokit instance retries a rate-limited request, but each concurrent
// request backs off independently, so a burst of many at once can retrigger
// the same limit repeatedly instead of the batch settling down as a whole.
const COMMENT_FETCH_CONCURRENCY = 4;

export async function fetchIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<IssueRecord[]> {
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    per_page: 100,
  });

  // The "list issues" endpoint also returns pull requests; skip those.
  const nonPrIssues = issues.filter((issue: Issue) => !issue.pull_request);

  return mapWithConcurrency(nonPrIssues, COMMENT_FETCH_CONCURRENCY, async (issue: Issue) => {
    const comments = await fetchComments(octokit, owner, repo, issue.number);

    return {
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state === "closed" ? "closed" : "open",
      authorLogin: issue.user?.login ?? null,
      labels: issue.labels
        .map((label: Label) => (typeof label === "string" ? label : (label.name ?? "")))
        .filter((label: string): label is string => label.length > 0),
      assignees: (issue.assignees ?? [])
        .map((assignee: Assignee) => assignee.login)
        .filter((login: string): login is string => Boolean(login)),
      milestone: issue.milestone?.title ?? null,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      body: issue.body ?? "",
      comments,
    };
  });
}

async function fetchComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  return comments.map((comment: Comment) => ({
    authorLogin: comment.user?.login ?? null,
    createdAt: comment.created_at,
    body: comment.body ?? "",
  }));
}
