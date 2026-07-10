# issue-to-repository-action

GitHub Issues（コメント履歴を含む）を、バージョン管理されたMarkdownファイルとして
リポジトリ内に同期します。これにより、変更が「なぜ」行われたかという履歴が
GitHubから独立して残ります。

## 設計方針

- **リアルタイムではなくバッチ処理。** 実行のたびに全Issueが API から再取得され、
  `issues/` ディレクトリが1つのコミットで完全に再生成されます。イベントごとの
  差分コミットは行わないため、この*アクションの複数の実行が同時に*同じブランチへ
  書き込む状況を調整する必要はありません — `concurrency` グループ
  （`sync.yml`/`self-sync.yml` 内）がそれらを直列化します。ただし
  `concurrency` グループは、このアクションの実行中に無関係なコミット
  （マージされたPRや他のボット）が同じブランチに乗ることまでは防げないため、
  同期コミットはプッシュが拒否された場合に1回だけ fetch-and-rebase の
  リトライを行ってから諦めます。それでも実行が失敗した場合（実際のコンテンツ
  競合、または独自の `concurrency` グループを持たない direct-action 経由の
  呼び出し元の場合）、自動でリトライされることはなく、次のスケジュール実行
  またはイベントトリガーの実行まで `issues/` は古いままになります。
- **Issueごとに1ファイル**、`issues/<number>.md` という名前で保存されます。
- **open/closed はフロントマターのフィールド**（`state: open` / `state: closed`）
  であり、ディレクトリの分割ではありません — Issueをクローズしてもファイルの
  リネームや移動は発生しないため、履歴は1つのパスに紐づいたままになります。
- **コメントは `## Comments` セクションの下に追記**されます。コメントも記録
  すべき履歴の一部だからです。
- **コメント本文は1レベルの引用ブロック（`> `）として保存**されます。引用
  ブロックはCommonMarkのコンテナブロックなので、コメント本文に閉じられて
  いないコードフェンスや見出しが含まれていても、その影響はコメントの終端で
  強制的に閉じられ、後続のコメントやセクション構造を壊しません（GitHub上では
  コメントごとに独立してレンダリングされるため起きない崩れですが、1ファイルに
  連結すると起きます）。変換は全行から引用を1レベル剥がすだけで完全に
  復元できます。
- **機械可読なHTMLコメントマーカー**（`<!-- issue-sync:comments -->` と
  `<!-- issue-sync:comment {"author":...,"created_at":...} -->`）がコメント
  セクションと各コメントの直前に埋め込まれます。Markdownプレビューでは
  表示されないまま、パーサーは見出し行の書式に依存せずコメント境界と
  メタデータを機械的に読み取れます。本文は全行が引用化されているため、
  本文がマーカーや見出しと同じ文字列を含んでいても誤認されません。
- **GitHub固有のメタデータ**（ラベル、担当者、マイルストーン、作成者、URL、
  タイムスタンプ）はフロントマターに記録されるため、将来GitHubから移行しても
  何も失われません。

## 使い方

### 推奨: 再利用可能なワークフロー

Issueを同期したいリポジトリに以下を追加してください。安定性のため `@main` では
なく `@v1`（または特定の `@vX.Y.Z` リリース）を指定することをお勧めします。

```yaml
# .github/workflows/issue-sync.yml
name: issue-sync
on:
  issues:
    types: [opened, edited, closed, reopened, deleted]
  schedule:
    - cron: "0 0 * * *"
jobs:
  sync:
    uses: a24fukuda/issue-to-repository-action/.github/workflows/sync.yml@v1
    permissions:
      contents: write
      issues: read
    secrets: inherit
```

この再利用可能なワークフローは、リポジトリをチェックアウトし、同期アクションを
実行し、`issues/` に変更があればコミットをプッシュします。また独自の
`concurrency` グループを適用するため、Issueイベントと日次スケジュールが
重なっても競合しません。

### 代替案: アクションを直接呼び出す

同期処理をより大きなワークフローに組み込みたい場合に便利です。

```yaml
permissions:
  contents: write
  issues: read

steps:
  - uses: actions/checkout@v4
  - uses: a24fukuda/issue-to-repository-action@v1
    with:
      issues-dir: issues
```

この方法には組み込みの並行実行保護がありません（JSアクション自体は
`concurrency:` ブロックを宣言できないため）。重複するイベントで
トリガーされる可能性がある場合は、自分のワークフロー側に追加してください。

## 入力

