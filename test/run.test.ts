import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RunDependencies } from "../src/run";
import { run } from "../src/run";
import type { IssueRecord } from "../src/types";

// @actions/core reads inputs from INPUT_<NAME> env vars and
// @actions/github reads the repo from GITHUB_REPOSITORY — set these
// directly rather than mocking the modules, so this test doesn't depend on
// module-mock semantics (which apply process-wide in Bun's test runner and
// would otherwise leak into other test files).
const ENV_KEYS = ["INPUT_GITHUB-TOKEN", "GITHUB_REPOSITORY"];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env["INPUT_GITHUB-TOKEN"] = "fake-token";
  process.env.GITHUB_REPOSITORY = "owner/repo";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  // @actions/core's setFailed() sets process.exitCode = 1 as a real side
  // effect on the actual process — several tests below deliberately
  // trigger it, so reset it to 0 or the whole `bun test` run exits
  // non-zero even though every assertion passed. (Assigning `undefined`
  // does NOT clear a previously-set process.exitCode — it must be a
  // number.)
  process.exitCode = 0;
});

function makeDeps(overrides: Partial<RunDependencies> = {}): RunDependencies {
  return {
    createOctokit: () => ({}) as never,
    fetchIssues: async () => [] as IssueRecord[],
    syncIssueFiles: async () => ({ written: [], deleted: [] }),
    commitAndPush: async () => null,
    ...overrides,
  };
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
});

describe("run output contract", () => {
  // core.setOutput has no return value and no test-friendly way to read
  // it back without mocking @actions/core itself (which risks the same
  // cross-file leakage module-mocking the local collaborators avoids).
  // Instead, spy on process.stdout.write, since core.setOutput ultimately
  // writes a `::set-output` / GITHUB_OUTPUT-file workflow command through
  // it when no GITHUB_OUTPUT file is configured.
  let written: string[] = [];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    written = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  function outputLines(): string {
    return written.join("");
  }

  it("sets changed=false (not left unset) when nothing changed", async () => {
    await run(makeDeps({ syncIssueFiles: async () => ({ written: [], deleted: [] }) }));
    expect(outputLines()).toContain("changed::false");
  });

  it("sets changed=true and commit-sha when a commit lands", async () => {
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => "abc123",
      }),
    );
    expect(outputLines()).toContain("changed::true");
    expect(outputLines()).toContain("commit-sha::abc123");
  });

  it("sets changed=false when commitAndPush finds nothing actually staged", async () => {
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => null,
      }),
    );
    expect(outputLines()).toContain("changed::false");
    expect(outputLines()).not.toContain("commit-sha::");
  });

  it("sets changed=false (not left unset) when commitAndPush throws", async () => {
    // Regression test: the catch block used to leave `changed` completely
    // unset on any error, so a caller reading the action's output saw an
    // empty string rather than an explicit false on failure.
    await run(
      makeDeps({
        syncIssueFiles: async () => ({ written: ["1.md"], deleted: [] }),
        commitAndPush: async () => {
          throw new Error("git push failed (exit 1): rejected");
        },
      }),
    );
    expect(outputLines()).toContain("changed::false");
    expect(outputLines()).toContain("::error::git push failed");
  });

  it("sets changed=false (not left unset) when fetching issues throws", async () => {
    await run(
      makeDeps({
        fetchIssues: async () => {
          throw new Error("API rate limit exceeded");
        },
      }),
    );
    expect(outputLines()).toContain("changed::false");
    expect(outputLines()).toContain("::error::API rate limit exceeded");
  });
});
