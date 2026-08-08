"use client";

import type { TxStage } from "../../lib/genlayer/transactions";
import { useLocale } from "../../lib/i18n";

const progression: TxStage[] = [
  "WALLET_CONFIRMATION",
  "SUBMITTED",
  "CONSENSUS_PENDING",
  "FINALIZED",
  "EXECUTION_SUCCESS",
  "READBACK_CONFIRMED",
];

export function TransactionLifecycle({
  actorAddress,
  operation,
  stage,
}: {
  actorAddress?: string | null;
  operation?: string | null;
  stage: TxStage | null;
}) {
  const { copy } = useLocale();
  if (!stage) return null;

  const currentIndex = progression.indexOf(stage);
  const walletConfirmed = currentIndex > progression.indexOf("WALLET_CONFIRMATION") || stage === "CONSENSUS_FAILED" || stage === "EXECUTION_ERROR";
  const submitted = currentIndex >= progression.indexOf("SUBMITTED") || stage === "CONSENSUS_FAILED" || stage === "EXECUTION_ERROR";
  const consensusPending = currentIndex >= progression.indexOf("CONSENSUS_PENDING") || stage === "CONSENSUS_FAILED" || stage === "EXECUTION_ERROR";
  const finalized = currentIndex >= progression.indexOf("FINALIZED") || stage === "EXECUTION_ERROR";
  const readbackConfirmed = stage === "READBACK_CONFIRMED";

  return (
    <section className="transaction-lifecycle" aria-live="polite" aria-labelledby="transaction-title">
      <h2 id="transaction-title">{copy.detail.transactionLifecycle}</h2>
      <ol>
        <li data-complete={walletConfirmed || undefined}>
          <code>WALLET_CONFIRMATION</code>
          <span>{walletConfirmed ? copy.detail.walletConfirmed : copy.detail.walletConfirmationPending}</span>
        </li>
        <li data-complete={submitted || undefined}>
          <code>SUBMITTED</code>
          <span>{submitted ? copy.detail.stageRecorded : copy.detail.stagePending}</span>
        </li>
        <li data-complete={consensusPending || undefined}>
          <code>{stage === "CONSENSUS_FAILED" ? "CONSENSUS_FAILED" : "CONSENSUS_PENDING"}</code>
          <span>{stage === "CONSENSUS_FAILED" ? copy.detail.consensusFailed : copy.detail.validatorProgress}</span>
        </li>
        <li data-complete={finalized || undefined}>
          <code>FINALIZED</code>
          <span>{finalized ? copy.detail.finalityRecorded : copy.detail.stagePending}</span>
        </li>
        <li data-complete={stage === "EXECUTION_SUCCESS" || readbackConfirmed || undefined}>
          <code>
            {stage === "EXECUTION_ERROR"
              ? "EXECUTION_ERROR"
              : stage === "EXECUTION_SUCCESS" || readbackConfirmed
                ? "EXECUTION_SUCCESS"
                : "EXECUTION_PENDING"}
          </code>
          <span>
            {stage === "EXECUTION_ERROR"
              ? copy.detail.executionError
              : stage === "EXECUTION_SUCCESS" || readbackConfirmed
                ? copy.detail.executionSuccess
                : copy.detail.stagePending}
          </span>
        </li>
        <li data-complete={readbackConfirmed || undefined}>
          <code>{readbackConfirmed ? "READBACK_CONFIRMED" : "READBACK_PENDING"}</code>
          <span>{readbackConfirmed ? copy.detail.readbackConfirmed : copy.detail.readbackPending}</span>
        </li>
      </ol>
      {stage === "CONSENSUS_FAILED" && operation === "request_resolution" && (
        <p className="form-notice form-notice--warning">{copy.detail.consensusUnchanged}</p>
      )}
      {stage === "CONSENSUS_FAILED" && operation !== "request_resolution" && actorAddress && operation && (
        <p className="form-notice form-notice--warning">
          {copy.detail.consensusActorRetry} <code>{actorAddress}</code>{" "}
          {copy.detail.consensusOperation} <code>{operation}</code>
        </p>
      )}
      {stage === "CONSENSUS_FAILED" && operation !== "request_resolution" && (!actorAddress || !operation) && (
        <p className="form-notice form-notice--warning">{copy.detail.consensusRetryUnspecified}</p>
      )}
    </section>
  );
}
