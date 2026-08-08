import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  readContract: vi.fn(),
  writeContract: vi.fn(),
}));

vi.mock("genlayer-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("genlayer-js")>();
  return { ...actual, createClient: sdk.createClient };
});

import {
  getFoodGuardConfiguration,
  FoodGuardDeploymentRequiredError,
} from "../../lib/genlayer/config";
import {
  readFoodGuard,
  reconcileOrder,
  writeFoodGuard,
} from "../../lib/genlayer/client";
import {
  ConsensusFailedError,
  trackTransaction,
  type TxStage,
} from "../../lib/genlayer/transactions";

const ADDRESS = "0x2222222222222222222222222222222222222222";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HASH = `0x${"a".repeat(64)}` as TransactionHash;
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
});

describe("FoodGuard StudioNet client", () => {
  const walletProvider = {
    request: vi.fn(),
  };

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_FOODGUARD_ADDRESS", ADDRESS);
    sdk.createClient.mockReset();
    sdk.getTransaction.mockReset();
    sdk.readContract.mockReset();
    sdk.writeContract.mockReset();
    walletProvider.request.mockReset();
    walletProvider.request.mockImplementation(
      async ({ method }: { method: string }) =>
        method === "eth_chainId" ? `0x${studionet.id.toString(16)}` : [ADDRESS],
    );
    sdk.createClient.mockReturnValue({
      getTransaction: sdk.getTransaction,
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

  it("times out after a bounded number of polls", async () => {
    sdk.getTransaction.mockResolvedValue({
      hash: HASH,
      statusName: TransactionStatus.PENDING,
      txExecutionResultName: ExecutionResult.NOT_VOTED,
    } satisfies GenLayerTransaction);

    await expect(
      trackTransaction(HASH, () => undefined, {
        maxAttempts: 2,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("timed out");
    expect(sdk.getTransaction).toHaveBeenCalledTimes(2);
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
