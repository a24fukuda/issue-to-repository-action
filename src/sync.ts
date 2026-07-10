import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { issueFileName, renderIssueFile } from "./render";
import type { IssueRecord } from "./types";

const ISSUE_FILE_PATTERN = /^\d+\.md$/;
const MANIFEST_FILE_NAME = ".manifest.json";

export interface SyncResult {
  written: string[];
  deleted: string[];
}

async function readManifest(manifestPath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return new Set(parsed);
    }
  } catch {
    // No manifest yet (first run) or it's unreadable/corrupt — treat as
    // "we don't know what we own", so nothing gets deleted this run.
  }
  return new Set();
}

/**
 * Regenerates the issues directory from scratch: writes one file per open
 * issue record and removes previously-synced files that no longer have a
 * matching issue (e.g. the issue was deleted on GitHub).
 *
 * Deletion is scoped to files this function wrote on a prior run (tracked
 * in a manifest alongside the issue files), not just to anything matching
 * the issue-file naming pattern — so a foreign file that happens to be
 * named like an issue (e.g. issues-dir pointed at a shared directory)
 * isn't silently deleted.
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

  const manifestPath = path.join(dir, MANIFEST_FILE_NAME);
  const previouslyOwned = await readManifest(manifestPath);

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
    if (!desired.has(fileName) && previouslyOwned.has(fileName)) {
      await rm(path.join(dir, fileName));
      deleted.push(fileName);
    }
  }

  await writeFile(manifestPath, `${JSON.stringify([...desired.keys()].sort(), null, 2)}\n`, "utf8");

  return { written, deleted };
}
