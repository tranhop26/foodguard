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
): Promise<TransactionHash> {
  const { address } = requireFoodGuardConfiguration();
  const provider = getWalletProvider();

  onUpdate?.("WALLET_CONFIRMATION");
  const account = await requestConnectedAddress(provider);
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
  return hash as TransactionHash;
}

export async function reconcileOrder<T = unknown>(orderId: string): Promise<T> {
  if (!orderId.trim()) {
    throw new Error("An order id is required for authoritative readback");
  }
  return readFoodGuard<T>("get_order", [orderId]);
}
