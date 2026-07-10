import yaml from "js-yaml";
import type { IssueRecord } from "./types";

// 機械可読マーカー。Markdownプレビューでは表示されないHTMLコメントとして、
// コメントセクションの開始と各コメントの境界を示す。見出し行
// （### @author — 日時）は人間向けの表示であり、パーサーはこのマーカーの
// JSONペイロードからメタデータを読むため、見出しの書式には依存しない。
export const COMMENTS_SECTION_MARKER = "<!-- issue-sync:comments -->";
export const COMMENT_MARKER_PREFIX = "<!-- issue-sync:comment ";

export function issueFileName(issue: IssueRecord): string {
  return `${issue.number}.md`;
}

// GitHubのAPIはWebフォームから投稿された本文を \r\n 改行で返す。そのまま
// 埋め込むとファイル内で改行コードが混在し、チェックアウト時の正規化
// （.gitattributes の text=auto 等）とレンダリング結果が毎回食い違って
// 無駄な再書き込みが発生する。また下のquoteBlockは行単位で処理するため、
// 正規化しないと `> foo\r` のような行が生まれてしまう。
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// コメント本文を1レベルの引用ブロックにする。引用ブロックはCommonMarkの
// コンテナブロックであり、内部で開かれたコードフェンス・見出し・リストは
// コンテナの終端で強制的に閉じる — そのため、閉じられていないフェンスを
// 含むコメントがあっても、その後ろのコメントがコードブロックに飲み込まれる
// ことはなく、本文中の見出しも文書全体の階層と混ざらない。空行にも `>` を
// 置くのは、素の空行が引用ブロックを分断して1つのコメントが複数の引用に
// 見えてしまうのを防ぐため。変換は全行から1レベル剥がすだけで完全に
// 復元できる。
function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function commentMarker(author: string | null, createdAt: string): string {
  // author（GitHubのloginは英数字とハイフンのみ）と createdAt（ISO 8601）には
  // HTMLコメントの終端 `-->` が現れ得ないため、JSONをそのまま埋め込める。
  return `${COMMENT_MARKER_PREFIX}${JSON.stringify({ author, created_at: createdAt })} -->`;
}

export function renderIssueFile(issue: IssueRecord): string {
  const frontmatter = {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    author: issue.authorLogin,
    labels: issue.labels,
    assignees: issue.assignees,
    milestone: issue.milestone,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments_count: issue.comments.length,
  };

  const yamlText = yaml
    .dump(frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false })
    .trimEnd();

  // フラットな配列に "" のセパレーターを混ぜるのではなく、空でない
  // ブロックのリストを作り、それらを1つの空行で連結する — こうすることで、
  // 空のIssue本文（タイトルのみのIssueでよくある）が次のブロックの前に
  // 余分な空行を残すことがない。
  const blocks = [`---\n${yamlText}\n---`];

  const body = normalizeNewlines(issue.body).trim();
  if (body) blocks.push(body);

  if (issue.comments.length > 0) {
    const commentBlocks = issue.comments.map((comment) => {
      const author = comment.authorLogin ? `@${comment.authorLogin}` : "unknown";
      const marker = commentMarker(comment.authorLogin, comment.createdAt);
      const header = `${marker}\n\n### ${author} — ${comment.createdAt}`;
      const commentBody = normalizeNewlines(comment.body).trim();
      return commentBody ? `${header}\n\n${quoteBlock(commentBody)}` : header;
    });
    blocks.push([COMMENTS_SECTION_MARKER, "## Comments", ...commentBlocks].join("\n\n"));
  }

  return `${blocks.join("\n\n")}\n`;
}
