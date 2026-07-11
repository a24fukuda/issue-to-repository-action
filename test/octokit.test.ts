import { describe, expect, it } from "bun:test";
import { logAndRetry, MAX_RATE_LIMIT_RETRIES } from "../src/octokit";
import type { EndpointDefaults } from "@octokit/types";

const options = { method: "GET", url: "https://api.github.com/repos/owner/repo/issues" } as Required<EndpointDefaults>;

describe("logAndRetry", () => {
  it("returns true while under the retry cap", () => {
    for (let retryCount = 0; retryCount < MAX_RATE_LIMIT_RETRIES; retryCount++) {
      expect(logAndRetry("レート制限", 1, options, retryCount)).toBe(true);
    }
  });

  it("returns false once the retry cap is reached", () => {
    // 回帰テスト: 以前は上限到達時も「リトライします」とログしてから
    // falseを返しており、ログとreturn値が矛盾していた。ここではreturn値
    // （実際にリトライするかどうかを決める唯一の契約）のみを検証する。
    expect(logAndRetry("レート制限", 1, options, MAX_RATE_LIMIT_RETRIES)).toBe(false);
    expect(logAndRetry("レート制限", 1, options, MAX_RATE_LIMIT_RETRIES + 1)).toBe(false);
  });
});
