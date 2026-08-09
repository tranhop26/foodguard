import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { abi } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import {
  ExecutionResult,
  TransactionHashVariant,
  TransactionStatus,
  type GenLayerTransaction,
  type TransactionHash,
} from "genlayer-js/types";

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  getTransaction: vi.fn(),
  getContractCode: vi.fn(),
  readContract: vi.fn(),
  writeContract: vi.fn(),
}));

vi.mock("genlayer-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("genlayer-js")>();
  return { ...actual, createClient: sdk.createClient };
});

import {
  getFoodGuardConfiguration,
  getFoodGuardDeploymentProofConfiguration,
  FoodGuardDeploymentRequiredError,
} from "../../lib/genlayer/config";
import {
  readFoodGuard,
  reconcileOrder,
  verifyFoodGuardDeploymentProof,
  writeFoodGuard,
} from "../../lib/genlayer/client";
import {
  ConsensusFailedError,
  trackTransaction,
  TransactionExecutionError,
  type TxStage,
} from "../../lib/genlayer/transactions";
import { executeFoodGuardOperation } from "../../lib/genlayer/operations";
import {
  AmbiguousWalletOutcomeError,
  classifyRpcFailure,
  OutcomeUnknownError,
  singleFlight,
  StudioNetRateLimitError,
  withStudioNetBackoff,
} from "../../lib/genlayer/rpcResilience";

const ADDRESS = "0x2222222222222222222222222222222222222222";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HASH = `0x${"a".repeat(64)}` as TransactionHash;
const SOURCE_HASH = `0x${"b".repeat(64)}`;
const DEPLOYMENT_HASH = `0x${"c".repeat(64)}` as TransactionHash;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function mockReceipt(
  receipt: Pick<GenLayerTransaction, "statusName" | "txExecutionResultName">,
) {
  sdk.getTransaction.mockResolvedValue({
    hash: HASH,
    txDataDecoded: {
      type: "call",
      leaderOnly: false,
      callData: new Map<string, unknown>([
        ["method", "execute_settlement"],
        ["args", ["fg-1"]],
      ]),
    },
    ...receipt,
  } satisfies GenLayerTransaction);
}

describe("StudioNet RPC failure classification", () => {
  it("honors a nested structured StudioNet rate-limit delay", () => {
    expect(
      classifyRpcFailure({
        cause: { code: -32029, data: { retry_after_seconds: 60 } },
      }),
    ).toEqual({ kind: "RATE_LIMIT", retryAfterMs: 60_000 });
  });

  it("finds structured rate limits inside an RPC error wrapper", () => {
    expect(
      classifyRpcFailure({
        error: {
          cause: { code: -32029, data: { retry_after_seconds: 2 } },
        },
      }),
    ).toEqual({ kind: "RATE_LIMIT", retryAfterMs: 2_000 });
  });

  it("treats a nested transport failure as ambiguous", () => {
    const error = new Error("request failed", {
      cause: new TypeError("Failed to fetch"),
    });

    expect(classifyRpcFailure(error)).toEqual({ kind: "TRANSIENT" });
    expect(new AmbiguousWalletOutcomeError(error)).toMatchObject({
      name: "AmbiguousWalletOutcomeError",
      cause: error,
    });
  });

  it.each([
    { error: { code: 4001 }, description: "user rejection" },
    { error: { cause: { code: 4100 } }, description: "unauthorized account" },
    { error: { details: { code: 4902 } }, description: "wrong chain" },
    {
      error: { name: "UserError", message: "[EXPECTED] invalid order state" },
      description: "contract UserError",
    },
  ])("keeps $description definitive", ({ error }) => {
    expect(classifyRpcFailure(error)).toEqual({ kind: "DEFINITIVE" });
  });
});

