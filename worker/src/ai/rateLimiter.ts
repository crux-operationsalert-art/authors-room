/**
 * Project-level limiter. Gemini limits are per PROJECT and per model, so one
 * limiter instance is shared by every key and every team in the worker.
 * RPM and TPM use a sliding 60-second window; RPD uses the count for the
 * current Pacific day (Google resets requests-per-day at midnight Pacific).
 */
export interface Limits { rpm?: number; tpm?: number; rpd?: number }

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };

interface Entry { at: number; tokens: number }

export type Decision =
  | { ok: true }
  | { ok: false; reason: 'rpm' | 'tpm' | 'rpd'; waitMs: number };

export class ProjectRateLimiter {
  private windows = new Map<string, Entry[]>();
  private daily = new Map<string, { day: string; count: number }>();

  constructor(private limits: Record<string, Limits>, private clock: Clock = systemClock) {}

  setLimits(limits: Record<string, Limits>) { this.limits = limits; }

  /** Seed today's request count from the ledger at start-up. */
  seedDaily(modelId: string, count: number) {
    this.daily.set(modelId, { day: pacificDay(this.clock.now()), count });
  }

  /** Check whether a call with `estTokens` input tokens may go now; reserve it if so. */
  tryAcquire(modelId: string, estTokens: number): Decision {
    const lim = this.limits[modelId] ?? {};
    const now = this.clock.now();
    const win = (this.windows.get(modelId) ?? []).filter(e => now - e.at < 60_000);
    this.windows.set(modelId, win);

    const d = this.daily.get(modelId);
    const today = pacificDay(now);
    const dayCount = d && d.day === today ? d.count : 0;
    if (lim.rpd && dayCount >= lim.rpd) {
      return { ok: false, reason: 'rpd', waitMs: msUntilPacificMidnight(now) };
    }
    if (lim.rpm && win.length >= lim.rpm) {
      return { ok: false, reason: 'rpm', waitMs: 60_000 - (now - win[0].at) };
    }
    const used = win.reduce((s, e) => s + e.tokens, 0);
    if (lim.tpm && used + estTokens > lim.tpm && win.length > 0) {
      return { ok: false, reason: 'tpm', waitMs: 60_000 - (now - win[0].at) };
    }
    win.push({ at: now, tokens: estTokens });
    this.daily.set(modelId, { day: today, count: dayCount + 1 });
    return { ok: true };
  }

  /** Correct the reservation with the real token count after the call. */
  settle(modelId: string, estTokens: number, actualTokens: number) {
    const win = this.windows.get(modelId);
    if (!win) return;
    for (let i = win.length - 1; i >= 0; i--) {
      if (win[i].tokens === estTokens) { win[i].tokens = actualTokens; return; }
    }
  }
}

export function pacificDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ms));
}

export function msUntilPacificMidnight(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const elapsed = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;
  return Math.max(1000, 86_400_000 - elapsed);
}

/** Rough token estimate before a call (about 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
