"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  CorrectionEffectiveAction,
  CorrectionStatement,
  EvidenceAction,
  EvidenceDocument,
  JsonValue,
  OrderItem,
} from "../../lib/domain";
import {
  CLAIM_CATEGORY_OPTIONS,
  CLAIM_CRITERION_KIND_OPTIONS,
  canonicalizeEvidence,
  canonicalizeEvidenceEnvelope,
  CONDITION_STATUS_OPTIONS,
  DELIVERY_OBSERVATION_OPTIONS,
  hashEvidence,
  PACKED_ITEM_STATUS_OPTIONS,
  PICKUP_OBSERVATION_OPTIONS,
  QUANTITY_STATUS_OPTIONS,
} from "../../lib/evidence";
import { useLocale } from "../../lib/i18n";
import type { EvidenceRecordView, OrderDetailView } from "./ItemOutcomeTable";
import { authoritativeNowMs, type AuthoritativeClock } from "./authoritativeClock";

type WritableEvidenceAction = Exclude<EvidenceAction, "ORDER_MANIFEST">;
const EVIDENCE_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const EMPTY_EVIDENCE: EvidenceRecordView[] = [];

export interface EvidenceDrawerProps {
  action: WritableEvidenceAction;
  address: string;
  chainId: string;
  clock?: AuthoritativeClock | null;
  contractAddress: string;
  correctableEvidence?: EvidenceRecordView[];
  disabled?: boolean;
  itemId?: string;
  nonce?: string;
  now?: Date;
  onSubmit?(envelopeJson: string): Promise<void> | void;
  order: OrderDetailView;
  sourceUrl?: string;
}

interface CorrectionSlot {
  action: CorrectionEffectiveAction;
  itemId: string;
  key: string;
}

function recordStatements(record: EvidenceRecordView): CorrectionStatement[] | null {
  if (Array.isArray(record.statements)) return record.statements;
  if (!record.envelope_json || (record.action !== "CURE" && record.action !== "APPEAL")) return null;
  try {
    const parsed = JSON.parse(record.envelope_json) as EvidenceDocument;
    canonicalizeEvidenceEnvelope(parsed);
    return parsed.statements ?? null;
  } catch {
    return null;
  }
}

