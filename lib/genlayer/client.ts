import { createClient } from "genlayer-js";
import type {
  CalldataEncodable,
  TransactionHash,
} from "genlayer-js/types";
import {
  ExecutionResult,
  TransactionHashVariant,
  TransactionStatus,
} from "genlayer-js/types";
import { isAddress, isHex, type Address } from "viem";

import {
  FOODGUARD_CHAIN,
  isFoodGuardReviewedDeploymentProofForContract,
  requireFoodGuardConfiguration,
  type FoodGuardDeploymentProof,
  type FoodGuardDeploymentProofConfiguration,
  type FoodGuardReviewedDeploymentProof,
} from "./config";
import type { TxStageHandler } from "./transactions";
import { singleFlight } from "./rpcResilience";

interface Eip1193WalletProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export class WalletAccountChangedAfterSubmissionError extends Error {
  readonly actualAccount: string | null;
  readonly expectedAccount: string;
  readonly transactionHash: TransactionHash;

  constructor(
    transactionHash: TransactionHash,
    expectedAccount: string,
    actualAccount: string | null,
  ) {
    super(
      `Wallet account changed after submission. Transaction ${transactionHash} may already be on StudioNet; reconcile it before retrying.`,
    );
    this.name = "WalletAccountChangedAfterSubmissionError";
    this.transactionHash = transactionHash;
    this.expectedAccount = expectedAccount;
    this.actualAccount = actualAccount;
  }
}

export class WalletAccountUnverifiedAfterSubmissionError extends Error {
  readonly expectedAccount: string;
  readonly transactionHash: TransactionHash;

  constructor(transactionHash: TransactionHash, expectedAccount: string) {
    super(
      `Wallet account could not be verified after submission. Transaction ${transactionHash} may already be on StudioNet; reconcile it before retrying.`,
    );
    this.name = "WalletAccountUnverifiedAfterSubmissionError";
    this.transactionHash = transactionHash;
    this.expectedAccount = expectedAccount;
  }
}

function getWalletProvider(): Eip1193WalletProvider {
  if (typeof window === "undefined") {
    throw new Error("A connected EIP-1193 browser wallet is required");
  }

  const provider = (
    window as typeof window & { ethereum?: Eip1193WalletProvider }
  ).ethereum;
  if (!provider) {
    throw new Error("A connected EIP-1193 browser wallet is required");
  }
  return provider;
}

async function requestConnectedAddress(
  provider: Eip1193WalletProvider,
): Promise<Address> {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof address !== "string" || !isAddress(address, { strict: false })) {
    throw new Error("The connected wallet did not provide a valid account");
  }
  return address;
}

async function requireStudioNetWallet(
  provider: Eip1193WalletProvider,
): Promise<void> {
  const expectedChainId = `0x${FOODGUARD_CHAIN.id.toString(16)}`;
  const chainId = await provider.request({ method: "eth_chainId" });
  if (
    typeof chainId !== "string" ||
    chainId.toLowerCase() !== expectedChainId
  ) {
    throw new Error(
      `Wallet network mismatch: switch to GenLayer StudioNet (chain ID ${FOODGUARD_CHAIN.id}) before writing`,
    );
  }
}

export function getFoodGuardReadClient() {
  return createClient({ chain: FOODGUARD_CHAIN });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalReadArgument(value: CalldataEncodable): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return ["number", Number.isFinite(value) ? value : String(value)];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (value instanceof Uint8Array) {
    return ["bytes", Array.from(value)];
  }
  if (Array.isArray(value)) {
    return ["array", value.map(canonicalReadArgument)];
  }
  if (value instanceof Map) {
    return [
      "map",
      Array.from(value.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalReadArgument(entry)]),
    ];
  }
  const record = value as Record<string, CalldataEncodable>;
  return [
    "object",
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalReadArgument(record[key])]),
  ];
}

