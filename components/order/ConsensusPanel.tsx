"use client";

import { useEffect, useState } from "react";

import type { TxStage } from "../../lib/genlayer/transactions";
import { useLocale } from "../../lib/i18n";
import type { OrderDetailView } from "./ItemOutcomeTable";
import { authoritativeNowMs, type AuthoritativeClock } from "./authoritativeClock";

interface ConsensusPanelProps {
  disabled?: boolean;
  clock?: AuthoritativeClock | null;
  onResolve?(): void;
  onSettle?(): void;
  order: OrderDetailView;
  stage: TxStage | null;
}

function parseDeadline(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint" && value >= 0n) return value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
    return null;
  } catch {
    return null;
  }
}

function canRequestResolution(order: OrderDetailView, now: bigint | null): boolean {
  if (now === null) return false;
  if (order.state === "EVIDENCE_CURE") return true;
  if (order.state === "REVIEW_WINDOW") {
    const deadline = parseDeadline(order.review_deadline);
    return deadline !== null && now >= deadline;
  }
  if (order.state === "APPEALED") {
    const deadline = parseDeadline(order.appeal_deadline);
    return deadline !== null && now >= deadline;
  }
  return false;
}

export function ConsensusPanel({
  clock,
  disabled = false,
  onResolve,
  onSettle,
  order,
  stage,
}: ConsensusPanelProps) {
  const { copy } = useLocale();
  const [now, setNow] = useState<bigint | null>(null);
  const eligible = canRequestResolution(order, now);
  const appealDeadline = parseDeadline(order.appeal_deadline);
  const settlementEligible = (
    order.state === "RESOLVED" &&
    appealDeadline !== null &&
    now !== null &&
    now >= appealDeadline
  );
  const failed = stage === "CONSENSUS_FAILED";

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
      const target = order.state === "REVIEW_WINDOW"
        ? parseDeadline(order.review_deadline)
        : order.state === "APPEALED" || order.state === "RESOLVED"
          ? parseDeadline(order.appeal_deadline)
          : null;
      if (target === null || nowSeconds >= target) return;
      const untilBoundary = target * 1_000n - nowMs;
      const maximum = 2_147_483_647n;
      timer = window.setTimeout(refresh, Number(untilBoundary > maximum ? maximum : untilBoundary));
    };
    refresh();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [clock, order.appeal_deadline, order.review_deadline, order.state]);

  return (
    <section className="order-card consensus-panel" aria-labelledby="consensus-title">
      <h2 id="consensus-title">{copy.detail.consensusTitle}</h2>
      <p>{copy.detail.consensusIntro}</p>
      {stage && <p className="consensus-panel__stage"><code>{stage}</code></p>}
      {failed && (
        <p className="form-notice form-notice--warning">
          {copy.detail.consensusFailureDistinct}
        </p>
      )}
      {eligible && onResolve && (
        <button
          className="button button--primary"
          disabled={disabled}
          onClick={onResolve}
          type="button"
        >
          {failed ? copy.detail.retryResolution : copy.detail.requestResolution}
        </button>
      )}
      {settlementEligible && onSettle && (
        <button
          className="button button--primary"
          disabled={disabled}
          onClick={onSettle}
          type="button"
        >
          {copy.detail.executeSettlement}
        </button>
      )}
      {!eligible && !settlementEligible && !failed && <p className="form-notice">{copy.detail.resolutionUnavailable}</p>}
    </section>
  );
}
