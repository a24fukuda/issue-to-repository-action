import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RunDependencies } from "../src/run";
import { run } from "../src/run";
import type { IssueRecord } from "../src/types";

// @actions/core reads inputs from INPUT_<NAME> env vars, reads the repo
// from GITHUB_REPOSITORY, and writes outputs by appending to the file at
// GITHUB_OUTPUT (always set by the real Actions runner) — set these
// directly rather than mocking the modules, so this test doesn't depend on
// module-mock semantics (which apply process-wide in Bun's test runner and
// would otherwise leak into other test files).
const ENV_KEYS = ["INPUT_GITHUB-TOKEN", "GITHUB_REPOSITORY", "GITHUB_OUTPUT"];
const originalEnv: Record<string, string | undefined> = {};
let outputFile: string;

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env["INPUT_GITHUB-TOKEN"] = "fake-token";
  process.env.GITHUB_REPOSITORY = "owner/repo";

  outputFile = path.join(mkdtempSync(path.join(os.tmpdir(), "run-test-")), "outputs");
  writeFileSync(outputFile, "");
  process.env.GITHUB_OUTPUT = outputFile;
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
    getCurrentBranch: async () => "main",
    fetchIssues: async () => [] as IssueRecord[],
    syncIssueFiles: async () => ({ written: [], deleted: [] }),
    commitAndPush: async () => null,
    setOutput: core.setOutput,
    ...overrides,
  };
}

/**
 * Parses the GITHUB_OUTPUT file's `key<<delimiter\nvalue\ndelimiter` format
 * (what @actions/core's setOutput actually writes) into a plain object.
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
    // Regression test: setOutput appends to GITHUB_OUTPUT, and the catch
    // block used to unconditionally set changed=false on any error. If the
    // commit-sha setOutput call failed *after* changed=true had already
    // been written (a real push landed), that would silently downgrade an
    // accurate "true" to an inaccurate "false".
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
    // setFailed still runs — the output-channel failure is itself a real
    // problem worth surfacing, even though `changed` stays accurate.
    expect(process.exitCode).toBe(1);
  });
});
