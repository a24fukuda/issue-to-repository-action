// リリーススクリプト: 新しいバージョンを1か所（コマンド引数）で受け取り、
// バージョンが手書きで重複しているすべての箇所を機械的に書き換える。
//
//   bun run release 1.1.0
//
// これまでは「sync.yml の内部参照を先に書き換えてコミット → そのコミットに
// タグ」という手順を人手で守る必要があり、README のサンプルとあわせて
// 7か所以上を漏れなく更新しなければならなかった。このスクリプトはその
// 書き換えを一括で行い（package.json / sync.yml / README）、コミットと
// 不変タグの作成までを1コマンドにまとめる。
//
// push だけは外向き・不可逆な操作なので自動では行わず、最後に実行すべき
// コマンドを表示する。--no-git を付けるとファイル編集のみ行う。

import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isReleaseVersion, REPO_ROOT, rewriteActionRefs } from "./version-refs";

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

  // 自分の変更だけをコミットするため、作業ツリーが汚れている場合は中断する。
  if (!noGit) {
    const status = (await $`git status --porcelain`.cwd(REPO_ROOT).text()).trim();
    if (status) {
      fail(`作業ツリーに未コミットの変更があります。先にコミットまたは退避してください:\n${status}`);
    }
  }

  // 1. package.json の version（唯一の真実）を更新。
  const pkgPath = join(REPO_ROOT, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  // キー順やフォーマットを保つため、JSONの再シリアライズではなく該当行のみ置換する。
  const newPkgText = pkgText.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
  if (newPkgText === pkgText) {
    fail('package.json の "version" 行が見つからず更新できませんでした。');
  }
  writeFileSync(pkgPath, newPkgText);

  // 2. sync.yml / README のアクション・ワークフロー参照（uses: の @vX.Y.Z）を更新。
  for (const rel of [".github/workflows/sync.yml", "README.md"]) {
    const p = join(REPO_ROOT, rel);
    const before = readFileSync(p, "utf8");
    const after = rewriteActionRefs(before, version);
    if (after !== before) writeFileSync(p, after);
  }

  // 3. README の推奨タグ（プロサ中の `@vX.Y.Z`）も更新。ここはコピペ用の
  //    `uses:` 行ではないため rewriteActionRefs では拾わない。安定性のため
  //    `@vX.Y.Z` を推奨する一文だけを対象に、後方参照で確実に置換する。
  {
    const p = join(REPO_ROOT, "README.md");
    const before = readFileSync(p, "utf8");
    const after = before.replace(/(なく `@v)\d+\.\d+\.\d+(`（特定のリリースタグ）)/, `$1${version}$2`);
    if (after !== before) writeFileSync(p, after);
  }

  console.log(`v${version} へバージョン参照を更新しました。`);

  if (noGit) {
    console.log("--no-git のためファイル編集のみ行いました。git 操作は手動で行ってください。");
    return;
  }

  // 4. 「参照を書き換えたコミット」に不変タグを付ける。sync.yml の内部参照が
  //    そのコミット時点で v{version} を指しているため、タグとコードが一致する。
  const tag = `v${version}`;
  const existingTag = (await $`git tag -l ${tag}`.cwd(REPO_ROOT).text()).trim();
  if (existingTag) {
    fail(`タグ ${tag} は既に存在します。別のバージョンを指定するか、既存タグを削除してください。`);
  }

  await $`git add package.json .github/workflows/sync.yml README.md`.cwd(REPO_ROOT);
  await $`git commit -m ${`chore: release ${tag}`}`.cwd(REPO_ROOT);
  await $`git tag ${tag}`.cwd(REPO_ROOT);

  console.log(`\nコミットとタグ ${tag} を作成しました。内容を確認してから push してください:\n`);
  console.log(`  git push origin HEAD ${tag}`);
}

main();
