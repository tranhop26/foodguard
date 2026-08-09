"use client";

import { use, useCallback, useEffect, useState } from "react";
import { isAddress } from "viem";

import { AppealPanel } from "../../../components/order/AppealPanel";
import { ConsensusPanel } from "../../../components/order/ConsensusPanel";
import { EvidenceDrawer, isPublicEvidenceUrl } from "../../../components/order/EvidenceDrawer";
import {
  ItemOutcomeTable,
  type EvidenceRecordView,
  type MutualSettlementView,
  type OrderDetailView,
  type ResolutionView,
  type SettlementProposalView,
  type SettlementView,
} from "../../../components/order/ItemOutcomeTable";
import { OrderTimeline } from "../../../components/order/OrderTimeline";
import { MutualSettlementPanel } from "../../../components/order/MutualSettlementPanel";
import {
  authoritativeNowMs,
  MAX_AUTHORITATIVE_CHAIN_SECONDS,
  MAX_CHAIN_SAMPLE_AGE_MS,
  sampleAuthoritativeClock,
  type AuthoritativeClock,
} from "../../../components/order/authoritativeClock";
import { RoleConsole, type RoleAction } from "../../../components/order/RoleConsole";
import { TransactionLifecycle } from "../../../components/order/TransactionLifecycle";
import { WalletButton, type WalletSnapshot } from "../../../components/wallet/WalletButton";
import type { DeliveryOutcome, EvidenceAction, EvidenceDocument, ItemOutcome, OrderItem, OrderState } from "../../../lib/domain";
import { canonicalizeEvidenceEnvelope, hashEvidence, validateCorrectionStatement } from "../../../lib/evidence";
import { getFoodGuardReadClient, readFoodGuard, writeFoodGuard } from "../../../lib/genlayer/client";
import {
  FOODGUARD_CHAIN,
  getFoodGuardConfiguration,
  getFoodGuardPublicAppOriginConfiguration,
} from "../../../lib/genlayer/config";
import { trackTransaction, type TxStage } from "../../../lib/genlayer/transactions";
import { LocaleProvider, type Locale, useLocale, WorkflowShell } from "../../../lib/i18n";

const orderStates = new Set<OrderState>([
  "FUNDED", "PARTIALLY_ACCEPTED", "ACCEPTED", "READY_FOR_PICKUP", "IN_TRANSIT",
  "REVIEW_WINDOW", "RESOLVING", "EVIDENCE_CURE", "RESOLVED", "APPEALED",
  "ESCALATED", "SETTLED", "CANCELLED_REFUNDED", "FULFILLMENT_TIMEOUT_REFUNDED",
]);
const evidenceActions = new Set<EvidenceAction>([
  "PACKED", "PICKED_UP", "DELIVERED", "CUSTOMER_CLAIM", "CURE", "APPEAL",
]);
const MAX_U64 = (1n << 64n) - 1n;
const MAX_EVIDENCE_HISTORY = 112n;
const MAX_SETTLEMENT_PROPOSALS = 96n;
const resolutionStates = new Set<OrderState>([
  "EVIDENCE_CURE", "RESOLVED", "APPEALED", "ESCALATED", "SETTLED",
]);

export type OrderDetailWorkspaceConfiguration =
  | {
      chainId: string;
      contractAddress: string;
      message: null;
      readsEnabled: true;
      status: "READY";
      writesEnabled: true;
    }
  | {
      chainId: string;
      contractAddress: string;
      message: string;
      readsEnabled: true;
      status: "PUBLIC_APP_ORIGIN_REQUIRED";
      writesEnabled: true;
    }
  | {
      chainId: string;
      contractAddress: null;
      message: string;
      readsEnabled: false;
      status: "DEPLOYMENT_REQUIRED";
      writesEnabled: false;
    };

interface TrackedOrderReadback {
  order: OrderDetailView;
  transactionHash?: string;
}

type OrderReader = (orderId: string) => Promise<OrderDetailView>;
type ChainTimeReader = () => Promise<bigint>;
type OrderTransactor = (
  method: string,
  args: string[],
  expectedAddress: string | undefined,
  onStage: (stage: TxStage) => void,
) => Promise<TrackedOrderReadback>;

function unsignedRaw(value: unknown, field: string): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  throw new TypeError(`${field} is missing or malformed`);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!plainObject(value)) throw new TypeError("Canonical JSON readback is malformed");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function authoritativeManifest(manifestJson: string): OrderItem[] {
  let manifest: unknown;
  try { manifest = JSON.parse(manifestJson); } catch { throw new TypeError("Order manifest is missing or malformed"); }
  if (!plainObject(manifest) || Object.keys(manifest).length !== 1 || !Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > 100) {
    throw new TypeError("Order manifest is missing or malformed");
  }
  if (canonicalJson(manifest) !== manifestJson) throw new TypeError("Order manifest is not canonical");
  const ids = new Set<string>();
  for (const item of manifest.items) {
    if (!plainObject(item) || Object.keys(item).sort().join(",") !== "conditions,item_id,name,permitted_substitutions,price_wei,quantity") {
      throw new TypeError("Order manifest item is malformed");
    }
    if (
      typeof item.item_id !== "string" || !item.item_id.trim() || ids.has(item.item_id) ||
      new TextEncoder().encode(item.item_id as string).length > 128 ||
      typeof item.name !== "string" || !item.name.trim() ||
      new TextEncoder().encode(item.name as string).length > 256 ||
      !Number.isSafeInteger(item.quantity) || (item.quantity as number) <= 0 ||
      typeof item.price_wei !== "string" || !/^[1-9][0-9]{0,77}$/.test(item.price_wei) ||
      !Array.isArray(item.conditions) || item.conditions.length > 20 || !item.conditions.every((entry) => typeof entry === "string" && entry.trim()) ||
      !Array.isArray(item.permitted_substitutions) || item.permitted_substitutions.length > 20 || !item.permitted_substitutions.every((entry) => typeof entry === "string" && entry.trim())
    ) throw new TypeError("Order manifest item is malformed");
    ids.add(item.item_id);
  }
  return manifest.items as OrderItem[];
}

