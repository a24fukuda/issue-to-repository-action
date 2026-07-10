import { describe, expect, it } from "bun:test";
import { issueFileName, renderIssueFile } from "../src/render";
import type { IssueRecord } from "../src/types";

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    number: 42,
    title: "Something broke",
    url: "https://github.com/owner/repo/issues/42",
    state: "open",
    authorLogin: "alice",
    labels: ["bug"],
    assignees: ["bob"],
    milestone: "v1.0",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    body: "Steps to reproduce...",
    comments: [],
    ...overrides,
  };
}

describe("issueFileName", () => {
  it("uses the issue number as the file name", () => {
    expect(issueFileName(makeIssue({ number: 7 }))).toBe("7.md");
  });
});

describe("renderIssueFile", () => {
  it("includes GitHub metadata in frontmatter", () => {
    const output = renderIssueFile(makeIssue());
    expect(output).toContain("number: 42");
    expect(output).toContain("state: open");
    expect(output).toContain("author: alice");
    expect(output).toContain("- bug");
    expect(output).toContain("- bob");
    expect(output).toContain("milestone: v1.0");
  });

  it("includes the issue body after the frontmatter", () => {
    const output = renderIssueFile(makeIssue({ body: "Steps to reproduce..." }));
    expect(output).toContain("Steps to reproduce...");
  });

  it("omits a Comments section when there are no comments", () => {
    const output = renderIssueFile(makeIssue({ comments: [] }));
    expect(output).not.toContain("## Comments");
  });

  it("renders each comment with its author and timestamp", () => {
    const output = renderIssueFile(
      makeIssue({
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
          { authorLogin: null, createdAt: "2026-01-04T00:00:00Z", body: "Me too." },
        ],
      }),
    );
    expect(output).toContain("## Comments");
    expect(output).toContain("### @carol — 2026-01-03T00:00:00Z");
    expect(output).toContain("Same here.");
    expect(output).toContain("### unknown — 2026-01-04T00:00:00Z");
    expect(output).toContain("Me too.");
  });

  it("is deterministic for the same input", () => {
    const issue = makeIssue();
    expect(renderIssueFile(issue)).toBe(renderIssueFile(issue));
  });

  it("emits exactly one blank line before Comments when the body is empty", () => {
    const output = renderIssueFile(
      makeIssue({
        body: "",
        comments: [{ authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." }],
      }),
    );
    expect(output).toContain("---\n\n## Comments");
    expect(output).not.toContain("\n\n\n");
  });

  it("never emits more than one consecutive blank line", () => {
    const output = renderIssueFile(
      makeIssue({
        body: "line one\n\nline two",
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
          { authorLogin: "dave", createdAt: "2026-01-04T00:00:00Z", body: "" },
        ],
      }),
    );
    expect(output).not.toContain("\n\n\n");
  });
});
