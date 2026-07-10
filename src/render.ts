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

  // Build a list of non-empty blocks and join them with a single blank
  // line, rather than threading "" separators through a flat array — that
  // way a blank issue body (common for title-only issues) never leaves
  // behind an extra blank line before the next block.
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
