import { describe, expect, it } from "bun:test";
import { mapWithConcurrency } from "../src/concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const delays = [30, 10, 20, 0];
    const result = await mapWithConcurrency(delays, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("actually runs calls concurrently, not sequentially", async () => {
    // 回帰テスト: 上のテストは上限のみをアサートするため、逐次実装
    // （実質 limit=1）でも通ってしまう。並行性が本当に発生していることを
    // 下限で確認する。
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item;
    });

    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("handles an empty input array", async () => {
    const result = await mapWithConcurrency([], 4, async (item) => item);
    expect(result).toEqual([]);
  });

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 5, async (item) => {
      seen.push(item);
      return item;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("propagates a rejection and stops scheduling new work", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const calls: number[] = [];
    const failure = new Error("item 2 failed");

    const promise = mapWithConcurrency(items, 2, async (item) => {
      calls.push(item);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (item === 2) throw failure;
      return item;
    });

    await expect(promise).rejects.toBe(failure);
    // 中断がなければ20件すべて呼ばれるはず。早期中断により大幅に少ないことを確認する
    // （タイミング依存だが、失敗直後に既に開始済みだった呼び出しが数件残る余地は許容する）。
    expect(calls.length).toBeLessThan(items.length);
  });
});
