import yaml from "js-yaml";
import {
  COMMENT_MARKER_PREFIX,
  COMMENT_MARKER_SUFFIX,
  COMMENTS_SECTION_MARKER,
  type CommentMarkerPayload,
} from "../src/render";
import type { IssueComment } from "../src/types";

/**
 * renderIssueFileが生成したファイルからコメントを復元する参照実装。
 * アクションの実行時には不要だが、保存形式が機械可読であることを
 * ラウンドトリップテストで保証するために使う。将来GitHubから移行する
 * 際のパーサーの出発点にもなる。
 *
 * 復元は、レンダリング時に適用される正規化を除いて正確である:
 * 改行コードは LF に正規化され、本文の先頭・末尾の空白は trim される。
 * つまり parse(render(comments)) は「正規化済みの comments」と一致する。
 *
 * 頑健性の設計:
 * - メタデータは見出し行（### @author — 日時）ではなくマーカーのJSON
 *   ペイロードから読み、本文は引用ブロックを1レベル剥がして復元する。
 * - セクションマーカーは最後の出現を採用する。（引用化されない）Issue本文
 *   はコメントセクションより前にあり、コメント本文は全行引用化されるため、
 *   本物のマーカーより後に裸のマーカー行が現れることはない — 本文中の
 *   マーカー同一行による偽装はこれで無害化される。
 * - フロントマターの comments_count と復元件数を照合し、不一致（旧形式の
 *   ファイル、破損、本文由来の偽装マーカーの混入など）は黙って壊れた結果を
 *   返すのではなく例外にする。
 * - チェックアウト時にCRLF正規化されたファイルも受け付ける（入口でLFに戻す）。
 */
export function parseComments(fileContent: string): IssueComment[] {
  const lines = fileContent.replace(/\r\n/g, "\n").split("\n");

  const expectedCount = readCommentsCount(lines);
  // コメント0件のファイルはセクション自体を持たない。本文が偶然マーカー
  // 同一の行を含んでいても、ここで打ち切るので偽コメントは生まれない。
  if (expectedCount === 0) return [];

  const sectionIndex = lines.lastIndexOf(COMMENTS_SECTION_MARKER);
  if (sectionIndex === -1) {
    throw new Error(
      `コメントセクションのマーカーが見つかりません（frontmatterのcomments_countは${expectedCount}件） — ` +
        "マーカー導入前の旧形式のファイルか、壊れたファイルです。",
    );
  }

  const comments: IssueComment[] = [];
  let current: { payload: CommentMarkerPayload; lines: string[] } | null = null;

  const flush = () => {
    if (current === null) return;
    comments.push({
      authorLogin: current.payload.author,
      createdAt: current.payload.created_at,
      body: unquoteBody(current.lines),
    });
    current = null;
  };

  for (const line of lines.slice(sectionIndex + 1)) {
    if (line.startsWith(COMMENT_MARKER_PREFIX) && line.endsWith(COMMENT_MARKER_SUFFIX)) {
      flush();
      current = { payload: parseMarkerPayload(line), lines: [] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  flush();

  if (comments.length !== expectedCount) {
    throw new Error(
      `復元したコメント数（${comments.length}件）がfrontmatterのcomments_count` +
        `（${expectedCount}件）と一致しません — 壊れたファイルの可能性があります。`,
    );
  }

  return comments;
}

function parseMarkerPayload(line: string): CommentMarkerPayload {
  const json = line.slice(COMMENT_MARKER_PREFIX.length, -COMMENT_MARKER_SUFFIX.length);
  try {
    return JSON.parse(json) as CommentMarkerPayload;
  } catch {
    // 本物のセクションマーカーより後に本文由来の行は現れないため、ここに
    // 来るのは実際に壊れたファイルだけ。生のSyntaxErrorではなく、どの行が
    // 問題かわかるエラーにして失敗させる。
    throw new Error(`コメントマーカーのJSONペイロードが不正です: ${line}`);
  }
}

// レンダリングされたファイルはフロントマターで始まる（1行目が "---"、
// 対になる "---" まで）。comments_count はrenderIssueFileが常に書き込む
// ため、読めないファイルはこのアクションの出力ではない — 黙って0件を
// 返すのではなく例外にする。
function readCommentsCount(lines: string[]): number {
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end === -1) {
    throw new Error("フロントマターが見つかりません — このアクションが生成したファイルではありません。");
  }

  const frontmatter: unknown = yaml.load(lines.slice(1, end).join("\n"));
  const count = (frontmatter as { comments_count?: unknown } | null)?.comments_count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error("frontmatterに有効なcomments_countがありません。");
  }
  return count;
}

// コメント本文の行はすべて引用化されている（空行は ">"、それ以外は "> "
// 前置）ため、引用行だけを集めて1レベル剥がせば本文が復元できる。
// 見出し行（### ...）や区切りの空行は引用されていないので自然に除外される。
function unquoteBody(lines: string[]): string {
  return lines
    .filter((line) => line === ">" || line.startsWith("> "))
    .map((line) => (line === ">" ? "" : line.slice(2)))
    .join("\n");
}
