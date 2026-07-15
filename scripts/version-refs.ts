// バージョンタグの「唯一の真実」は package.json の `version` フィールド。
// このモジュールは、そのバージョンに一致していなければならない参照を機械的に
// 「見つける」「書き換える」ための共有ロジックを提供する。
//
// リリースタグと一致する必要があるのは、実際に実行される参照 —— すなわち
// ワークフロー（`.github/workflows/*.yml`）の `uses:` に書かれた、この
// アクション／再利用可能ワークフローへの参照 —— だけである。GitHub Actions の
// `uses:` は式（${{ ... }}）を使えず静的な文字列しか書けないため、切る
// リリースタグに手で合わせる必要がある。
//
// README などのドキュメントは意図的に追跡対象に含めない。サンプルは
// `@vX.Y.Z` というプレースホルダで書かれており、このリポジトリの現行版と
// 一致する制約が無い（利用者が自分でピン留めする版を選ぶための例）ため。
// 文書を同期対象から外すことで、陳腐化と誤検出（無関係なバージョン文字列を
// 巻き込む問題）の両方を根本的に避けている。
//
// CI整合性チェック（test/version-consistency.test.ts）とリリーススクリプト
// （scripts/release.ts）の両方がこのモジュールを使うことで、「検出に使う
// パターン」と「書き換えに使うパターン」が必ず一致する。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(__dirname, "..");

// `uses:` に書くアクション／再利用可能ワークフローへの参照。パス部分の有無で
// 2つの形を取る:
//   a24fukuda/issue-to-repository-action@vX.Y.Z
//   a24fukuda/issue-to-repository-action/.github/workflows/sync.yml@vX.Y.Z
// `X.Y.Z`（英字のプレースホルダ）や `actions/checkout@v4` のようなメジャー
// のみのタグには一致しないため、プレースホルダや第三者アクションを誤検出しない。
// 毎回新しい RegExp リテラルを返す（`g` フラグの lastIndex が呼び出し間で
// 共有されるのを避ける）。
function actionRefPattern(): RegExp {
  return /a24fukuda\/issue-to-repository-action(?<path>\/[^\s@]+)?@v(?<version>\d+\.\d+\.\d+)/g;
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

// バージョン参照が現れ得るファイルの集合＝ワークフローディレクトリの
// `*.yml`/`*.yaml`。グロブで列挙するため、新しいワークフローを追加しても
// この一覧を手で更新せずに CIチェックとリリーススクリプトの両方が自動で
// 対象に含める。ドキュメント（README 等）は前掲の理由で意図的に対象外。
export function trackedFiles(): string[] {
  const workflowsDir = join(REPO_ROOT, ".github/workflows");
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

/** 追跡対象ファイルすべてから、アクション／ワークフロー参照を抽出する。 */
export function findVersionRefs(): VersionRef[] {
  const refs: VersionRef[] = [];
  for (const file of trackedFiles()) {
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
export function rewriteVersionRefs(content: string, version: string): string {
  return content.replace(actionRefPattern(), (_full, ...args) => {
    const groups = args[args.length - 1] as { path?: string };
    return `a24fukuda/issue-to-repository-action${groups.path ?? ""}@v${version}`;
  });
}