function authoritativeBase(value: unknown, expectedOrderId: string): OrderDetailView {
  if (!plainObject(value)) throw new TypeError("Order readback is missing or malformed");
  for (const actor of ["customer", "restaurant", "courier"] as const) {
    if (typeof value[actor] !== "string" || !isAddress(value[actor] as string, { strict: false })) {
      throw new TypeError(`Order ${actor} is missing or malformed`);
    }
  }
  if (value.order_id !== expectedOrderId) throw new TypeError("Order readback ID does not match the requested order");
  if (typeof value.state !== "string" || !orderStates.has(value.state as OrderState)) {
    throw new TypeError("Order state is missing or malformed");
  }
  if (typeof value.manifest_json !== "string") throw new TypeError("Order manifest is missing or malformed");
  const items = authoritativeManifest(value.manifest_json);
  for (const accepted of ["restaurant_accepted", "courier_accepted"] as const) {
    if (typeof value[accepted] !== "boolean") throw new TypeError(`Order ${accepted} is missing or malformed`);
  }
  for (const settled of ["items_settled", "delivery_settled", "refund_emitted"] as const) {
    if (typeof value[settled] !== "boolean") throw new TypeError(`Order ${settled} is missing or malformed`);
  }
  const actors = [value.customer as string, value.restaurant as string, value.courier as string].map((actor) => actor.toLowerCase());
  if (new Set(actors).size !== actors.length || actors.some((actor) => /^0x0{40}$/.test(actor))) {
    throw new TypeError("Order actors are missing, zero, or duplicated");
  }
  const subtotal = unsignedRaw(value.subtotal, "subtotal");
  const deliveryFee = unsignedRaw(value.delivery_fee, "delivery_fee");
  const totalValue = unsignedRaw(value.total_value, "total_value");
  const manifestSubtotal = items.reduce((total, item) => total + BigInt(item.price_wei) * BigInt(item.quantity), 0n);
  if (manifestSubtotal !== BigInt(subtotal) || manifestSubtotal + BigInt(deliveryFee) !== BigInt(totalValue)) {
    throw new TypeError("Order value readback is inconsistent with its manifest");
  }
  const deadlines = [value.acceptance_deadline, value.packing_deadline, value.delivery_deadline, value.review_deadline, value.appeal_deadline]
    .map((deadline, index) => BigInt(unsignedRaw(deadline, `deadline_${index}`)));
  if (deadlines.some((deadline, index) => deadline > MAX_U64 || (index > 0 && deadline <= deadlines[index - 1]))) {
    throw new TypeError("Order deadlines are malformed");
  }
  const refunded = (
    value.state === "CANCELLED_REFUNDED" ||
    value.state === "FULFILLMENT_TIMEOUT_REFUNDED"
  );
  const finalState = value.state === "SETTLED" || refunded;
  if (Boolean(value.items_settled) !== finalState || Boolean(value.delivery_settled) !== finalState) {
    throw new TypeError("Order settlement flags are inconsistent with its state");
  }
  const cancelled = value.state === "CANCELLED_REFUNDED";
  const acceptanceIsConsistent = value.state === "FUNDED" || cancelled
    ? !value.restaurant_accepted && !value.courier_accepted
    : value.state === "PARTIALLY_ACCEPTED"
      ? value.restaurant_accepted !== value.courier_accepted
      : value.restaurant_accepted && value.courier_accepted;
  if (!acceptanceIsConsistent) {
    throw new TypeError("Order acceptance flags are inconsistent with its state or cancellation");
  }
  if (Boolean(value.refund_emitted) !== refunded) {
    throw new TypeError("Order refund and cancellation flags are inconsistent with its state");
  }
  const base = {
    ...value,
    acceptance_deadline: unsignedRaw(value.acceptance_deadline, "acceptance_deadline"),
    appeal_deadline: unsignedRaw(value.appeal_deadline, "appeal_deadline"),
    courier: value.courier as string,
    courier_accepted: value.courier_accepted as boolean,
    customer: value.customer as string,
    delivery_deadline: unsignedRaw(value.delivery_deadline, "delivery_deadline"),
    delivery_fee: deliveryFee,
    evidence: undefined,
    manifest_json: value.manifest_json,
    order_id: value.order_id,
    packing_deadline: unsignedRaw(value.packing_deadline, "packing_deadline"),
    resolution: null,
    resolution_round: undefined,
    restaurant: value.restaurant as string,
    restaurant_accepted: value.restaurant_accepted as boolean,
    review_deadline: unsignedRaw(value.review_deadline, "review_deadline"),
    settlement: null,
    state: value.state as OrderState,
    subtotal,
    total_value: totalValue,
  } satisfies OrderDetailView;
  return base;
}

async function evidenceRecord(value: unknown, order: OrderDetailView, evidenceIndex: number): Promise<EvidenceRecordView> {
  if (!plainObject(value)) throw new TypeError("Evidence readback is malformed");
  const required = [
    "schema_version", "order_id", "subject", "action", "actor_wallet", "issuer_id", "source_url",
    "sha256", "observed_at", "submitted_at", "expires_at", "chain_id", "contract_address", "nonce",
    "envelope_json",
  ] as const;
  if (required.some((field) => typeof value[field] !== "string" || !(value[field] as string).trim())) {
    throw new TypeError("Evidence readback is malformed");
  }
  if (
    value.schema_version !== "foodguard-evidence/1" || value.order_id !== order.order_id ||
    !evidenceActions.has(value.action as EvidenceAction) ||
    !/^0x[0-9a-f]{64}$/i.test(value.sha256 as string)
  ) throw new TypeError("Evidence readback binding is malformed");
  if (value.item_id !== undefined && typeof value.item_id !== "string") throw new TypeError("Evidence item binding is malformed");
  if (!isPublicEvidenceUrl(value.source_url as string)) throw new TypeError("Evidence public source binding is malformed");
  let envelope: unknown;
  try { envelope = JSON.parse(value.envelope_json as string); } catch { throw new TypeError("Evidence envelope readback is malformed"); }
  if (!plainObject(envelope) || canonicalJson(envelope) !== value.envelope_json) throw new TypeError("Evidence envelope readback is not canonical");
  const items = authoritativeManifest(order.manifest_json);
  let canonicalEnvelope: string;
  try { canonicalEnvelope = canonicalizeEvidenceEnvelope(envelope as EvidenceDocument, items); } catch { throw new TypeError("Evidence envelope readback is malformed"); }
  if (canonicalEnvelope !== value.envelope_json) throw new TypeError("Evidence envelope readback is not canonical");
  const metadataFields = required.filter((field) => field !== "envelope_json");
  if (metadataFields.some((field) => envelope[field] !== value[field])) throw new TypeError("Evidence record does not match its envelope");
  const itemId = typeof value.item_id === "string" ? value.item_id : "";
  if ((envelope.item_id ?? "") !== itemId) throw new TypeError("Evidence item binding is malformed");
  if (itemId && !items.some((item) => item.item_id === itemId)) throw new TypeError("Evidence item binding is malformed");
  if (value.action === "PACKED") {
    const observations = envelope.item_observations;
    if (
      !Array.isArray(observations) ||
      observations.length !== items.length ||
      observations.some((observation, index) => (
        !plainObject(observation) || observation.item_id !== items[index].item_id
      ))
    ) throw new TypeError("Evidence packed item bindings are malformed");
  }
  const expectedSubject = itemId ? `order:${order.order_id}/item:${itemId}` : `order:${order.order_id}`;
  if (value.subject !== expectedSubject) throw new TypeError("Evidence subject binding is malformed");
  const actor = (value.actor_wallet as string).toLowerCase();
  const expectedActor = value.action === "PACKED"
    ? order.restaurant
    : value.action === "PICKED_UP" || value.action === "DELIVERED"
      ? order.courier
      : value.action === "CUSTOMER_CLAIM"
        ? order.customer
        : null;
  if (expectedActor ? actor !== expectedActor.toLowerCase() : ![order.customer, order.restaurant, order.courier].some((address) => address.toLowerCase() === actor)) {
    throw new TypeError("Evidence actor binding is malformed");
  }
  if (value.action === "CUSTOMER_CLAIM" && !itemId) throw new TypeError("Evidence claim item binding is malformed");
  const configuration = getFoodGuardConfiguration();
  if (
    value.chain_id !== String(FOODGUARD_CHAIN.id) ||
    (configuration.status === "READY" && (value.contract_address as string).toLowerCase() !== configuration.address.toLowerCase())
  ) throw new TypeError("Evidence chain or contract binding is malformed");
  const timestamp = (field: "observed_at" | "submitted_at" | "expires_at") => {
    const parsed = Date.parse(value[field] as string);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value[field]) throw new TypeError("Evidence timestamp binding is malformed");
    return parsed;
  };
  if (!(timestamp("observed_at") <= timestamp("submitted_at") && timestamp("submitted_at") <= timestamp("expires_at"))) {
    throw new TypeError("Evidence timestamp binding is malformed");
  }
  if ((await hashEvidence(envelope as EvidenceDocument)).toLowerCase() !== (value.sha256 as string).toLowerCase()) {
    throw new TypeError("Evidence digest binding is malformed");
  }
  const correction = envelope.action === "CURE" || envelope.action === "APPEAL"
    ? {
        effective_action: "BATCH_CORRECTION" as const,
        statements: envelope.statements as EvidenceRecordView["statements"],
        supersedes_evidence_indices: envelope.supersedes_evidence_indices as number[],
      }
    : { effective_action: envelope.action as EvidenceRecordView["effective_action"] };
  if (typeof value.effective_action === "string" && value.effective_action !== correction.effective_action) {
    throw new TypeError("Evidence effective action binding is malformed");
  }
  return { ...(value as unknown as EvidenceRecordView), ...correction, evidence_index: evidenceIndex };
}

