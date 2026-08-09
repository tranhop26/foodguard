"use client";

import { useEffect, useState } from "react";

import { useLocale } from "../../lib/i18n";
import { deriveWalletRole } from "../wallet/WalletButton";
import type { OrderDetailView } from "./ItemOutcomeTable";
import { authoritativeNowMs, type AuthoritativeClock } from "./authoritativeClock";

interface AppealPanelProps {
  address?: string | null;
  clock?: AuthoritativeClock | null;
  disabled?: boolean;
  onAppeal?(): void;
  onCure?(): void;
  order: OrderDetailView;
}

const MAX_U64 = (1n << 64n) - 1n;

function deadlineSeconds(value: unknown): bigint | null {
  try {
    let parsed: bigint;
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
    else return null;
    return parsed >= 0n && parsed <= MAX_U64 ? parsed : null;
  } catch {
    return null;
  }
}

export function AppealPanel({
  address,
  clock,
  disabled = false,
  onAppeal,
  onCure,
  order,
}: AppealPanelProps) {
  const { copy } = useLocale();
  const [now, setNow] = useState<bigint | null>(null);
  const role = address
    ? deriveWalletRole(address, [order.customer, order.restaurant, order.courier])
    : null;
  const participant = role !== null && role !== "OUTSIDER";
  const normalizedAddress = address?.toLowerCase();
  const authoritativeCorrectionActions = new Set(order.evidence
    ?.filter((record) => record.actor_wallet.toLowerCase() === normalizedAddress)
    .map((record) => record.action)
    .filter((action) => action === "CURE" || action === "APPEAL") ?? []);
  const cureUsed = authoritativeCorrectionActions.has("CURE");
  const appealUsed = authoritativeCorrectionActions.has("APPEAL");
  const deadline = deadlineSeconds(order.appeal_deadline);
  const appealOpen = (
    participant &&
    (order.state === "RESOLVED" || order.state === "APPEALED") &&
    deadline !== null &&
    now !== null &&
    now < deadline &&
    !appealUsed
  );
  const cureOpen = participant && order.state === "EVIDENCE_CURE" && !cureUsed;
  const remaining = deadline !== null && now !== null && now < deadline
    ? deadline - now
    : null;

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      const nowMs = authoritativeNowMs(clock);
      if (nowMs === null) {
        setNow(null);
        return;
      }
      const nowSeconds = nowMs / 1_000n;
      setNow(nowSeconds);
      const parsed = deadlineSeconds(order.appeal_deadline);
      if (parsed === null || nowSeconds >= parsed) return;
      const untilBoundary = parsed * 1_000n - nowMs;
      timer = window.setTimeout(refresh, Number(untilBoundary < 1_000n ? untilBoundary : 1_000n));
    };
    refresh();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [clock, order.appeal_deadline]);

  return (
    <section className="order-card" aria-labelledby="appeal-title">
      <h2 id="appeal-title">{copy.detail.cureAndAppeal}</h2>
      {order.state === "EVIDENCE_CURE" && (
        <p className="form-notice form-notice--warning">
          {copy.detail.unresolvedReserved}
        </p>
      )}
      {order.state === "ESCALATED" && (
        <p className="form-notice form-notice--warning">
          {copy.detail.escalatedReserved}
        </p>
      )}
      {deadline !== null && (
        <dl className="order-facts">
          <div>
            <dt>{copy.detail.appealDeadline}</dt>
            <dd>
              <code>{deadline.toString()}</code>
              {remaining !== null && <span>{remaining.toString()} {copy.detail.secondsRemaining}</span>}
            </dd>
          </div>
        </dl>
      )}
      {cureOpen && (
        <button className="button button--primary" disabled={disabled} onClick={onCure} type="button">
          {copy.detail.addCureEvidence}
        </button>
      )}
      {appealOpen && (
        <button className="button button--primary" disabled={disabled} onClick={onAppeal} type="button">
          {copy.detail.appeal}
        </button>
      )}
      {!cureOpen && !appealOpen && order.state !== "ESCALATED" && (
        <p className="form-notice">{copy.detail.noAppealAction}</p>
      )}
    </section>
  );
}
