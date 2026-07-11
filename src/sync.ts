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

interface ManifestLoadResult {
  owned: Set<string>;
  // マニフェストが読めなかった／壊れていたため「owned」を安全側に空集合と
  // みなした場合にtrue。この場合、今回の実行では削除を一切行わないだけで
  // なく、書き込むマニフェスト内容も desired だけでなく現在ディスク上に
  // ある候補ファイルすべてを含めて上書きし、次回実行以降に正しく所有権を
  // 再認識できるようにする（syncIssueFiles側で処理）。
  needsRepair: boolean;
}

async function loadManifest(manifestPath: string): Promise<ManifestLoadResult> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // マニフェストがまだない＝初回実行時には想定内なので、警告は出さない。
      // 修復も不要 — 「何も所有していない」は正しい状態。
      return { owned: new Set(), needsRepair: false };
    }
    core.warning(
      `${MANIFEST_FILE_NAME} を読み込めませんでした（${(error as Error).message}） — ` +
        "この実行ではまだ何もファイルを所有していないものとして扱うため、今回はIssueファイルを削除しません。" +
        "現在ディスク上にあるIssueファイルは、次回以降の実行で正しく認識されるようマニフェストに記録し直します。",
    );
    return { owned: new Set(), needsRepair: true };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return { owned: new Set(parsed), needsRepair: false };
    }
  } catch {
    // 下の警告処理へフォールスルーする
  }

  core.warning(
    `${MANIFEST_FILE_NAME} は存在しますが、有効なファイル名のリストではありません — ` +
      "この実行ではまだ何もファイルを所有していないものとして扱うため、今回はIssueファイルを削除しません。" +
      "現在ディスク上にあるIssueファイルは、次回以降の実行で正しく認識されるようマニフェストに記録し直します。",
  );
  return { owned: new Set(), needsRepair: true };
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
  const { owned: previouslyOwned, needsRepair } = await loadManifest(manifestPath);

  const entries = await readdir(dir, { withFileTypes: true });
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  const existingFiles = new Set(
    entries
      .filter((entry) => entry.isFile() && ISSUE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name),
  );

  const written: string[] = [];
  const skippedForeignEntries: string[] = [];
  for (const [fileName, content] of desired) {
    const entry = entryByName.get(fileName);
    if (entry && !entry.isFile()) {
      // シンボリックリンクやディレクトリなど、通常ファイルでないエントリが
      // 同名で既に存在する。writeFileはシンボリックリンクを辿って書き込む
      // ため、無条件に書き込むとリンク先（issues-dirの外かもしれない）を
      // 上書きしてしまう。「所有していないものには触れない」という設計方針
      // に従い、書き込みをスキップする。
      skippedForeignEntries.push(fileName);
      continue;
    }

    const filePath = path.join(dir, fileName);
    const current = existingFiles.has(fileName)
      ? await readFile(filePath, "utf8")
      : null;

    if (current !== content) {
      await writeFile(filePath, content, "utf8");
      written.push(fileName);
    }
  }
  if (skippedForeignEntries.length > 0) {
    core.warning(
      `${skippedForeignEntries.length}件のファイル名がシンボリックリンクまたはディレクトリと衝突しているため書き込みをスキップしました: ` +
        skippedForeignEntries.join(", "),
    );
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
      `対応するIssueがないファイルが${skippedDeletion.length}件ありますが、` +
        `${MANIFEST_FILE_NAME} にこのアクションが所有しているファイルとして記録されていないため削除しません: ${sample}` +
        (more > 0 ? `、他${more}件` : ""),
    );
  }

  // 所有ファイルの集合が実際に変化したときにのみマニフェストを書き換え、
  // 書き込みとして報告する。そうすることで、Issueに変更がない実行
  // （よくあるケース）では、syncIssueFilesの呼び出し元がコミットが
  // 必要かどうか知る手段のない書き込みが発生しないようにする。生バイトでは
  // なくパース済みの内容で比較しているため、フォーマットの違い
  // （チェックアウト時の改行コード正規化など）によって見かけ上の差分が
  // 発生することはない。
  //
  // needsRepairのとき（マニフェストが読めなかった／壊れていた）は例外:
  // (1) 書き込む内容を desired だけでなく existingFiles（現在ディスク上に
  //     ある候補ファイルすべて）との和集合にする。そうしないと、今回の
  //     実行で削除せず残した古い所有ファイルが「所有していないファイル」
  //     として記録され、二度と削除できなくなってしまう。次回実行で
  //     マニフェストが正しく読めれば、これらは正しく所有認識され、
  //     まだ desired になければ通常どおり削除される（1回の修復実行を
  //     挟んで自己修復する）。
  // (2) setsEqualによる書き込み省略をバイパスし、常にマニフェストを
  //     書き直す。そうしないと（例えば desired も existingFiles も空の
  //     場合）壊れたバイト列がディスクに残り続け、実行のたびに同じ警告が
  //     永久に繰り返される。
  const desiredFileNames = new Set(desired.keys());
  const manifestOwnershipToPersist = needsRepair
    ? new Set([...desiredFileNames, ...existingFiles])
    : desiredFileNames;
  if (needsRepair || !setsEqual(previouslyOwned, manifestOwnershipToPersist)) {
    const manifestContent = `${JSON.stringify([...manifestOwnershipToPersist].sort(), null, 2)}\n`;
    await writeFile(manifestPath, manifestContent, "utf8");
    written.push(MANIFEST_FILE_NAME);
  }

  return { written, deleted };
}