function foodGuardReadKey(
  address: string,
  method: string,
  args: CalldataEncodable[],
): string {
  return JSON.stringify([
    FOODGUARD_CHAIN.id,
    address.toLowerCase(),
    method,
    args.map(canonicalReadArgument),
  ]);
}

function runtimeVerificationFailed(
  proof: FoodGuardReviewedDeploymentProof,
  reason: string,
  message: string,
): FoodGuardReviewedDeploymentProof {
  return {
    ...proof,
    runtimeVerification: { status: "FAILED", reason, message },
  };
}

function codeBytes(code: string): Uint8Array {
  if (/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
    const raw = code.slice(2);
    const bytes = new Uint8Array(raw.length / 2);
    for (let index = 0; index < raw.length; index += 2) {
      bytes[index / 2] = Number.parseInt(raw.slice(index, index + 2), 16);
    }
    return bytes;
  }
  return new TextEncoder().encode(code);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

async function sha256(bytes: Uint8Array): Promise<`0x${string}`> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable in this browser");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

/**
 * Turns reviewed public deployment metadata into VERIFIED only after a
 * StudioNet RPC checks the deployment transaction, deployed code, source
 * digest, and this order's authoritative contract readback. Failures retain
 * REVIEWED status so the UI cannot turn an environment assertion into proof.
 */
export async function verifyFoodGuardDeploymentProof(
  configuredProof: FoodGuardDeploymentProofConfiguration,
  orderId: string,
): Promise<FoodGuardDeploymentProof> {
  if (configuredProof.status !== "REVIEWED") return configuredProof;
  if (!isFoodGuardReviewedDeploymentProofForContract(configuredProof, configuredProof.address)) {
    return runtimeVerificationFailed(
      configuredProof,
      "CONFIGURATION_INVALID",
      "Reviewed deployment metadata failed its StudioNet contract binding checks.",
    );
  }
  if (!orderId.trim()) {
    return runtimeVerificationFailed(
      configuredProof,
      "ORDER_ID_REQUIRED",
      "A nonempty order ID is required for authoritative deployment readback.",
    );
  }

  try {
    const client = getFoodGuardReadClient();
    const transaction = await client.getTransaction({
      hash: configuredProof.transactionHash as TransactionHash,
    });
    if (transaction.statusName !== TransactionStatus.FINALIZED) {
      return runtimeVerificationFailed(
        configuredProof,
        "TRANSACTION_NOT_FINALIZED",
        "The configured deployment transaction is not finalized on StudioNet.",
      );
    }
    if (transaction.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
      return runtimeVerificationFailed(
        configuredProof,
        "TRANSACTION_EXECUTION_UNSUCCESSFUL",
        "The configured deployment transaction did not finish successfully on StudioNet.",
      );
    }

    const deployment = transaction.txDataDecoded as Record<string, unknown> | undefined;
    if (
      !deployment ||
      deployment.type !== "deploy" ||
      typeof deployment.contractAddress !== "string" ||
      deployment.contractAddress.toLowerCase() !== configuredProof.address.toLowerCase() ||
      typeof deployment.code !== "string"
    ) {
      return runtimeVerificationFailed(
        configuredProof,
        "DEPLOYMENT_TRANSACTION_MISMATCH",
        "The finalized transaction is not a deployment of the configured FoodGuard contract.",
      );
    }

    const deployedCode = await client.getContractCode(configuredProof.address);
    if (typeof deployedCode !== "string" || !deployedCode) {
      return runtimeVerificationFailed(
        configuredProof,
        "DEPLOYED_CODE_UNAVAILABLE",
        "StudioNet did not return deployed contract code for the configured address.",
      );
    }
    const transactionCode = codeBytes(deployment.code);
    const currentCode = codeBytes(deployedCode);
    if (!sameBytes(transactionCode, currentCode)) {
      return runtimeVerificationFailed(
        configuredProof,
        "DEPLOYED_CODE_MISMATCH",
        "Current contract code does not match the finalized deployment transaction.",
      );
    }
    if ((await sha256(currentCode)).toLowerCase() !== configuredProof.sourceHash.toLowerCase()) {
      return runtimeVerificationFailed(
        configuredProof,
        "SOURCE_HASH_MISMATCH",
        "The deployed contract code does not match the reviewed SHA-256 digest.",
      );
    }

    const readback = await client.readContract({
      address: configuredProof.address,
      functionName: "get_order",
      args: [orderId],
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
    if (!isRecord(readback) || readback.order_id !== orderId) {
      return runtimeVerificationFailed(
        configuredProof,
        "ORDER_READBACK_MISMATCH",
        "The authoritative FoodGuard get_order readback did not match this proof order.",
      );
    }

    return {
      ...configuredProof,
      status: "VERIFIED",
      runtimeVerification: { status: "VERIFIED" },
    };
  } catch (caught: unknown) {
    return runtimeVerificationFailed(
      configuredProof,
      "RUNTIME_RPC_UNAVAILABLE",
      caught instanceof Error
        ? `StudioNet runtime verification failed: ${caught.message}`
        : "StudioNet runtime verification failed before all evidence could be checked.",
    );
  }
}

export async function readFoodGuard<T>(
  method: string,
  args: CalldataEncodable[] = [],
): Promise<T> {
  const { address } = requireFoodGuardConfiguration();
  return singleFlight(foodGuardReadKey(address, method, args), async () =>
    (await getFoodGuardReadClient().readContract({
      address,
      functionName: method,
      args,
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    })) as T,
  );
}

export async function writeFoodGuard(
  method: string,
  args: CalldataEncodable[] = [],
  value = 0n,
  onUpdate?: TxStageHandler,
  expectedAccount?: string,
): Promise<TransactionHash> {
  const { address } = requireFoodGuardConfiguration();
  const provider = getWalletProvider();

  onUpdate?.("WALLET_CONFIRMATION");
  await requireStudioNetWallet(provider);
  const account = await requestConnectedAddress(provider);
  if (
    expectedAccount !== undefined &&
    (!isAddress(expectedAccount, { strict: false }) ||
      account.toLowerCase() !== expectedAccount.toLowerCase())
  ) {
    throw new Error(
      "The connected wallet account changed after preview; reconnect and review the commitments again",
    );
  }
  const client = createClient({
    chain: FOODGUARD_CHAIN,
    account,
    provider,
  });
  const hash: unknown = await client.writeContract({
    address,
    functionName: method,
    args,
    value,
  });
  if (typeof hash !== "string" || !isHex(hash) || hash.length !== 66) {
    throw new Error("StudioNet returned an invalid transaction hash");
  }

  onUpdate?.("SUBMITTED");
  const transactionHash = hash as TransactionHash;
  const submittedAccount = expectedAccount ?? account;
  let currentAccount: string | null = null;
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    const candidate = Array.isArray(accounts) ? accounts[0] : undefined;
    if (typeof candidate === "string" && isAddress(candidate, { strict: false })) {
      currentAccount = candidate;
    }
  } catch {
    // A hash exists, so failure to recheck must remain recoverable rather than
    // being reported as an authorized success.
  }
  if (
    currentAccount === null
  ) {
    throw new WalletAccountUnverifiedAfterSubmissionError(
      transactionHash,
      submittedAccount,
    );
  }
  if (
    currentAccount.toLowerCase() !== submittedAccount.toLowerCase()
  ) {
    throw new WalletAccountChangedAfterSubmissionError(
      transactionHash,
      submittedAccount,
      currentAccount,
    );
  }

  return transactionHash;
}

export async function reconcileOrder<T = unknown>(orderId: string): Promise<T> {
  if (!orderId.trim()) {
    throw new Error("An order id is required for authoritative readback");
  }
  return readFoodGuard<T>("get_order", [orderId]);
}
