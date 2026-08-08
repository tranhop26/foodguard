export interface AuthoritativeClock {
  sampledAtMonotonicMs: number;
  seconds: bigint;
}

export const MAX_CHAIN_SAMPLE_AGE_MS = 20_000;

export type MonotonicNow = () => number | null;

export function monotonicNow(): number | null {
  if (typeof performance === "undefined" || typeof performance.now !== "function") return null;
  const value = performance.now();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function sampleAuthoritativeClock(
  seconds: bigint,
  now: MonotonicNow = monotonicNow,
): AuthoritativeClock | null {
  if (seconds < 0n) return null;
  const sampledAtMonotonicMs = now();
  return sampledAtMonotonicMs === null
    ? null
    : { sampledAtMonotonicMs, seconds };
}

export function authoritativeNowMs(
  clock: AuthoritativeClock | null | undefined,
  now: MonotonicNow = monotonicNow,
): bigint | null {
  if (!clock) return null;
  const currentMonotonicMs = now();
  if (
    currentMonotonicMs === null ||
    !Number.isFinite(clock.sampledAtMonotonicMs) ||
    clock.sampledAtMonotonicMs < 0 ||
    currentMonotonicMs < clock.sampledAtMonotonicMs
  ) return null;
  const elapsedMs = Math.floor(currentMonotonicMs - clock.sampledAtMonotonicMs);
  if (elapsedMs > MAX_CHAIN_SAMPLE_AGE_MS) return null;
  return clock.seconds * 1_000n + BigInt(elapsedMs);
}

export function authoritativeNowSeconds(clock: AuthoritativeClock | null | undefined): bigint | null {
  const milliseconds = authoritativeNowMs(clock);
  return milliseconds === null ? null : milliseconds / 1_000n;
}
