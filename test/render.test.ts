import { describe, expect, it } from "bun:test";
import {
  COMMENT_MARKER_PREFIX,
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
  // ファイルから元のコメントが完全に復元できる。
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
      body: `${COMMENT_MARKER_PREFIX}{"author":"fake","created_at":"1970-01-01T00:00:00Z"} -->`,
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
});
