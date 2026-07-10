import { describe, expect, it } from "bun:test";
import { fetchIssues } from "../src/github";

function makeFakeOctokit(overrides: {
  issues: unknown[];
  commentsByIssue: Record<number, unknown[]>;
}) {
  return {
    rest: {
      issues: {
        listForRepo: "listForRepo-marker",
        listComments: "listComments-marker",
      },
    },
    paginate: async (endpoint: unknown, params: Record<string, unknown>) => {
      if (endpoint === "listForRepo-marker") return overrides.issues;
      if (endpoint === "listComments-marker") {
        return overrides.commentsByIssue[params.issue_number as number] ?? [];
      }
      throw new Error("unexpected endpoint");
    },
  };
}

describe("fetchIssues", () => {
  it("maps issues and comments into IssueRecords", async () => {
    const octokit = makeFakeOctokit({
      issues: [
        {
          number: 1,
          title: "Bug report",
          html_url: "https://github.com/owner/repo/issues/1",
          state: "open",
          user: { login: "alice" },
          labels: [{ name: "bug" }, "needs-triage"],
          assignees: [{ login: "bob" }],
          milestone: { title: "v1.0" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          closed_at: null,
          body: "It broke.",
        },
      ],
      commentsByIssue: {
        1: [
          {
            user: { login: "carol" },
            created_at: "2026-01-03T00:00:00Z",
            body: "Confirmed.",
          },
        ],
      },
    });

    const records = await fetchIssues(octokit as never, "owner", "repo");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      number: 1,
      title: "Bug report",
      state: "open",
      authorLogin: "alice",
      labels: ["bug", "needs-triage"],
      assignees: ["bob"],
      milestone: "v1.0",
      closedAt: null,
      body: "It broke.",
    });
    expect(records[0].comments).toEqual([
      { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Confirmed." },
    ]);
  });

  it("excludes pull requests returned by the issues endpoint", async () => {
    const octokit = makeFakeOctokit({
      issues: [
        {
          number: 2,
          title: "A PR",
          html_url: "https://github.com/owner/repo/pull/2",
          state: "open",
          pull_request: {},
          user: { login: "alice" },
          labels: [],
          assignees: [],
          milestone: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          closed_at: null,
          body: "",
        },
      ],
      commentsByIssue: {},
    });

    const records = await fetchIssues(octokit as never, "owner", "repo");

    expect(records).toEqual([]);
  });
});
