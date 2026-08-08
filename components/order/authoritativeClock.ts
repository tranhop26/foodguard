export interface AuthoritativeClock {
  sampledAtMonotonicMs: number;
  seconds: bigint;
}

export const MAX_CHAIN_SAMPLE_AGE_MS = 20_000;
// Leaves one full UTC day for evidence expiry while staying inside ISO year 9999.
export const MAX_AUTHORITATIVE_CHAIN_SECONDS = 253_402_214_399n;

export type MonotonicNow = () => number | null;

export function monotonicNow(): number | null {
  if (typeof performance === "undefined" || typeof performance.now !== "function") return null;
  const value = performance.now();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function sampleAuthoritativeClock(
  seconds: bigint,
  now: MonotonicNow = monotonicNow,
  previous: AuthoritativeClock | null = null,
): AuthoritativeClock | null {
  if (
    seconds < 0n ||
    seconds > MAX_AUTHORITATIVE_CHAIN_SECONDS ||
    (previous !== null && (
      previous.seconds < 0n ||
      previous.seconds > MAX_AUTHORITATIVE_CHAIN_SECONDS ||
      !Number.isFinite(previous.sampledAtMonotonicMs) ||
      previous.sampledAtMonotonicMs < 0 ||
      seconds < previous.seconds
    ))
  ) return null;
  if (previous !== null && seconds === previous.seconds) return previous;
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
    currentMonotonicMs < clock.sampledAtMonotonicMs ||
    clock.seconds < 0n ||
    clock.seconds > MAX_AUTHORITATIVE_CHAIN_SECONDS
  ) return null;
  const elapsedMs = Math.floor(currentMonotonicMs - clock.sampledAtMonotonicMs);
  if (elapsedMs > MAX_CHAIN_SAMPLE_AGE_MS) return null;
  const current = clock.seconds * 1_000n + BigInt(elapsedMs);
  return current / 1_000n > MAX_AUTHORITATIVE_CHAIN_SECONDS ? null : current;
}

export function authoritativeNowSeconds(clock: AuthoritativeClock | null | undefined): bigint | null {
  const milliseconds = authoritativeNowMs(clock);
  return milliseconds === null ? null : milliseconds / 1_000n;
}
