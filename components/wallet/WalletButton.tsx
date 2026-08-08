"use client";

import { useCallback, useEffect, useState } from "react";
import { isAddress, zeroAddress } from "viem";

import { FOODGUARD_CHAIN } from "../../lib/genlayer/config";
import { useLocale } from "../../lib/i18n";

export type WalletRole = "CUSTOMER" | "RESTAURANT" | "COURIER" | "OUTSIDER";
export type WalletStatus = "DISCONNECTED" | "READY" | "WRONG_CHAIN" | "ERROR";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface WalletSnapshot {
  address: string | null;
  chainId: string | null;
  role: WalletRole;
  status: WalletStatus;
}

interface WalletButtonProps {
  actors?: readonly [string, string, string];
  onChange?(snapshot: WalletSnapshot): void;
}

const DISCONNECTED: WalletSnapshot = {
  address: null,
  chainId: null,
  role: "OUTSIDER",
  status: "DISCONNECTED",
};

const expectedChainId = `0x${FOODGUARD_CHAIN.id.toString(16)}`;

function walletProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as typeof window & { ethereum?: Eip1193Provider }).ethereum;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function deriveWalletRole(
  address: string,
  actors: readonly [string, string, string],
): WalletRole {
  if (sameAddress(address, actors[0])) return "CUSTOMER";
  if (sameAddress(address, actors[1])) return "RESTAURANT";
  if (sameAddress(address, actors[2])) return "COURIER";
  return "OUTSIDER";
}

export function WalletButton({
  actors = ["", "", ""],
  onChange,
}: WalletButtonProps) {
  const { copy } = useLocale();
  const [snapshot, setSnapshot] = useState<WalletSnapshot>(DISCONNECTED);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const commitSnapshot = useCallback(
    (address: string, chainId: string) => {
      const next: WalletSnapshot = {
        address,
        chainId,
        role: deriveWalletRole(address, actors),
        status: chainId.toLowerCase() === expectedChainId ? "READY" : "WRONG_CHAIN",
      };
      setSnapshot(next);
      setError(null);
    },
    [actors],
  );

  useEffect(() => {
    if (!snapshot.address) return;
    const nextRole = deriveWalletRole(snapshot.address, actors);
    if (nextRole !== snapshot.role) {
      setSnapshot((current) => ({ ...current, role: nextRole }));
    }
  }, [actors, snapshot.address, snapshot.role]);

  useEffect(() => {
    onChange?.(snapshot);
  }, [onChange, snapshot]);

  async function connect() {
    const provider = walletProvider();
    if (!provider) {
      setError(copy.wallet.missing);
      setSnapshot({ ...DISCONNECTED, status: "ERROR" });
      return;
    }
    setBusy(true);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const chainId = await provider.request({ method: "eth_chainId" });
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      if (
        typeof address !== "string" ||
        !isAddress(address, { strict: false }) ||
        sameAddress(address, zeroAddress) ||
        typeof chainId !== "string"
      ) {
        throw new Error(copy.wallet.invalidAccount);
      }
      commitSnapshot(address, chainId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.wallet.invalidAccount);
      setSnapshot({ ...DISCONNECTED, status: "ERROR" });
    } finally {
      setBusy(false);
    }
  }

  async function switchNetwork() {
    const provider = walletProvider();
    if (!provider) {
      setError(copy.wallet.missing);
      return;
    }
    setBusy(true);
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: expectedChainId }],
      });
      const [accounts, chainId] = await Promise.all([
        provider.request({ method: "eth_accounts" }),
        provider.request({ method: "eth_chainId" }),
      ]);
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof address !== "string" || typeof chainId !== "string") {
        throw new Error(copy.wallet.invalidAccount);
      }
      commitSnapshot(address, chainId);
    } catch {
      setError(copy.wallet.switchFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wallet-panel" aria-labelledby="wallet-heading">
      <div className="wallet-panel__heading">
        <h2 id="wallet-heading">{copy.wallet.connected}</h2>
        {snapshot.status === "READY" && <span className="status-chip">{copy.wallet.networkReady}</span>}
      </div>

      {snapshot.address ? (
        <dl className="wallet-panel__details">
          <div>
            <dt>Address</dt>
            <dd><code>{snapshot.address}</code></dd>
          </div>
          <div>
            <dt>{copy.wallet.role}</dt>
            <dd>{copy.roles[snapshot.role]} <code>{snapshot.role}</code></dd>
          </div>
        </dl>
      ) : (
        <button className="button button--primary" disabled={busy} onClick={connect} type="button">
          {copy.wallet.connect}
        </button>
      )}

      {snapshot.status === "WRONG_CHAIN" && (
        <div className="form-notice form-notice--warning" role="alert">
          <p>{copy.wallet.wrongNetwork}</p>
          <button className="button button--quiet" disabled={busy} onClick={switchNetwork} type="button">
            {copy.wallet.switchNetwork}
          </button>
        </div>
      )}
      {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
    </section>
  );
}
