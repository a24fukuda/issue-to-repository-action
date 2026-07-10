import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import { issueFileName, renderIssueFile } from "./render";
import type { IssueRecord } from "./types";

const ISSUE_FILE_PATTERN = /^\d+\.md$/;
const MANIFEST_FILE_NAME = ".manifest.json";
const SKIPPED_DELETION_LOG_LIMIT = 10;

export interface SyncResult {
  written: string[];
  deleted: string[];
}

async function readManifestRaw(manifestPath: string): Promise<string | null> {
  try {
    return await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      core.warning(
        `Could not read ${MANIFEST_FILE_NAME} (${(error as Error).message}) — treating this ` +
          "run as if no files are owned yet, so no issue files will be deleted this run.",
      );
    }
    // ENOENT (no manifest yet) is expected on the very first run — stay quiet.
    return null;
  }
}

function parseManifest(raw: string | null): Set<string> {
  if (raw === null) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return new Set(parsed);
    }
  } catch {
    // fall through to the warning below
  }

  core.warning(
    `${MANIFEST_FILE_NAME} exists but isn't a valid list of file names — treating this run ` +
      "as if no files are owned yet, so no issue files will be deleted this run.",
  );
  return new Set();
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
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
  const previouslyOwned = parseManifest(await readManifestRaw(manifestPath));

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
  const skippedDeletion: string[] = [];
  for (const fileName of existingFiles) {
    if (desired.has(fileName)) continue;
    if (previouslyOwned.has(fileName)) {
      await rm(path.join(dir, fileName));
      deleted.push(fileName);
    } else {
      skippedDeletion.push(fileName);
    }
  }
  if (skippedDeletion.length > 0) {
    const sample = skippedDeletion.slice(0, SKIPPED_DELETION_LOG_LIMIT).join(", ");
    const more = skippedDeletion.length - SKIPPED_DELETION_LOG_LIMIT;
    core.info(
      `Not deleting ${skippedDeletion.length} file(s) with no matching issue, since they ` +
        `aren't recorded in ${MANIFEST_FILE_NAME} as owned by this action: ${sample}` +
        (more > 0 ? `, and ${more} more` : ""),
    );
  }

  // Only rewrite the manifest — and only report it as written — when the
  // set of owned files actually changes, so a run with no issue changes
  // (the common case) doesn't produce a write that syncIssueFiles' caller
  // has no way to know it needs to commit. Compared by parsed content, not
  // raw bytes, so formatting (e.g. line-ending normalization on checkout)
  // can't make this spuriously differ.
  const desiredFileNames = new Set(desired.keys());
  if (!setsEqual(previouslyOwned, desiredFileNames)) {
    const manifestContent = `${JSON.stringify([...desiredFileNames].sort(), null, 2)}\n`;
    await writeFile(manifestPath, manifestContent, "utf8");
    written.push(MANIFEST_FILE_NAME);
  }

  return { written, deleted };
}
