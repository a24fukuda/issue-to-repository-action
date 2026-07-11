import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { syncIssueFiles } from "../src/sync";
import type { IssueRecord } from "../src/types";
import { makeIssue as makeBaseIssue } from "./fixtures";

// 共有フィクスチャに対する薄い (number, overrides) ラッパー — このファイルの
// テストはIssue番号を位置引数として扱うほうが読みやすいが、フィールド
// リスト自体は ./fixtures に単一の情報源を持たせている。
function makeIssue(number: number, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return makeBaseIssue({ number, ...overrides });
}

describe("syncIssueFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "issue-sync-"));
  });

  it("creates a file per issue and reports the manifest as written too", async () => {
    const result = await syncIssueFiles(dir, [makeIssue(1), makeIssue(2)]);
    expect(result.written.sort()).toEqual([".manifest.json", "1.md", "2.md"]);
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

  it("does not rewrite files (including the manifest) when nothing changed", async () => {
    await syncIssueFiles(dir, [makeIssue(1)]);
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.written).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  it("reports the manifest as written if it's missing, even though issue content is unchanged", async () => {
    // 回帰テスト: 以前のsyncIssueFilesは `written` に報告せずに無条件で
    // マニフェストを書き込んでいたため、Issue内容に変更がない実行では
    // コミットが一切トリガーされなかった — つまりマニフェストが実際に
    // gitの履歴に残ることが決してなかった。
    await syncIssueFiles(dir, [makeIssue(1)]);
    await rm(path.join(dir, ".manifest.json"));
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.written).toEqual([".manifest.json"]);
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
    // issues-dir が、たまたま <number>.md パターンに一致する無関係な
    // ファイルを既に持っていたディレクトリを指している状況をシミュレートする。
    await writeFile(path.join(dir, "2.md"), "not ours\n", "utf8");
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.deleted).toEqual([]);
    expect(await readFile(path.join(dir, "2.md"), "utf8")).toBe("not ours\n");
  });

  it("treats a corrupt manifest as owning nothing, without throwing", async () => {
    await syncIssueFiles(dir, [makeIssue(1), makeIssue(2)]);
    await writeFile(path.join(dir, ".manifest.json"), "{ not valid json", "utf8");
    const result = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(result.deleted).toEqual([]);
    expect(await readFile(path.join(dir, "2.md"), "utf8")).toContain("Issue 2");
  });

  it("self-heals a corrupt manifest: previously-owned stale files become deletable again after one repair run", async () => {
    // 回帰テスト: 以前は破損マニフェストを検出した実行でマニフェストを
    // desired のみで上書きしていたため、今回削除しなかった古い所有ファイル
    // （2.md）が「所有していないファイル」として記録され、以後どの実行でも
    // 永久に削除できなくなっていた。
    await syncIssueFiles(dir, [makeIssue(1), makeIssue(2)]);
    await writeFile(path.join(dir, ".manifest.json"), "{ not valid json", "utf8");
    const repairRun = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(repairRun.deleted).toEqual([]); // 修復実行自体では保守的に削除しない

    const followUpRun = await syncIssueFiles(dir, [makeIssue(1)]);
    expect(followUpRun.deleted).toEqual(["2.md"]); // 次回実行で正しく所有認識され削除される
  });

  it("repairs a corrupt manifest to valid content even when there is nothing else to write", async () => {
    // 回帰テスト: desired と existingFiles が両方とも空の場合、以前は
    // setsEqual(空,空)がtrueとなり書き込みがスキップされ、壊れたバイト列が
    // 永久に残って毎回同じ警告が繰り返されていた。
    await writeFile(path.join(dir, ".manifest.json"), "{ not valid json", "utf8");
    const result = await syncIssueFiles(dir, []);
    expect(result.written).toEqual([".manifest.json"]);
    const manifestContent = await readFile(path.join(dir, ".manifest.json"), "utf8");
    expect(() => JSON.parse(manifestContent)).not.toThrow();
  });

  it("does not follow a symlink to write through it, and leaves the link's target untouched", async () => {
    // issues-dir に、たまたま <number>.md と同名のシンボリックリンクが
    // 既に存在する状況をシミュレートする。writeFileはリンクを辿るため、
    // ガードがなければリンク先（issues-dirの外の可能性もある）を
    // 上書きしてしまう。
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "issue-sync-outside-"));
    const targetPath = path.join(outsideDir, "precious.txt");
    await writeFile(targetPath, "PRECIOUS UNRELATED CONTENT\n", "utf8");
    await symlink(targetPath, path.join(dir, "3.md"));

    const result = await syncIssueFiles(dir, [makeIssue(3)]);

    expect(result.written).toEqual([".manifest.json"]);
    expect(await readFile(targetPath, "utf8")).toBe("PRECIOUS UNRELATED CONTENT\n");
  });

  it("does not write anything on a first run with no issues", async () => {
    // 回帰テスト: 以前はパース済みの所有ファイル集合ではなく生の
    // マニフェストバイトを比較していたため、追跡すべきものが何もない
    // 場合でもマニフェストが書き込まれたと報告し、Issueが0件の
    // リポジトリで無意味なコミットを生成していた。
    const result = await syncIssueFiles(dir, []);
    expect(result.written).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not rewrite the manifest when only its formatting would differ", async () => {
    // 回帰テスト: 書き込み省略の判定は以前、生のファイルバイトを比較して
    // いたため、例えばチェックアウト時の改行コード正規化によって、
    // 変更されていない所有ファイル集合が実行のたびに「変更あり」に
    // 見えてしまうことがあった。
    await syncIssueFiles(dir, [makeIssue(1), makeIssue(2)]);
    await writeFile(path.join(dir, ".manifest.json"), '["1.md","2.md"]', "utf8");
    const result = await syncIssueFiles(dir, [makeIssue(1), makeIssue(2)]);
    expect(result.written).toEqual([]);
  });
});