export function deriveActiveEvidenceRecords(
  evidence: readonly EvidenceRecordView[],
  manifestItems?: readonly OrderItem[],
): EvidenceRecordView[] {
  const active = new Set<number>();
  const semanticSlots = (record: EvidenceRecordView): Array<[string, string]> => {
    if (record.action === "CURE" || record.action === "APPEAL") {
      if (record.effective_action !== "BATCH_CORRECTION" || !Array.isArray(record.statements) || record.statements.length === 0) {
        throw new TypeError("Batch correction active-set readback is malformed");
      }
      return record.statements.map((statement) => {
        try {
          validateCorrectionStatement(statement, manifestItems);
        } catch {
          throw new TypeError("Batch correction active-set readback is malformed");
        }
        const itemId = statement.effective_action === "CUSTOMER_CLAIM" ? statement.item_id : "";
        if (!["PACKED", "PICKED_UP", "DELIVERED", "CUSTOMER_CLAIM"].includes(statement.effective_action) || (statement.effective_action === "CUSTOMER_CLAIM" && !itemId)) {
          throw new TypeError("Batch correction active-set readback is malformed");
        }
        return [statement.effective_action, itemId];
      });
    }
    if (
      !["PACKED", "PICKED_UP", "DELIVERED", "CUSTOMER_CLAIM"].includes(record.action) ||
      record.effective_action !== record.action ||
      (record.action === "CUSTOMER_CLAIM" && !record.item_id)
    ) throw new TypeError("Batch correction active-set readback is malformed");
    const facts = record as unknown as Record<string, unknown>;
    const statement = record.action === "PACKED"
      ? { effective_action: "PACKED", item_observations: facts.item_observations }
      : record.action === "PICKED_UP"
        ? { effective_action: "PICKED_UP", pickup_observation: facts.pickup_observation }
        : record.action === "DELIVERED"
          ? { delivery_observation: facts.delivery_observation, effective_action: "DELIVERED" }
          : {
              claim_category: facts.claim_category,
              criterion_index: facts.criterion_index,
              criterion_kind: facts.criterion_kind,
              effective_action: "CUSTOMER_CLAIM",
              item_id: record.item_id,
            };
    try {
      const validated = validateCorrectionStatement(statement, manifestItems);
      return [[validated.effective_action, validated.effective_action === "CUSTOMER_CLAIM" ? validated.item_id : ""]];
    } catch {
      throw new TypeError("Batch correction active-set readback is malformed");
    }
  };

  evidence.forEach((record, correctionIndex) => {
    if (record.action !== "CURE" && record.action !== "APPEAL") {
      semanticSlots(record);
      active.add(correctionIndex);
      return;
    }
    const targets = record.supersedes_evidence_indices;
    if (!Array.isArray(targets) || targets.length === 0 || !Array.isArray(record.statements)) {
      throw new TypeError("Batch correction active-set readback is malformed");
    }
    let previous = -1;
    const expectedSlots: Array<[string, string]> = [];
    for (const target of targets) {
      if (!Number.isSafeInteger(target) || target <= previous || target >= correctionIndex || !active.has(target)) {
        throw new TypeError("Batch correction active-set readback is malformed");
      }
      const targetRecord = evidence[target];
      if (targetRecord.actor_wallet.toLowerCase() !== record.actor_wallet.toLowerCase()) {
        throw new TypeError("Batch correction active-set readback is malformed");
      }
      previous = target;
      expectedSlots.push(...semanticSlots(targetRecord));
    }
    const actualSlots = semanticSlots(record);
    if (
      actualSlots.length !== expectedSlots.length ||
      actualSlots.some(([action, itemId], index) => action !== expectedSlots[index][0] || itemId !== expectedSlots[index][1])
    ) throw new TypeError("Batch correction active-set readback is malformed");
    targets.forEach((target) => active.delete(target));
    active.add(correctionIndex);
  });
  return [...active].sort((left, right) => left - right).map((index) => ({ ...evidence[index], evidence_index: index }));
}

