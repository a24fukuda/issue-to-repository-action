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
なく `@v1.0.0`（特定のリリースタグ）を指定することをお勧めします。

```yaml
# .github/workflows/issue-sync.yml
name: issue-sync
on:
  issues:
    types:
      [
        opened,
        edited,
        closed,
        reopened,
        deleted,
        labeled,
        unlabeled,
        assigned,
        unassigned,
        milestoned,
        demilestoned,
      ]
  issue_comment:
    types: [created, edited, deleted]
  schedule:
    - cron: "0 0 * * *"
jobs:
  sync:
    uses: a24fukuda/issue-to-repository-action/.github/workflows/sync.yml@v1.0.0
    permissions:
      contents: write
      issues: read
    secrets: inherit
```

この再利用可能なワークフローは、リポジトリをチェックアウトし、同期アクションを
実行し、`issues/` に変更があればコミットをプッシュします。また独自の
`concurrency` グループを適用するため、Issueイベントと日次スケジュールが
重なっても競合しません。

`issues` トリガーの `types` にコメント以外の変更（ラベル・担当者・
マイルストーン）も含め、`issue_comment` も別途トリガーとして追加している
点に注意してください — `issues: edited` はタイトル・本文の編集のみに発火し、
コメントの追加やラベル変更では発火しません。これらを省略すると、コメントや
ラベルの変更が次の日次スケジュール実行（最大24時間後）まで反映されません。

`secrets: inherit` はこのワークフローが宣言する `github-token` という
シークレットを供給できない点に注意してください — GitHubのリポジトリ/組織
シークレット名にはハイフンを含められないため、その名前のシークレットは
そもそも保存できず、`inherit` は常に呼び出し元の既定の `GITHUB_TOKEN` に
フォールバックします（多くの場合はそれで十分です）。独自のPersonal Access
Tokenを使いたい場合は、`secrets: inherit` の代わりに明示的なマッピングを
使ってください:

```yaml
    secrets:
      github-token: ${{ secrets.MY_PAT }}
```

このアクションは通常のブランチのチェックアウト（`actions/checkout@v4` の
既定の動作）を前提としています。`pull_request` イベントのようにdetached
HEAD状態でチェックアウトされるトリガーでは、コミットをpushできないため
即座に失敗します。

### 代替案: アクションを直接呼び出す

同期処理をより大きなワークフローに組み込みたい場合に便利です。

```yaml
permissions:
  contents: write
  issues: read

steps:
  - uses: actions/checkout@v4
  - uses: a24fukuda/issue-to-repository-action@v1.0.0
    with:
      issues-dir: issues
```

この方法には組み込みの並行実行保護がありません（JSアクション自体は
`concurrency:` ブロックを宣言できないため）。重複するイベントで
トリガーされる可能性がある場合は、自分のワークフロー側に追加してください。

## 入力

| Input             | デフォルト                                              | 説明                                       |
| ------------------|---------------------------------------------------------|--------------------------------------------|
| `github-token`    | `${{ github.token }}`                                  | Issue/コメントの読み取りとコミットのプッシュに使うトークン（※） |
| `issues-dir`      | `issues`                                                | Issueファイルの書き込み先ディレクトリ         |
| `commit-message`  | `chore: sync issues`                                    | ファイルに変更があった場合のコミットメッセージ |
| `committer-name`  | `github-actions[bot]`                                   | コミット作成者名                             |
| `committer-email` | `41898282+github-actions[bot]@users.noreply.github.com` | コミット作成者のメールアドレス                |

※ `github-token` を明示的に空文字列（未設定のシークレットを参照する式など）で
渡した場合、action.ymlのデフォルトは適用されず、"Input required and not
supplied" として即座に失敗します。デフォルトが適用されるのは、入力自体を
省略した場合のみです。

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
  されない、文書の本体）は理論上マーカーと同一の行を含み得ます。ただし
  パースはこれを前提に設計できます: 本物のセクションマーカーは常に最後の
  出現であり（コメント本文は全行引用化されるため、本物より後に裸のマーカー
  行は現れない）、フロントマターの `comments_count` と復元件数を照合すれば、
  不整合は黙ったデータ破損ではなく明示的なエラーとして検出できます。
  参照実装（`test/parse-helper.ts`）はこの両方を実装しています。
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