| Input             | デフォルト                                              | 説明                                       |
| ------------------|---------------------------------------------------------|--------------------------------------------|
| `github-token`    | `${{ github.token }}`                                  | Issue/コメントの読み取りとコミットのプッシュに使うトークン |
| `issues-dir`      | `issues`                                                | Issueファイルの書き込み先ディレクトリ         |
| `commit-message`  | `chore: sync issues`                                    | ファイルに変更があった場合のコミットメッセージ |
| `committer-name`  | `github-actions[bot]`                                   | コミット作成者名                             |
| `committer-email` | `41898282+github-actions[bot]@users.noreply.github.com` | コミット作成者のメールアドレス                |

## ファイル形式

```markdown
---
number: 42
title: Something broke
url: https://github.com/owner/repo/issues/42
state: open
author: alice
labels:
  - bug
assignees:
  - bob
milestone: v1.0
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-02T00:00:00Z"
closed_at: null
comments_count: 1
---

Steps to reproduce...

<!-- issue-sync:comments -->

## Comments

<!-- issue-sync:comment {"author":"carol","created_at":"2026-01-03T00:00:00Z"} -->

### @carol — 2026-01-03T00:00:00Z

> Same here.
```

### 既知の制限

- マーカーはファイル内（in-band）に埋め込まれるため、**Issue本文**（引用化
  されない、文書の本体）が偶然マーカーと同一の行を含んでいた場合、パーサーは
  そこをコメント境界と誤認し得ます。コメント本文は全行引用化されるのでこの
  問題はありません。
- Issue本文に閉じられていないコードフェンスが含まれる場合、それ以降の
  *表示*（`## Comments` セクションを含む）はコードブロックに飲み込まれて
  崩れ得ますが、マーカーによる機械的なパースには影響しません。

GitHub上流で削除された（またはGitHubにより削除された）Issueは、次回の同期時に
ファイルも削除されます。ディレクトリは常に現在のIssue集合から再生成される
ためです。削除の対象はこのアクションが以前の実行で書き込んだファイルに
限定されます — `issues/.manifest.json`（Issueファイルと一緒にコミットされます）
で追跡されているため、Issueのような名前を偶然持つ既存ファイル（例えば
`issues-dir` が完全に制御できないディレクトリを指している場合など）が
誤って削除されることはありません。

## リリース手順

`.github/workflows/sync.yml` は内部で
`a24fukuda/issue-to-repository-action@v1` を参照しているため、コミットには
不変のバージョンタグ（`vX.Y.Z`）と、同じコミットを指す可変のメジャータグ
（`v1`）の両方を付けてください:

```sh
git tag v1.0.0
git tag -f v1
git push origin v1.0.0
git push -f origin v1
```

`dist/index.js` はコミットされており（`action.yml` の `runs.main` が実行する
ファイルです）、CI（`.github/workflows/ci.yml`）は `src/` と内容が一致しない
場合PRを失敗させます。ソースを変更したら `bun run build` を実行し、結果を
コミットしてください。

`.github/workflows/self-sync.yml` は `action.yml` を直接（`uses: ./`）使って
プッシュのたびにドッグフーディングを行うため、`src/` の変更は継続的に
検証されます。ただしこれは `.github/workflows/sync.yml` を検証するもの
**ではありません** — その再利用可能なワークフローは内部でリリース済みの
`@v1` タグを固定して参照しているため、self-sync経由でそれをテストすると
現在のコミットではなく最新リリースをテストすることになってしまいます。
`sync.yml` 自体への変更（権限、secrets/outputs の配線）はこのリポジトリの
どの自動化ワークフローでもカバーされていないため、手動でレビューし、
それを変更するリリースを切った後は実際のconsumerリポジトリに対する
手動のエンドツーエンド確認を検討してください。

## 開発

ツールチェイン（依存関係のインストール、型チェック、テスト、バンドル）は
[Bun](https://bun.sh) 上で動作します。アクション自体は実行時には引き続き
Node.js上で実行されます（`action.yml` の `runs.using: node20`）—
`bun build` はNodeをターゲットにする（`--target=node --format=cjs`）ため、
`dist/index.js` はBun専用バンドルではなく、通常のNode互換CommonJSです。

```sh
bun install
bun run typecheck
bun test
bun run build   # dist/index.js を再生成
```

`bun build` の最小化された出力はBunのリリース間でバイト単位の安定性が
保証されておらず、CIの「dist/ が最新か」チェックは `dist/index.js` を
バイト単位で比較するため、CIは `latest` ではなく固定した `bun-version`
（`.github/workflows/ci.yml`）を使用しています。固定バージョンを
上げる場合は、同じ変更内で `dist/index.js` を再ビルドして
コミットし直してください。
