import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RunDependencies } from "../src/run";
import { run } from "../src/run";
import type { IssueRecord } from "../src/types";

// @actions/core は INPUT_<NAME> 環境変数から入力を読み取り、
// GITHUB_REPOSITORY からリポジトリを読み取り、GITHUB_OUTPUT
// （実際のActionsランナーでは常に設定されている）のファイルへの追記で
// 出力を書き込む — モジュールをモックするのではなくこれらを直接設定する
// ことで、このテストがモジュールモックのセマンティクス（Bunのテスト
// ランナーではプロセス全体に適用され、他の無関係なテストファイルにも
// 漏れ出してしまう）に依存しないようにしている。
const ENV_KEYS = [
  "INPUT_GITHUB-TOKEN",
  "INPUT_ISSUES-DIR",
  "INPUT_COMMIT-MESSAGE",
  "INPUT_COMMITTER-NAME",
  "INPUT_COMMITTER-EMAIL",
  "GITHUB_REPOSITORY",
  "GITHUB_OUTPUT",
];
const originalEnv: Record<string, string | undefined> = {};
let outputFile: string;
let originalCwd: string;

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env["INPUT_GITHUB-TOKEN"] = "fake-token";
  process.env.GITHUB_REPOSITORY = "owner/repo";
  originalCwd = process.cwd();

  outputFile = path.join(mkdtempSync(path.join(os.tmpdir(), "run-test-")), "outputs");
  writeFileSync(outputFile, "");
  process.env.GITHUB_OUTPUT = outputFile;
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  // @actions/core の setFailed() は実際のプロセスに対する本物の副作用
  // として process.exitCode = 1 を設定する — 以下のいくつかのテストは
  // 意図的にこれをトリガーするため、リセットして0に戻さないと、すべての
  // アサーションが通過していても `bun test` の実行全体が非ゼロで
  // 終了してしまう。（`undefined` を代入しても、既に設定された
  // process.exitCode はクリアされない — 数値を設定する必要がある。）
  process.exitCode = 0;
});

function makeDeps(overrides: Partial<RunDependencies> = {}): RunDependencies {
  return {
    createOctokit: () => ({}) as never,
    getCurrentBranch: async () => "main",
    fetchIssues: async () => [] as IssueRecord[],
    syncIssueFiles: async () => ({ written: [], deleted: [] }),
    commitAndPush: async () => null,
    setOutput: core.setOutput,
    ...overrides,
  };
}

/**
 * GITHUB_OUTPUTファイルの `key<<delimiter\nvalue\ndelimiter` 形式
 * （@actions/core の setOutput が実際に書き込む形式）をプレーンな
 * オブジェクトにパースする。
 */
function readOutputs(): Record<string, string> {
  const lines = readFileSync(outputFile, "utf8").split("\n");
  const values: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const match = /^(.+)<<(ghadelimiter_.+)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, delimiter] = match;
    const valueLines: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i]);
      i++;
    }
    values[key] = valueLines.join("\n");
  }
  return values;
}

describe("run", () => {
  it("never calls commitAndPush when nothing changed", async () => {
    let commitAndPushCalled = false;
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: [], deleted: [] }),
        commitAndPush: async () => {
          commitAndPushCalled = true;
          return null;
        },
      }),
    );
    expect(commitAndPushCalled).toBe(false);
  });

  it("calls commitAndPush when there are file changes", async () => {
    let commitAndPushCalled = false;
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => {
          commitAndPushCalled = true;
          return "abc123";
        },
      }),
    );
    expect(commitAndPushCalled).toBe(true);
  });

  it("checks the current branch before fetching issues, to fail fast on a bad checkout", async () => {
    let fetchIssuesCalled = false;
    await run(
      makeDeps({
        getCurrentBranch: async () => {
          throw new Error("detached HEAD");
        },
        fetchIssues: async () => {
          fetchIssuesCalled = true;
          return [];
        },
      }),
    );
    expect(fetchIssuesCalled).toBe(false);
  });

  it("forwards issues-dir, committer fields, commit message, and branch to the injected dependencies", async () => {
    // 回帰テスト: 依存関数への引数を一切アサートしていなかったため、
    // 例えば issues-dir をハードコードしていてもテストがグリーンのまま
    // だった。
    process.env["INPUT_ISSUES-DIR"] = "custom-dir";
    process.env["INPUT_COMMIT-MESSAGE"] = "custom message";
    process.env["INPUT_COMMITTER-NAME"] = "custom-name";
    process.env["INPUT_COMMITTER-EMAIL"] = "custom@example.com";

    let syncDirArg: string | undefined;
    let commitOptionsArg: unknown;
    await run(
      makeDeps({
        getCurrentBranch: async () => "custom-branch",
        syncIssueFiles: async (dir) => {
          syncDirArg = dir;
          return { written: ["1.md"], deleted: [] };
        },
        commitAndPush: async (options) => {
          commitOptionsArg = options;
          return "abc123";
        },
      }),
    );

    expect(syncDirArg).toBe("custom-dir");
    expect(commitOptionsArg).toMatchObject({
      dir: "custom-dir",
      message: "custom message",
      committerName: "custom-name",
      committerEmail: "custom@example.com",
      branch: "custom-branch",
    });
  });
});

