import { COMMENT_MARKER_PREFIX, COMMENTS_SECTION_MARKER } from "../src/render";
import type { IssueComment } from "../src/types";

const MARKER_SUFFIX = " -->";

interface CommentMarkerPayload {
  author: string | null;
  created_at: string;
}

/**
 * renderIssueFileが生成したファイルからコメントを復元する参照実装。
 * アクションの実行時には不要だが、保存形式が本当に機械可読である
 * （render → parse で元のコメントが復元できる）ことをラウンドトリップ
 * テストで保証するために使う。将来GitHubから移行する際のパーサーの
 * 出発点にもなる。
 *
 * メタデータは見出し行（### @author — 日時）ではなくマーカーのJSON
 * ペイロードから読み、本文は引用ブロックを1レベル剥がして復元する。
 * コメント本文はレンダリング時に全行が引用化されているため、本文が
 * マーカーや見出しと同じ文字列を含んでいても誤認しない。
 */
export function parseComments(fileContent: string): IssueComment[] {
  const lines = fileContent.split("\n");
  const sectionIndex = lines.indexOf(COMMENTS_SECTION_MARKER);
  if (sectionIndex === -1) return [];

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
    if (line.startsWith(COMMENT_MARKER_PREFIX) && line.endsWith(MARKER_SUFFIX)) {
      flush();
      const json = line.slice(COMMENT_MARKER_PREFIX.length, -MARKER_SUFFIX.length);
      current = { payload: JSON.parse(json) as CommentMarkerPayload, lines: [] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  flush();

  return comments;
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
