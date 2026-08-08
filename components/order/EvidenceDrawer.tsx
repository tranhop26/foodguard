"use client";

import { useEffect, useMemo, useState } from "react";

import type { EvidenceAction, EvidenceDocument, JsonValue, OrderItem } from "../../lib/domain";
import {
  canonicalizeEvidence,
  canonicalizeEvidenceEnvelope,
  hashEvidence,
} from "../../lib/evidence";
import { useLocale } from "../../lib/i18n";
import type { OrderDetailView } from "./ItemOutcomeTable";
import { authoritativeNowMs, type AuthoritativeClock } from "./authoritativeClock";

type WritableEvidenceAction = Exclude<EvidenceAction, "ORDER_MANIFEST">;
const EVIDENCE_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface EvidenceDrawerProps {
  action: WritableEvidenceAction;
  address: string;
  chainId: string;
  clock?: AuthoritativeClock | null;
  contractAddress: string;
  disabled?: boolean;
  itemId?: string;
  nonce?: string;
  now?: Date;
  onSubmit?(envelopeJson: string): Promise<void> | void;
  order: OrderDetailView;
  sourceUrl?: string;
}

function manifestItems(manifestJson: string): OrderItem[] | null {
  try {
    const parsed: unknown = JSON.parse(manifestJson);
    if (typeof parsed !== "object" || parsed === null || !("items" in parsed)) return null;
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    if (!items.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Partial<OrderItem>;
      return typeof candidate.item_id === "string" && candidate.item_id.length > 0;
    })) return null;
    return items as OrderItem[];
  } catch {
    return null;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function isPublicEvidenceUrl(value: string): boolean {
  try {
    if (new TextEncoder().encode(value).length > 2_048) return false;
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || !hostname) return false;
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      hostname.startsWith("[") ||
      isPrivateIpv4(hostname) ||
      hostname === "example.com" ||
      hostname.endsWith(".example") ||
      hostname.endsWith(".example.com") ||
      hostname.endsWith(".invalid") ||
      hostname.endsWith(".test")
    ) return false;
    return true;
  } catch {
    return false;
  }
}

function createNonce(): string | null {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") return null;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function evidenceExpiryMs(capturedNow: Date, appealDeadline: unknown): number | null {
  if (!Number.isFinite(capturedNow.getTime())) return null;
  try {
    let seconds: bigint;
    if (typeof appealDeadline === "bigint") seconds = appealDeadline;
    else if (typeof appealDeadline === "number" && Number.isSafeInteger(appealDeadline)) seconds = BigInt(appealDeadline);
    else if (typeof appealDeadline === "string" && /^(0|[1-9][0-9]*)$/.test(appealDeadline)) seconds = BigInt(appealDeadline);
    else return null;
    if (seconds < 0n) return null;
    const deadlineMs = seconds * 1_000n;
    const latestMs = BigInt(8_640_000_000_000_000 - EVIDENCE_SAFETY_WINDOW_MS);
    if (deadlineMs > latestMs) return null;
    return Math.max(
      capturedNow.getTime() + EVIDENCE_SAFETY_WINDOW_MS,
      Number(deadlineMs) + EVIDENCE_SAFETY_WINDOW_MS,
    );
  } catch {
    return null;
  }
}

function actionFacts(
  action: WritableEvidenceAction,
  items: OrderItem[],
  itemId: string | undefined,
  packedObservations: Record<string, string>,
  deliveryObservation: string,
  claimCategory: string,
): Record<string, JsonValue> | null {
  if (action === "PACKED") {
    if (items.some((item) => ![
      "PACKED_AS_ORDERED", "NOT_PACKED", "PACKED_DIFFERENT",
    ].includes(packedObservations[item.item_id] ?? ""))) return null;
    return {
      item_observations: items.map((item) => ({
        item_id: item.item_id,
        observation: packedObservations[item.item_id],
      })),
    };
  }
  if (action === "DELIVERED") {
    return ["HANDOFF_CONFIRMED", "HANDOFF_FAILED"].includes(deliveryObservation)
      ? { delivery_observation: deliveryObservation }
      : null;
  }
  if (action === "CUSTOMER_CLAIM") {
    if (!itemId || !items.some((item) => item.item_id === itemId)) return null;
    if (![
      "ABSENT_AT_RECEIPT", "NOT_AS_ORDERED", "HANDOFF_NOT_RECEIVED",
    ].includes(claimCategory)) return null;
    return { claim_category: claimCategory };
  }
  return {};
}

