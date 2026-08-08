"use client";

import { use, useCallback, useEffect, useState } from "react";
import { isAddress } from "viem";

import { AppealPanel } from "../../../components/order/AppealPanel";
import { ConsensusPanel } from "../../../components/order/ConsensusPanel";
import { EvidenceDrawer, isPublicEvidenceUrl } from "../../../components/order/EvidenceDrawer";
import {
  ItemOutcomeTable,
  type EvidenceRecordView,
  type OrderDetailView,
  type ResolutionView,
  type SettlementView,
} from "../../../components/order/ItemOutcomeTable";
import { OrderTimeline } from "../../../components/order/OrderTimeline";
import { authoritativeNowMs, type AuthoritativeClock } from "../../../components/order/authoritativeClock";
import { RoleConsole, type RoleAction } from "../../../components/order/RoleConsole";
import { TransactionLifecycle } from "../../../components/order/TransactionLifecycle";
import { WalletButton, type WalletSnapshot } from "../../../components/wallet/WalletButton";
import type { DeliveryOutcome, EvidenceAction, EvidenceDocument, ItemOutcome, OrderItem, OrderState } from "../../../lib/domain";
import { canonicalizeEvidenceEnvelope, hashEvidence } from "../../../lib/evidence";
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
  "ESCALATED", "SETTLED", "CANCELLED_REFUNDED",
]);
const evidenceActions = new Set<EvidenceAction>([
  "PACKED", "PICKED_UP", "DELIVERED", "CUSTOMER_CLAIM", "CURE", "APPEAL",
]);
const MAX_U64 = (1n << 64n) - 1n;
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
  const finalState = value.state === "SETTLED" || value.state === "CANCELLED_REFUNDED";
  if (Boolean(value.items_settled) !== finalState || Boolean(value.delivery_settled) !== finalState) {
    throw new TypeError("Order settlement flags are inconsistent with its state");
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

async function evidenceRecord(value: unknown, order: OrderDetailView): Promise<EvidenceRecordView> {
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
  let canonicalEnvelope: string;
  try { canonicalEnvelope = canonicalizeEvidenceEnvelope(envelope as EvidenceDocument); } catch { throw new TypeError("Evidence envelope readback is malformed"); }
  if (canonicalEnvelope !== value.envelope_json) throw new TypeError("Evidence envelope readback is not canonical");
  const metadataFields = required.filter((field) => field !== "envelope_json");
  if (metadataFields.some((field) => envelope[field] !== value[field])) throw new TypeError("Evidence record does not match its envelope");
  const itemId = typeof value.item_id === "string" ? value.item_id : "";
  if ((envelope.item_id ?? "") !== itemId) throw new TypeError("Evidence item binding is malformed");
  const items = authoritativeManifest(order.manifest_json);
  if (itemId && !items.some((item) => item.item_id === itemId)) throw new TypeError("Evidence item binding is malformed");
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
  return value as unknown as EvidenceRecordView;
}

function parseResolution(value: unknown, manifestJson: string): ResolutionView {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new TypeError("Resolution readback is malformed"); }
  }
  if (
    !plainObject(parsed) ||
    Object.keys(parsed).sort().join(",") !== "delivery_outcome,evidence_hashes,items" ||
    !Array.isArray(parsed.items) ||
    !Array.isArray(parsed.evidence_hashes)
  ) {
    throw new TypeError("Resolution readback is malformed");
  }
  const manifest = JSON.parse(manifestJson) as { items: Array<{ item_id: string }> };
  const itemOutcomes = new Set(["MATCHED", "MISSING", "MISMATCHED", "DELIVERY_FAILED", "UNRESOLVED"]);
  const deliveryOutcomes = new Set(["DELIVERED", "DELIVERY_FAILED", "UNRESOLVED"]);
  if (
    parsed.items.length !== manifest.items.length ||
    !deliveryOutcomes.has(parsed.delivery_outcome as string) ||
    !parsed.evidence_hashes.every((hash) => typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash))
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
    evidence_hashes: parsed.evidence_hashes as string[],
    items,
  };
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
  if (count > 256n) throw new TypeError("Evidence count exceeds the safe readback limit");
  const evidence = await Promise.all(
    Array.from({ length: Number(count) }, (_, index) =>
      readFoodGuard<unknown>("get_evidence", [normalizedOrderId, BigInt(index)])
        .then((record) => evidenceRecord(record, order)),
    ),
  );
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
    const readbackDigests = evidence.map((record) => record.sha256);
    if (
      resolution.evidence_hashes.length !== readbackDigests.length ||
      resolution.evidence_hashes.some((digest, index) => digest !== readbackDigests[index])
    ) throw new TypeError("Resolution evidence digests do not match append-only evidence");
  }
  const settlement = order.state === "SETTLED" || order.state === "CANCELLED_REFUNDED"
    ? parseSettlement(await readFoodGuard<unknown>("get_order_settlement", [normalizedOrderId]))
    : null;
  if (settlement) {
    const customer = BigInt(settlement.customer_wei);
    const restaurant = BigInt(settlement.restaurant_wei);
    const courier = BigInt(settlement.courier_wei);
    if (customer + restaurant + courier !== BigInt(order.total_value)) {
      throw new TypeError("Settlement allocations do not conserve the order value");
    }
    if (order.state === "CANCELLED_REFUNDED" && (customer !== BigInt(order.total_value) || restaurant !== 0n || courier !== 0n)) {
      throw new TypeError("Cancellation settlement allocation is malformed");
    }
    if (order.state === "SETTLED") {
      if (!resolution) throw new TypeError("Settled order resolution is missing");
      const items = authoritativeManifest(order.manifest_json);
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
    }
  }
  return { ...order, evidence, resolution, resolution_round: round, settlement };
}

export async function readAuthoritativeChainTime(): Promise<bigint> {
  const block = await getFoodGuardReadClient().getBlock();
  if (typeof block.timestamp !== "bigint" || block.timestamp < 0n) {
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
  const [transactionMethod, setTransactionMethod] = useState<string | null>(null);
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
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const seconds = await readChainTime();
        if (!active) return;
        setClock({ sampledAtMs: Date.now(), seconds });
        setClockError(null);
      } catch {
        if (!active) return;
        setClock(null);
        setClockError(copy.detail.chainTimeUnavailable);
      }
      if (active) timer = window.setTimeout(() => { void refresh(); }, 15_000);
    };
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
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

  async function runWrite(method: string, args: string[], expectedAddress?: string) {
    if (!configuration.writesEnabled || pending || !order) return order;
    setPending(true);
    setError(null);
    setStage(null);
    setTransactionMethod(method);
    try {
      const result = transact
        ? await transact(method, args, expectedAddress, setStage)
        : await transactAndRead(order.order_id, method, args, expectedAddress, setStage);
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
          {activeEvidence && wallet?.address && configuration.contractAddress && clock && chainNowMs !== null && (
            <EvidenceDrawer
              action={activeEvidence.action}
              address={wallet.address}
              chainId={configuration.chainId}
              clock={clock}
              contractAddress={configuration.contractAddress}
              disabled={pending || !evidenceWritesEnabled || wallet.status !== "READY"}
              now={new Date(Number(chainNowMs))}
              onSubmit={async (envelopeJson) => {
                await runWrite(activeEvidence.method, [order.order_id, envelopeJson], wallet.address ?? undefined);
                setActiveEvidence(null);
              }}
              order={order}
            />
          )}
          <TransactionLifecycle stage={stage} />
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
