import { describe, expect, it } from "bun:test";
import { findVersionRefs, readPackageVersion } from "../scripts/version-refs";

// バージョンタグは複数のファイルに手書きで重複している（再利用可能
// ワークフロー sync.yml の内部 `uses:`、README のコピペ用サンプルと推奨タグ）。
// GitHub Actions の `uses:` は式を使えないため、これらは静的な文字列
// として実際のリリースタグに一致していなければならない。
//
// このテストは package.json の version を「唯一の真実」とし、追跡対象
// ファイル内のすべての参照がそれに一致することを検証する。過去に実際に
// 起きた「一部だけ @v1 が取り残される」「一部だけバージョンを上げ忘れる」
// といったドリフトを、利用者へ出荷する前にPRで落とす。
describe("バージョン参照の整合性", () => {
  const expected = readPackageVersion();
  const refs = findVersionRefs();

  it("追跡対象ファイルに参照が最低1つは見つかる（正規表現が壊れて空振りしていないことの保証）", () => {
    // リネームや書式変更で正規表現がどの参照にもマッチしなくなると、
    // 「不一致0件」で誤って成功してしまう。最低1件は必ずあるはずなので、
    // それを明示的に要求して空振り成功を防ぐ。
    expect(refs.length).toBeGreaterThan(0);
  });

  it("すべての参照が package.json の version に一致する", () => {
    const mismatches = refs.filter((ref) => ref.version !== expected);
    // 失敗時に「どのファイルのどの行が」ズレているかを一目で分かるようにする。
    const detail = mismatches.map((ref) => `  ${ref.file}: ${ref.line} (期待: v${expected})`).join("\n");
    expect(mismatches, `package.json は v${expected} だが、以下が一致しない:\n${detail}`).toEqual([]);
  });

  // 追跡すべき参照は2種類ある: (1) `uses:` のアクション／ワークフロー参照、
  // (2) ドキュメント中の推奨タグ（バッククォート囲みの裸タグ）。上の「最低1件」
  // チェックは総数しか見ないため、片方のパターンが壊れて0件になっても、もう
  // 一方が残っていれば緑のまま通ってしまう。すると壊れた側の参照が黙って
  // ドリフトし得る（(2) の検出漏れは実際に一度作り込んだ退行）。両カテゴリが
  // それぞれ最低1件あることを明示的に要求し、どちらのパターンの退行も落とす。
  it("uses: のアクション参照が追跡対象に含まれる", () => {
    const actionRefs = refs.filter((ref) => /a24fukuda\/issue-to-repository-action(\/[^\s@]+)?@v\d+\.\d+\.\d+/.test(ref.line));
    expect(actionRefs.length).toBeGreaterThan(0);
  });

  it("README の推奨タグ（バッククォート囲みの `@vX.Y.Z`）が追跡対象に含まれる", () => {
    const backtickRefs = refs.filter((ref) => ref.file === "README.md" && /`@v\d+\.\d+\.\d+`/.test(ref.line));
    expect(backtickRefs.length).toBeGreaterThan(0);
  });
});
