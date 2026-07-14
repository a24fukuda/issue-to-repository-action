// バージョンタグの「唯一の真実」は package.json の `version` フィールド。
// このモジュールは、リポジトリ内でそのバージョンにピン留めされている
// 参照を機械的に「見つける」「書き換える」ための共有ロジックを提供する。
//
// CI整合性チェック（test/version-consistency.test.ts）とリリーススクリプト
// （scripts/release.ts）の両方がこのモジュールを使うことで、「検出に使う
// パターン」と「書き換えに使うパターン」が必ず一致し、片方だけが取り残される
// ことを防ぐ。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(__dirname, "..");

// このバージョンにピン留めされ得る参照は2種類あり、どちらも package.json の
// version に一致していなければならない:
//
//   (1) `uses:` に書くアクション／再利用可能ワークフローへの参照。仕様上
//       `uses:` は式（${{ ... }}）を使えず静的な文字列しか書けないため、
//       リリースのたびにタグ名を手で合わせる必要がある。パス部分の有無で
//       2つの形を取る:
//         a24fukuda/issue-to-repository-action@vX.Y.Z
//         a24fukuda/issue-to-repository-action/.github/workflows/sync.yml@vX.Y.Z
//
//   (2) ドキュメント本文で「推奨タグ」として書かれる、バッククォート囲みの
//       裸のタグ `@vX.Y.Z`。アクション名の接頭辞が付かないため (1) では
//       拾えないが、これも利用者が参照する具体的なバージョンなので追跡する。
//       `X.Y.Z`（英字のプレースホルダ）や `actions/checkout@v4` のような
//       メジャーのみのタグには一致しないため、第三者アクションの誤検出はない。
//
// 各アクセサは毎回新しい RegExp リテラルを返す（`g` フラグの lastIndex が
// 呼び出し間で共有されるのを避ける）。
function actionRefPattern(): RegExp {
  return /a24fukuda\/issue-to-repository-action(?<path>\/[^\s@]+)?@v(?<version>\d+\.\d+\.\d+)/g;
}

function backtickTagPattern(): RegExp {
  return /`@v(?<version>\d+\.\d+\.\d+)`/g;
}

/** ファイルに書かれた「X.Y.Z 形式のリリースバージョン」を管理対象とみなす。 */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isReleaseVersion(version: string): boolean {
  return SEMVER_RE.test(version);
}

/** package.json の version フィールド（＝唯一の真実）を読む。 */
export function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !isReleaseVersion(pkg.version)) {
    throw new Error(`package.json の version が X.Y.Z 形式ではありません: ${JSON.stringify(pkg.version)}`);
  }
  return pkg.version;
}

export interface VersionRef {
  /** 参照が書かれているファイル（リポジトリルートからの相対パス）。 */
  file: string;
  /** その参照がピン留めしているバージョン（`v` を除いた X.Y.Z）。 */
  version: string;
  /** 元の行全体（診断メッセージ用）。 */
  line: string;
}

// バージョン参照が現れ得るファイルの集合。ワークフローはグロブで列挙するため、
// 新しい `.github/workflows/*.yml` を追加しても、この一覧を手で更新しなくても
// CIチェックとリリーススクリプトの両方が自動で対象に含める（＝参照箇所の
// 追加漏れによるドリフトを防ぐ）。issues/ や dist/ など、履歴テキストとして
// 偶然バージョン文字列を含み得る自動生成物は意図的に対象外にしている。
export function trackedFiles(): string[] {
  const workflowsDir = join(REPO_ROOT, ".github/workflows");
  const workflows = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `.github/workflows/${name}`);
  return [...workflows, "README.md"];
}

/** 追跡対象ファイルすべてから、バージョン参照（(1)と(2)の両方）を抽出する。 */
export function findVersionRefs(): VersionRef[] {
  const refs: VersionRef[] = [];
  for (const file of trackedFiles()) {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const line of content.split("\n")) {
      for (const pattern of [actionRefPattern(), backtickTagPattern()]) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          refs.push({ file, version: match.groups!.version!, line: line.trim() });
        }
      }
    }
  }
  return refs;
}

/**
 * 与えたファイル内容の中のバージョン参照（(1)と(2)の両方）を `version` へ
 * 書き換えた新しい内容を返す。(1) のパス部分（/.github/...）は保持する。
 * 2つのパターンは排他的（一方はアクション名接頭辞、他方は直前がバッククォート）
 * なので、二重に書き換わることはない。
 */
export function rewriteVersionRefs(content: string, version: string): string {
  return content
    .replace(actionRefPattern(), (_full, ...args) => {
      const groups = args[args.length - 1] as { path?: string };
      return `a24fukuda/issue-to-repository-action${groups.path ?? ""}@v${version}`;
    })
    .replace(backtickTagPattern(), () => `\`@v${version}\``);
}
