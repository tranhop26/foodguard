"use client";

import { use, useEffect, useState } from "react";

import { ItemOutcomeTable, type OrderDetailView } from "../../../../components/order/ItemOutcomeTable";
import {
  FOODGUARD_CHAIN,
  getFoodGuardConfiguration,
  getFoodGuardDeploymentProofConfiguration,
  getFoodGuardPublicAppOriginConfiguration,
  isFoodGuardReviewedDeploymentProofForContract,
  isFoodGuardVerifiedDeploymentProofForContract,
  type FoodGuardDeploymentProof,
  type FoodGuardDeploymentProofConfiguration,
} from "../../../../lib/genlayer/config";
import { verifyFoodGuardDeploymentProof } from "../../../../lib/genlayer/client";
import { LocaleProvider, type Locale, useLocale, WorkflowShell } from "../../../../lib/i18n";
import { readAuthoritativeOrder } from "../page";

const terminalProofStates = new Set<string>([
  "SETTLED",
  "CANCELLED_REFUNDED",
  "FULFILLMENT_TIMEOUT_REFUNDED",
]);

function readbackJson(order: OrderDetailView): string {
  return JSON.stringify(
    order,
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value,
    2,
  );
}

export function ProofView({
  chainId,
  contractAddress,
  deploymentProof,
  order,
  runtimeVerifier = verifyFoodGuardDeploymentProof,
}: {
  chainId: string;
  contractAddress: string;
  deploymentProof?: FoodGuardDeploymentProofConfiguration;
  order: OrderDetailView;
  runtimeVerifier?: (
    proof: FoodGuardDeploymentProofConfiguration,
    orderId: string,
  ) => Promise<FoodGuardDeploymentProof>;
}) {
  const { copy } = useLocale();
  const [runtimeProof, setRuntimeProof] = useState<FoodGuardDeploymentProof>(
    () => deploymentProof ?? getFoodGuardDeploymentProofConfiguration(),
  );
  const terminalState = terminalProofStates.has(order.state);
  const terminalVerified = terminalState && order.settlement != null;
  const verifiedDeploymentProof = isFoodGuardVerifiedDeploymentProofForContract(
    runtimeProof,
    contractAddress,
  ) ? runtimeProof : null;
  const reviewedDeploymentProof = isFoodGuardReviewedDeploymentProofForContract(
    runtimeProof,
    contractAddress,
  ) ? runtimeProof : null;
  const deploymentProofUnavailableReason = runtimeProof.status === "UNAVAILABLE"
    ? runtimeProof.reason
    : "CONTRACT_ADDRESS_MISMATCH";
  const deploymentProofUnavailableMessage = runtimeProof.status === "UNAVAILABLE"
    ? runtimeProof.message
    : "Deployment provenance is unavailable because the deployment record does not match this contract address.";

  useEffect(() => {
    let active = true;
    const configured = deploymentProof ?? getFoodGuardDeploymentProofConfiguration();
    setRuntimeProof(configured);
    if (configured.status !== "REVIEWED") return () => { active = false; };
    void runtimeVerifier(configured, order.order_id).then((verified) => {
      if (active) setRuntimeProof(verified);
    }).catch((caught: unknown) => {
      if (!active) return;
      setRuntimeProof({
        ...configured,
        runtimeVerification: {
          status: "FAILED",
          reason: "RUNTIME_VERIFIER_FAILED",
          message: caught instanceof Error
            ? caught.message
            : "StudioNet runtime verification did not complete.",
        },
      });
    });
    return () => { active = false; };
  }, [deploymentProof, order.order_id, runtimeVerifier]);

  return (
    <article className="proof-view" aria-labelledby="proof-title">
      <header className="proof-view__header">
        <p className="eyebrow">
          {terminalVerified ? copy.detail.proofEyebrowTerminal : copy.detail.proofEyebrowCurrent}
        </p>
        <h1 id="proof-title">
          {terminalVerified ? copy.detail.proofTitleTerminal : copy.detail.proofTitleCurrent}
        </h1>
        <p>{copy.detail.proofIntro}</p>
        {!terminalVerified && (
          <p className="form-notice form-notice--warning">{copy.detail.nonterminalProof}</p>
        )}
      </header>
      <section className="order-card" aria-labelledby="proof-domain-title">
        <h2 id="proof-domain-title">{copy.detail.proofDomain}</h2>
        <dl className="order-facts proof-facts">
          <div><dt>{copy.detail.chainId}</dt><dd><code>{chainId}</code></dd></div>
          <div><dt>{copy.detail.contractAddress}</dt><dd><code>{contractAddress}</code></dd></div>
          <div><dt>Order ID</dt><dd><code>{order.order_id}</code></dd></div>
          <div><dt>{copy.console.state}</dt><dd><code>{order.state}</code></dd></div>
          {order.settlement?.settlement_id && (
            <div><dt>{copy.detail.settlementId}</dt><dd><code>{order.settlement.settlement_id}</code></dd></div>
          )}
        </dl>
      </section>
      <section className="order-card" aria-labelledby="proof-deployment-title">
        <h2 id="proof-deployment-title">{copy.detail.deploymentVerification}</h2>
        {verifiedDeploymentProof ? (
          <>
            <p>{copy.detail.deploymentProofVerified}</p>
            <dl className="order-facts proof-facts">
              <div><dt>{copy.detail.contractSourceHash}</dt><dd><code>{verifiedDeploymentProof.sourceHash}</code></dd></div>
              <div><dt>{copy.detail.transactionHash}</dt><dd><code>{verifiedDeploymentProof.transactionHash}</code></dd></div>
              <div>
                <dt>{copy.detail.deploymentTransactionLifecycle}</dt>
                <dd><code>{`${verifiedDeploymentProof.finality} → ${verifiedDeploymentProof.execution} → ${verifiedDeploymentProof.readback}`}</code></dd>
              </div>
            </dl>
          </>
        ) : reviewedDeploymentProof ? (
          <>
            <p className="form-notice form-notice--warning">{copy.detail.deploymentProofReviewed}</p>
            <dl className="order-facts proof-facts">
              <div><dt>{copy.detail.contractSourceHash}</dt><dd><code>{reviewedDeploymentProof.sourceHash}</code></dd></div>
              <div><dt>{copy.detail.transactionHash}</dt><dd><code>{reviewedDeploymentProof.transactionHash}</code></dd></div>
              <div>
                <dt>{copy.detail.deploymentTransactionLifecycle}</dt>
                <dd><code>{`${reviewedDeploymentProof.finality} → ${reviewedDeploymentProof.execution} → ${reviewedDeploymentProof.readback}`}</code></dd>
              </div>
              <div>
                <dt>{copy.detail.runtimeVerification}</dt>
                <dd><code>{reviewedDeploymentProof.runtimeVerification.status}</code></dd>
              </div>
            </dl>
            {reviewedDeploymentProof.runtimeVerification.status === "FAILED" && (
              <p><code>{reviewedDeploymentProof.runtimeVerification.reason}</code> {reviewedDeploymentProof.runtimeVerification.message}</p>
            )}
          </>
        ) : (
          <>
            <p className="form-notice form-notice--warning">{copy.detail.deploymentProofUnavailable}</p>
            <p><code>{deploymentProofUnavailableReason}</code> {deploymentProofUnavailableMessage}</p>
          </>
        )}
      </section>
      {order.settlement && (
        <section className="order-card" aria-labelledby="proof-allocation-title">
          <h2 id="proof-allocation-title">{copy.detail.settlementAllocations}</h2>
          <dl className="order-facts">
            <div><dt>{copy.roles.CUSTOMER}</dt><dd><code>{String(order.settlement.customer_wei)} wei</code> <span>Simulated GEN</span></dd></div>
            <div><dt>{copy.roles.RESTAURANT}</dt><dd><code>{String(order.settlement.restaurant_wei)} wei</code> <span>Simulated GEN</span></dd></div>
            <div><dt>{copy.roles.COURIER}</dt><dd><code>{String(order.settlement.courier_wei)} wei</code> <span>Simulated GEN</span></dd></div>
          </dl>
        </section>
      )}
      <section className="order-card" aria-labelledby="proof-evidence-title">
        <h2 id="proof-evidence-title">{copy.detail.proofEvidence}</h2>
        {order.evidence?.length ? (
          <ol className="evidence-history">
            {order.evidence.map((record, index) => (
              <li key={`${record.sha256}-${index}`}>
                <code>{record.action}</code>
                <code>{record.sha256}</code>
                <a href={record.source_url} rel="noreferrer" target="_blank">{record.source_url}</a>
              </li>
            ))}
          </ol>
        ) : <p className="form-notice">{copy.detail.noEvidence}</p>}
        {order.resolution?.evidence_hashes.length ? (
          <div className="proof-resolution-digests">
            <h3>{copy.detail.consensusEvidenceDigests}</h3>
            {order.resolution.evidence_hashes.map((hash) => <code key={hash}>{hash}</code>)}
          </div>
        ) : null}
      </section>
      <ItemOutcomeTable order={order} />
      <section className="order-card" aria-labelledby="proof-readback-title">
        <h2 id="proof-readback-title">{copy.detail.authoritativeReadback}</h2>
        <p>{copy.detail.readbackProof}</p>
        <pre className="proof-readback">{readbackJson(order)}</pre>
      </section>
    </article>
  );
}