export function EvidenceDrawer({
  action,
  address,
  chainId,
  clock,
  contractAddress,
  disabled = false,
  itemId,
  nonce: providedNonce,
  now: providedNow,
  onSubmit,
  order,
  sourceUrl = "",
}: EvidenceDrawerProps) {
  const { copy } = useLocale();
  const [capturedNow, setCapturedNow] = useState(() => providedNow ?? new Date());
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Number(authoritativeNowMs(clock) ?? 0n));
  const [nonce, setNonce] = useState(() => providedNonce ?? createNonce());
  const [url, setUrl] = useState(sourceUrl);
  const [packedObservations, setPackedObservations] = useState<Record<string, string>>({});
  const [deliveryObservation, setDeliveryObservation] = useState("");
  const [selectedItemId, setSelectedItemId] = useState(itemId ?? "");
  const [claimCategory, setClaimCategory] = useState("");
  const [envelopeJson, setEnvelopeJson] = useState<string | null>(null);
  const [publicDocument, setPublicDocument] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [verifyingSource, setVerifyingSource] = useState(false);
  const [verifiedDigest, setVerifiedDigest] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => manifestItems(order.manifest_json), [order.manifest_json]);
  const sourceReady = isPublicEvidenceUrl(url);
  const effectiveItemId = action === "CUSTOMER_CLAIM" ? selectedItemId : itemId;
  const expiryMs = useMemo(
    () => evidenceExpiryMs(capturedNow, order.appeal_deadline),
    [capturedNow, order.appeal_deadline],
  );
  const expired = expiryMs !== null && currentTimeMs >= expiryMs;
  const sourceVerified = digest !== null && verifiedDigest === digest;

  useEffect(() => {
    if (expiryMs === null) return;
    let timer: number | undefined;
    const refresh = () => {
      const authoritative = authoritativeNowMs(clock);
      if (authoritative === null) return;
      const nextNow = Number(authoritative);
      setCurrentTimeMs(nextNow);
      if (nextNow >= expiryMs) return;
      timer = window.setTimeout(refresh, Math.min(expiryMs - nextNow, MAX_TIMER_DELAY_MS));
    };
    refresh();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [clock, expiryMs]);

  useEffect(() => {
    let active = true;
    setEnvelopeJson(null);
    setPublicDocument(null);
    setDigest(null);
    setVerifiedDigest(null);
    setVerificationError(null);
    if (!items || !nonce || !sourceReady || expiryMs === null) return () => { active = false; };
    const facts = actionFacts(
      action,
      items,
      effectiveItemId,
      packedObservations,
      deliveryObservation,
      claimCategory,
    );
    if (!facts) return () => { active = false; };
    const submittedAt = capturedNow.toISOString();
    const evidence = {
      action,
      actor_wallet: address,
      chain_id: chainId,
      contract_address: contractAddress,
      expires_at: new Date(expiryMs).toISOString(),
      issuer_id: "foodguard-web",
      ...(effectiveItemId ? { item_id: effectiveItemId } : {}),
      ...facts,
      nonce,
      observed_at: submittedAt,
      order_id: order.order_id,
      schema_version: "foodguard-evidence/1",
      sha256: `0x${"0".repeat(64)}`,
      source_url: url,
      subject: effectiveItemId ? `order:${order.order_id}/item:${effectiveItemId}` : `order:${order.order_id}`,
      submitted_at: submittedAt,
    } satisfies EvidenceDocument;

    void hashEvidence(evidence).then((sha256) => {
      if (!active) return;
      const complete = { ...evidence, sha256 } satisfies EvidenceDocument;
      setPublicDocument(canonicalizeEvidence(complete));
      setEnvelopeJson(canonicalizeEvidenceEnvelope(complete));
      setDigest(sha256);
    }).catch((caught: unknown) => {
      if (!active) return;
      setError(caught instanceof Error ? caught.message : copy.detail.evidenceBuildFailed);
    });
    return () => { active = false; };
  }, [action, address, capturedNow, chainId, claimCategory, contractAddress, copy.detail.evidenceBuildFailed, deliveryObservation, effectiveItemId, expiryMs, items, nonce, order.order_id, packedObservations, sourceReady, url]);

  async function submitEvidence() {
    if (!envelopeJson || !onSubmit || disabled || pending || !sourceVerified || expiryMs === null) return;
    const current = authoritativeNowMs(clock);
    if (current === null) return;
    if (current >= BigInt(expiryMs)) {
      setCurrentTimeMs(Number(current));
      setError(copy.detail.evidenceExpired);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(envelopeJson);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.detail.evidenceSubmitFailed);
    } finally {
      setPending(false);
    }
  }

  async function verifyPublicSource() {
    if (!publicDocument || !digest || !sourceReady || verifyingSource || expired) return;
    setVerifyingSource(true);
    setVerifiedDigest(null);
    setVerificationError(null);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok || await response.text() !== publicDocument) {
        throw new Error(copy.detail.publicSourceMismatch);
      }
      setVerifiedDigest(digest);
    } catch (caught) {
      setVerificationError(caught instanceof Error ? caught.message : copy.detail.publicSourceMismatch);
    } finally {
      setVerifyingSource(false);
    }
  }

  function refreshEvidence() {
    const nextNonce = createNonce();
    if (!nextNonce) {
      setError(copy.detail.evidenceBuildFailed);
      return;
    }
    const authoritative = authoritativeNowMs(clock);
    if (authoritative === null) {
      setError(copy.detail.chainTimeUnavailable);
      return;
    }
    const nextNow = new Date(Number(authoritative));
    setError(null);
    setCurrentTimeMs(nextNow.getTime());
    setCapturedNow(nextNow);
    setNonce(nextNonce);
  }

  return (
    <section className="order-card evidence-drawer" aria-labelledby="evidence-title">
      <h2 id="evidence-title">{copy.detail.evidenceTitle}</h2>
      <p>{copy.detail.evidenceIntro}</p>
      <label>
        <span>{copy.detail.publicSourceUrl}</span>
        <input
          aria-invalid={url.length > 0 && !sourceReady}
          onChange={(event) => setUrl(event.target.value)}
          type="url"
          value={url}
        />
      </label>
      {!sourceReady && <p className="form-notice form-notice--error">{copy.detail.publicSourceRequired}</p>}
      {action === "PACKED" && items && (
        <fieldset className="evidence-facts">
          <legend>{copy.detail.typedEvidenceFacts}</legend>
          {items.map((item) => (
            <label key={item.item_id}>
              <span>{copy.detail.packedObservation} — {item.name} ({item.item_id})</span>
              <select
                onChange={(event) => setPackedObservations((current) => ({
                  ...current,
                  [item.item_id]: event.target.value,
                }))}
                value={packedObservations[item.item_id] ?? ""}
              >
                <option value="">{copy.detail.selectTypedFact}</option>
                <option value="PACKED_AS_ORDERED">PACKED_AS_ORDERED</option>
                <option value="NOT_PACKED">NOT_PACKED</option>
                <option value="PACKED_DIFFERENT">PACKED_DIFFERENT</option>
              </select>
            </label>
          ))}
        </fieldset>
      )}
      {action === "DELIVERED" && (
        <label>
          <span>{copy.detail.deliveryObservation}</span>
          <select onChange={(event) => setDeliveryObservation(event.target.value)} value={deliveryObservation}>
            <option value="">{copy.detail.selectTypedFact}</option>
            <option value="HANDOFF_CONFIRMED">HANDOFF_CONFIRMED</option>
            <option value="HANDOFF_FAILED">HANDOFF_FAILED</option>
          </select>
        </label>
      )}
      {action === "CUSTOMER_CLAIM" && items && (
        <fieldset className="evidence-facts">
          <legend>{copy.detail.typedEvidenceFacts}</legend>
          <label>
            <span>{copy.detail.claimItem}</span>
            <select disabled={Boolean(itemId)} onChange={(event) => setSelectedItemId(event.target.value)} value={selectedItemId}>
              <option value="">{copy.detail.selectTypedFact}</option>
              {items.map((item) => <option key={item.item_id} value={item.item_id}>{item.name} ({item.item_id})</option>)}
            </select>
          </label>
          <label>
            <span>{copy.detail.claimCategory}</span>
            <select onChange={(event) => setClaimCategory(event.target.value)} value={claimCategory}>
              <option value="">{copy.detail.selectTypedFact}</option>
              <option value="ABSENT_AT_RECEIPT">ABSENT_AT_RECEIPT</option>
              <option value="NOT_AS_ORDERED">NOT_AS_ORDERED</option>
              <option value="HANDOFF_NOT_RECEIVED">HANDOFF_NOT_RECEIVED</option>
            </select>
          </label>
        </fieldset>
      )}
      <dl className="order-facts">
        <div><dt>{copy.detail.evidenceAction}</dt><dd><code>{action}</code></dd></div>
        <div><dt>{copy.detail.evidenceSubject}</dt><dd><code>{effectiveItemId ? `order:${order.order_id}/item:${effectiveItemId}` : `order:${order.order_id}`}</code></dd></div>
        <div><dt>{copy.detail.evidenceActor}</dt><dd><code>{address}</code></dd></div>
        <div><dt>{copy.detail.evidenceDomain}</dt><dd><code>{chainId} / {contractAddress}</code></dd></div>
      </dl>
      {publicDocument && envelopeJson && (
        <div className="evidence-preview">
          <dl className="order-facts evidence-metadata">
            <div><dt>{copy.detail.evidenceIssuer}</dt><dd>foodguard-web</dd></div>
            <div><dt>{copy.detail.evidenceSchema}</dt><dd>foodguard-evidence/1</dd></div>
            <div><dt>{copy.detail.evidenceFreshness}</dt><dd>{expiryMs === null ? null : new Date(expiryMs).toISOString()}</dd></div>
            <div><dt>{copy.detail.evidenceNonce}</dt><dd><code>{nonce}</code></dd></div>
            {digest && <div><dt>SHA-256</dt><dd><code>{digest}</code></dd></div>}
            <div>
              <dt>{copy.detail.evidenceValidation}</dt>
              <dd data-testid="evidence-validation">{copy.detail.canonicalHashVerified}</dd>
            </div>
          </dl>
          <h3>{copy.detail.publicCanonicalDocument}</h3>
          <pre data-testid="evidence-public-json">{publicDocument}</pre>
          <h3>{copy.detail.appendOnlyEnvelope}</h3>
          <pre data-testid="evidence-envelope-json">{envelopeJson}</pre>
        </div>
      )}
      {publicDocument && (
        <button
          className="button button--quiet"
          disabled={expired || verifyingSource}
          onClick={() => void verifyPublicSource()}
          type="button"
        >
          {copy.detail.verifyPublicSource}
        </button>
      )}
      {sourceVerified && <p className="form-notice form-notice--success">{copy.detail.publicSourceVerified}</p>}
      {verificationError && <p className="form-notice form-notice--error" role="alert">{verificationError}</p>}
      <button
        className="button button--primary"
        disabled={disabled || pending || !onSubmit || !envelopeJson || !sourceVerified || expired}
        onClick={() => void submitEvidence()}
        type="button"
      >
        {copy.detail.evidenceSubmit[action]}
      </button>
      {expired && (
        <div className="evidence-expired" role="alert">
          <p className="form-notice form-notice--error">{copy.detail.evidenceExpired}</p>
          <button className="button button--quiet" onClick={refreshEvidence} type="button">
            {copy.detail.refreshEvidence}
          </button>
        </div>
      )}
      {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
    </section>
  );
}
