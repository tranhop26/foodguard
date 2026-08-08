"use client";

import { use, useEffect, useState } from "react";

import { ItemOutcomeTable, type OrderDetailView } from "../../../../components/order/ItemOutcomeTable";
import {
  FOODGUARD_CHAIN,
  getFoodGuardConfiguration,
  getFoodGuardPublicAppOriginConfiguration,
} from "../../../../lib/genlayer/config";
import { LocaleProvider, type Locale, useLocale, WorkflowShell } from "../../../../lib/i18n";
import { readAuthoritativeOrder } from "../page";

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
  order,
}: {
  chainId: string;
  contractAddress: string;
  order: OrderDetailView;
}) {
  const { copy } = useLocale();

  return (
    <article className="proof-view" aria-labelledby="proof-title">
      <header className="proof-view__header">
        <p className="eyebrow">{copy.detail.proofEyebrow}</p>
        <h1 id="proof-title">{copy.detail.proofTitle}</h1>
        <p>{copy.detail.proofIntro}</p>
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
  deploymentMessage,
  orderId,
  publicOriginMessage,
}: {
  contractAddress: string | null;
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
  const publicOrigin = getFoodGuardPublicAppOriginConfiguration();

  return (
    <LocaleProvider hasExplicitLocale={Boolean(rawLocale)} initialLocale={locale}>
      <WorkflowShell page="orders">
        <ProofWorkspace
          contractAddress={contract.address}
          deploymentMessage={contract.status === "DEPLOYMENT_REQUIRED" ? contract.message : undefined}
          orderId={id}
          publicOriginMessage={publicOrigin.status === "PUBLIC_APP_ORIGIN_REQUIRED" ? publicOrigin.message : undefined}
        />
      </WorkflowShell>
    </LocaleProvider>
  );
}
