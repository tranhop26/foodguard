import { createClient } from "genlayer-js";
import type {
  CalldataEncodable,
  TransactionHash,
} from "genlayer-js/types";
import { TransactionHashVariant } from "genlayer-js/types";
import { isAddress, isHex, type Address } from "viem";

import { FOODGUARD_CHAIN, requireFoodGuardConfiguration } from "./config";
import type { TxStageHandler } from "./transactions";

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

export async function readFoodGuard<T>(
  method: string,
  args: CalldataEncodable[] = [],
): Promise<T> {
  const { address } = requireFoodGuardConfiguration();
  return (await getFoodGuardReadClient().readContract({
    address,
    functionName: method,
    args,
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  })) as T;
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