describe("StudioNet RPC resilience", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares an identical read only while it is in flight", async () => {
    let resolveRead: ((value: string) => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const first = singleFlight("61999:contract:get_order:[\"fg-1\"]", operation);
    const concurrent = singleFlight(
      "61999:contract:get_order:[\"fg-1\"]",
      operation,
    );

    expect(operation).toHaveBeenCalledTimes(1);
    resolveRead?.("first");
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      "first",
      "first",
    ]);

    operation.mockResolvedValueOnce("fresh");
    await expect(
      singleFlight("61999:contract:get_order:[\"fg-1\"]", operation),
    ).resolves.toBe("fresh");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("keeps different read keys independent", async () => {
    const operation = vi.fn(async (value: string) => value);

    await expect(
      Promise.all([
        singleFlight("get_order:fg-1", () => operation("fg-1")),
        singleFlight("get_order:fg-2", () => operation("fg-2")),
      ]),
    ).resolves.toEqual(["fg-1", "fg-2"]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("honors the exact server retry delay and clears its timer", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        cause: { code: -32029, data: { retry_after_seconds: 60 } },
      })
      .mockResolvedValueOnce("settled");

    const result = withStudioNetBackoff(operation, {
      deadline: Date.now() + 61_000,
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe("settled");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule a server retry beyond the deadline", async () => {
    vi.useFakeTimers();
    const rateLimit = {
      cause: { code: -32029, data: { retry_after_seconds: 60 } },
    };
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(rateLimit);

    const result = withStudioNetBackoff(operation, {
      deadline: Date.now() + 59_999,
    });

    await expect(result).rejects.toMatchObject({
      name: "StudioNetRateLimitError",
      retryAfterMs: 60_000,
      cause: rateLimit,
    });
    await expect(result).rejects.toBeInstanceOf(StudioNetRateLimitError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses bounded exponential backoff for transport failures", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce("settled");

    const result = withStudioNetBackoff(operation, {
      deadline: Date.now() + 10_000,
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe("settled");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("FoodGuard StudioNet configuration", () => {
  it.each([undefined, "", "not-an-address", ZERO_ADDRESS])(
    "reports deployment required for an unusable address (%s)",
    (address) => {
      expect(getFoodGuardConfiguration(address)).toMatchObject({
        status: "DEPLOYMENT_REQUIRED",
        address: null,
        chain: {
          id: 61999,
          name: "Genlayer Studio Network",
        },
      });
    },
  );

  it("accepts a syntactically valid nonzero deployed address", () => {
    expect(getFoodGuardConfiguration(ADDRESS)).toMatchObject({
      status: "READY",
      address: ADDRESS,
      chain: {
        id: 61999,
      },
    });
  });

  it("keeps a complete public deployment record reviewed until runtime verification", () => {
    expect(getFoodGuardDeploymentProofConfiguration({
      address: ADDRESS,
      deploymentAddress: ADDRESS,
      deploymentChainId: "61999",
      sourceHash: SOURCE_HASH,
      transactionHash: DEPLOYMENT_HASH,
      finality: "FINALIZED",
      execution: "EXECUTION_SUCCESS",
      readback: "READBACK_CONFIRMED",
      sourceHashMatch: "true",
    })).toMatchObject({
      address: ADDRESS,
      sourceHash: SOURCE_HASH,
      status: "REVIEWED",
      transactionHash: DEPLOYMENT_HASH,
      runtimeVerification: { status: "NOT_CHECKED" },
    });
  });

  it("keeps malformed deployment proof hashes unavailable", () => {
    expect(getFoodGuardDeploymentProofConfiguration({
      address: ADDRESS,
      deploymentAddress: ADDRESS,
      deploymentChainId: "61999",
      sourceHash: "0xnot-a-sha256",
      transactionHash: DEPLOYMENT_HASH,
      finality: "FINALIZED",
      execution: "EXECUTION_SUCCESS",
      readback: "READBACK_CONFIRMED",
      sourceHashMatch: "true",
    })).toMatchObject({
      reason: "SOURCE_HASH_INVALID",
      status: "UNAVAILABLE",
    });
  });

  it("keeps deployment provenance bound to the configured contract address", () => {
    expect(getFoodGuardDeploymentProofConfiguration({
      address: ADDRESS,
      deploymentAddress: "0x3333333333333333333333333333333333333333",
      deploymentChainId: "61999",
      sourceHash: SOURCE_HASH,
      transactionHash: DEPLOYMENT_HASH,
      finality: "FINALIZED",
      execution: "EXECUTION_SUCCESS",
      readback: "READBACK_CONFIRMED",
      sourceHashMatch: "true",
    })).toMatchObject({
      reason: "DEPLOYMENT_ADDRESS_MISMATCH",
      status: "UNAVAILABLE",
    });
  });

  it("rejects deployment metadata for a different chain", () => {
    expect(getFoodGuardDeploymentProofConfiguration({
      address: ADDRESS,
      deploymentAddress: ADDRESS,
      deploymentChainId: "1",
      sourceHash: SOURCE_HASH,
      transactionHash: DEPLOYMENT_HASH,
      finality: "FINALIZED",
      execution: "EXECUTION_SUCCESS",
      readback: "READBACK_CONFIRMED",
      sourceHashMatch: "true",
    })).toMatchObject({
      reason: "DEPLOYMENT_CHAIN_MISMATCH",
      status: "UNAVAILABLE",
    });
  });
});

describe("FoodGuard StudioNet client", () => {
  const walletProvider = {
    request: vi.fn(),
  };

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_FOODGUARD_ADDRESS", ADDRESS);
    sdk.createClient.mockReset();
    sdk.getTransaction.mockReset();
    sdk.getContractCode.mockReset();
    sdk.readContract.mockReset();
    sdk.writeContract.mockReset();
    walletProvider.request.mockReset();
    walletProvider.request.mockImplementation(
      async ({ method }: { method: string }) =>
        method === "eth_chainId" ? `0x${studionet.id.toString(16)}` : [ADDRESS],
    );
    sdk.createClient.mockReturnValue({
      getTransaction: sdk.getTransaction,
      getContractCode: sdk.getContractCode,
      readContract: sdk.readContract,
      writeContract: sdk.writeContract,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { ethereum: walletProvider },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("reads authoritative contract state from StudioNet", async () => {
    const order = { order_id: "fg-1", state: "RESOLVED" };
    sdk.readContract.mockResolvedValue(order);

    await expect(readFoodGuard<typeof order>("get_order", ["fg-1"])).resolves.toEqual(
      order,
    );
    expect(sdk.createClient).toHaveBeenCalledWith({ chain: studionet });
    expect(sdk.readContract).toHaveBeenCalledWith({
      address: ADDRESS,
      functionName: "get_order",
      args: ["fg-1"],
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
  });

  it("coalesces only concurrent identical latest-final contract reads", async () => {
    const order = { order_id: "fg-1", state: "RESOLVED" };
    let resolveRead: ((value: typeof order) => void) | undefined;
    sdk.readContract.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const first = readFoodGuard<typeof order>("get_order", ["fg-1"]);
    const concurrent = readFoodGuard<typeof order>("get_order", ["fg-1"]);
    expect(sdk.readContract).toHaveBeenCalledTimes(1);

    resolveRead?.(order);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([order, order]);

    const freshOrder = { ...order, state: "SETTLED" };
    sdk.readContract.mockResolvedValueOnce(freshOrder);
    await expect(
      readFoodGuard<typeof freshOrder>("get_order", ["fg-1"]),
    ).resolves.toEqual(freshOrder);
    expect(sdk.readContract).toHaveBeenCalledTimes(2);
  });

  it("only marks deployment metadata verified after finalized deploy, code, hash, and order readback checks", async () => {
    const deployedCode = "0x666f6f646775617264" as `0x${string}`;
    const deployedSourceHash = `0x${createHash("sha256")
      .update(Buffer.from(deployedCode.slice(2), "hex"))
      .digest("hex")}`;
    const configured = getFoodGuardDeploymentProofConfiguration({
      address: ADDRESS,
      deploymentAddress: ADDRESS,
      deploymentChainId: "61999",
      sourceHash: deployedSourceHash,
      transactionHash: DEPLOYMENT_HASH,
      finality: "FINALIZED",
      execution: "EXECUTION_SUCCESS",
      readback: "READBACK_CONFIRMED",
      sourceHashMatch: "true",
    });
    expect(configured.status).toBe("REVIEWED");
    sdk.getTransaction.mockResolvedValue({
      hash: DEPLOYMENT_HASH,
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
      txDataDecoded: {
        type: "deploy",
        contractAddress: ADDRESS,
        code: deployedCode,
      },
    } satisfies GenLayerTransaction);
    sdk.getContractCode.mockResolvedValue(deployedCode);
    sdk.readContract.mockResolvedValue({ order_id: "fg-1", state: "SETTLED" });

    await expect(verifyFoodGuardDeploymentProof(configured, "fg-1")).resolves.toMatchObject({
      address: ADDRESS,
      status: "VERIFIED",
      runtimeVerification: { status: "VERIFIED" },
      sourceHash: deployedSourceHash,
      transactionHash: DEPLOYMENT_HASH,
    });
    expect(sdk.createClient).toHaveBeenCalledWith({ chain: studionet });
    expect(sdk.getTransaction).toHaveBeenCalledWith({ hash: DEPLOYMENT_HASH });
    expect(sdk.getContractCode).toHaveBeenCalledWith(ADDRESS);
    expect(sdk.readContract).toHaveBeenCalledWith({
      address: ADDRESS,
      functionName: "get_order",
      args: ["fg-1"],
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
  });

  it("keeps review metadata unverified when current code does not match the deploy transaction", async () => {
    const deployedCode = "0x666f6f646775617264" as `0x${string}`;
    const deployedSourceHash = `0x${createHash("sha256")
      .update(Buffer.from(deployedCode.slice(2), "hex"))
      .digest("hex")}`;
    const configured = getFoodGuardDeploymentProofConfiguration({
      address: ADDRESS,
      deploymentAddress: ADDRESS,
      deploymentChainId: "61999",
      sourceHash: deployedSourceHash,
      transactionHash: DEPLOYMENT_HASH,
      finality: "FINALIZED",
      execution: "EXECUTION_SUCCESS",
      readback: "READBACK_CONFIRMED",
      sourceHashMatch: "true",
    });
    sdk.getTransaction.mockResolvedValue({
      hash: DEPLOYMENT_HASH,
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
      txDataDecoded: {
        type: "deploy",
        contractAddress: ADDRESS,
        code: deployedCode,
      },
    } satisfies GenLayerTransaction);
    sdk.getContractCode.mockResolvedValue("0x646966666572656e74");

    await expect(verifyFoodGuardDeploymentProof(configured, "fg-1")).resolves.toMatchObject({
      status: "REVIEWED",
      runtimeVerification: {
        status: "FAILED",
        reason: "DEPLOYED_CODE_MISMATCH",
      },
    });
    expect(sdk.readContract).not.toHaveBeenCalled();
  });

  it("uses the connected EIP-1193 wallet and preserves an exact payable value", async () => {
    const stages: TxStage[] = [];
    sdk.writeContract.mockResolvedValue(HASH);

    await expect(
      writeFoodGuard("create_order", ["fg-1"], 123456789n, (stage) =>
        stages.push(stage),
      ),
    ).resolves.toBe(HASH);

    expect(walletProvider.request).toHaveBeenCalledWith({
      method: "eth_requestAccounts",
    });
    expect(sdk.createClient).toHaveBeenLastCalledWith({
      chain: studionet,
      account: ADDRESS,
      provider: walletProvider,
    });
    expect(sdk.writeContract).toHaveBeenCalledWith({
      address: ADDRESS,
      functionName: "create_order",
      args: ["fg-1"],
      value: 123456789n,
    });
    expect(stages).toEqual(["WALLET_CONFIRMATION", "SUBMITTED"]);
  });

  it("rejects a malformed transaction hash before reporting submission", async () => {
    const stages: TxStage[] = [];
    sdk.writeContract.mockResolvedValue("0x1234");

    await expect(
      writeFoodGuard("accept_restaurant", ["fg-1"], 0n, (stage) =>
        stages.push(stage),
      ),
    ).rejects.toThrow("invalid transaction hash");
    expect(stages).toEqual(["WALLET_CONFIRMATION"]);
  });

  it("never retries a wallet write after an ambiguous transport failure", async () => {
    const transportFailure = new TypeError("Failed to fetch");
    sdk.writeContract.mockRejectedValue(transportFailure);

    await expect(
      writeFoodGuard("accept_restaurant", ["fg-1"]),
    ).rejects.toBe(transportFailure);
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(sdk.getTransaction).not.toHaveBeenCalled();
    expect(sdk.readContract).not.toHaveBeenCalled();
  });

  it("reconciles a broadcast-then-transport-error with a readback-only stage without resubmitting", async () => {
    const stages: TxStage[] = [];
    const order = {
      courier: "0x3333333333333333333333333333333333333333",
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: true,
      state: "PARTIALLY_ACCEPTED",
    };
    const readback = vi.fn().mockResolvedValue(order);
    sdk.writeContract.mockRejectedValue(
      new Error("wallet request failed", {
        cause: { error: new TypeError("Failed to fetch") },
      }),
    );

    await expect(executeFoodGuardOperation<typeof order>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    })).resolves.toEqual(order);

    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages).toEqual([
      "WALLET_CONFIRMATION",
      "RECONCILING",
      "STATE_READBACK_CONFIRMED",
    ]);
  });

  it("tracks a trusted post-submission account error through its recoverable hash", async () => {
    const changedAccount = "0x3333333333333333333333333333333333333333";
    const stages: TxStage[] = [];
    const order = {
      courier: changedAccount,
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: true,
      state: "PARTIALLY_ACCEPTED",
    };
    walletProvider.request.mockImplementation(
      async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return `0x${studionet.id.toString(16)}`;
        if (method === "eth_requestAccounts") return [ADDRESS];
        if (method === "eth_accounts") return [changedAccount];
        throw new Error(`unexpected wallet method ${method}`);
      },
    );
    sdk.writeContract.mockResolvedValue(HASH);
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });
    sdk.readContract.mockResolvedValue(order);
    const readback = vi.fn().mockResolvedValue(order);

    await expect(executeFoodGuardOperation<typeof order>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    })).resolves.toEqual(order);

    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(sdk.getTransaction).toHaveBeenCalledWith({ hash: HASH });
    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages).toContain("FINALIZED");
    expect(stages).toContain("EXECUTION_SUCCESS");
    expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
    expect(stages).not.toContain("STATE_READBACK_CONFIRMED");
  });

  it("never trusts an arbitrary hash attached to a rejected wallet request", async () => {
    const rejection = { code: 4001, message: "User rejected the request", transactionHash: HASH };
    const readback = vi.fn();
    sdk.writeContract.mockRejectedValue(rejection);

    await expect(executeFoodGuardOperation({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: () => undefined,
      readback,
      matches: () => true,
    })).rejects.toBe(rejection);

    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(sdk.getTransaction).not.toHaveBeenCalled();
    expect(readback).not.toHaveBeenCalled();
  });

  it("does not reconcile a definitive wallet rejection", async () => {
    const stages: TxStage[] = [];
    const rejection = { code: 4001, message: "User rejected the request" };
    const readback = vi.fn();
    sdk.writeContract.mockRejectedValue(rejection);

    await expect(executeFoodGuardOperation({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: () => true,
    })).rejects.toBe(rejection);

    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(readback).not.toHaveBeenCalled();
    expect(stages).toEqual(["WALLET_CONFIRMATION"]);
  });

  it("reports an unknown outcome after bounded nonmatching readback without resubmitting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const stages: TxStage[] = [];
    const unchangedOrder = {
      courier: "0x3333333333333333333333333333333333333333",
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: false,
      state: "FUNDED",
    };
    const readback = vi.fn().mockResolvedValue(unchangedOrder);
    sdk.writeContract.mockRejectedValue(
      new Error("wallet request failed", {
        cause: { details: new TypeError("Failed to fetch") },
      }),
    );

    const outcome = executeFoodGuardOperation<typeof unchangedOrder>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(120_000);
    await expect(outcome).resolves.toMatchObject({
      kind: "rejected",
      error: expect.any(OutcomeUnknownError),
    });
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(readback.mock.calls.length).toBeGreaterThan(1);
    expect(stages).toEqual([
      "WALLET_CONFIRMATION",
      "RECONCILING",
      "OUTCOME_UNKNOWN",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a reconciliation read that never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const stages: TxStage[] = [];
    const readback = vi.fn(() => new Promise<{ restaurant_accepted: boolean }>(() => undefined));
    const settled = vi.fn();
    sdk.writeContract.mockRejectedValue(new TypeError("Failed to fetch"));

    void executeFoodGuardOperation({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    }).then(settled, settled);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toHaveBeenCalledWith(expect.any(OutcomeUnknownError));
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages).toEqual([
      "WALLET_CONFIRMATION",
      "RECONCILING",
      "OUTCOME_UNKNOWN",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles a known-hash status RPC timeout without another write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const stages: TxStage[] = [];
    const order = {
      courier: "0x3333333333333333333333333333333333333333",
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: true,
      state: "PARTIALLY_ACCEPTED",
    };
    const readback = vi.fn().mockResolvedValue(order);
    sdk.writeContract.mockResolvedValue(HASH);
    sdk.getTransaction.mockReturnValue(new Promise(() => undefined));

    const outcome = executeFoodGuardOperation<typeof order>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(120_000);
    await expect(outcome).resolves.toEqual({ kind: "resolved", value: order });
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages).toContain("RECONCILING");
    expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles after known-hash status attempts are exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const stages: TxStage[] = [];
    const order = {
      courier: "0x3333333333333333333333333333333333333333",
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: true,
      state: "PARTIALLY_ACCEPTED",
    };
    const readback = vi.fn().mockResolvedValue(order);
    sdk.writeContract.mockResolvedValue(HASH);
    sdk.getTransaction.mockResolvedValue({
      hash: HASH,
      statusName: TransactionStatus.PENDING,
      txExecutionResultName: ExecutionResult.NOT_VOTED,
    } satisfies GenLayerTransaction);

    const outcome = executeFoodGuardOperation<typeof order>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(117_000);
    await expect(outcome).resolves.toEqual({ kind: "resolved", value: order });
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(sdk.getTransaction).toHaveBeenCalledTimes(40);
    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages).toContain("RECONCILING");
    expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses the tracker confirmation until the operation readback matches", async () => {
    const stages: TxStage[] = [];
    const trackedOrder = {
      courier: "0x3333333333333333333333333333333333333333",
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: false,
      state: "FUNDED",
    };
    const matchedOrder = {
      ...trackedOrder,
      restaurant_accepted: true,
      state: "PARTIALLY_ACCEPTED",
    };
    sdk.writeContract.mockResolvedValue(HASH);
    sdk.readContract.mockResolvedValue(trackedOrder);
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });
    const readback = vi.fn(async () => {
      expect(stages).toContain("FINALIZED");
      expect(stages).toContain("EXECUTION_SUCCESS");
      expect(stages).not.toContain("READBACK_CONFIRMED");
      return matchedOrder;
    });

    await expect(executeFoodGuardOperation<typeof trackedOrder>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    })).resolves.toEqual(matchedOrder);

    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages.filter((stage) => stage === "READBACK_CONFIRMED")).toHaveLength(1);
    expect(stages).not.toContain("RECONCILING");
    expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
  });

  it("returns the enriched operation readback after normal tracked success", async () => {
    const stages: TxStage[] = [];
    const trackedOrder = {
      courier: "0x3333333333333333333333333333333333333333",
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: true,
      state: "PARTIALLY_ACCEPTED",
    };
    const enrichedOrder = {
      ...trackedOrder,
      evidence: [{ evidence_index: 0, sha256: `0x${"d".repeat(64)}` }],
      mutual_settlement: null,
      resolution: null,
      settlement: { settlement_id: `0x${"e".repeat(64)}` },
      settlement_proposals: [],
    };
    const readback = vi.fn().mockResolvedValue(enrichedOrder);
    sdk.writeContract.mockResolvedValue(HASH);
    sdk.readContract.mockResolvedValue(trackedOrder);
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });

    await expect(executeFoodGuardOperation<typeof enrichedOrder>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    })).resolves.toEqual(enrichedOrder);

    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages).toContain("FINALIZED");
    expect(stages).toContain("EXECUTION_SUCCESS");
    expect(stages.filter((stage) => stage === "READBACK_CONFIRMED")).toHaveLength(1);
    expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
  });

  it("bounds a hung enriched read after successful transaction tracking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const stages: TxStage[] = [];
    const trackedOrder = {
      courier: "0x3333333333333333333333333333333333333333",
      courier_accepted: false,
      customer: "0x1111111111111111111111111111111111111111",
      order_id: "fg-1",
      restaurant: ADDRESS,
      restaurant_accepted: true,
      state: "PARTIALLY_ACCEPTED",
    };
    const readback = vi.fn(
      () => new Promise<typeof trackedOrder>(() => undefined),
    );
    const settled = vi.fn();
    sdk.writeContract.mockResolvedValue(HASH);
    sdk.readContract.mockResolvedValue(trackedOrder);
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });

    void executeFoodGuardOperation<typeof trackedOrder>({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: (stage) => stages.push(stage),
      readback,
      matches: (candidate) => candidate.restaurant_accepted === true,
    }).then(settled, settled);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toHaveBeenCalledWith(expect.any(OutcomeUnknownError));
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
    expect(readback).toHaveBeenCalledTimes(1);
    expect(stages).toContain("FINALIZED");
    expect(stages).toContain("EXECUTION_SUCCESS");
    expect(stages).toContain("RECONCILING");
    expect(stages.at(-1)).toBe("OUTCOME_UNKNOWN");
    expect(stages).not.toContain("READBACK_CONFIRMED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reconcile a known-hash explicit consensus failure", async () => {
    const readback = vi.fn();
    sdk.writeContract.mockResolvedValue(HASH);
    mockReceipt({
      statusName: TransactionStatus.UNDETERMINED,
      txExecutionResultName: ExecutionResult.NOT_VOTED,
    });

    await expect(executeFoodGuardOperation({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: () => undefined,
      readback,
      matches: () => true,
    })).rejects.toBeInstanceOf(ConsensusFailedError);
    expect(readback).not.toHaveBeenCalled();
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile a known-hash execution failure", async () => {
    const readback = vi.fn();
    sdk.writeContract.mockResolvedValue(HASH);
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_ERROR,
    });

    await expect(executeFoodGuardOperation({
      method: "accept_restaurant",
      args: ["fg-1"],
      value: 0n,
      expectedAccount: ADDRESS,
      onStage: () => undefined,
      readback,
      matches: () => true,
    })).rejects.toBeInstanceOf(TransactionExecutionError);
    expect(readback).not.toHaveBeenCalled();
    expect(sdk.writeContract).toHaveBeenCalledTimes(1);
  });

  it("blocks writes when the connected wallet is not on StudioNet", async () => {
    const stages: TxStage[] = [];
    walletProvider.request.mockImplementation(
      async ({ method }: { method: string }) =>
        method === "eth_chainId" ? "0x1" : [ADDRESS],
    );

    await expect(
      writeFoodGuard("accept_restaurant", ["fg-1"], 0n, (stage) =>
        stages.push(stage),
      ),
    ).rejects.toThrow("StudioNet");
    expect(walletProvider.request).toHaveBeenCalledWith({ method: "eth_chainId" });
    expect(sdk.writeContract).not.toHaveBeenCalled();
    expect(stages).toEqual(["WALLET_CONFIRMATION"]);
  });

  it("blocks a write when the confirmed account changed after preview", async () => {
    const previewedCustomer = "0x3333333333333333333333333333333333333333";
    sdk.writeContract.mockResolvedValue(HASH);

    await expect(
      writeFoodGuard("create_order", ["fg-1"], 1n, undefined, previewedCustomer),
    ).rejects.toThrow(/changed after preview/i);
    expect(sdk.writeContract).not.toHaveBeenCalled();
  });

  it("preserves a submitted hash when the account changes while confirmation is pending", async () => {
    const changedAccount = "0x3333333333333333333333333333333333333333";
    const stages: TxStage[] = [];
    let currentAccounts = [ADDRESS];
    let resolveWrite: ((hash: TransactionHash) => void) | undefined;
    walletProvider.request.mockImplementation(
      async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return `0x${studionet.id.toString(16)}`;
        return currentAccounts;
      },
    );
    sdk.writeContract.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );

    const outcomePromise = writeFoodGuard(
      "create_order",
      ["fg-1"],
      1n,
      (stage) => stages.push(stage),
      ADDRESS,
    ).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );
    await vi.waitFor(() => expect(sdk.writeContract).toHaveBeenCalledTimes(1));

    currentAccounts = [changedAccount];
    resolveWrite?.(HASH);
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "WalletAccountChangedAfterSubmissionError",
        transactionHash: HASH,
        message: expect.stringContaining(HASH),
      },
    });
    expect(walletProvider.request).toHaveBeenCalledWith({ method: "eth_accounts" });
    expect(stages).toEqual(["WALLET_CONFIRMATION", "SUBMITTED"]);
  });

  it("reports an unverifiable post-submission account without losing the hash", async () => {
    sdk.writeContract.mockResolvedValue(HASH);
    walletProvider.request.mockImplementation(
      async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return `0x${studionet.id.toString(16)}`;
        if (method === "eth_requestAccounts") return [ADDRESS];
        throw new Error("wallet disconnected");
      },
    );

    const outcome = await writeFoodGuard(
      "create_order",
      ["fg-1"],
      1n,
      undefined,
      ADDRESS,
    ).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "WalletAccountUnverifiedAfterSubmissionError",
        transactionHash: HASH,
        message: expect.stringMatching(/could not be verified.*0x[a-f0-9]{64}/i),
      },
    });
  });

  it("disables writes before deployment without asking the wallet", async () => {
    vi.stubEnv("NEXT_PUBLIC_FOODGUARD_ADDRESS", "");

    await expect(writeFoodGuard("accept_restaurant", ["fg-1"])).rejects.toBeInstanceOf(
      FoodGuardDeploymentRequiredError,
    );
    expect(walletProvider.request).not.toHaveBeenCalled();
    expect(sdk.writeContract).not.toHaveBeenCalled();
  });

  it("reconciles an order with an authoritative contract read", async () => {
    const order = { order_id: "fg-1", state: "SETTLED" };
    sdk.readContract.mockResolvedValue(order);

    await expect(reconcileOrder<typeof order>("fg-1")).resolves.toEqual(order);
    expect(sdk.readContract).toHaveBeenCalledWith({
      address: ADDRESS,
      functionName: "get_order",
      args: ["fg-1"],
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
  });

  it("does not report success from finality alone", async () => {
    const stages: TxStage[] = [];
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_ERROR,
    });

    await expect(trackTransaction(HASH, (stage) => stages.push(stage))).rejects.toThrow(
      "execution failed",
    );
    expect(stages).toContain("FINALIZED");
    expect(stages.at(-1)).toBe("EXECUTION_ERROR");
    expect(stages).not.toContain("READBACK_CONFIRMED");
    expect(sdk.readContract).not.toHaveBeenCalled();
  });

  it("requires post-success order readback", async () => {
    const stages: TxStage[] = [];
    const order = { order_id: "fg-1", state: "SETTLED" };
    sdk.readContract.mockResolvedValue(order);
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });

    await expect(trackTransaction(HASH, (stage) => stages.push(stage))).resolves.toEqual(
      order,
    );
    expect(sdk.readContract).toHaveBeenCalledWith({
      address: ADDRESS,
      functionName: "get_order",
      args: ["fg-1"],
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
    expect(stages).toEqual([
      "SUBMITTED",
      "CONSENSUS_PENDING",
      "FINALIZED",
      "EXECUTION_SUCCESS",
      "READBACK_CONFIRMED",
    ]);
  });

  it("recovers the order id from real StudioNet calldata bytes", async () => {
    const stages: TxStage[] = [];
    const order = { order_id: "fg-1", state: "SETTLED" };
    const calldata = abi.calldata.encode({
      method: "execute_settlement",
      args: ["fg-1"],
    });
    const readable = abi.calldata.toString(abi.calldata.decode(calldata));
    expect(() => JSON.parse(readable)).toThrow();
    sdk.readContract.mockResolvedValue(order);
    sdk.getTransaction.mockResolvedValue({
      hash: HASH,
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
      data: {
        calldata: {
          base64: "fixture",
          raw: Array.from(calldata),
          readable,
        },
      },
    } satisfies GenLayerTransaction);

    await expect(trackTransaction(HASH, (stage) => stages.push(stage))).resolves.toEqual(
      order,
    );
    expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
  });

  it("maps validator disagreement to retry without advancing readback", async () => {
    const stages: TxStage[] = [];
    mockReceipt({
      statusName: TransactionStatus.UNDETERMINED,
      txExecutionResultName: ExecutionResult.NOT_VOTED,
    });

    const result = trackTransaction(HASH, (stage) => stages.push(stage));
    await expect(result).rejects.toMatchObject({ retryable: true });
    await expect(result).rejects.toBeInstanceOf(ConsensusFailedError);
    expect(stages.at(-1)).toBe("CONSENSUS_FAILED");
    expect(stages).not.toContain("FINALIZED");
    expect(stages).not.toContain("READBACK_CONFIRMED");
    expect(sdk.readContract).not.toHaveBeenCalled();
  });

  it("does not advance readback when the authoritative read fails", async () => {
    const stages: TxStage[] = [];
    sdk.readContract.mockRejectedValue(new Error("RPC unavailable"));
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });

    await expect(trackTransaction(HASH, (stage) => stages.push(stage))).rejects.toThrow(
      "RPC unavailable",
    );
    expect(stages.at(-1)).toBe("EXECUTION_SUCCESS");
    expect(stages).not.toContain("READBACK_CONFIRMED");
  });

  it("backs off a transient status read without exceeding the poll budget", async () => {
    vi.useFakeTimers();
    const stages: TxStage[] = [];
    const order = { order_id: "fg-1", state: "SETTLED" };
    sdk.readContract.mockResolvedValue(order);
    sdk.getTransaction
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        hash: HASH,
        statusName: TransactionStatus.FINALIZED,
        txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
        txDataDecoded: {
          type: "call",
          leaderOnly: false,
          callData: new Map<string, unknown>([
            ["method", "execute_settlement"],
            ["args", ["fg-1"]],
          ]),
        },
      } satisfies GenLayerTransaction);

    const outcome = trackTransaction(HASH, (stage) => stages.push(stage)).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(2_999);
    expect(sdk.getTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toEqual({ kind: "resolved", value: order });
    expect(stages).toEqual([
      "SUBMITTED",
      "CONSENSUS_PENDING",
      "FINALIZED",
      "EXECUTION_SUCCESS",
      "READBACK_CONFIRMED",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off a transient authoritative readback without conflating claims", async () => {
    vi.useFakeTimers();
    const stages: TxStage[] = [];
    const order = { order_id: "fg-1", state: "SETTLED" };
    sdk.readContract
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(order);
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });

    const outcome = trackTransaction(HASH, (stage) => stages.push(stage)).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(sdk.readContract).toHaveBeenCalledTimes(1);
    expect(stages.at(-1)).toBe("EXECUTION_SUCCESS");
    expect(stages).not.toContain("READBACK_CONFIRMED");
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toEqual({ kind: "resolved", value: order });
    expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits default status polling to twenty requests in the first minute", async () => {
    vi.useFakeTimers();
    sdk.getTransaction.mockResolvedValue({
      hash: HASH,
      statusName: TransactionStatus.PENDING,
      txExecutionResultName: ExecutionResult.NOT_VOTED,
    } satisfies GenLayerTransaction);

    const outcome = trackTransaction(HASH, () => undefined, {
      maxAttempts: 21,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(sdk.getTransaction).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({
      kind: "rejected",
      error: { message: expect.stringContaining("21 attempts") },
    });
    expect(sdk.getTransaction).toHaveBeenCalledTimes(21);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a 120-second default deadline for a hung status RPC", async () => {
    vi.useFakeTimers();
    sdk.getTransaction.mockReturnValue(new Promise(() => undefined));

    const outcome = trackTransaction(HASH, () => undefined).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(119_999);
    await expect(
      Promise.race([
        outcome,
        Promise.resolve({ kind: "still-pending" } as const),
      ]),
    ).resolves.toEqual({ kind: "still-pending" });

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      kind: "rejected",
      error: {
        name: "TransactionTrackingTimeoutError",
        message: expect.stringContaining("transaction status"),
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never marks an explicit consensus failure retryable for a malformed hash", async () => {
    const stages: TxStage[] = [];
    mockReceipt({
      statusName: TransactionStatus.UNDETERMINED,
      txExecutionResultName: ExecutionResult.NOT_VOTED,
    });

    const outcome = await trackTransaction("not-a-transaction-hash", (stage) =>
      stages.push(stage),
    ).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: { message: expect.stringMatching(/transaction hash/i) },
    });
    expect(
      outcome.kind === "rejected" && outcome.error instanceof ConsensusFailedError,
    ).toBe(false);
    expect(stages).not.toContain("CONSENSUS_FAILED");
    expect(sdk.getTransaction).not.toHaveBeenCalled();
  });

  it("clamps an unsafe poll override while keeping attempts bounded", async () => {
    vi.useFakeTimers();
    sdk.getTransaction.mockResolvedValue({
      hash: HASH,
      statusName: TransactionStatus.PENDING,
      txExecutionResultName: ExecutionResult.NOT_VOTED,
    } satisfies GenLayerTransaction);

    const outcome = trackTransaction(HASH, () => undefined, {
      maxAttempts: 2,
      pollIntervalMs: 0,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(2_999);
    expect(sdk.getTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      kind: "rejected",
      error: { message: expect.stringContaining("timed out") },
    });
    expect(sdk.getTransaction).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out when the transaction RPC never settles", async () => {
    vi.useFakeTimers();
    const stages: TxStage[] = [];
    sdk.getTransaction.mockReturnValue(new Promise(() => undefined));

    const outcomePromise = trackTransaction(HASH, (stage) => stages.push(stage), {
      maxAttempts: 2,
      pollIntervalMs: 0,
      timeoutMs: 100,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(100);
    const outcome = await Promise.race([
      outcomePromise,
      Promise.resolve({ kind: "still-pending" } as const),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "TransactionTrackingTimeoutError",
        message: expect.stringContaining("transaction status"),
      },
    });
    expect(stages.at(-1)).toBe("CONSENSUS_PENDING");
    expect(stages).not.toContain("FINALIZED");
    expect(stages).not.toContain("READBACK_CONFIRMED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a hung readback without confirming a late result", async () => {
    vi.useFakeTimers();
    const stages: TxStage[] = [];
    let resolveReadback: ((value: unknown) => void) | undefined;
    sdk.readContract.mockReturnValue(
      new Promise((resolve) => {
        resolveReadback = resolve;
      }),
    );
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });

    const outcomePromise = trackTransaction(HASH, (stage) => stages.push(stage), {
      timeoutMs: 100,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );

    await vi.advanceTimersByTimeAsync(100);
    const outcome = await Promise.race([
      outcomePromise,
      Promise.resolve({ kind: "still-pending" } as const),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "TransactionTrackingTimeoutError",
        message: expect.stringContaining("order readback"),
      },
    });
    expect(stages.at(-1)).toBe("EXECUTION_SUCCESS");
    expect(stages).not.toContain("READBACK_CONFIRMED");
    expect(vi.getTimerCount()).toBe(0);

    resolveReadback?.({ order_id: "fg-1", state: "SETTLED" });
    await Promise.resolve();
    await Promise.resolve();
    expect(stages.at(-1)).toBe("EXECUTION_SUCCESS");
    expect(stages).not.toContain("READBACK_CONFIRMED");
  });

  it("rejects readback that settles after the deadline before its timer runs", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const stages: TxStage[] = [];
    let resolveReadback: ((value: unknown) => void) | undefined;
    sdk.readContract.mockReturnValue(
      new Promise((resolve) => {
        resolveReadback = resolve;
      }),
    );
    mockReceipt({
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
    });

    const outcomePromise = trackTransaction(HASH, (stage) => stages.push(stage), {
      timeoutMs: 100,
    }).then(
      (value) => ({ kind: "resolved", value }) as const,
      (error: unknown) => ({ kind: "rejected", error }) as const,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(stages.at(-1)).toBe("EXECUTION_SUCCESS");

    vi.setSystemTime(startedAt + 101);
    resolveReadback?.({ order_id: "fg-1", state: "SETTLED" });
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
    const outcome = await Promise.race([
      outcomePromise,
      Promise.resolve({ kind: "still-pending" } as const),
    ]);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        name: "TransactionTrackingTimeoutError",
        message: expect.stringContaining("order readback"),
      },
    });
    expect(stages.at(-1)).toBe("EXECUTION_SUCCESS");
    expect(stages).not.toContain("READBACK_CONFIRMED");
    expect(vi.getTimerCount()).toBe(0);
  });
});