describe("issues-dir validation", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "run-issues-dir-"));
    process.chdir(tmpRoot);
  });

  it("rejects a path that escapes the checkout root, before checking the branch or fetching issues", async () => {
    process.env["INPUT_ISSUES-DIR"] = "../outside";
    let branchCheckCalled = false;
    let fetchIssuesCalled = false;
    await run(
      makeDeps({
        getCurrentBranch: async () => {
          branchCheckCalled = true;
          return "main";
        },
        fetchIssues: async () => {
          fetchIssuesCalled = true;
          return [];
        },
      }),
    );
    expect(branchCheckCalled).toBe(false);
    expect(fetchIssuesCalled).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("rejects an absolute path outside the checkout root", async () => {
    process.env["INPUT_ISSUES-DIR"] = path.join(os.tmpdir(), "somewhere-else");
    await run(makeDeps());
    expect(process.exitCode).toBe(1);
    expect(readOutputs().changed).toBe("false");
  });

  it("rejects the checkout root itself ('.')", async () => {
    // "." を許すと `git add -- .` が作業ツリー全体（他のステップが残した
    // 無関係な変更まで含む）をステージしてしまう。
    process.env["INPUT_ISSUES-DIR"] = ".";
    await run(makeDeps());
    expect(process.exitCode).toBe(1);
    expect(readOutputs().changed).toBe("false");
  });

  it("rejects issues-dir when it is a symlink pointing outside the checkout root", async () => {
    // 回帰テスト: レキシカルな検証（path.resolve/path.relative）だけでは
    // シンボリックリンクを辿らないため、issues-dir自体がチェックアウト外を
    // 指すシンボリックリンクであるケースを見逃していた。
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "run-issues-dir-outside-"));
    symlinkSync(outsideDir, path.join(tmpRoot, "issues"));
    process.env["INPUT_ISSUES-DIR"] = "issues";

    let branchCheckCalled = false;
    await run(
      makeDeps({
        getCurrentBranch: async () => {
          branchCheckCalled = true;
          return "main";
        },
      }),
    );
    expect(branchCheckCalled).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("accepts a normal relative subdirectory", async () => {
    process.env["INPUT_ISSUES-DIR"] = "issues";
    let fetchIssuesCalled = false;
    await run(
      makeDeps({
        fetchIssues: async () => {
          fetchIssuesCalled = true;
          return [];
        },
      }),
    );
    expect(fetchIssuesCalled).toBe(true);
  });
});

describe("run output contract", () => {
  it("sets changed=false (not left unset) when nothing changed", async () => {
    await run(makeDeps({ syncIssueFiles: async () => ({ written: [], deleted: [] }) }));
    expect(readOutputs().changed).toBe("false");
  });

  it("sets changed=true and commit-sha when a commit lands", async () => {
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => "abc123",
      }),
    );
    const outputs = readOutputs();
    expect(outputs.changed).toBe("true");
    expect(outputs["commit-sha"]).toBe("abc123");
  });

  it("sets changed=false when commitAndPush finds nothing actually staged", async () => {
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => null,
      }),
    );
    const outputs = readOutputs();
    expect(outputs.changed).toBe("false");
    expect(outputs["commit-sha"]).toBeUndefined();
  });

  it("sets changed=false (not left unset) when commitAndPush throws", async () => {
    // 回帰テスト: 以前のcatchブロックは、どんなエラーが起きても
    // `changed` を完全に未設定のままにしていたため、このアクションの
    // 出力を読む呼び出し元は、失敗時に明示的なfalseではなく空文字列を
    // 見ることになっていた。
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => {
          throw new Error("git push failed (exit 1): rejected");
        },
      }),
    );
    expect(readOutputs().changed).toBe("false");
    expect(process.exitCode).toBe(1);
  });

  it("sets changed=false (not left unset) when fetching issues throws", async () => {
    await run(
      makeDeps({
        fetchIssues: async () => {
          throw new Error("API rate limit exceeded");
        },
      }),
    );
    expect(readOutputs().changed).toBe("false");
    expect(process.exitCode).toBe(1);
  });

  it("does not downgrade changed=true to false if a later output write fails", async () => {
    // 回帰テスト: setOutputはGITHUB_OUTPUTに追記する方式であり、以前の
    // catchブロックはどんなエラーでも無条件に changed=false を
    // 設定していた。changed=true が既に書き込まれた*後*（実際にpushが
    // 成功していた）に commit-sha の setOutput 呼び出しが失敗した場合、
    // 正確な "true" が黙って不正確な "false" に格下げされてしまっていた。
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => "abc123",
        setOutput: (name, value) => {
          if (name === "commit-sha") {
            throw new Error("simulated output-channel failure");
          }
          core.setOutput(name, value);
        },
      }),
    );

    expect(readOutputs().changed).toBe("true");
    // setFailedはそれでも実行される — `changed` は正確な値のままだが、
    // 出力チャネル自体の失敗も報告に値する実際の問題である。
    expect(process.exitCode).toBe(1);
  });
});
