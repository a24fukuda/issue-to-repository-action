import type { IssueRecord } from "../src/types";

export function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  const number = overrides.number ?? 1;
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/owner/repo/issues/${number}`,
    state: "open",
    authorLogin: "alice",
    labels: [],
    assignees: [],
    milestone: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    body: "body",
    comments: [],
    ...overrides,
  };
}
