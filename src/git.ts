import * as core from "@actions/core";
import * as exec from "@actions/exec";

export interface CommitOptions {
  dir: string;
  message: string;
  committerName: string;
  committerEmail: string;
}

// process.envの値は `string | undefined` だが、子プロセスに渡すenvは
// `string` のみを受け付ける（@actions/execの型）。undefinedのキーは
// 単に除外する（子プロセス側にとっては未設定のままなので、渡しても
// 渡さなくても意味は同じ）。
function definedEnvEntries(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function git(
  args: string[],
  options?: Parameters<typeof exec.getExecOutput>[2],
) {
  return exec.getExecOutput("git", args, {
    ignoreReturnCode: true,
    ...options,
    env: {
      ...definedEnvEntries(process.env),
      // gitのメッセージのロケールを固定する: looksLikeRejectedPush（下記）
      // はstderrの英語の定型文言をパターンマッチしており、ランナーの
      // ロケールが非英語（NLS対応gitで LANG/LC_ALL が英語以外）だと
      // メッセージが翻訳されてしまいマッチしなくなる。診断目的の文字列
      // マッチングを行うすべての呼び出しに一律影響するよう、この
      // 関数レベルで固定する。
      LANG: "C",
      LC_ALL: "C",
      ...options?.env,
    },
  });
}

// commitやrebaseの際にcommitterのidentityを渡すための環境変数。
// `git config` で永続的に設定する（.git/configを書き換える）のではなく、
// 個別のgit呼び出しに環境変数として渡すことで、このチェックアウトに
// 副作用を残さない。GIT_AUTHOR_*/GIT_COMMITTER_* はコミットを新規作成
// する呼び出し（`commit` と、リトライ経路の `rebase`
// — パッチの再適用時にコミッターとしてidentityを解決する必要がある）
// の両方に渡す必要がある。
function identityEnv(committerName: string, committerEmail: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: committerName,
    GIT_AUTHOR_EMAIL: committerEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  };
}

