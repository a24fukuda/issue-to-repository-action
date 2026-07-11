/**
 * `items` に対して `fn` を実行する。同時に実行中の呼び出しは最大 `limit`
 * 件までとし、返される配列では入力の順序を保持する。
 *
 * いずれかの呼び出しが失敗した場合、他のワーカーは現在処理中の呼び出しを
 * 終えたら新規のアイテムに着手せず停止する（既に開始済みの呼び出しを
 * キャンセルすることはできないが、これから始まる呼び出しは防げる）。
 * こうしないと、呼び出し元が最初のエラーを受け取った後もバックグラウンドで
 * 残り全アイテムへの呼び出しが続き、レート制限を無駄に消費し続ける。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let aborted = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!aborted && nextIndex < items.length) {
      const current = nextIndex++;
      try {
        results[current] = await fn(items[current], current);
      } catch (error) {
        if (!aborted) {
          aborted = true;
          firstError = error;
        }
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (aborted) throw firstError;

  return results;
}
