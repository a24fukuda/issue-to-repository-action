import { describe, expect, it } from "bun:test";
import { findVersionRefs, readPackageVersion } from "../scripts/version-refs";

// リリースタグと一致していなければならないのは、実際に実行される参照
// —— ワークフロー（`.github/workflows/*.yml`）の `uses:` に書かれた、この
// アクション／再利用可能ワークフローへの参照 —— だけ。GitHub Actions の
// `uses:` は式を使えないため、これらは静的な文字列として実際のリリースタグに
// 一致していなければならない。
//
// このテストは package.json の version を「唯一の真実」とし、追跡対象の
// 参照がそれに一致することを検証する。過去に実際に起きた「一部だけ @v1 が
// 取り残される」「一部だけバージョンを上げ忘れる」といったドリフトを、
// 利用者へ出荷する前にPRで落とす。（README のサンプルは `@vX.Y.Z`
// プレースホルダで、現行版に同期する必要が無いため追跡対象外。）
describe("バージョン参照の整合性", () => {
  const expected = readPackageVersion();
  const refs = findVersionRefs();

  it("追跡対象ファイルに参照が最低1つは見つかる（正規表現が壊れて空振りしていないことの保証）", () => {
    // リネームや書式変更で正規表現がどの参照にもマッチしなくなると、
    // 「不一致0件」で誤って成功してしまう。sync.yml の内部参照が最低1件は
    // 必ずあるはずなので、それを明示的に要求して空振り成功を防ぐ。
    expect(refs.length).toBeGreaterThan(0);
  });

  it("すべての参照が package.json の version に一致する", () => {
    const mismatches = refs.filter((ref) => ref.version !== expected);
    // 失敗時に「どのファイルのどの行が」ズレているかを一目で分かるようにする。
    const detail = mismatches.map((ref) => `  ${ref.file}: ${ref.line} (期待: v${expected})`).join("\n");
    expect(mismatches, `package.json は v${expected} だが、以下が一致しない:\n${detail}`).toEqual([]);
  });
});
