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

  const sections = [`---\n${yamlText}\n---`, "", issue.body.trim()];

  if (issue.comments.length > 0) {
    sections.push("", "## Comments");
    for (const comment of issue.comments) {
      const author = comment.authorLogin ? `@${comment.authorLogin}` : "unknown";
      sections.push("", `### ${author} — ${comment.createdAt}`, "", comment.body.trim());
    }
  }

  return `${sections.join("\n").trimEnd()}\n`;
}
