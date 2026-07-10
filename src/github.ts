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

// 同時に取得するIssueのコメントスレッド数の上限。8以上のような大きな値では
// なく控えめにしている。GitHubのセカンダリレート制限は同時リクエスト数に
// よってトリガーされるためである — Octokitインスタンスのthrottlingプラグインは
// レート制限にかかったリクエストをリトライするが、それぞれの同時リクエストは
// 独立してバックオフするため、一度に大量のリクエストを送るとバッチ全体が
// 落ち着くのではなく、同じ制限に何度も引っかかってしまう。
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

  // "list issues" エンドポイントはプルリクエストも返すため、それらは除外する。
  const nonPrIssues = issues.filter((issue: Issue) => !issue.pull_request);

  return mapWithConcurrency(nonPrIssues, COMMENT_FETCH_CONCURRENCY, async (issue: Issue) => {
    // Issue一覧のレスポンスには既にコメント数が含まれているため、常に
    // 空のページをfetchしてから破棄するのではなく、コメントが全くない
    // Issue（多くの場合かなりの割合を占める）については追加リクエスト
    // 自体をスキップする。
    const comments = issue.comments > 0 ? await fetchComments(octokit, owner, repo, issue.number) : [];

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
