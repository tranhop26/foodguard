import { abi } from "genlayer-js";
import {
  ExecutionResult,
  TransactionStatus,
  type GenLayerTransaction,
  type TransactionHash,
} from "genlayer-js/types";

import { getFoodGuardReadClient, reconcileOrder } from "./client";
import { withStudioNetBackoff } from "./rpcResilience";

export type TxStage =
  | "WALLET_CONFIRMATION"
  | "SUBMITTED"
  | "RECONCILING"
  | "CONSENSUS_PENDING"
  | "CONSENSUS_FAILED"
  | "FINALIZED"
  | "EXECUTION_SUCCESS"
  | "EXECUTION_ERROR"
  | "READBACK_CONFIRMED"
  | "STATE_READBACK_CONFIRMED"
  | "OUTCOME_UNKNOWN";

export type TxStageHandler = (stage: TxStage) => void;

export interface TrackTransactionOptions {
  maxAttempts?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class ConsensusFailedError extends Error {
  readonly retryable = true;

  constructor(status: string) {
    super(`StudioNet consensus failed (${status}); the transaction is safe to retry`);
    this.name = "ConsensusFailedError";
  }
}

export class TransactionExecutionError extends Error {
  constructor(result: string) {
    super(`FoodGuard transaction execution failed (${result})`);
    this.name = "TransactionExecutionError";
  }
}

export class TransactionTrackingTimeoutError extends Error {
  constructor(
    operation: "transaction status" | "order readback",
    attempts?: number,
  ) {
    super(
      attempts === undefined
        ? `FoodGuard ${operation} timed out before confirmation`
        : `FoodGuard ${operation} timed out after ${attempts} attempts`,
    );
    this.name = "TransactionTrackingTimeoutError";
  }
}

const consensusFailureStatuses = new Set<string>([
  TransactionStatus.UNDETERMINED,
  TransactionStatus.CANCELED,
  TransactionStatus.VALIDATORS_TIMEOUT,
  TransactionStatus.LEADER_TIMEOUT,
]);
const minimumStatusPollIntervalMs = 3_000;

function getStatusName(transaction: GenLayerTransaction): string | undefined {
  return (
    transaction.statusName ??
    (transaction as GenLayerTransaction & { status_name?: string }).status_name
  );
}

function getMapOrObjectValue(value: unknown, key: string): unknown {
  if (value instanceof Map) {
    return value.get(key);
  }
  if (typeof value === "object" && value !== null) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function orderIdFromCalldata(value: unknown): string | undefined {
  const args = getMapOrObjectValue(value, "args");
  return Array.isArray(args) && typeof args[0] === "string" ? args[0] : undefined;
}

function orderIdFromRawCalldata(value: unknown): string | undefined {
  if (
    !Array.isArray(value) ||
    !value.every(
      (byte) =>
        typeof byte === "number" &&
        Number.isInteger(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  ) {
    return undefined;
  }
  try {
    return orderIdFromCalldata(abi.calldata.decode(Uint8Array.from(value)));
  } catch {
    return undefined;
  }
}

function orderIdFromTransaction(transaction: GenLayerTransaction): string | undefined {
  const callData =
    transaction.txDataDecoded && "callData" in transaction.txDataDecoded
      ? transaction.txDataDecoded.callData
      : undefined;
  const decodedOrderId = orderIdFromCalldata(callData);
  if (decodedOrderId) {
    return decodedOrderId;
  }

  const studioData = getMapOrObjectValue(transaction.data, "calldata");
  return orderIdFromRawCalldata(getMapOrObjectValue(studioData, "raw"));
}

function wait(ms: number): Promise<void> {
  if (ms === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  operationName: "transaction status" | "order readback",
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new TransactionTrackingTimeoutError(operationName));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TransactionTrackingTimeoutError(operationName));
    }, remainingMs);

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (Date.now() >= deadline) {
          reject(new TransactionTrackingTimeoutError(operationName));
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (Date.now() >= deadline) {
          reject(new TransactionTrackingTimeoutError(operationName));
          return;
        }
        reject(error);
      },
    );
  });
}

async function waitForNextPoll(
  pollIntervalMs: number,
  deadline: number,
): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new TransactionTrackingTimeoutError("transaction status");
  }
  await wait(Math.min(pollIntervalMs, remainingMs));
  if (Date.now() >= deadline) {
    throw new TransactionTrackingTimeoutError("transaction status");
  }
}

async function waitForStatusRequestBudget(
  nextRequestAt: number,
  deadline: number,
): Promise<void> {
  const delayMs = nextRequestAt - Date.now();
  if (delayMs <= 0) return;
  if (delayMs >= deadline - Date.now()) {
    throw new TransactionTrackingTimeoutError("transaction status");
  }
  await wait(delayMs);
  if (Date.now() >= deadline) {
    throw new TransactionTrackingTimeoutError("transaction status");
  }
}

export async function trackTransaction<T = unknown>(
  hash: string,
  onUpdate: TxStageHandler,
  options: TrackTransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 40;
  const requestedPollIntervalMs =
    options.pollIntervalMs ?? minimumStatusPollIntervalMs;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  if (
    !Number.isFinite(requestedPollIntervalMs) ||
    requestedPollIntervalMs < 0
  ) {
    throw new RangeError("pollIntervalMs must be a nonnegative finite number");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("A valid StudioNet transaction hash is required for tracking");
  }
  const pollIntervalMs = Math.max(
    requestedPollIntervalMs,
    minimumStatusPollIntervalMs,
  );

  const deadline = Date.now() + timeoutMs;

  onUpdate("SUBMITTED");
  onUpdate("CONSENSUS_PENDING");
  const client = getFoodGuardReadClient();
  let nextStatusRequestAt = Date.now();

  const readTransactionStatus = async (): Promise<GenLayerTransaction> => {
    await waitForStatusRequestBudget(nextStatusRequestAt, deadline);
    nextStatusRequestAt = Date.now() + minimumStatusPollIntervalMs;
    return client.getTransaction({
      hash: hash as TransactionHash,
    });
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const transaction = await withDeadline(
      withStudioNetBackoff(readTransactionStatus, { deadline }),
      deadline,
      "transaction status",
    );
    const status = getStatusName(transaction);
    if (status && consensusFailureStatuses.has(status)) {
      onUpdate("CONSENSUS_FAILED");
      throw new ConsensusFailedError(status);
    }

    if (status === TransactionStatus.FINALIZED) {
      onUpdate("FINALIZED");
      const executionResult = transaction.txExecutionResultName;
      if (executionResult !== ExecutionResult.FINISHED_WITH_RETURN) {
        onUpdate("EXECUTION_ERROR");
        throw new TransactionExecutionError(executionResult ?? "UNKNOWN");
      }

      onUpdate("EXECUTION_SUCCESS");
      const orderId = orderIdFromTransaction(transaction);
      if (!orderId) {
        throw new Error(
          "FoodGuard execution succeeded, but the order id required for readback is unavailable",
        );
      }

      const order = await withDeadline(
        withStudioNetBackoff(() => reconcileOrder<T>(orderId), { deadline }),
        deadline,
        "order readback",
      );
      onUpdate("READBACK_CONFIRMED");
      return order;
    }

    if (attempt + 1 < maxAttempts) {
      await waitForNextPoll(pollIntervalMs, deadline);
    }
  }

  throw new TransactionTrackingTimeoutError("transaction status", maxAttempts);
}
