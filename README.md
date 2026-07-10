# issue-to-repository-action

Syncs GitHub Issues (with their comment history) into version-controlled
Markdown files inside your repository, so the history of *why* a change was
made survives independently of GitHub.

## Design

- **Batch, not real-time.** On every run, all issues are re-fetched from the
  API and the `issues/` directory is fully regenerated in a single commit.
  There's no per-event incremental commit, so there's no need to reconcile
  multiple *simultaneous runs of this action* writing to the same branch —
  a `concurrency` group (in `sync.yml`/`self-sync.yml`) serializes those. A
  concurrency group can't stop an unrelated commit (a merged PR, another
  bot) landing on the same branch while this run is mid-fetch, though, so
  the sync commit still does one fetch-and-rebase retry on a rejected push
  before giving up. If a run still fails outright (a genuine content
  conflict, or a caller using the direct-action path with no concurrency
  group of its own), nothing retries it automatically — `issues/` stays
  stale until the next scheduled or event-triggered run.
- **One file per issue**, named `issues/<number>.md`.
- **Open/closed is a frontmatter field** (`state: open` / `state: closed`),
  not a directory split — closing an issue never renames/moves its file, so
  history stays attached to one path.
- **Comments are appended** under a `## Comments` section, since they're
  part of the recorded history too.
- **GitHub-specific metadata** (labels, assignees, milestone, author, URL,
  timestamps) is captured in frontmatter so nothing is lost if you ever
  migrate away from GitHub.

## Usage

### Recommended: reusable workflow

Add this to the repository whose issues you want synced. Pin `@v1` (or a
specific `@vX.Y.Z` release) rather than `@main` for stability.

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

The reusable workflow checks out your repository, runs the sync action, and
pushes a commit when `issues/` changes. It also applies its own
`concurrency` group, so overlapping issue events and the daily schedule
never race each other.

### Alternative: call the action directly

Useful if you want to fold the sync step into a larger workflow.

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

This path has no built-in concurrency protection (a JS action can't declare a
`concurrency:` block itself) — add one to your own workflow if it can be
triggered by overlapping events.

## Inputs

| Input             | Default                                                | Description                                       |
| ------------------|---------------------------------------------------------|-----------------------------------------------------|
| `github-token`    | `${{ github.token }}`                                  | Token used to read issues/comments and push commits |
| `issues-dir`      | `issues`                                                | Directory to write issue files into                 |
| `commit-message`  | `chore: sync issues`                                    | Commit message when files change                    |
| `committer-name`  | `github-actions[bot]`                                   | Commit author name                                   |
| `committer-email` | `41898282+github-actions[bot]@users.noreply.github.com` | Commit author email                                  |

## File format

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

## Comments

### @carol — 2026-01-03T00:00:00Z

Same here.
```

Issues deleted upstream (or removed by GitHub) have their file deleted on
the next sync, since the directory is always regenerated from the current
set of issues. Deletion is scoped to files this action wrote on a prior
run — tracked in `issues/.manifest.json`, which is committed alongside the
issue files — so a pre-existing file that happens to be named like an
issue (e.g. `issues-dir` pointed at a directory you don't fully control)
is never touched.

## Releasing

Tag a commit with both an immutable version (`vX.Y.Z`) and a moving major
tag (`v1`) pointing at the same commit, since `.github/workflows/sync.yml`
references `a24fukuda/issue-to-repository-action@v1` internally:

```sh
git tag v1.0.0
git tag -f v1
git push origin v1.0.0
git push -f origin v1
```

`dist/index.js` is committed (it's what `runs.main` in `action.yml`
executes) and CI (`.github/workflows/ci.yml`) fails a PR if it's out of
date with `src/`. Run `bun run build` after any source change and commit
the result.

## Development

The toolchain (dependency install, type checking, tests, bundling) runs on
[Bun](https://bun.sh). The action itself still executes on Node.js at
runtime (`runs.using: node20` in `action.yml`) — `bun build` targets
Node (`--target=node --format=cjs`), so `dist/index.js` is plain
Node-compatible CommonJS, not a Bun-only bundle.

```sh
bun install
bun run typecheck
bun test
bun run build   # regenerates dist/index.js
```

CI pins an exact `bun-version` (`.github/workflows/ci.yml`) rather than
`latest`, since `bun build`'s minified output isn't guaranteed byte-stable
across Bun releases and the CI "dist/ is up to date" check compares
`dist/index.js` byte-for-byte. If you bump the pinned version, rebuild and
recommit `dist/index.js` in the same change.