function parseResolution(value: unknown, manifestJson: string): ResolutionView {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new TypeError("Resolution readback is malformed"); }
  }
  if (
    !plainObject(parsed) ||
    Object.keys(parsed).sort().join(",") !== "delivery_outcome,evidence_hashes,evidence_indices,items" ||
    !Array.isArray(parsed.items) ||
    !Array.isArray(parsed.evidence_hashes) ||
    !Array.isArray(parsed.evidence_indices)
  ) {
    throw new TypeError("Resolution readback is malformed");
  }
  const evidenceHashes = parsed.evidence_hashes as unknown[];
  const evidenceIndices = parsed.evidence_indices as unknown[];
  const manifest = JSON.parse(manifestJson) as { items: Array<{ item_id: string }> };
  const itemOutcomes = new Set(["MATCHED", "MISSING", "MISMATCHED", "DELIVERY_FAILED", "UNRESOLVED"]);
  const deliveryOutcomes = new Set(["DELIVERED", "DELIVERY_FAILED", "UNRESOLVED"]);
  if (
    parsed.items.length !== manifest.items.length ||
    !deliveryOutcomes.has(parsed.delivery_outcome as string) ||
    !evidenceHashes.every((hash) => typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash)) ||
    evidenceIndices.length !== evidenceHashes.length ||
    !evidenceIndices.every((index, position) => (
      typeof index === "number" &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      (position === 0 || index > (evidenceIndices[position - 1] as number))
    ))
  ) throw new TypeError("Resolution readback is malformed");
  const items: ResolutionView["items"] = parsed.items.map((item, index) => {
    if (
      !plainObject(item) || Object.keys(item).sort().join(",") !== "facts,item_id,outcome" || item.item_id !== manifest.items[index].item_id ||
      !itemOutcomes.has(item.outcome as string) || !Array.isArray(item.facts) ||
      !item.facts.every((fact) => typeof fact === "string")
    ) throw new TypeError("Resolution item readback is malformed");
    return {
      facts: item.facts as string[],
      item_id: item.item_id as string,
      outcome: item.outcome as ItemOutcome,
    };
  });
  return {
    delivery_outcome: parsed.delivery_outcome as DeliveryOutcome,
    evidence_hashes: evidenceHashes as string[],
    evidence_indices: evidenceIndices as number[],
    items,
  };
}

function hasUnresolvedOutcome(resolution: ResolutionView): boolean {
  return (
    resolution.delivery_outcome === "UNRESOLVED" ||
    resolution.items.some((item) => item.outcome === "UNRESOLVED")
  );
}

function assertStateResolutionConsistency(
  order: OrderDetailView,
  roundRaw: string,
  resolution: ResolutionView | null,
): void {
  const round = BigInt(roundRaw);
  if (round > MAX_U64) throw new TypeError("Resolution round is outside its safe domain");
  if (!resolutionStates.has(order.state)) {
    if (round !== 0n || resolution !== null) throw new TypeError("Order state and resolution round are inconsistent");
    return;
  }
  if (!resolution || round === 0n) throw new TypeError("Order state requires a stored resolution round");
  const unresolved = hasUnresolvedOutcome(resolution);
  if ((order.state === "RESOLVED" || order.state === "APPEALED") && unresolved) {
    throw new TypeError("Resolved order state cannot contain UNRESOLVED outcomes");
  }
  if (order.state === "EVIDENCE_CURE") {
    if (!unresolved) throw new TypeError("EVIDENCE_CURE requires an UNRESOLVED outcome");
  }
  if (order.state === "ESCALATED" && (round < 2n || !unresolved)) {
    throw new TypeError("ESCALATED requires a later UNRESOLVED round");
  }
  if (order.state === "SETTLED" && unresolved && round < 2n) {
    throw new TypeError("A mutually settled UNRESOLVED order requires an escalated round");
  }
}

function parseSettlement(value: unknown): SettlementView {
  if (!plainObject(value) || typeof value.settlement_id !== "string" || !/^0x[0-9a-f]{64}$/i.test(value.settlement_id)) {
    throw new TypeError("Settlement readback is malformed");
  }
  return {
    courier_wei: unsignedRaw(value.courier_wei, "courier_wei"),
    customer_wei: unsignedRaw(value.customer_wei, "customer_wei"),
    restaurant_wei: unsignedRaw(value.restaurant_wei, "restaurant_wei"),
    settlement_id: value.settlement_id,
  };
}

async function parseSettlementProposal(
  value: unknown,
  order: OrderDetailView,
): Promise<SettlementProposalView> {
  if (!plainObject(value)) throw new TypeError("Mutual settlement proposal readback is malformed");
  const stringFields = ["proposal_json", "digest", "proposal_nonce", "active_evidence_digest"] as const;
  const signatureFields = ["customer_signed", "restaurant_signed", "courier_signed"] as const;
  if (
    Object.keys(value).sort().join(",") !== "active_evidence_digest,courier_signed,courier_wei,customer_signed,customer_wei,digest,proposal_json,proposal_nonce,proposal_version,resolution_round,restaurant_signed,restaurant_wei" ||
    stringFields.some((field) => typeof value[field] !== "string" || !(value[field] as string).trim()) ||
    signatureFields.some((field) => typeof value[field] !== "boolean") ||
    !/^0x[0-9a-f]{64}$/i.test(value.digest as string) ||
    !/^0x[0-9a-f]{64}$/i.test(value.active_evidence_digest as string)
  ) throw new TypeError("Mutual settlement proposal readback is malformed");
  const customerTotal = unsignedRaw(value.customer_wei, "mutual customer_wei");
  const restaurantTotal = unsignedRaw(value.restaurant_wei, "mutual restaurant_wei");
  const courierTotal = unsignedRaw(value.courier_wei, "mutual courier_wei");
  const proposalVersion = unsignedRaw(value.proposal_version, "mutual proposal_version");
  const resolutionRound = unsignedRaw(value.resolution_round, "mutual resolution_round");
  let proposal: unknown;
  try { proposal = JSON.parse(value.proposal_json as string); } catch { throw new TypeError("Mutual settlement proposal JSON is malformed"); }
  if (
    !plainObject(proposal) ||
    Object.keys(proposal).sort().join(",") !== "active_evidence_digest,chain_id,contract_address,delivery_allocation,item_allocations,order_id,proposal_nonce,proposal_version,resolution_round" ||
    canonicalJson(proposal) !== value.proposal_json ||
    proposal.chain_id !== String(FOODGUARD_CHAIN.id) ||
    proposal.order_id !== order.order_id ||
    proposal.proposal_nonce !== value.proposal_nonce ||
    !Number.isSafeInteger(proposal.proposal_version) ||
    !Number.isSafeInteger(proposal.resolution_round) ||
    proposal.proposal_version !== Number(proposalVersion) ||
    proposal.resolution_round !== Number(resolutionRound) ||
    proposal.active_evidence_digest !== value.active_evidence_digest ||
    !plainObject(proposal.delivery_allocation) ||
    Object.keys(proposal.delivery_allocation).sort().join(",") !== "courier_wei,customer_wei" ||
    !Array.isArray(proposal.item_allocations)
  ) throw new TypeError("Mutual settlement proposal binding is malformed");
  const configuration = getFoodGuardConfiguration();
  if (
    typeof proposal.contract_address !== "string" ||
    !isAddress(proposal.contract_address, { strict: false }) ||
    (configuration.status === "READY" && proposal.contract_address.toLowerCase() !== configuration.address.toLowerCase()) ||
    (await sha256Text(value.proposal_json as string)).toLowerCase() !== (value.digest as string).toLowerCase()
  ) throw new TypeError("Mutual settlement proposal digest or contract binding is malformed");
  const manifest = authoritativeManifest(order.manifest_json);
  if (proposal.item_allocations.length !== manifest.length) throw new TypeError("Mutual item allocations are malformed");
  let expectedCustomer = 0n;
  let expectedRestaurant = 0n;
  const itemAllocations = proposal.item_allocations.map((allocation, index) => {
    if (
      !plainObject(allocation) ||
      Object.keys(allocation).sort().join(",") !== "customer_wei,item_id,restaurant_wei" ||
      allocation.item_id !== manifest[index].item_id
    ) throw new TypeError("Mutual item allocations are malformed");
    const customerWei = unsignedRaw(allocation.customer_wei, "mutual item customer_wei");
    const restaurantWei = unsignedRaw(allocation.restaurant_wei, "mutual item restaurant_wei");
    if (BigInt(customerWei) + BigInt(restaurantWei) !== BigInt(manifest[index].price_wei) * BigInt(manifest[index].quantity)) {
      throw new TypeError("Mutual item allocation does not conserve value");
    }
    expectedCustomer += BigInt(customerWei);
    expectedRestaurant += BigInt(restaurantWei);
    return { customer_wei: customerWei, item_id: allocation.item_id as string, restaurant_wei: restaurantWei };
  });
  const deliveryCustomer = unsignedRaw(proposal.delivery_allocation.customer_wei, "mutual delivery customer_wei");
  const deliveryCourier = unsignedRaw(proposal.delivery_allocation.courier_wei, "mutual delivery courier_wei");
  if (BigInt(deliveryCustomer) + BigInt(deliveryCourier) !== BigInt(order.delivery_fee)) {
    throw new TypeError("Mutual delivery allocation does not conserve value");
  }
  expectedCustomer += BigInt(deliveryCustomer);
  if (
    expectedCustomer !== BigInt(customerTotal) ||
    expectedRestaurant !== BigInt(restaurantTotal) ||
    BigInt(deliveryCourier) !== BigInt(courierTotal)
  ) throw new TypeError("Mutual settlement proposal totals are malformed");
  return {
    active_evidence_digest: value.active_evidence_digest as string,
    courier_signed: value.courier_signed as boolean,
    courier_wei: courierTotal,
    customer_signed: value.customer_signed as boolean,
    customer_wei: customerTotal,
    delivery_allocation: { courier_wei: deliveryCourier, customer_wei: deliveryCustomer },
    digest: value.digest as string,
    item_allocations: itemAllocations,
    is_current: false,
    proposal_json: value.proposal_json as string,
    proposal_nonce: value.proposal_nonce as string,
    proposal_version: proposalVersion,
    resolution_round: resolutionRound,
    restaurant_signed: value.restaurant_signed as boolean,
    restaurant_wei: restaurantTotal,
  };
}

