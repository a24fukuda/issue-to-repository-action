import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { issueFileName, renderIssueFile } from "./render";
import type { IssueRecord } from "./types";

const ISSUE_FILE_PATTERN = /^\d+\.md$/;

export interface SyncResult {
  written: string[];
  deleted: string[];
}

/**
 * Regenerates the issues directory from scratch: writes one file per open
 * issue record and removes any previously-synced file that no longer has a
 * matching issue (e.g. the issue was deleted on GitHub).
 */
export async function syncIssueFiles(
  dir: string,
  issues: IssueRecord[],
): Promise<SyncResult> {
  await mkdir(dir, { recursive: true });

  const desired = new Map<string, string>();
  for (const issue of issues) {
    desired.set(issueFileName(issue), renderIssueFile(issue));
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const existingFiles = new Set(
    entries
      .filter((entry) => entry.isFile() && ISSUE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name),
  );

  const written: string[] = [];
  for (const [fileName, content] of desired) {
    const filePath = path.join(dir, fileName);
    const current = existingFiles.has(fileName)
      ? await readFile(filePath, "utf8")
      : null;

    if (current !== content) {
      await writeFile(filePath, content, "utf8");
      written.push(fileName);
    }
  }

  const deleted: string[] = [];
  for (const fileName of existingFiles) {
    if (!desired.has(fileName)) {
      await rm(path.join(dir, fileName));
      deleted.push(fileName);
    }
  }

  return { written, deleted };
}
