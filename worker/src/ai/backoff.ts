/** Exponential backoff with full jitter: 2s, 4s, 8s, 16s (cap), randomised. */
export function backoffMs(attempt: number, baseMs = 2000, capMs = 16_000, rand: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + rand() * (ceiling / 2));
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
