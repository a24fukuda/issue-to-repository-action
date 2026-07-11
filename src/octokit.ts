import * as core from "@actions/core";
import * as github from "@actions/github";
import { throttling } from "@octokit/plugin-throttling";
import type { ThrottlingOptions } from "@octokit/plugin-throttling";
import type { EndpointDefaults } from "@octokit/types";

export const MAX_RATE_LIMIT_RETRIES = 3;

export function logAndRetry(
  kind: string,
  retryAfter: number,
  options: Required<EndpointDefaults>,
  retryCount: number,
): boolean {
  const willRetry = retryCount < MAX_RATE_LIMIT_RETRIES;
  if (willRetry) {
    core.warning(
      `${kind}に達しました: ${options.method} ${options.url}。${retryAfter}秒後にリトライします（${retryCount + 1}回目の試行）。`,
    );
  } else {
    core.warning(
      `${kind}に達しました: ${options.method} ${options.url}。リトライ上限（${MAX_RATE_LIMIT_RETRIES}回）に達したため中断します。`,
    );
  }
  return willRetry;
}

const throttle: ThrottlingOptions = {
  onRateLimit: (retryAfter, options, _octokit, retryCount) =>
    logAndRetry("レート制限", retryAfter, options, retryCount),
  onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) =>
    logAndRetry("セカンダリレート制限", retryAfter, options, retryCount),
};

export function createOctokit(token: string): ReturnType<typeof github.getOctokit> {
  return github.getOctokit(token, { throttle }, throttling);
}
