import { abi } from "genlayer-js";
import {
  ExecutionResult,
  TransactionStatus,
  type GenLayerTransaction,
  type TransactionHash,
} from "genlayer-js/types";

import { getFoodGuardReadClient, reconcileOrder } from "./client";

export type TxStage =
  | "WALLET_CONFIRMATION"
  | "SUBMITTED"
  | "CONSENSUS_PENDING"
  | "CONSENSUS_FAILED"
  | "FINALIZED"
  | "EXECUTION_SUCCESS"
  | "EXECUTION_ERROR"
  | "READBACK_CONFIRMED";

export type TxStageHandler = (stage: TxStage) => void;

export interface TrackTransactionOptions {
  maxAttempts?: number;
  pollIntervalMs?: number;
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

const consensusFailureStatuses = new Set<string>([
  TransactionStatus.UNDETERMINED,
  TransactionStatus.CANCELED,
  TransactionStatus.VALIDATORS_TIMEOUT,
  TransactionStatus.LEADER_TIMEOUT,
]);

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

export async function trackTransaction<T = unknown>(
  hash: string,
  onUpdate: TxStageHandler,
  options: TrackTransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 40;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("pollIntervalMs must be a nonnegative finite number");
  }

  onUpdate("SUBMITTED");
  onUpdate("CONSENSUS_PENDING");
  const client = getFoodGuardReadClient();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const transaction = await client.getTransaction({
      hash: hash as TransactionHash,
    });
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

      const order = await reconcileOrder<T>(orderId);
      onUpdate("READBACK_CONFIRMED");
      return order;
    }

    if (attempt + 1 < maxAttempts) {
      await wait(pollIntervalMs);
    }
  }

  throw new Error(
    `FoodGuard transaction tracking timed out after ${maxAttempts} attempts`,
  );
}