function ProofWorkspace({
  contractAddress,
  deploymentProof,
  deploymentMessage,
  orderId,
  publicOriginMessage,
}: {
  contractAddress: string | null;
  deploymentProof: FoodGuardDeploymentProofConfiguration;
  deploymentMessage?: string;
  orderId: string;
  publicOriginMessage?: string;
}) {
  const { copy } = useLocale();
  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!contractAddress) return () => { active = false; };
    void readAuthoritativeOrder(orderId).then((readback) => {
      if (active) setOrder(readback);
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : copy.detail.readFailed);
    });
    return () => { active = false; };
  }, [contractAddress, copy.detail.readFailed, orderId]);

  if (!contractAddress) {
    return (
      <section className="deployment-note order-configuration-state" role="status">
        <strong>DEPLOYMENT_REQUIRED</strong>
        <span>{deploymentMessage}</span>
      </section>
    );
  }
  return (
    <>
      {publicOriginMessage && (
        <section className="deployment-note order-configuration-state" role="status">
          <strong>PUBLIC_APP_ORIGIN_REQUIRED</strong>
          <span>{publicOriginMessage}</span>
        </section>
      )}
      {!order && !error && <p className="form-notice" role="status">{copy.detail.reading}</p>}
      {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
      {order && (
        <ProofView
          chainId={String(FOODGUARD_CHAIN.id)}
          contractAddress={contractAddress}
          deploymentProof={deploymentProof}
          order={order}
        />
      )}
    </>
  );
}

type DynamicParams = Promise<{ id: string }>;
type ProofSearchParams = Promise<{
  locale?: string | string[];
}>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function ProofPage({
  params,
  searchParams,
}: {
  params: DynamicParams;
  searchParams: ProofSearchParams;
}) {
  const { id } = use(params);
  const query = use(searchParams);
  const rawLocale = first(query.locale);
  const locale: Locale = rawLocale === "en" ? "en" : "vi";
  const contract = getFoodGuardConfiguration();
  const deploymentProof = getFoodGuardDeploymentProofConfiguration();
  const publicOrigin = getFoodGuardPublicAppOriginConfiguration();

  return (
    <LocaleProvider hasExplicitLocale={Boolean(rawLocale)} initialLocale={locale}>
      <WorkflowShell page="orders">
        <ProofWorkspace
          contractAddress={contract.address}
          deploymentProof={deploymentProof}
          deploymentMessage={contract.status === "DEPLOYMENT_REQUIRED" ? contract.message : undefined}
          orderId={id}
          publicOriginMessage={publicOrigin.status === "PUBLIC_APP_ORIGIN_REQUIRED" ? publicOrigin.message : undefined}
        />
      </WorkflowShell>
    </LocaleProvider>
  );
}