### 同期処理に関する既知の制限

- **ページネーション中のIssueの削除／移譲**: Issue一覧はREST APIの
  ページネーションで取得しており、単一の実行の取得中にIssueが削除・
  移譲されるとページ境界がずれ、まれに実在する別のIssueが今回の取得結果に
  含まれず、そのファイルが誤って削除されることがあります。次回の実行で
  そのIssueが再取得できれば、ファイルは正しく復元されます（gitの履歴も
  残るため恒久的なデータ損失にはなりません）。
- **大文字小文字を区別しないファイルシステム**: macOS/Windowsランナーや
  それらの上でのローカル実行では、`issues-dir` に偶然大文字小文字だけが
  異なる同名の無関係なファイル（例: `7.MD`）が既に存在すると、そのファイルの
  内容が黙って上書きされ得ます（Linux上のGitHub Actionsランナー
  `ubuntu-latest` では、ファイルシステムが大文字小文字を区別するため
  この問題は起こりません）。

## リリース手順

バージョンは `package.json` の `version` フィールドを**唯一の真実**とし、
`.github/workflows/sync.yml` の内部参照
（`a24fukuda/issue-to-repository-action@vX.Y.Z`）や README のサンプルは
すべてこの値に一致していなければなりません。GitHub Actions の `uses:` は式
（`${{ ... }}`）を使えず静的な文字列しか書けないため、この一致はリリース
のたびに手で合わせる必要があり、以前は複数箇所への手書き更新で取り残しが
起きやすい構造でした。これを2つの仕組みで安全にしています。

**リリーススクリプト（`bun run release`）** が、バージョンを1か所（コマンド
引数）で受け取り、重複しているすべての箇所（`package.json` / `sync.yml` /
README のサンプルと推奨タグ）を機械的に書き換え、その変更をコミットして
不変タグ（`vX.Y.Z`）を作成します。可変のメジャータグ（`v1`）は使いません。

```sh
bun run release 1.1.0        # ファイルを書き換え、コミットし、タグ v1.1.0 を作成
git push origin HEAD v1.1.0  # 内容を確認してから push（push だけは手動）
```

`sync.yml` の内部参照が「バージョンを書き換えたコミット」そのものを指す
不変タグに固定されるため、タグとコードは常に一致します。ファイル編集だけを
行いたい場合は `bun run release <version> --no-git` を使ってください。

**CI整合性チェック（`test/version-consistency.test.ts`、`bun test` で実行）**
が、追跡対象ファイル内のすべてのバージョン参照が `package.json` の version に
一致するかを検証し、不一致があればPRを落とします。手でバージョンを更新して
一部を取り残した場合でも、利用者へ出荷する前に検出されます。

利用者が「使い方」セクションの推奨どおり `sync.yml@vX.Y.Z` のように
特定バージョンでワークフローYAMLを固定すると、そのYAMLが内部で参照する
`a24fukuda/issue-to-repository-action@vX.Y.Z` も同じ不変タグを指すため、
再利用可能ワークフローの*配線*（permissions/secrets/outputs）と、実際に
実行されるアクションのコードの**両方**が同じバージョンに固定されます。
パッチ更新を受け取るには、利用者が参照するタグ名を新しいバージョンへ
明示的に上げる必要があります（自動追従はしません）。

`dist/index.js` はコミットされており（`action.yml` の `runs.main` が実行する
ファイルです）、CI（`.github/workflows/ci.yml`）は `src/` と内容が一致しない
場合PRを失敗させます。ソースを変更したら `bun run build` を実行し、結果を
コミットしてください。

`.github/workflows/self-sync.yml` は `action.yml` を直接（`uses: ./`）使って
プッシュのたびにドッグフーディングを行うため、`src/` の変更は継続的に
検証されます。ただしこれは `.github/workflows/sync.yml` を検証するもの
**ではありません** — その再利用可能なワークフローは内部でリリース済みの
`@v1.0.0` タグを固定して参照しているため、self-sync経由でそれをテストすると
現在のコミットではなく固定されたリリースをテストすることになってしまいます。
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