function parseMutualSettlement(
  proposal: SettlementProposalView,
  settlement: SettlementView,
): MutualSettlementView {
  if (
    !proposal.customer_signed ||
    !proposal.restaurant_signed ||
    !proposal.courier_signed ||
    proposal.customer_wei !== String(settlement.customer_wei) ||
    proposal.restaurant_wei !== String(settlement.restaurant_wei) ||
    proposal.courier_wei !== String(settlement.courier_wei)
  ) throw new TypeError("Mutual settlement totals do not match final settlement readback");
  return {
    ...proposal,
    courier_signed: true,
    customer_signed: true,
    restaurant_signed: true,
  };
}

async function activeEvidenceDigest(
  evidence: EvidenceRecordView[],
  resolution: ResolutionView,
): Promise<string> {
  const bindings = resolution.evidence_indices.map((index) => {
    if (index >= evidence.length) throw new TypeError("Resolution evidence index is outside append-only history");
    return [index, evidence[index].sha256.toLowerCase()];
  });
  return sha256Text(canonicalJson(bindings));
}

async function readSettlementProposals(
  orderId: string,
  order: OrderDetailView,
  resolution: ResolutionView,
  round: string,
  evidence: EvidenceRecordView[],
): Promise<SettlementProposalView[]> {
  const count = BigInt(unsignedRaw(
    await readFoodGuard<unknown>("get_settlement_proposal_count", [orderId]),
    "settlement_proposal_count",
  ));
  if (count > MAX_SETTLEMENT_PROPOSALS) {
    throw new TypeError("Settlement proposal count exceeds the safe readback limit");
  }
  const digests = await Promise.all(
    Array.from({ length: Number(count) }, (_, index) =>
      readFoodGuard<unknown>("get_settlement_proposal_digest", [orderId, BigInt(index)]),
    ),
  );
  if (
    digests.some((digest) => typeof digest !== "string" || !/^0x[0-9a-f]{64}$/i.test(digest)) ||
    new Set(digests.map((digest) => (digest as string).toLowerCase())).size !== digests.length
  ) throw new TypeError("Settlement proposal digest index is malformed");
  const typedDigests = digests as string[];
  const resolvedActiveDigest = await activeEvidenceDigest(evidence, resolution);
  const proposals = await Promise.all(
    typedDigests.map((digest) => readFoodGuard<unknown>("get_settlement_proposal", [orderId, digest])
      .then((value) => parseSettlementProposal(value, order))),
  );
  return proposals.map((proposal) => ({
    ...proposal,
    is_current: (
      proposal.resolution_round === round &&
      proposal.active_evidence_digest.toLowerCase() === resolvedActiveDigest.toLowerCase()
    ),
  }));
}

async function expectedSettlementId(
  orderId: string,
  contractAddress: string,
  basis: string,
  settlement: SettlementView,
): Promise<string> {
  return sha256Text(canonicalJson({
    basis,
    chain_id: String(FOODGUARD_CHAIN.id),
    contract_address: contractAddress.toLowerCase(),
    courier_wei: String(settlement.courier_wei),
    customer_wei: String(settlement.customer_wei),
    order_id: orderId,
    restaurant_wei: String(settlement.restaurant_wei),
    schema_version: "foodguard-settlement-v1",
  }));
}

