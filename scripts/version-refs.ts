// バージョンタグの「唯一の真実」は package.json の `version` フィールド。
// このモジュールは、リポジトリ内でそのバージョンにピン留めされている
// 参照（再利用可能ワークフロー sync.yml とドキュメントのコピペ用サンプル）を
// 機械的に「見つける」「書き換える」ための共有ロジックを提供する。
//
// CI整合性チェック（test/version-consistency.test.ts）とリリーススクリプト
// （scripts/release.ts）の両方がこのモジュールを使うことで、「検出に使う
// パターン」と「書き換えに使うパターン」が必ず一致し、片方だけが取り残される
// ことを防ぐ。

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(__dirname, "..");

// GitHub Actions の `uses:` に書かれる、このアクション／再利用可能
// ワークフローへの参照。仕様上 `uses:` は式（${{ ... }}）を使えず静的な
// 文字列しか書けないため、リリースのたびにここのタグ名を実際のリリース
// タグへ手で合わせる必要がある。そのズレを検出・修正するのがこのモジュール。
//
// 2つの形をどちらも捕捉する:
//   a24fukuda/issue-to-repository-action@vX.Y.Z
//   a24fukuda/issue-to-repository-action/.github/workflows/sync.yml@vX.Y.Z
const ACTION_REF = String.raw`a24fukuda/issue-to-repository-action(?<path>/[^\s@]+)?@v(?<version>\d+\.\d+\.\d+)`;

/** 各呼び出しで状態を持たない新しい RegExp を返す（`g` フラグの lastIndex 共有を避ける）。*/
export function actionRefPattern(): RegExp {
  return new RegExp(ACTION_REF, "g");
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

export interface ActionRef {
  /** 参照が書かれているファイル（リポジトリルートからの相対パス）。 */
  file: string;
  /** その参照がピン留めしているバージョン（`v` を除いた X.Y.Z）。 */
  version: string;
  /** 元の行全体（診断メッセージ用）。 */
  line: string;
}

// バージョン参照が現れるファイル一覧。将来ここへ追加すれば、CIチェックと
// リリーススクリプトの両方が自動で対象に含める。
export const TRACKED_FILES = [".github/workflows/sync.yml", "README.md"] as const;

/** 追跡対象ファイルすべてから、アクション／ワークフロー参照を抽出する。 */
export function findActionRefs(): ActionRef[] {
  const refs: ActionRef[] = [];
  for (const file of TRACKED_FILES) {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const line of content.split("\n")) {
      const pattern = actionRefPattern();
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        refs.push({ file, version: match.groups!.version!, line: line.trim() });
      }
    }
  }
  return refs;
}

/**
 * 与えたファイル内容の中のアクション／ワークフロー参照のバージョンを
 * `version` へ書き換えた新しい内容を返す。パス部分（/.github/...）は保持する。
 */
export function rewriteActionRefs(content: string, version: string): string {
  return content.replace(actionRefPattern(), (_full, ...args) => {
    const groups = args[args.length - 1] as { path?: string };
    return `a24fukuda/issue-to-repository-action${groups.path ?? ""}@v${version}`;
  });
}
