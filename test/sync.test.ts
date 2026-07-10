import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { syncIssueFiles } from "../src/sync";
import type { IssueRecord } from "../src/types";

function makeIssue(number: number, overrides: Partial<IssueRecord> = {}): IssueRecord {
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

describe("syncIssueFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "issue-sync-"));
  });

  it("creates a file per issue", async () => {
    const result = await syncIssueFiles(dir, [makeIssue(1), makeIssue(2)]);
    expect(result.written.sort()).toEqual(["1.md", "2.md"]);
    expect(result.deleted).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([".manifest.json", "1.md", "2.md"]);
  });

  it("updates a file when the issue content changes", async () => {
    await syncIssueFiles(dir, [makeIssue(1, { title: "Old title" })]);
    const result = await syncIssueFiles(dir, [makeIssue(1, { title: "New title" })]);
    expect(result.written).toEqual(["1.md"]);
    const content = await readFile(path.join(dir, "1.md"), "utf8");
    expect(content).toContain("New title");
  });

  it("does not rewrite files whose content is unchanged", async () => {
    await syncIssueFiles(dir, [makeIssue(1)]);
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.written).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it("deletes files for issues that no longer exist (closed/deleted upstream)", async () => {
    await syncIssueFiles(dir, [makeIssue(1), makeIssue(2)]);
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.deleted).toEqual(["2.md"]);
    expect((await readdir(dir)).sort()).toEqual([".manifest.json", "1.md"]);
  });

  it("ignores unrelated files in the issues directory", async () => {
    await writeFile(path.join(dir, "README.md"), "# issues\n", "utf8");
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.deleted).toEqual([]);
    expect((await readdir(dir)).sort()).toContain("README.md");
  });

  it("does not delete a numerically-named file it never wrote itself", async () => {
    // Simulates issues-dir pointing at a directory that already had a
    // foreign file coincidentally matching the <number>.md pattern.
    await writeFile(path.join(dir, "2.md"), "not ours\n", "utf8");
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.deleted).toEqual([]);
    expect(await readFile(path.join(dir, "2.md"), "utf8")).toBe("not ours\n");
  });
});
