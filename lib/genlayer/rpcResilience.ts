export type RpcFailureClassification =
  | { kind: "RATE_LIMIT"; retryAfterMs?: number }
  | { kind: "TRANSIENT" }
  | { kind: "DEFINITIVE" };

export interface StudioNetBackoffOptions {
  deadline: number;
  maxRetries?: number;
}

export class StudioNetRateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly cause: unknown;

  constructor(retryAfterMs: number, cause?: unknown) {
    super(`StudioNet rate limit requires waiting ${retryAfterMs}ms`);
    this.name = "StudioNetRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
}

export class AmbiguousWalletOutcomeError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "The wallet request may have reached StudioNet; reconcile contract state before retrying",
    );
    this.name = "AmbiguousWalletOutcomeError";
    this.cause = cause;
  }
}

export class OutcomeUnknownError extends Error {
  constructor() {
    super(
      "The StudioNet outcome is still unknown; do not resubmit before checking contract state",
    );
    this.name = "OutcomeUnknownError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampRetryDelay(delayMs: number): number {
  return Math.min(60_000, Math.max(1_000, delayMs));
}

function structuredRetryDelay(value: Record<string, unknown>): number | undefined {
  if (value.code !== -32029 || !isRecord(value.data)) return undefined;
  const seconds = value.data.retry_after_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return clampRetryDelay(seconds * 1_000);
}

function relatedFailureValues(error: unknown): unknown[] {
  const values: unknown[] = [];
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const value = pending.shift();
    if (value === undefined || value === null || visited.has(value)) continue;
    visited.add(value);
    values.push(value);

    if (isRecord(value)) {
      pending.push(value.error, value.cause, value.details);
    }
  }

  return values;
}

function failureText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!isRecord(value)) return [];
  return [value.name, value.message].filter(
    (entry): entry is string => typeof entry === "string",
  );
}

const definitiveProviderCodes = new Set([4001, 4100, 4200, 4900, 4901, 4902]);
const transientTransportPattern =
  /failed to fetch|fetch failed|network request failed|networkerror/i;

export function classifyRpcFailure(error: unknown): RpcFailureClassification {
  const values = relatedFailureValues(error);

  for (const value of values) {
    if (isRecord(value) && value.code === -32029) {
      return {
        kind: "RATE_LIMIT",
        ...(() => {
          const retryAfterMs = structuredRetryDelay(value);
          return retryAfterMs === undefined ? {} : { retryAfterMs };
        })(),
      };
    }
  }

  for (const value of values) {
    if (
      (isRecord(value) &&
        typeof value.code === "number" &&
        definitiveProviderCodes.has(value.code)) ||
      failureText(value).some((text) => /\bUserError\b/.test(text))
    ) {
      return { kind: "DEFINITIVE" };
    }
  }

  if (
    values.some((value) =>
      failureText(value).some((text) => transientTransportPattern.test(text)),
    )
  ) {
    return { kind: "TRANSIENT" };
  }

  return { kind: "DEFINITIVE" };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

const transientRetryDelays = [2_000, 4_000, 8_000] as const;

export async function withStudioNetBackoff<T>(
  operation: () => Promise<T>,
  options: StudioNetBackoffOptions,
): Promise<T> {
  const maxRetries = options.maxRetries ?? transientRetryDelays.length;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a nonnegative integer");
  }
  if (!Number.isFinite(options.deadline)) {
    throw new RangeError("deadline must be finite");
  }

  for (let retry = 0; ; retry += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      const classification = classifyRpcFailure(error);
      if (classification.kind === "DEFINITIVE") throw error;

      const delayMs =
        classification.kind === "RATE_LIMIT" &&
        classification.retryAfterMs !== undefined
          ? classification.retryAfterMs
          : transientRetryDelays[Math.min(retry, transientRetryDelays.length - 1)];
      if (retry >= maxRetries || delayMs >= options.deadline - Date.now()) {
        if (classification.kind === "RATE_LIMIT") {
          throw new StudioNetRateLimitError(delayMs, error);
        }
        throw error;
      }

      await wait(delayMs);
    }
  }
}

const singleFlightLeaseMs = 30_000;

interface InFlightRead {
  expiresAt: number;
  promise: Promise<unknown>;
}

const inFlightReads = new Map<string, InFlightRead>();

export function singleFlight<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = inFlightReads.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.promise as Promise<T>;
  }
  if (existing) inFlightReads.delete(key);

  let operationPromise: Promise<T>;
  try {
    operationPromise = Promise.resolve(operation());
  } catch (error: unknown) {
    operationPromise = Promise.reject(error);
  }
  const entry = {} as InFlightRead;
  const sharedPromise = operationPromise.finally(() => {
    if (inFlightReads.get(key) === entry) {
      inFlightReads.delete(key);
    }
  });
  entry.promise = sharedPromise;
  entry.expiresAt = Date.now() + singleFlightLeaseMs;
  inFlightReads.set(key, entry);
  return sharedPromise;
}
