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
    // ENOENT（マニフェストがまだない）は初回実行時には想定内なので、警告は出さない。
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
    // 下の警告処理へフォールスルーする
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
 * issuesディレクトリをゼロから再生成する: 各Issueレコードにつき1ファイルを
 * 書き込み、対応するIssueがなくなった過去に同期済みのファイル（例えば
 * GitHub上でIssueが削除された場合）を削除する。
 *
 * 削除の対象は、Issueファイルの命名パターンに一致するものすべてではなく、
 * この関数が過去の実行で書き込んだファイル（Issueファイルと一緒に
 * マニフェストで追跡されている）に限定される — そのため、Issueのような
 * 名前を偶然持つ無関係なファイル（例えば issues-dir が共有ディレクトリを
 * 指している場合）が黙って削除されることはない。
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

  // 所有ファイルの集合が実際に変化したときにのみマニフェストを書き換え、
  // 書き込みとして報告する。そうすることで、Issueに変更がない実行
  // （よくあるケース）では、syncIssueFilesの呼び出し元がコミットが
  // 必要かどうか知る手段のない書き込みが発生しないようにする。生バイトでは
  // なくパース済みの内容で比較しているため、フォーマットの違い
  // （チェックアウト時の改行コード正規化など）によって見かけ上の差分が
  // 発生することはない。
  const desiredFileNames = new Set(desired.keys());
  if (!setsEqual(previouslyOwned, desiredFileNames)) {
    const manifestContent = `${JSON.stringify([...desiredFileNames].sort(), null, 2)}\n`;
    await writeFile(manifestPath, manifestContent, "utf8");
    written.push(MANIFEST_FILE_NAME);
  }

  return { written, deleted };
}