export async function readAuthoritativeOrder(orderId: string): Promise<OrderDetailView> {
  const normalizedOrderId = orderId.trim();
  if (!normalizedOrderId) throw new TypeError("An order ID is required");
  const order = authoritativeBase(
    await readFoodGuard<unknown>("get_order", [normalizedOrderId]),
    normalizedOrderId,
  );
  const countRaw = unsignedRaw(
    await readFoodGuard<unknown>("get_evidence_count", [normalizedOrderId]),
    "evidence_count",
  );
  const count = BigInt(countRaw);
  if (count > MAX_EVIDENCE_HISTORY) throw new TypeError("Evidence count exceeds the safe readback limit");
  const evidence = await Promise.all(
    Array.from({ length: Number(count) }, (_, index) =>
      readFoodGuard<unknown>("get_evidence", [normalizedOrderId, BigInt(index)])
        .then((record) => evidenceRecord(record, order, index)),
    ),
  );
  deriveActiveEvidenceRecords(evidence, authoritativeManifest(order.manifest_json));
  const round = unsignedRaw(
    await readFoodGuard<unknown>("get_round", [normalizedOrderId]),
    "resolution_round",
  );
  const resolution = resolutionStates.has(order.state)
    ? parseResolution(
        await readFoodGuard<unknown>("get_resolution", [normalizedOrderId]),
        order.manifest_json,
      )
    : null;
  if (resolution) {
    const boundDigests = resolution.evidence_indices.map((index) => {
      if (index >= evidence.length) throw new TypeError("Resolution evidence index is outside append-only history");
      return evidence[index].sha256;
    });
    const fullyUnresolved = (
      resolution.delivery_outcome === "UNRESOLVED" &&
      resolution.items.every((item) => item.outcome === "UNRESOLVED")
    );
    const failClosedWithoutDigests = fullyUnresolved && resolution.evidence_hashes.length === 0;
    if (
      !failClosedWithoutDigests && (
        resolution.evidence_hashes.length === 0 ||
        resolution.evidence_hashes.some((digest, index) => digest !== boundDigests[index])
      )
    ) throw new TypeError("Resolution evidence digests do not match its ordered active evidence set");
  }
  assertStateResolutionConsistency(order, round, resolution);
  const settlement = (
    order.state === "SETTLED" ||
    order.state === "CANCELLED_REFUNDED" ||
    order.state === "FULFILLMENT_TIMEOUT_REFUNDED"
  )
    ? parseSettlement(await readFoodGuard<unknown>("get_order_settlement", [normalizedOrderId]))
    : null;
  const needsProposalRead = resolution !== null && (
    order.state === "ESCALATED" ||
    (order.state === "SETTLED" && hasUnresolvedOutcome(resolution))
  );
  const settlementProposals = needsProposalRead && resolution
    ? await readSettlementProposals(normalizedOrderId, order, resolution, round, evidence)
    : [];
  let mutualSettlement: MutualSettlementView | null = null;
  let settlementBases: string[] = [];
  if (settlement) {
    const customer = BigInt(settlement.customer_wei);
    const restaurant = BigInt(settlement.restaurant_wei);
    const courier = BigInt(settlement.courier_wei);
    if (customer + restaurant + courier !== BigInt(order.total_value)) {
      throw new TypeError("Settlement allocations do not conserve the order value");
    }
    const fullRefund = (
      order.state === "CANCELLED_REFUNDED" ||
      order.state === "FULFILLMENT_TIMEOUT_REFUNDED"
    );
    if (fullRefund && (customer !== BigInt(order.total_value) || restaurant !== 0n || courier !== 0n)) {
      throw new TypeError("Cancellation settlement allocation is malformed");
    }
    if (order.state === "CANCELLED_REFUNDED") settlementBases = ["unaccepted-cancellation"];
    if (order.state === "FULFILLMENT_TIMEOUT_REFUNDED") {
      settlementBases = [
        "fulfillment-timeout:ACCEPTED",
        "fulfillment-timeout:READY_FOR_PICKUP",
        "fulfillment-timeout:IN_TRANSIT",
      ];
    }
    if (order.state === "SETTLED") {
      if (!resolution) throw new TypeError("Settled order resolution is missing");
      const items = authoritativeManifest(order.manifest_json);
      const hasUnresolved = hasUnresolvedOutcome(resolution);
      if (hasUnresolved) {
        const matchingProposals = await Promise.all(
          settlementProposals
            .filter((proposal) => (
              proposal.is_current &&
              proposal.customer_signed &&
              proposal.restaurant_signed &&
              proposal.courier_signed &&
              proposal.customer_wei === String(settlement.customer_wei) &&
              proposal.restaurant_wei === String(settlement.restaurant_wei) &&
              proposal.courier_wei === String(settlement.courier_wei)
            ))
            .map(async (proposal) => {
              const stored = JSON.parse(proposal.proposal_json) as { contract_address: string };
              const expected = await expectedSettlementId(
                normalizedOrderId,
                stored.contract_address,
                `mutual:${proposal.digest}`,
                settlement,
              );
              return expected.toLowerCase() === settlement.settlement_id.toLowerCase() ? proposal : null;
            }),
        );
        const matches = matchingProposals.filter((proposal): proposal is SettlementProposalView => proposal !== null);
        if (matches.length !== 1) throw new TypeError("Settlement ID does not bind one current mutual proposal");
        mutualSettlement = parseMutualSettlement(matches[0], settlement);
      } else {
      let expectedCustomer = 0n;
      let expectedRestaurant = 0n;
      for (const [index, result] of resolution.items.entries()) {
        const value = BigInt(items[index].price_wei) * BigInt(items[index].quantity);
        if (result.outcome === "MATCHED") expectedRestaurant += value;
        else if (result.outcome === "UNRESOLVED") throw new TypeError("Settled order cannot contain UNRESOLVED outcomes");
        else expectedCustomer += value;
      }
      const expectedCourier = resolution.delivery_outcome === "DELIVERED" ? BigInt(order.delivery_fee) : 0n;
      if (resolution.delivery_outcome === "UNRESOLVED") throw new TypeError("Settled delivery cannot be UNRESOLVED");
      if (resolution.delivery_outcome === "DELIVERY_FAILED") expectedCustomer += BigInt(order.delivery_fee);
      if (customer !== expectedCustomer || restaurant !== expectedRestaurant || courier !== expectedCourier) {
        throw new TypeError("Settlement allocations do not match the authoritative resolution");
      }
        settlementBases = [`resolution:${await sha256Text(canonicalJson(resolution))}`];
      }
    }
    const configuration = getFoodGuardConfiguration();
    if (settlementBases.length && configuration.status === "READY") {
      const expectedIds = await Promise.all(settlementBases.map((basis) => expectedSettlementId(
        normalizedOrderId,
        configuration.address,
        basis,
        settlement,
      )));
      if (!expectedIds.some((expected) => expected.toLowerCase() === settlement.settlement_id.toLowerCase())) {
        throw new TypeError("Settlement ID does not bind the authoritative allocation");
      }
    }
  }
  return {
    ...order,
    evidence,
    mutual_settlement: mutualSettlement,
    resolution,
    resolution_round: round,
    settlement,
    settlement_proposals: settlementProposals,
  };
}

export async function readAuthoritativeChainTime(): Promise<bigint> {
  const block = await getFoodGuardReadClient().getBlock();
  if (
    typeof block.timestamp !== "bigint" ||
    block.timestamp < 0n ||
    block.timestamp > MAX_AUTHORITATIVE_CHAIN_SECONDS
  ) {
    throw new TypeError("Authoritative chain time is unavailable");
  }
  return block.timestamp;
}

export async function transactAndRead(
  orderId: string,
  method: string,
  args: string[],
  expectedAddress: string | undefined,
  onStage: (stage: TxStage) => void,
): Promise<TrackedOrderReadback> {
  const hash = await writeFoodGuard(method, args, 0n, onStage, expectedAddress);
  await trackTransaction<OrderDetailView>(hash, (stage) => {
    if (stage !== "READBACK_CONFIRMED") onStage(stage);
  });
  const enriched = await readAuthoritativeOrder(orderId);
  onStage("READBACK_CONFIRMED");
  return { order: enriched, transactionHash: hash };
}

