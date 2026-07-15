// リリーススクリプト: 新しいバージョンを1か所（コマンド引数）で受け取り、
// リリースタグと一致していなければならない箇所を機械的に書き換える。
//
//   bun run release 1.1.0
//
// リリースタグに合わせる必要があるのは `package.json` の version と、実行
// される参照であるワークフローの内部 `uses:` だけ（README のサンプルは
// `@vX.Y.Z` プレースホルダで同期不要）。以前は「sync.yml の内部参照を先に
// 書き換えてコミット → そのコミットにタグ」という手順を人手で守る必要が
// あったが、このスクリプトが書き換え・コミット・不変タグ作成までを1コマンド
// にまとめる。
//
// push だけは外向き・不可逆な操作なので自動では行わず、最後に実行すべき
// コマンドを表示する。--no-git を付けるとファイル編集のみ行う。

import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isReleaseVersion, REPO_ROOT, rewriteVersionRefs, trackedFiles } from "./version-refs";

function fail(message: string): never {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noGit = args.includes("--no-git");
  const version = args.find((a) => !a.startsWith("-"));

  if (!version) {
    fail("バージョンを指定してください。例: bun run release 1.1.0");
  }
  if (!isReleaseVersion(version)) {
    fail(`バージョンは X.Y.Z 形式で指定してください（先頭に v は付けない）: ${version}`);
  }

  const tag = `v${version}`;

  // git を触る場合は、ファイルを1つでも書き換える"前"に前提条件をすべて
  // 検証する。書き換えた後に中断すると、コミットされない変更が作業ツリーに
  // 残り、次回実行が下の「汚れたツリー」ガードで弾かれて手動復旧が必要に
  // なるため、副作用が出る前にここで弾く。
  if (!noGit) {
    // 自分の変更だけをコミットするため、作業ツリーが汚れている場合は中断する。
    const status = (await $`git status --porcelain`.cwd(REPO_ROOT).text()).trim();
    if (status) {
      fail(`作業ツリーに未コミットの変更があります。先にコミットまたは退避してください:\n${status}`);
    }
    // 既存タグとの衝突も書き換え前に検出する（不変タグは上書きしない）。
    const existingTag = (await $`git tag -l ${tag}`.cwd(REPO_ROOT).text()).trim();
    if (existingTag) {
      fail(`タグ ${tag} は既に存在します。別のバージョンを指定するか、既存タグを削除してください。`);
    }
  }

  // 1. package.json の version（唯一の真実）を更新。
  //    「行が見つからない」ことだけを失敗として扱い、「見つかったが値が同じ
  //    （＝現行と同じバージョンでの再実行）」は正常系として通す。両者を
  //    `newText === oldText` で混同すると、再実行時に「行が見つからない」と
  //    いう誤ったエラーになるため、マッチしたかどうかをフラグで判定する。
  const pkgPath = join(REPO_ROOT, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  let versionLineFound = false;
  // キー順やフォーマットを保つため、JSONの再シリアライズではなく該当行のみ置換する。
  const newPkgText = pkgText.replace(/("version":\s*")\d+\.\d+\.\d+(")/, (_m, p1, p2) => {
    versionLineFound = true;
    return `${p1}${version}${p2}`;
  });
  if (!versionLineFound) {
    fail('package.json に "version": "X.Y.Z" の行が見つからず更新できませんでした。');
  }
  writeFileSync(pkgPath, newPkgText);

  // 2. ワークフローの内部参照（uses: の @vX.Y.Z）を更新。書き換え対象の
  //    一覧は version-refs の trackedFiles() を共有し、CIチェックの検出対象と
  //    完全に一致させる（片方だけ取り残されるのを防ぐ）。
  for (const rel of trackedFiles()) {
    const p = join(REPO_ROOT, rel);
    const before = readFileSync(p, "utf8");
    const after = rewriteVersionRefs(before, version);
    if (after !== before) writeFileSync(p, after);
  }

  console.log(`v${version} へバージョン参照を更新しました。`);

  if (noGit) {
    console.log("--no-git のためファイル編集のみ行いました。git 操作は手動で行ってください。");
    return;
  }

  // 変更が一切なければ（既に v{version} に整合している）、空コミットを
  // 作らずに正常終了する。現行バージョンでの再実行が無害になる。
  const changed = (await $`git status --porcelain`.cwd(REPO_ROOT).text()).trim();
  if (!changed) {
    console.log(`変更はありません（既に v${version} に整合しています）。コミットとタグ作成はスキップします。`);
    return;
  }

  // 3. 「参照を書き換えたコミット」に不変タグを付ける。sync.yml の内部参照が
  //    そのコミット時点で v{version} を指しているため、タグとコードが一致する。
  //    タグ衝突は書き換え前に検証済みなので、ここでは作成のみ行う。
  await $`git add package.json ${trackedFiles()}`.cwd(REPO_ROOT);
  await $`git commit -m ${`chore: release ${tag}`}`.cwd(REPO_ROOT);
  await $`git tag ${tag}`.cwd(REPO_ROOT);

  console.log(`\nコミットとタグ ${tag} を作成しました。内容を確認してから push してください:\n`);
  console.log(`  git push origin HEAD ${tag}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
