import type { CalldataEncodable } from "genlayer-js/types";

import { writeFoodGuard } from "./client";
import {
  AmbiguousWalletOutcomeError,
  classifyRpcFailure,
  OutcomeUnknownError,
  withStudioNetBackoff,
} from "./rpcResilience";
import { trackTransaction, type TxStageHandler } from "./transactions";

export interface FoodGuardOperation<T> {
  method: string;
  args: CalldataEncodable[];
  value: bigint;
  expectedAccount?: string;
  onStage: TxStageHandler;
  readback: () => Promise<T>;
  matches: (readback: T) => boolean;
}

const reconciliationTimeoutMs = 120_000;

class ReconciliationDeadlineError extends Error {
  constructor() {
    super("FoodGuard reconciliation deadline expired");
    this.name = "ReconciliationDeadlineError";
  }
}

function withReconciliationDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new ReconciliationDeadlineError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ReconciliationDeadlineError());
    }, remainingMs);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function reconcileFoodGuardOperation<T>(
  input: FoodGuardOperation<T>,
  ambiguousCause: unknown,
): Promise<T> {
  input.onStage("RECONCILING");
  const deadline = Date.now() + reconciliationTimeoutMs;

  try {
    const readback = await withStudioNetBackoff(async () => {
      const candidate = await withReconciliationDeadline(
        input.readback(),
        deadline,
      );
      if (!input.matches(candidate)) {
        throw new AmbiguousWalletOutcomeError(ambiguousCause);
      }
      return candidate;
    }, {
      deadline,
      maxRetries: Number.MAX_SAFE_INTEGER,
    });
    input.onStage("READBACK_CONFIRMED");
    return readback;
  } catch {
    input.onStage("OUTCOME_UNKNOWN");
    throw new OutcomeUnknownError();
  }
}

export async function executeFoodGuardOperation<T>(
  input: FoodGuardOperation<T>,
): Promise<T> {
  let trackedReadback: T;
  try {
    const hash = await writeFoodGuard(
      input.method,
      input.args,
      input.value,
      input.onStage,
      input.expectedAccount,
    );
    trackedReadback = await trackTransaction<T>(hash, input.onStage);
  } catch (error: unknown) {
    if (classifyRpcFailure(error).kind === "DEFINITIVE") throw error;
    return reconcileFoodGuardOperation(input, error);
  }

  if (input.matches(trackedReadback)) return trackedReadback;
  return reconcileFoodGuardOperation(
    input,
    new TypeError("Failed to fetch a matching authoritative readback"),
  );
}
