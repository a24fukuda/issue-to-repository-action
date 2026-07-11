import { describe, expect, it } from "bun:test";
import {
  COMMENT_MARKER_PREFIX,
  COMMENT_MARKER_SUFFIX,
  COMMENTS_SECTION_MARKER,
  issueFileName,
  renderIssueFile,
} from "../src/render";
import type { IssueComment, IssueRecord } from "../src/types";
import { makeIssue as makeBaseIssue } from "./fixtures";
import { parseComments } from "./parse-helper";

// 共有フィクスチャをこのファイル独自の規約（ラベル/担当者/マイルストーンが
// 設定されたIssue）でラップし、フィールドリスト自体は単一の情報源を
// 保ちながら、このファイル固有のデフォルト値も維持している。
function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return makeBaseIssue({
    number: 42,
    title: "Something broke",
    labels: ["bug"],
    assignees: ["bob"],
    milestone: "v1.0",
    updatedAt: "2026-01-02T00:00:00Z",
    body: "Steps to reproduce...",
    ...overrides,
  });
}

describe("issueFileName", () => {
  it("uses the issue number as the file name", () => {
    expect(issueFileName(makeIssue({ number: 7 }))).toBe("7.md");
  });
});

describe("renderIssueFile", () => {
  it("includes GitHub metadata in frontmatter", () => {
    const output = renderIssueFile(makeIssue());
    expect(output).toContain("number: 42");
    expect(output).toContain("state: open");
    expect(output).toContain("author: alice");
    expect(output).toContain("- bug");
    expect(output).toContain("- bob");
    expect(output).toContain("milestone: v1.0");
  });

  it("includes the issue body after the frontmatter", () => {
    const output = renderIssueFile(makeIssue({ body: "Steps to reproduce..." }));
    expect(output).toContain("Steps to reproduce...");
  });

  it("omits a Comments section when there are no comments", () => {
    const output = renderIssueFile(makeIssue({ comments: [] }));
    expect(output).not.toContain("## Comments");
    expect(output).not.toContain(COMMENTS_SECTION_MARKER);
  });

  it("renders each comment with its author and timestamp", () => {
    const output = renderIssueFile(
      makeIssue({
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
          { authorLogin: null, createdAt: "2026-01-04T00:00:00Z", body: "Me too." },
        ],
      }),
    );
    expect(output).toContain("## Comments");
    expect(output).toContain("### @carol — 2026-01-03T00:00:00Z");
    expect(output).toContain("> Same here.");
    expect(output).toContain("### unknown — 2026-01-04T00:00:00Z");
    expect(output).toContain("> Me too.");
  });

  it("emits a machine-readable marker before the section and before each comment", () => {
    const output = renderIssueFile(
      makeIssue({
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
          { authorLogin: null, createdAt: "2026-01-04T00:00:00Z", body: "Me too." },
        ],
      }),
    );
    expect(output).toContain(`${COMMENTS_SECTION_MARKER}\n\n## Comments`);
    expect(output).toContain(
      '<!-- issue-sync:comment {"author":"carol","created_at":"2026-01-03T00:00:00Z"} -->',
    );
    expect(output).toContain(
      '<!-- issue-sync:comment {"author":null,"created_at":"2026-01-04T00:00:00Z"} -->',
    );
  });

  it("quotes every line of a comment body, using bare '>' for blank lines", () => {
    // 空行に `>` を置かないと引用ブロックがそこで分断され、1つのコメントが
    // 複数の引用に見えてしまう。
    const output = renderIssueFile(
      makeIssue({
        comments: [
          {
            authorLogin: "carol",
            createdAt: "2026-01-03T00:00:00Z",
            body: "first paragraph\n\nsecond paragraph",
          },
        ],
      }),
    );
    expect(output).toContain("> first paragraph\n>\n> second paragraph");
  });

  it("normalizes CRLF to LF in the issue body and comment bodies", () => {
    // GitHubのAPIはWebフォーム投稿の本文を \r\n で返す。そのまま埋め込むと
    // 改行コードが混在し、checkout時の正規化とレンダリング結果が毎回
    // 食い違うほか、引用化で `> foo\r` のような行が生まれてしまう。
    const output = renderIssueFile(
      makeIssue({
        body: "line one\r\nline two",
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "reply one\r\nreply two" },
        ],
      }),
    );
    expect(output).not.toContain("\r");
    expect(output).toContain("line one\nline two");
    expect(output).toContain("> reply one\n> reply two");
  });

  it("normalizes lone CR and CR-CR-LF sequences too", () => {
    // 回帰テスト: 以前の正規化は \r\n のみを置換していたため、CRのみの
    // 改行や \r\r\n の残骸の \r がレンダリング結果に残り、`> foo\r` の
    // ような行と改行コード混在（= checkout正規化との毎回の食い違い）を
    // 生んでいた。
    const output = renderIssueFile(
      makeIssue({
        body: "old\rmac",
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "double\r\r\ncr" },
        ],
      }),
    );
    expect(output).not.toContain("\r");
    expect(output).toContain("old\nmac");
    expect(output).toContain("> double\n>\n> cr");
  });

  it("nests a comment body that is itself a quote one level deeper", () => {
    const output = renderIssueFile(
      makeIssue({
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "> original\n\nreply" },
        ],
      }),
    );
    expect(output).toContain("> > original\n>\n> reply");
  });

  it("is deterministic for the same input", () => {
    const issue = makeIssue();
    expect(renderIssueFile(issue)).toBe(renderIssueFile(issue));
  });

  it("emits exactly one blank line before Comments when the body is empty", () => {
    const output = renderIssueFile(
      makeIssue({
        body: "",
        comments: [{ authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." }],
      }),
    );
    expect(output).toContain(`---\n\n${COMMENTS_SECTION_MARKER}\n\n## Comments`);
    expect(output).not.toContain("\n\n\n");
  });

  it("never emits more than one consecutive blank line", () => {
    const output = renderIssueFile(
      makeIssue({
        body: "line one\n\nline two",
        comments: [
          { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
          { authorLogin: "dave", createdAt: "2026-01-04T00:00:00Z", body: "" },
        ],
      }),
    );
    expect(output).not.toContain("\n\n\n");
  });
});

describe("round trip (renderIssueFile → parseComments)", () => {
  // 保存形式が本当に機械可読であることの保証: コメント本文がMarkdownの
  // 構造を壊しにくる内容（見出し、セクション見出しと同じ文字列、閉じ
  // 忘れコードフェンス、引用、マーカー風の行）であっても、render した
  // ファイルから元のコメントが復元できる。復元はレンダリング時の正規化
  // （改行のLF化・本文前後のtrim）を除いて正確 — その正規化自体も
  // ここで明示的にテストする。
  const adversarialComments: IssueComment[] = [
    {
      authorLogin: "carol",
      createdAt: "2026-01-03T00:00:00Z",
      body: "## Comments\n\n### @dave — 2026-01-04T00:00:00Z\n\nheadings that mimic our own structure",
    },
    {
      authorLogin: "dave",
      createdAt: "2026-01-04T00:00:00Z",
      body: "an unclosed fence:\n\n```\ncode that never ends",
    },
    {
      authorLogin: null,
      createdAt: "2026-01-05T00:00:00Z",
      body: "> already a quote\n\nwith a blank line",
    },
    {
      authorLogin: "eve",
      createdAt: "2026-01-06T00:00:00Z",
      // マーカー書式の定数から組み立てる: 手書きのリテラルだと、書式が
      // 変わったときにこのフィクスチャが「ただのテキスト行」に静かに劣化し、
      // マーカー偽装耐性のテストがno-opのままグリーンになってしまう。
      body: `${COMMENT_MARKER_PREFIX}{"author":"fake","created_at":"1970-01-01T00:00:00Z"}${COMMENT_MARKER_SUFFIX}`,
    },
    {
      authorLogin: "frank",
      createdAt: "2026-01-07T00:00:00Z",
      body: "",
    },
  ];

  it("recovers every comment exactly", () => {
    const issue = makeIssue({ comments: adversarialComments });
    expect(parseComments(renderIssueFile(issue))).toEqual(adversarialComments);
  });

  it("recovers CRLF comments in normalized (LF) form", () => {
    const issue = makeIssue({
      comments: [
        { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "one\r\ntwo\r\n\r\nthree" },
      ],
    });
    expect(parseComments(renderIssueFile(issue))).toEqual([
      { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "one\ntwo\n\nthree" },
    ]);
  });

  it("parses no comments from a file without a Comments section", () => {
    expect(parseComments(renderIssueFile(makeIssue({ comments: [] })))).toEqual([]);
  });

  it("recovers comment bodies in trimmed form (render-time normalization)", () => {
    // trim はレンダリング時の正規化仕様: 先頭・末尾の空白/改行は保存されない。
    // 「完全復元」の主張をこの正規化の範囲に明示的にスコープするテスト。
    const issue = makeIssue({
      comments: [
        { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "\n\n  hello \n" },
        { authorLogin: "dave", createdAt: "2026-01-04T00:00:00Z", body: "   " },
      ],
    });
    expect(parseComments(renderIssueFile(issue))).toEqual([
      { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "hello" },
      { authorLogin: "dave", createdAt: "2026-01-04T00:00:00Z", body: "" },
    ]);
  });

  it("parses a CRLF-normalized checkout of the file identically", () => {
    // Windows（core.autocrlf=true や .gitattributes eol=crlf）でチェック
    // アウトされたファイルは全行がCRLFになる。行の完全一致でマーカーを
    // 探すパーサーが、黙って0件を返さないことを保証する。
    const comments: IssueComment[] = [
      { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
    ];
    const crlfContent = renderIssueFile(makeIssue({ comments })).replace(/\n/g, "\r\n");
    expect(parseComments(crlfContent)).toEqual(comments);
  });

  it("ignores spoofed markers in the issue body when real comments exist", () => {
    // 本文（引用化されない）がセクションマーカーや偽コメントマーカーと
    // 同一の行を含んでいても、本物のセクションマーカーは常に最後の出現
    // なので、本文由来の偽コメントは混入しない。
    const comments: IssueComment[] = [
      { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
    ];
    const spoofingBody = [
      "quoting the file format:",
      COMMENTS_SECTION_MARKER,
      `${COMMENT_MARKER_PREFIX}{"author":"evil","created_at":"1999-01-01T00:00:00Z"}${COMMENT_MARKER_SUFFIX}`,
      "> injected line",
    ].join("\n");
    const output = renderIssueFile(makeIssue({ body: spoofingBody, comments }));
    expect(parseComments(output)).toEqual(comments);
  });

  it("returns no comments for a zero-comment issue whose body spoofs the markers", () => {
    // comments_count が 0 ならセクションを探しにすら行かないため、本文中の
    // 偽マーカーが偽コメントとしてパースされることはない。
    const spoofingBody = [
      COMMENTS_SECTION_MARKER,
      `${COMMENT_MARKER_PREFIX}{"author":"evil","created_at":"1999-01-01T00:00:00Z"}${COMMENT_MARKER_SUFFIX}`,
      "> injected line",
    ].join("\n");
    const output = renderIssueFile(makeIssue({ body: spoofingBody, comments: [] }));
    expect(parseComments(output)).toEqual([]);
  });

  it("throws on a pre-marker legacy file instead of silently dropping its comments", () => {
    // マーカー導入前のリリースが書いたファイル（### 見出しのみ・引用なし）
    // は、コメント0件として黙って [] を返すのではなく、明示的に失敗する。
    const legacyFile = [
      "---",
      "number: 42",
      "comments_count: 1",
      "---",
      "",
      "Steps to reproduce...",
      "",
      "## Comments",
      "",
      "### @carol — 2026-01-03T00:00:00Z",
      "",
      "Same here.",
      "",
    ].join("\n");
    expect(() => parseComments(legacyFile)).toThrow(/旧形式/);
  });

  it("throws when the recovered comment count disagrees with comments_count", () => {
    // 破損したファイル（マーカー行の欠落など）は、欠けた分を黙って
    // 失った結果を返すのではなく、件数照合で明示的に失敗する。
    const comments: IssueComment[] = [
      { authorLogin: "carol", createdAt: "2026-01-03T00:00:00Z", body: "Same here." },
      { authorLogin: "dave", createdAt: "2026-01-04T00:00:00Z", body: "Me too." },
    ];
    const corrupted = renderIssueFile(makeIssue({ comments }))
      .split("\n")
      .filter((line) => !line.includes('"author":"dave"'))
      .join("\n");
    expect(() => parseComments(corrupted)).toThrow(/comments_count/);
  });
});
