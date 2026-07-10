import * as core from "@actions/core";
import * as github from "@actions/github";
import { throttling } from "@octokit/plugin-throttling";
import type { ThrottlingOptions } from "@octokit/plugin-throttling";
import type { EndpointDefaults } from "@octokit/types";

const MAX_RATE_LIMIT_RETRIES = 3;

function logAndRetry(
  kind: string,
  retryAfter: number,
  options: Required<EndpointDefaults>,
  retryCount: number,
): boolean {
  core.warning(
    `${kind} hit for ${options.method} ${options.url}; retrying after ${retryAfter}s (attempt ${retryCount + 1}).`,
  );
  return retryCount < MAX_RATE_LIMIT_RETRIES;
}

const throttle: ThrottlingOptions = {
  onRateLimit: (retryAfter, options, _octokit, retryCount) =>
    logAndRetry("Rate limit", retryAfter, options, retryCount),
  onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) =>
    logAndRetry("Secondary rate limit", retryAfter, options, retryCount),
};

export function createOctokit(token: string): ReturnType<typeof github.getOctokit> {
  return github.getOctokit(token, { throttle }, throttling);
}
