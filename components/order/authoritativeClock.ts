export interface AuthoritativeClock {
  sampledAtMs: number;
  seconds: bigint;
}

export function authoritativeNowMs(clock: AuthoritativeClock | null | undefined): bigint | null {
  if (clock === null) return null;
  if (clock === undefined) return BigInt(Date.now());
  const elapsedMs = Math.max(0, Date.now() - clock.sampledAtMs);
  return clock.seconds * 1_000n + BigInt(elapsedMs);
}

export function authoritativeNowSeconds(clock: AuthoritativeClock | null | undefined): bigint | null {
  const milliseconds = authoritativeNowMs(clock);
  return milliseconds === null ? null : milliseconds / 1_000n;
}
