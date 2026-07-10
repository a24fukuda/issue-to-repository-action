import yaml from "js-yaml";
import type { IssueRecord } from "./types";

export function issueFileName(issue: IssueRecord): string {
  return `${issue.number}.md`;
}

export function renderIssueFile(issue: IssueRecord): string {
  const frontmatter = {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    author: issue.authorLogin,
    labels: issue.labels,
    assignees: issue.assignees,
    milestone: issue.milestone,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments_count: issue.comments.length,
  };

  const yamlText = yaml
    .dump(frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false })
    .trimEnd();

  // フラットな配列に "" のセパレーターを混ぜるのではなく、空でない
  // ブロックのリストを作り、それらを1つの空行で連結する — こうすることで、
  // 空のIssue本文（タイトルのみのIssueでよくある）が次のブロックの前に
  // 余分な空行を残すことがない。
  const blocks = [`---\n${yamlText}\n---`];

  const body = issue.body.trim();
  if (body) blocks.push(body);

  if (issue.comments.length > 0) {
    const commentBlocks = issue.comments.map((comment) => {
      const author = comment.authorLogin ? `@${comment.authorLogin}` : "unknown";
      const header = `### ${author} — ${comment.createdAt}`;
      const commentBody = comment.body.trim();
      return commentBody ? `${header}\n\n${commentBody}` : header;
    });
    blocks.push(["## Comments", ...commentBlocks].join("\n\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}