interface ActiveEvidenceRequest {
  action: Exclude<EvidenceAction, "ORDER_MANIFEST">;
  itemId?: string;
  method: string;
}

export function OrderDetailWorkspace({
  configuration,
  orderId,
  readChainTime = readAuthoritativeChainTime,
  readOrder = readAuthoritativeOrder,
  transact,
}: {
  configuration: OrderDetailWorkspaceConfiguration;
  orderId: string;
  readChainTime?: ChainTimeReader;
  readOrder?: OrderReader;
  transact?: OrderTransactor;
}) {
  const { copy, locale } = useLocale();
  const [order, setOrder] = useState<OrderDetailView | null>(null);
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [stage, setStage] = useState<TxStage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeEvidence, setActiveEvidence] = useState<ActiveEvidenceRequest | null>(null);
  const [transactionActorAddress, setTransactionActorAddress] = useState<string | null>(null);
  const [transactionMethod, setTransactionMethod] = useState<string | null>(null);
  const [confirmedCorrectionTargetCount, setConfirmedCorrectionTargetCount] = useState<number | null>(null);
  const [clock, setClock] = useState<AuthoritativeClock | null>(null);
  const [clockError, setClockError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!configuration.readsEnabled) return;
    setPending(true);
    setError(null);
    try {
      setOrder(await readOrder(orderId));
    } catch (caught) {
      setOrder(null);
      setError(caught instanceof Error ? caught.message : copy.detail.readFailed);
    } finally {
      setPending(false);
    }
  }, [configuration.readsEnabled, copy.detail.readFailed, orderId, readOrder]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!configuration.readsEnabled) return;
    let active = true;
    let refreshTimer: number | undefined;
    let staleTimer: number | undefined;
    let sampleGeneration = 0;
    let lastAcceptedClock: AuthoritativeClock | null = null;
    const refresh = async () => {
      try {
        const seconds = await readChainTime();
        if (!active) return;
        const sample = sampleAuthoritativeClock(seconds, undefined, lastAcceptedClock);
        if (!sample) throw new TypeError("Monotonic time is unavailable");
        if (sample !== lastAcceptedClock) {
          lastAcceptedClock = sample;
          const generation = ++sampleGeneration;
          if (staleTimer !== undefined) window.clearTimeout(staleTimer);
          setClock(sample);
          setClockError(null);
          staleTimer = window.setTimeout(() => {
            if (!active || generation !== sampleGeneration) return;
            setClock(null);
            setClockError(copy.detail.chainTimeUnavailable);
          }, MAX_CHAIN_SAMPLE_AGE_MS + 1);
        }
      } catch {
        if (!active) return;
        sampleGeneration += 1;
        if (staleTimer !== undefined) window.clearTimeout(staleTimer);
        setClock(null);
        setClockError(copy.detail.chainTimeUnavailable);
      }
      if (active) refreshTimer = window.setTimeout(() => { void refresh(); }, 15_000);
    };
    void refresh();
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (staleTimer !== undefined) window.clearTimeout(staleTimer);
    };
  }, [configuration.readsEnabled, copy.detail.chainTimeUnavailable, readChainTime]);

  if (!configuration.readsEnabled) {
    return (
      <section className="deployment-note order-configuration-state" role="status">
        <strong>DEPLOYMENT_REQUIRED</strong>
        <span>{configuration.message}</span>
      </section>
    );
  }

  async function runWrite(
    method: string,
    args: string[],
    expectedAddress?: string,
    validateReadback?: (nextOrder: OrderDetailView) => void,
  ) {
    if (!configuration.writesEnabled || pending || !order) return order;
    setPending(true);
    setError(null);
    setStage(null);
    setTransactionMethod(method);
    setTransactionActorAddress(expectedAddress ?? null);
    try {
      const result = transact
        ? await transact(method, args, expectedAddress, setStage)
        : await transactAndRead(order.order_id, method, args, expectedAddress, setStage);
      validateReadback?.(result.order);
      setOrder(result.order);
      return result.order;
    } catch (caught) {
      const failure = caught instanceof Error ? caught : new Error(copy.detail.writeFailed);
      setError(failure.message);
      throw failure;
    } finally {
      setPending(false);
    }
  }

  async function roleAction(action: RoleAction, currentOrder: OrderDetailView) {
    if (action.requiresEvidence) {
      const actionByMethod: Record<string, ActiveEvidenceRequest["action"]> = {
        submit_claim_evidence: "CUSTOMER_CLAIM",
        submit_delivery_evidence: "DELIVERED",
        submit_packed_evidence: "PACKED",
        submit_pickup_evidence: "PICKED_UP",
      };
      const evidenceAction = actionByMethod[action.method];
      if (!evidenceAction) return currentOrder;
      setActiveEvidence({ action: evidenceAction, method: action.method });
      return currentOrder;
    }
    return (await runWrite(action.method, [currentOrder.order_id], wallet?.address ?? undefined)) ?? currentOrder;
  }

  const proofHref = `/orders/${encodeURIComponent(orderId)}/proof${locale === "en" ? "?locale=en" : ""}`;
  const evidenceWritesEnabled = configuration.status === "READY" && clock !== null;
  const chainNowMs = authoritativeNowMs(clock);

  return (
    <div className="order-detail-workspace">
      {configuration.status === "PUBLIC_APP_ORIGIN_REQUIRED" && (
        <section className="deployment-note order-configuration-state" role="status">
          <strong>PUBLIC_APP_ORIGIN_REQUIRED</strong>
          <span>{configuration.message}</span>
        </section>
      )}
      {pending && !order && <p className="form-notice" role="status">{copy.detail.reading}</p>}
      {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
      {clockError && <p className="form-notice form-notice--error" role="alert">{clockError}</p>}
      {order && (
        <>
          <header className="order-detail-heading">
            <p className="eyebrow">{copy.detail.eyebrow}</p>
            <h1>{copy.detail.title}</h1>
            <dl className="order-facts">
              <div><dt>Order ID</dt><dd><code>{order.order_id}</code></dd></div>
              <div><dt>{copy.console.state}</dt><dd><code data-testid="raw-detail-state">{order.state}</code></dd></div>
              <div><dt>{copy.detail.totalReserved}</dt><dd><code>{String(order.total_value)} wei</code> <span>Simulated GEN</span></dd></div>
            </dl>
            <a className="button button--quiet" href={proofHref}>{copy.detail.openProof}</a>
          </header>
          <OrderTimeline order={order} />
          <ItemOutcomeTable order={order} />
          <section className="order-card" aria-labelledby="evidence-history-title">
            <h2 id="evidence-history-title">{copy.detail.evidenceHistory}</h2>
            <p className="form-notice">
              Active evidence indices: {" "}
              <code data-testid="active-evidence-indices">
                {deriveActiveEvidenceRecords(order.evidence ?? [], authoritativeManifest(order.manifest_json)).map((record) => record.evidence_index).join(", ")}
              </code>
            </p>
            {order.evidence?.length ? (
              <ol className="evidence-history">
                {order.evidence.map((record, index) => (
                  <li key={`${record.sha256}-${index}`}>
                    <code>{record.action}</code>
                    <a href={record.source_url} rel="noreferrer" target="_blank">{record.source_url}</a>
                    <code>{record.sha256}</code>
                    <span>{record.subject} · {record.issuer_id} · {record.schema_version}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="form-notice">{copy.detail.noEvidence}</p>}
          </section>
          <WalletButton
            actors={[order.customer, order.restaurant, order.courier]}
            onChange={setWallet}
          />
          <RoleConsole
            key={`${order.state}-${order.evidence?.length ?? 0}-${order.resolution_round ?? "0"}`}
            address={wallet?.address}
            clock={clock}
            evidenceWritesEnabled={evidenceWritesEnabled}
            onAction={roleAction}
            order={order}
            writesEnabled={configuration.writesEnabled && wallet?.status === "READY"}
          />
          <ConsensusPanel
            clock={clock}
            disabled={pending || !configuration.writesEnabled}
            onResolve={() => { void runWrite("request_resolution", [order.order_id]).catch(() => undefined); }}
            onSettle={() => { void runWrite("execute_settlement", [order.order_id]).catch(() => undefined); }}
            order={order}
            stage={transactionMethod === "request_resolution" ? stage : null}
          />
          <AppealPanel
            address={wallet?.address}
            clock={clock}
            disabled={pending || !evidenceWritesEnabled || wallet?.status !== "READY"}
            onAppeal={() => setActiveEvidence({ action: "APPEAL", method: "appeal" })}
            onCure={() => setActiveEvidence({ action: "CURE", method: "submit_cure_evidence" })}
            order={order}
          />
          {(order.state === "ESCALATED" || (order.settlement_proposals?.length ?? 0) > 0) && (
            <MutualSettlementPanel
              address={wallet?.address}
              configuration={{
                chainId: configuration.chainId,
                contractAddress: configuration.contractAddress,
                writesEnabled: configuration.writesEnabled && wallet?.status === "READY",
              }}
              disabled={pending || !configuration.writesEnabled}
              nowSeconds={chainNowMs === null ? null : chainNowMs / 1_000n}
              onPropose={async (allocationJson) => {
                await runWrite(
                  "propose_mutual_settlement",
                  [order.order_id, allocationJson],
                  wallet?.address ?? undefined,
                );
              }}
              onSign={async (digest) => {
                await runWrite(
                  "sign_mutual_settlement",
                  [order.order_id, digest],
                  wallet?.address ?? undefined,
                );
              }}
              order={order}
              proposals={order.settlement_proposals ?? []}
            />
          )}
          {activeEvidence && wallet?.address && configuration.contractAddress && clock && chainNowMs !== null && (
            <EvidenceDrawer
              action={activeEvidence.action}
              address={wallet.address}
              chainId={configuration.chainId}
              clock={clock}
              contractAddress={configuration.contractAddress}
              correctableEvidence={deriveActiveEvidenceRecords(order.evidence ?? [], authoritativeManifest(order.manifest_json))}
              disabled={pending || !evidenceWritesEnabled || wallet.status !== "READY"}
              now={new Date(Number(chainNowMs))}
              onSubmit={async (envelopeJson) => {
                const submitted = JSON.parse(envelopeJson) as EvidenceDocument;
                await runWrite(
                  activeEvidence.method,
                  [order.order_id, envelopeJson],
                  wallet.address ?? undefined,
                  activeEvidence.action === "CURE" || activeEvidence.action === "APPEAL"
                    ? (nextOrder) => {
                        const activeRecords = deriveActiveEvidenceRecords(
                          nextOrder.evidence ?? [],
                          authoritativeManifest(nextOrder.manifest_json),
                        );
                        const confirmed = activeRecords.some((record) => (
                          record.action === activeEvidence.action &&
                          record.actor_wallet.toLowerCase() === wallet.address?.toLowerCase() &&
                          record.sha256.toLowerCase() === submitted.sha256.toLowerCase()
                        ));
                        const activeIndices = new Set(activeRecords.map((record) => record.evidence_index));
                        const targetsRemoved = submitted.supersedes_evidence_indices?.every((index) => !activeIndices.has(index)) ?? false;
                        if (!confirmed || !targetsRemoved) throw new TypeError(copy.detail.correctionReadbackFailed);
                      }
                    : undefined,
                );
                if (activeEvidence.action === "CURE" || activeEvidence.action === "APPEAL") {
                  setConfirmedCorrectionTargetCount(submitted.supersedes_evidence_indices?.length ?? null);
                }
                setActiveEvidence(null);
              }}
              order={order}
            />
          )}
          <TransactionLifecycle
            actorAddress={transactionActorAddress}
            operation={transactionMethod}
            stage={stage}
          />
          {confirmedCorrectionTargetCount !== null && (
            <p className="form-notice form-notice--success">
              {locale === "en"
                ? `${confirmedCorrectionTargetCount} evidence selected`
                : `${confirmedCorrectionTargetCount} bằng chứng đã chọn`}
            </p>
          )}
        </>
      )}
    </div>
  );
}

type DynamicParams = Promise<{ id: string }>;
type DynamicSearchParams = Promise<{ locale?: string | string[] }>;

export default function OrderDetailPage({
  params,
  searchParams,
}: {
  params: DynamicParams;
  searchParams: DynamicSearchParams;
}) {
  const { id } = use(params);
  const query = use(searchParams);
  const rawLocale = Array.isArray(query.locale) ? query.locale[0] : query.locale;
  const locale: Locale = rawLocale === "en" ? "en" : "vi";
  const contract = getFoodGuardConfiguration();
  const publicOrigin = getFoodGuardPublicAppOriginConfiguration();
  const chainId = String(FOODGUARD_CHAIN.id);
  const configuration: OrderDetailWorkspaceConfiguration = contract.status !== "READY"
    ? {
        chainId,
        contractAddress: null,
        message: contract.message,
        readsEnabled: false,
        status: "DEPLOYMENT_REQUIRED",
        writesEnabled: false,
      }
    : publicOrigin.status !== "READY"
      ? {
          chainId,
          contractAddress: contract.address,
          message: publicOrigin.message,
          readsEnabled: true,
          status: "PUBLIC_APP_ORIGIN_REQUIRED",
          writesEnabled: true,
        }
      : {
          chainId,
          contractAddress: contract.address,
          message: null,
          readsEnabled: true,
          status: "READY",
          writesEnabled: true,
        };

  return (
    <LocaleProvider hasExplicitLocale={Boolean(rawLocale)} initialLocale={locale}>
      <WorkflowShell page="orders">
        <OrderDetailWorkspace configuration={configuration} orderId={id} />
      </WorkflowShell>
    </LocaleProvider>
  );
}