function assertSuccess(
  result: { exitCode: number; stderr: string },
  action: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${action} に失敗しました（終了コード ${result.exitCode}）: ${result.stderr.trim()}`);
  }
}

// pushが拒否（他のコミットが既にリモートに存在する）されたことを示す
// gitの標準的な文言。これに一致しない失敗（認証エラー、ネットワーク断、
// upstream未設定など）は、fetch+rebaseで復旧できるものではないため、
// 無駄なfetch/rebase/pushサイクルを踏んでから紛らわしいエラーになる前に、
// 元のpushエラーで即座に失敗させる。
const PUSH_REJECTION_MARKERS = ["[rejected]", "non-fast-forward", "fetch first", "stale info"];

function looksLikeRejectedPush(stderr: string): boolean {
  return PUSH_REJECTION_MARKERS.some((marker) => stderr.includes(marker));
}

async function currentSha(): Promise<string> {
  const rev = await git(["rev-parse", "HEAD"]);
  assertSuccess(rev, "git rev-parse");
  return rev.stdout.trim();
}

/**
 * 現在のブランチ名を解決する。チェックアウトがdetached HEAD状態の場合は
 * 例外を投げる。低コストで副作用がないため、呼び出し元は決してpushできない
 * チェックアウトに無駄な高コストの処理（GitHub APIへのfetchなど）を
 * 費やす前にこれをチェックすべきである。
 */
export async function getCurrentBranch(): Promise<string> {
  const branchCheck = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (branchCheck.exitCode !== 0) {
    throw new Error(
      "現在のブランチを解決できませんでした — 同期コミットをpushできません。" +
        "通常はチェックアウトがdetached HEAD状態（ブランチではなく固定の" +
        `ref/SHAをチェックアウトした状態）であることが原因です: ${branchCheck.stderr.trim() || "（エラー出力なし）"}`,
    );
  }
  return branchCheck.stdout.trim();
}

/**
 * 同期対象のディレクトリをステージし、HEADと差分があればコミットして
 * pushする。新しいコミットのSHAを返す。コミットするものが何もなければ
 * nullを返す。
 */
export async function commitAndPush(
  options: CommitOptions & { branch: string },
): Promise<string | null> {
  const { branch } = options;

  assertSuccess(await git(["add", "--", options.dir]), "git add");

  const diff = await git(["diff", "--cached", "--quiet"]);
  if (diff.exitCode === 0) {
    return null;
  }
  if (diff.exitCode !== 1) {
    // 0 = ステージされた差分なし、1 = 差分あり — それ以外の終了コードは
    // 「差分あり」のシグナルではなく実際のgitエラー（インデックス破損など）
    // であり、そのままステージ済みの内容をコミットする処理に流れて
    // はならない。
    assertSuccess(diff, "git diff --cached --quiet");
  }

  // committerのidentityは `git config` で永続的に設定するのではなく、
  // GIT_AUTHOR_*/GIT_COMMITTER_* 環境変数として個別のgit呼び出しに局所的に
  // 渡す。永続的な設定は no-op実行（差分なしで早期returnする実行）でも
  // このチェックアウトの.git/configを書き換えてしまい、同じジョブの
  // 後続ステップがコミットする際にbotのidentityを誤って引き継ぐ原因になる。
  const commitIdentity = identityEnv(options.committerName, options.committerEmail);
  assertSuccess(
    await git(["commit", "-m", options.message], { env: commitIdentity }),
    "git commit",
  );

  // `concurrency` グループ（sync.yml/self-sync.yml）は、このアクションの
  // 実行同士を直列化するだけであり、このアクションがGitHub APIから
  // fetchしている間に無関係なコミット（マージされたPR、他のボット）が
  // 同じブランチに乗ることは防げない。このアクションのコミットのツリーは
  // 常に `options.dir` を完全に再生成したこの実行のスナップショットで
  // あり（差分ではない）、拒否されたpushは最新のtipにrebaseして1回だけ
  // リトライすれば復旧できる — このrebaseは `options.dir` に限定された
  // 変更を再適用するだけでよく、このアクション以外がそのディレクトリに
  // 触れることは想定されていないため、ここで実際にテキスト競合が発生
  // するのは報告に値する本物の異常事態であり、それ以上リトライすべき
  // ものではない。
  //
  // `HEAD:<branch>` という明示的なrefspecを使う: bareの `git push` は
  // upstreamトラッキングの設定に依存するため、（通常のチェックアウトでは
  // 通常自動設定されるが）非標準的なチェックアウトでは上流未設定エラーに
  // なり得る。明示的なrefspecなら上流設定の有無によらず動作する。
  let sha = await currentSha();
  let push = await git(["push", "origin", `HEAD:${branch}`]);
  if (push.exitCode !== 0) {
    if (!looksLikeRejectedPush(push.stderr)) {
      // 拒否（他のコミットが既に存在する）以外の失敗 — 認証エラー、
      // ネットワーク断、upstream未設定など — はfetch+rebaseでは復旧
      // できない。無駄なfetch/rebase/pushを試みて元のエラーを失う前に、
      // pushの本来のエラーで即座に失敗させる。
      throw new Error(`git push に失敗しました（終了コード ${push.exitCode}）: ${push.stderr.trim()}`);
    }

    assertSuccess(await git(["fetch", "origin", branch]), "git fetch");
    // rebaseはこの実行のコミットをoriginの新しいtip上に再適用するために
    // 新しいコミットオブジェクトを作る（committerとしてidentityの解決が
    // 必要）ため、上のcommit呼び出しと同じidentityを渡す。渡さないと
    // 「Committer identity unknown」で失敗し、まさにこの経路が復旧する
    // はずの同時書き込みの競合が、リトライどころか即座の失敗になって
    // しまう。
    const rebase = await git(["rebase", `origin/${branch}`], { env: commitIdentity });
    if (rebase.exitCode !== 0) {
      const abort = await git(["rebase", "--abort"]);
      if (abort.exitCode !== 0) {
        core.warning(`git rebase --abort にも失敗しました: ${abort.stderr.trim()}`);
      }
      throw new Error(
        `git pushが拒否され、origin/${branch} へのrebaseにも失敗しました` +
          `（一時的な競合ではなく、実際の content conflict の可能性があります）: ${rebase.stderr.trim()}`,
      );
    }
    sha = await currentSha();
    push = await git(["push", "origin", `HEAD:${branch}`]);
  }

  // `sha` を既に取得した後で最後にアサートする: `git push` は参照元の
  // ローカルHEADを動かさないため、これ以降の処理が失敗しても、成功した
  // pushがなかったことにされることはない。
  assertSuccess(push, "git push");
  return sha;
}
