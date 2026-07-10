import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { commitAndPush, getCurrentBranch } from "../src/git";

// commitAndPush shells out to `git` in the current working directory (no
// explicit cwd is threaded through — that matches how it actually runs in
// a real Actions job, checked out into the runner's workspace). These
// tests exercise it against real, disposable git repositories rather than
// mocking git, since the fetch+rebase retry logic here has been added,
// removed, and re-added across review rounds with no automated coverage
// each time — this is the one part of the codebase that's flip-flopped
// the most, so it's worth verifying against real git rather than trusting
// prose.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function isRebaseInProgress(work: string): boolean {
  return existsSync(path.join(work, ".git", "rebase-merge")) || existsSync(path.join(work, ".git", "rebase-apply"));
}

/** Bare "remote" repo plus a clone of it with an initial commit already pushed. */
function initRemoteAndClone(root: string): { remote: string; work: string } {
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  git(root, "init", "--bare", "-b", "main", remote);
  git(root, "clone", remote, work);
  git(work, "config", "user.email", "init@example.com");
  git(work, "config", "user.name", "init");
  mkdirSync(path.join(work, "issues"), { recursive: true });
  writeFileSync(path.join(work, "issues", "1.md"), "original\n");
  git(work, "add", "issues");
  git(work, "commit", "-m", "init");
  git(work, "push", "origin", "main");
  return { remote, work };
}

const COMMIT_OPTIONS = {
  dir: "issues",
  message: "sync",
  committerName: "sync-bot",
  committerEmail: "sync-bot@example.com",
  branch: "main",
};

describe("commitAndPush (real git)", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "git-integration-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });

  it("commits and pushes when there are staged changes", async () => {
    const { work, remote } = initRemoteAndClone(root);
    writeFileSync(path.join(work, "issues", "2.md"), "new issue\n");

    process.chdir(work);
    const sha = await commitAndPush(COMMIT_OPTIONS);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(remote, "log", "--oneline", "-1", "main")).toContain("sync");
    expect(git(remote, "show", `main:issues/2.md`)).toBe("new issue\n");
  });

  it("returns null and pushes nothing when the directory already matches HEAD", async () => {
    const { work, remote } = initRemoteAndClone(root);
    const before = git(remote, "rev-parse", "main").trim();

    process.chdir(work);
    const sha = await commitAndPush(COMMIT_OPTIONS);

    expect(sha).toBeNull();
    expect(git(remote, "rev-parse", "main").trim()).toBe(before);
  });

  it("getCurrentBranch throws a clear error on a detached HEAD checkout", async () => {
    const { work } = initRemoteAndClone(root);
    const headSha = git(work, "rev-parse", "HEAD").trim();
    git(work, "checkout", "--detach", headSha);

    process.chdir(work);
    await expect(getCurrentBranch()).rejects.toThrow(/detached HEAD/);
  });

  it("getCurrentBranch resolves the branch name on a normal checkout", async () => {
    const { work } = initRemoteAndClone(root);
    process.chdir(work);
    expect(await getCurrentBranch()).toBe("main");
  });

  it("recovers via rebase when the push is rejected by an unrelated commit", async () => {
    const { remote, work } = initRemoteAndClone(root);
    const other = path.join(root, "other");
    git(root, "clone", remote, other);
    git(other, "config", "user.email", "other@example.com");
    git(other, "config", "user.name", "other");
    writeFileSync(path.join(other, "unrelated.md"), "from another writer\n");
    git(other, "add", "unrelated.md");
    git(other, "commit", "-m", "unrelated commit");
    git(other, "push", "origin", "main");

    writeFileSync(path.join(work, "issues", "2.md"), "new issue\n");
    process.chdir(work);
    const sha = await commitAndPush(COMMIT_OPTIONS);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Both the unrelated writer's commit and this run's commit must be present.
    const log = git(remote, "log", "--oneline", "main");
    expect(log).toContain("unrelated commit");
    expect(log).toContain("sync");
    expect(git(remote, "show", "main:unrelated.md")).toBe("from another writer\n");
    expect(git(remote, "show", "main:issues/2.md")).toBe("new issue\n");
  });

  it("aborts cleanly and throws on a genuine content conflict, leaving no rebase in progress", async () => {
    const { remote, work } = initRemoteAndClone(root);
    const other = path.join(root, "other");
    git(root, "clone", remote, other);
    git(other, "config", "user.email", "other@example.com");
    git(other, "config", "user.name", "other");
    writeFileSync(path.join(other, "issues", "1.md"), "changed by another writer\n");
    git(other, "add", "issues");
    git(other, "commit", "-m", "conflicting edit");
    git(other, "push", "origin", "main");

    writeFileSync(path.join(work, "issues", "1.md"), "changed by this run\n");
    process.chdir(work);
    await expect(commitAndPush(COMMIT_OPTIONS)).rejects.toThrow(/content conflict/);

    expect(isRebaseInProgress(work)).toBe(false);
    expect(git(work, "status", "--porcelain=v1", "--branch").split("\n")[0]).toContain("main");
  });
});