function semanticSlots(record: EvidenceRecordView): Array<{ action: CorrectionEffectiveAction; itemId: string }> {
  const statements = recordStatements(record);
  if (statements) {
    return statements.map((statement) => ({
      action: statement.effective_action,
      itemId: statement.effective_action === "CUSTOMER_CLAIM" ? statement.item_id : "",
    }));
  }
  const action = record.effective_action && record.effective_action !== "BATCH_CORRECTION"
    ? record.effective_action
    : record.action;
  if (!["PACKED", "PICKED_UP", "DELIVERED", "CUSTOMER_CLAIM"].includes(action)) return [];
  return [{ action: action as CorrectionEffectiveAction, itemId: action === "CUSTOMER_CLAIM" ? record.item_id ?? "" : "" }];
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
  correctableEvidence = EMPTY_EVIDENCE,
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
  const [selectedTargets, setSelectedTargets] = useState<number[]>([]);
  const [correctionFacts, setCorrectionFacts] = useState<Record<string, string>>({});
  const [envelopeJson, setEnvelopeJson] = useState<string | null>(null);
  const [publicDocument, setPublicDocument] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  const [verifyingSource, setVerifyingSource] = useState(false);
  const [verifiedDigest, setVerifiedDigest] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = useMemo(() => manifestItems(order.manifest_json), [order.manifest_json]);
  const isCorrection = action === "CURE" || action === "APPEAL";
  const callerRecords = useMemo(() => correctableEvidence
    .filter((record) => record.actor_wallet.toLowerCase() === address.toLowerCase())
    .map((record, fallbackIndex) => ({ ...record, evidence_index: record.evidence_index ?? fallbackIndex }))
    .sort((left, right) => (left.evidence_index ?? 0) - (right.evidence_index ?? 0)), [address, correctableEvidence]);
  const selectedRecords = useMemo(() => callerRecords.filter((record) => selectedTargets.includes(record.evidence_index ?? -1)), [callerRecords, selectedTargets]);
  const correctionSlots = useMemo(() => selectedRecords.flatMap((record) => semanticSlots(record).map((slot, slotIndex) => ({
    ...slot,
    key: `${record.evidence_index}:${slotIndex}`,
  } satisfies CorrectionSlot))), [selectedRecords]);
  const sourceReady = isPublicEvidenceUrl(url);
  const effectiveItemId = action === "CUSTOMER_CLAIM" ? selectedItemId : itemId;
  const expiryMs = useMemo(
    () => evidenceExpiryMs(capturedNow, order.appeal_deadline),
    [capturedNow, order.appeal_deadline],
  );
  const expired = expiryMs !== null && currentTimeMs >= expiryMs;
  const sourceVerified = digest !== null && verifiedDigest === digest;

  function fact(slot: CorrectionSlot, field: string): string {
    return correctionFacts[`${slot.key}:${field}`] ?? "";
  }

  function buildCorrectionStatement(slot: CorrectionSlot): CorrectionStatement | null {
    if (!items) return null;
    if (slot.action === "PICKED_UP") {
      const pickup = fact(slot, "pickup_observation");
      return (PICKUP_OBSERVATION_OPTIONS as readonly string[]).includes(pickup)
        ? { effective_action: "PICKED_UP", pickup_observation: pickup as "PICKUP_CONFIRMED" | "PICKUP_FAILED" | "UNKNOWN" }
        : null;
    }
    if (slot.action === "DELIVERED") {
      const delivery = fact(slot, "delivery_observation");
      return (DELIVERY_OBSERVATION_OPTIONS as readonly string[]).includes(delivery)
        ? { effective_action: "DELIVERED", delivery_observation: delivery as "HANDOFF_CONFIRMED" | "HANDOFF_FAILED" | "UNKNOWN" }
        : null;
    }
    if (slot.action === "CUSTOMER_CLAIM") {
      const category = fact(slot, "claim_category");
      const kind = fact(slot, "criterion_kind");
      const rawIndex = fact(slot, "criterion_index");
      const criterionIndex = Number(rawIndex);
      const item = items.find((candidate) => candidate.item_id === slot.itemId);
      if (
        !item || !(CLAIM_CATEGORY_OPTIONS as readonly string[]).includes(category) ||
        !(CLAIM_CRITERION_KIND_OPTIONS as readonly string[]).includes(kind) ||
        !/^-?(0|[1-9][0-9]*)$/.test(rawIndex) || !Number.isSafeInteger(criterionIndex)
      ) return null;
      const limit = kind === "SUBSTITUTION" ? item.permitted_substitutions.length
        : kind === "CONDITION" ? item.conditions.length
          : kind === "DELIVERY" ? 0 : 1;
      if (kind === "DELIVERY" ? criterionIndex !== -1 : criterionIndex < 0 || criterionIndex >= limit) return null;
      return {
        claim_category: category as "ABSENT_AT_RECEIPT" | "NOT_AS_ORDERED" | "HANDOFF_NOT_RECEIVED",
        criterion_index: criterionIndex,
        criterion_kind: kind as "ITEM" | "SUBSTITUTION" | "CONDITION" | "QUANTITY" | "DELIVERY",
        effective_action: "CUSTOMER_CLAIM",
        item_id: slot.itemId,
      };
    }
    const observations = items.map((item) => {
      const itemStatus = fact(slot, `item_status:${item.item_id}`);
      const quantityStatus = fact(slot, `quantity_status:${item.item_id}`);
      const rawSubstitution = fact(slot, `substitution_index:${item.item_id}`);
      const substitutionIndex = Number(rawSubstitution);
      const conditions = item.conditions.map((_condition, conditionIndex) => ({
        condition_index: conditionIndex,
        status: fact(slot, `condition:${item.item_id}:${conditionIndex}`),
      }));
      if (
        !(PACKED_ITEM_STATUS_OPTIONS as readonly string[]).includes(itemStatus) ||
        !(QUANTITY_STATUS_OPTIONS as readonly string[]).includes(quantityStatus) ||
        !/^-?(0|[1-9][0-9]*)$/.test(rawSubstitution) || !Number.isSafeInteger(substitutionIndex) ||
        (itemStatus === "PERMITTED_SUBSTITUTION"
          ? substitutionIndex < 0 || substitutionIndex >= item.permitted_substitutions.length
          : substitutionIndex !== -1) ||
        conditions.some((condition) => !(CONDITION_STATUS_OPTIONS as readonly string[]).includes(condition.status))
      ) return null;
      return {
        condition_statuses: conditions as Array<{ condition_index: number; status: "MET" | "NOT_MET" | "UNKNOWN" }>,
        item_id: item.item_id,
        item_status: itemStatus as "AS_ORDERED" | "PERMITTED_SUBSTITUTION" | "ABSENT" | "DIFFERENT" | "UNKNOWN",
        quantity_status: quantityStatus as "EXACT" | "SHORT" | "EXCESS" | "UNKNOWN",
        substitution_index: substitutionIndex,
      };
    });
    return observations.some((observation) => observation === null)
      ? null
      : { effective_action: "PACKED", item_observations: observations as Extract<CorrectionStatement, { effective_action: "PACKED" }>["item_observations"] };
  }

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
    if (pendingRef.current) return () => { active = false; };
    setEnvelopeJson(null);
    setPublicDocument(null);
    setDigest(null);
    setVerifiedDigest(null);
    setVerificationError(null);
    if (!items || !nonce || !sourceReady || expiryMs === null) return () => { active = false; };
    const statements = isCorrection ? correctionSlots.map(buildCorrectionStatement) : null;
    const facts = isCorrection
      ? (selectedRecords.length > 0 && statements?.every((statement): statement is CorrectionStatement => statement !== null)
          ? {
              statements,
              supersedes_evidence_indices: selectedRecords.map((record) => record.evidence_index as number),
            }
          : null)
      : actionFacts(
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
      ...(!isCorrection && effectiveItemId ? { item_id: effectiveItemId } : {}),
      ...facts,
      nonce,
      observed_at: submittedAt,
      order_id: order.order_id,
      schema_version: "foodguard-evidence/1",
      sha256: `0x${"0".repeat(64)}`,
      source_url: url,
      subject: !isCorrection && effectiveItemId ? `order:${order.order_id}/item:${effectiveItemId}` : `order:${order.order_id}`,
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
  }, [action, address, capturedNow, chainId, claimCategory, contractAddress, copy.detail.evidenceBuildFailed, correctionFacts, correctionSlots, deliveryObservation, effectiveItemId, expiryMs, isCorrection, items, nonce, order.order_id, packedObservations, selectedRecords, sourceReady, url]);

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

  function setCorrectionFact(slot: CorrectionSlot, field: string, value: string) {
    setCorrectionFacts((current) => ({ ...current, [`${slot.key}:${field}`]: value }));
  }

  return (
    <section className="order-card evidence-drawer" aria-labelledby="evidence-title">
      <h2 id="evidence-title">{copy.detail.evidenceTitle}</h2>
      <p>{copy.detail.evidenceIntro}</p>
      {isCorrection && (
        <fieldset className="evidence-facts evidence-targets" disabled={pending}>
          <legend>{copy.detail.correctionTargets}</legend>
          {callerRecords.map((record) => {
            const evidenceIndex = record.evidence_index as number;
            return (
              <label className="evidence-target" key={evidenceIndex}>
                <input
                  aria-label={`${copy.detail.selectEvidence} #${evidenceIndex}`}
                  checked={selectedTargets.includes(evidenceIndex)}
                  onChange={(event) => {
                    setSelectedTargets((current) => event.target.checked
                      ? [...current, evidenceIndex].sort((left, right) => left - right)
                      : current.filter((index) => index !== evidenceIndex));
                    setCorrectionFacts({});
                  }}
                  type="checkbox"
                />
                <span>{copy.detail.selectEvidence} #{evidenceIndex} · <code>{record.action}</code>{record.item_id ? ` · ${record.item_id}` : ""}</span>
              </label>
            );
          })}
          <p className="form-notice">{selectedTargets.length} {copy.detail.recordsSelected}</p>
          {selectedRecords.some((record) => record.action === "CURE" || record.action === "APPEAL") && (
            <p className="form-notice form-notice--warning">{copy.detail.replacingPriorBatch}</p>
          )}
        </fieldset>
      )}
      <label>
        <span>{copy.detail.publicSourceUrl}</span>
        <input
          aria-invalid={url.length > 0 && !sourceReady}
          disabled={pending}
          onChange={(event) => setUrl(event.target.value)}
          type="url"
          value={url}
        />
      </label>
      {!sourceReady && <p className="form-notice form-notice--error">{copy.detail.publicSourceRequired}</p>}
      {isCorrection && correctionSlots.length > 0 && items && (
        <fieldset className="evidence-facts correction-statements" disabled={pending}>
          <legend>{copy.detail.explicitCorrectionFacts}</legend>
          {correctionSlots.map((slot, slotIndex) => (
            <section className="correction-statement" key={slot.key}>
              <h3>#{slotIndex + 1} · <code>{slot.action}</code>{slot.itemId ? ` · ${slot.itemId}` : ""}</h3>
              {slot.action === "CUSTOMER_CLAIM" && (
                <>
                  <label>
                    <span>{copy.detail.claimCategory} #{slotIndex + 1}</span>
                    <select aria-label={`${copy.detail.claimCategory} ${slotIndex + 1}`} onChange={(event) => setCorrectionFact(slot, "claim_category", event.target.value)} value={fact(slot, "claim_category")}>
                      <option value="">{copy.detail.selectTypedFact}</option>
                      {CLAIM_CATEGORY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>{copy.detail.criterionKind} #{slotIndex + 1}</span>
                    <select aria-label={`${copy.detail.criterionKind} ${slotIndex + 1}`} onChange={(event) => setCorrectionFact(slot, "criterion_kind", event.target.value)} value={fact(slot, "criterion_kind")}>
                      <option value="">{copy.detail.selectTypedFact}</option>
                      {CLAIM_CRITERION_KIND_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>{copy.detail.criterionIndex} #{slotIndex + 1}</span>
                    <input aria-label={`${copy.detail.criterionIndex} ${slotIndex + 1}`} onChange={(event) => setCorrectionFact(slot, "criterion_index", event.target.value)} type="number" value={fact(slot, "criterion_index")} />
                  </label>
                </>
              )}
              {slot.action === "PICKED_UP" && (
                <label>
                  <span>{copy.detail.pickupObservation} #{slotIndex + 1}</span>
                  <select onChange={(event) => setCorrectionFact(slot, "pickup_observation", event.target.value)} value={fact(slot, "pickup_observation")}>
                    <option value="">{copy.detail.selectTypedFact}</option>
                    {PICKUP_OBSERVATION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
              )}
              {slot.action === "DELIVERED" && (
                <label>
                  <span>{copy.detail.deliveryObservation} #{slotIndex + 1}</span>
                  <select onChange={(event) => setCorrectionFact(slot, "delivery_observation", event.target.value)} value={fact(slot, "delivery_observation")}>
                    <option value="">{copy.detail.selectTypedFact}</option>
                    {DELIVERY_OBSERVATION_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
              )}
              {slot.action === "PACKED" && items.map((item) => (
                <fieldset className="evidence-facts" key={item.item_id}>
                  <legend>{item.name} ({item.item_id})</legend>
                  <label><span>{copy.detail.itemStatus}</span><select onChange={(event) => setCorrectionFact(slot, `item_status:${item.item_id}`, event.target.value)} value={fact(slot, `item_status:${item.item_id}`)}><option value="">{copy.detail.selectTypedFact}</option>{PACKED_ITEM_STATUS_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
                  <label><span>{copy.detail.quantityStatus}</span><select onChange={(event) => setCorrectionFact(slot, `quantity_status:${item.item_id}`, event.target.value)} value={fact(slot, `quantity_status:${item.item_id}`)}><option value="">{copy.detail.selectTypedFact}</option>{QUANTITY_STATUS_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
                  <label><span>{copy.detail.substitutionIndex}</span><input onChange={(event) => setCorrectionFact(slot, `substitution_index:${item.item_id}`, event.target.value)} type="number" value={fact(slot, `substitution_index:${item.item_id}`)} /></label>
                  {item.conditions.map((condition, conditionIndex) => <label key={condition}><span>{copy.detail.conditionStatus} #{conditionIndex}</span><select onChange={(event) => setCorrectionFact(slot, `condition:${item.item_id}:${conditionIndex}`, event.target.value)} value={fact(slot, `condition:${item.item_id}:${conditionIndex}`)}><option value="">{copy.detail.selectTypedFact}</option>{CONDITION_STATUS_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>)}
                </fieldset>
              ))}
            </section>
          ))}
          <p className="form-notice">{copy.detail.atomicCorrection}</p>
        </fieldset>
      )}
      {action === "PACKED" && items && (
        <fieldset className="evidence-facts" disabled={pending}>
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
          <select disabled={pending} onChange={(event) => setDeliveryObservation(event.target.value)} value={deliveryObservation}>
            <option value="">{copy.detail.selectTypedFact}</option>
            <option value="HANDOFF_CONFIRMED">HANDOFF_CONFIRMED</option>
            <option value="HANDOFF_FAILED">HANDOFF_FAILED</option>
          </select>
        </label>
      )}
      {action === "CUSTOMER_CLAIM" && items && (
        <fieldset className="evidence-facts" disabled={pending}>
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
