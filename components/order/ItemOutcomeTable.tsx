"use client";

import type {
  DeliveryOutcome,
  EvidenceDocument,
  ItemOutcome,
  OrderItem,
  OrderState,
} from "../../lib/domain";
import { useLocale } from "../../lib/i18n";

export interface ResolutionItemView {
  facts: string[];
  item_id: string;
  outcome: ItemOutcome;
}

export interface ResolutionView {
  delivery_outcome: DeliveryOutcome;
  evidence_hashes: string[];
  evidence_indices: number[];
  items: ResolutionItemView[];
}

export interface EvidenceRecordView {
  action: EvidenceDocument["action"];
  actor_wallet: string;
  chain_id: string;
  contract_address: string;
  expires_at: string;
  envelope_json?: string;
  issuer_id: string;
  item_id?: string;
  nonce: string;
  observed_at: string;
  order_id: string;
  schema_version: "foodguard-evidence/1";
  sha256: string;
  source_url: string;
  subject: string;
  submitted_at: string;
}

export interface SettlementView {
  courier_wei: bigint | number | string;
  customer_wei: bigint | number | string;
  restaurant_wei: bigint | number | string;
  settlement_id: string;
}

export interface MutualSettlementView {
  courier_signed: true;
  courier_wei: string;
  customer_signed: true;
  customer_wei: string;
  delivery_allocation: {
    courier_wei: string;
    customer_wei: string;
  };
  digest: string;
  item_allocations: Array<{
    customer_wei: string;
    item_id: string;
    restaurant_wei: string;
  }>;
  proposal_json: string;
  proposal_nonce: string;
  proposal_version: string;
  resolution_round: string;
  active_evidence_digest: string;
  restaurant_signed: true;
  restaurant_wei: string;
}

export interface SettlementProposalView {
  active_evidence_digest: string;
  courier_signed: boolean;
  courier_wei: string;
  customer_signed: boolean;
  customer_wei: string;
  delivery_allocation: {
    courier_wei: string;
    customer_wei: string;
  };
  digest: string;
  item_allocations: Array<{
    customer_wei: string;
    item_id: string;
    restaurant_wei: string;
  }>;
  is_current: boolean;
  proposal_json: string;
  proposal_nonce: string;
  proposal_version: string;
  resolution_round: string;
  restaurant_signed: boolean;
  restaurant_wei: string;
}

export interface OrderDetailView {
  acceptance_deadline?: bigint | number | string;
  appeal_deadline?: bigint | number | string;
  courier: string;
  courier_accepted: boolean;
  customer: string;
  delivery_deadline?: bigint | number | string;
  delivery_fee: bigint | number | string;
  delivery_settled?: boolean;
  evidence?: EvidenceRecordView[];
  items_settled?: boolean;
  manifest_json: string;
  mutual_settlement?: MutualSettlementView | null;
  settlement_proposals?: SettlementProposalView[];
  order_id: string;
  packing_deadline?: bigint | number | string;
  restaurant: string;
  restaurant_accepted: boolean;
  resolution?: ResolutionView | null;
  resolution_round?: bigint | number | string;
  review_deadline?: bigint | number | string;
  settlement?: SettlementView | null;
  state: OrderState;
  subtotal: bigint | number | string;
  total_value: bigint | number | string;
  [key: string]: unknown;
}

const itemOutcomes = new Set<ItemOutcome>([
  "MATCHED",
  "MISSING",
  "MISMATCHED",
  "DELIVERY_FAILED",
  "UNRESOLVED",
]);
const deliveryOutcomes = new Set<DeliveryOutcome>([
  "DELIVERED",
  "DELIVERY_FAILED",
  "UNRESOLVED",
]);

function readManifestItems(manifestJson: string): OrderItem[] | null {
  try {
    const value: unknown = JSON.parse(manifestJson);
    if (typeof value !== "object" || value === null || !("items" in value)) return null;
    const items = (value as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    const valid = items.every((item) => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Partial<OrderItem>;
      return (
        typeof candidate.item_id === "string" &&
        candidate.item_id.length > 0 &&
        typeof candidate.name === "string" &&
        Number.isSafeInteger(candidate.quantity) &&
        (candidate.quantity ?? 0) > 0 &&
        typeof candidate.price_wei === "string" &&
        /^(0|[1-9][0-9]*)$/.test(candidate.price_wei)
      );
    });
    return valid ? (items as OrderItem[]) : null;
  } catch {
    return null;
  }
}

function validResolution(
  resolution: ResolutionView | null | undefined,
  items: OrderItem[],
): resolution is ResolutionView {
  if (
    !resolution ||
    !deliveryOutcomes.has(resolution.delivery_outcome) ||
    !Array.isArray(resolution.items) ||
    resolution.items.length !== items.length
  ) return false;
  return resolution.items.every(
    (result, index) =>
      result.item_id === items[index].item_id &&
      itemOutcomes.has(result.outcome) &&
      Array.isArray(result.facts) &&
      result.facts.every((fact) => typeof fact === "string"),
  );
}

function itemValueWei(item: OrderItem): string {
  return (BigInt(item.price_wei) * BigInt(item.quantity)).toString();
}

function itemAllocation(outcome: ItemOutcome, copy: ReturnType<typeof useLocale>["copy"]): string {
  if (outcome === "MATCHED") return copy.detail.restaurantAllocation;
  if (outcome === "UNRESOLVED") return copy.detail.escrowLocked;
  return copy.detail.customerRefund;
}

function deliveryAllocation(outcome: DeliveryOutcome, copy: ReturnType<typeof useLocale>["copy"]): string {
  if (outcome === "DELIVERED") return copy.detail.courierAllocation;
  if (outcome === "UNRESOLVED") return copy.detail.escrowLocked;
  return copy.detail.customerRefund;
}

function mutualItemAllocation(
  allocation: MutualSettlementView["item_allocations"][number],
  copy: ReturnType<typeof useLocale>["copy"],
): string {
  return `${copy.roles.CUSTOMER}: ${allocation.customer_wei} wei / ${copy.roles.RESTAURANT}: ${allocation.restaurant_wei} wei`;
}

function mutualDeliveryAllocation(
  allocation: MutualSettlementView["delivery_allocation"],
  copy: ReturnType<typeof useLocale>["copy"],
): string {
  return `${copy.roles.CUSTOMER}: ${allocation.customer_wei} wei / ${copy.roles.COURIER}: ${allocation.courier_wei} wei`;
}

function validMutualSettlement(
  settlement: MutualSettlementView | null | undefined,
  items: OrderItem[],
  deliveryFee: OrderDetailView["delivery_fee"],
): settlement is MutualSettlementView {
  if (!settlement) return false;
  const unsigned = (value: unknown): value is string => (
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
  );
  if (
    settlement.customer_signed !== true ||
    settlement.restaurant_signed !== true ||
    settlement.courier_signed !== true ||
    !/^0x[0-9a-f]{64}$/i.test(settlement.digest) ||
    !settlement.proposal_json ||
    !settlement.proposal_nonce ||
    !unsigned(settlement.customer_wei) ||
    !unsigned(settlement.restaurant_wei) ||
    !unsigned(settlement.courier_wei) ||
    !Array.isArray(settlement.item_allocations) ||
    settlement.item_allocations.length !== items.length ||
    !settlement.delivery_allocation ||
    !unsigned(settlement.delivery_allocation.customer_wei) ||
    !unsigned(settlement.delivery_allocation.courier_wei)
  ) return false;
  try {
    let customer = BigInt(settlement.delivery_allocation.customer_wei);
    let restaurant = 0n;
    const validItems = settlement.item_allocations.every((allocation, index) => {
      if (
        allocation.item_id !== items[index].item_id ||
        !unsigned(allocation.customer_wei) ||
        !unsigned(allocation.restaurant_wei)
      ) return false;
      const itemValue = BigInt(items[index].price_wei) * BigInt(items[index].quantity);
      if (BigInt(allocation.customer_wei) + BigInt(allocation.restaurant_wei) !== itemValue) return false;
      customer += BigInt(allocation.customer_wei);
      restaurant += BigInt(allocation.restaurant_wei);
      return true;
    });
    return (
      validItems &&
      BigInt(settlement.delivery_allocation.customer_wei) + BigInt(settlement.delivery_allocation.courier_wei) === BigInt(String(deliveryFee)) &&
      customer === BigInt(settlement.customer_wei) &&
      restaurant === BigInt(settlement.restaurant_wei) &&
      BigInt(settlement.delivery_allocation.courier_wei) === BigInt(settlement.courier_wei)
    );
  } catch {
    return false;
  }
}

export function ItemOutcomeTable({ order }: { order: OrderDetailView }) {
  const { copy } = useLocale();
  const items = readManifestItems(order.manifest_json);
  const resolution = items && validResolution(order.resolution, items)
    ? order.resolution
    : null;
  const mutualSettlement = items && validMutualSettlement(order.mutual_settlement, items, order.delivery_fee)
    ? order.mutual_settlement
    : null;
  const malformedMutualSettlement = order.mutual_settlement != null && mutualSettlement === null;
  const cancelled = (
    order.state === "CANCELLED_REFUNDED" ||
    order.state === "FULFILLMENT_TIMEOUT_REFUNDED"
  );
  const lockedBeforeResolution = (
    order.resolution == null &&
    !cancelled &&
    order.state !== "SETTLED" &&
    order.state !== "RESOLVED" &&
    order.state !== "APPEALED" &&
    order.state !== "EVIDENCE_CURE" &&
    order.state !== "ESCALATED"
  );
  const unavailable = (!resolution && !cancelled && !lockedBeforeResolution) || malformedMutualSettlement;

  if (!items) {
    return (
      <section className="order-card" aria-labelledby="outcomes-title">
        <h2 id="outcomes-title">{copy.detail.outcomes}</h2>
        <p className="form-notice">{copy.detail.outcomesUnavailable}</p>
      </section>
    );
  }

  return (
    <section className="order-card" aria-labelledby="outcomes-title">
      <h2 id="outcomes-title">{copy.detail.outcomes}</h2>
      <div className="outcome-table-wrap">
        <table className="outcome-table">
          <thead>
            <tr>
              <th scope="col">{copy.detail.commitment}</th>
              <th scope="col">{copy.detail.reservedWei}</th>
              <th scope="col">{copy.detail.outcome}</th>
              <th scope="col">{copy.detail.allocation}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const result = resolution?.items[index];
              return (
                <tr key={item.item_id}>
                  <th scope="row">
                    {item.name}
                    <code>{item.item_id}</code>
                  </th>
                  <td><code>{itemValueWei(item)} wei</code></td>
                  <td>
                    {result ? (
                      <><span>{copy.outcomes[result.outcome]}</span><code>{result.outcome}</code></>
                    ) : cancelled ? (
                      <><span>{copy.detail.cancelledOutcome}</span><code>{order.state}</code></>
                    ) : (
                      <span>{unavailable ? copy.detail.consequenceUnavailable : copy.detail.noStoredOutcome}</span>
                    )}
                  </td>
                  <td>{mutualSettlement
                    ? mutualItemAllocation(mutualSettlement.item_allocations[index], copy)
                    : cancelled
                      ? copy.detail.customerRefund
                      : result && !unavailable
                        ? itemAllocation(result.outcome, copy)
                        : lockedBeforeResolution
                          ? copy.detail.escrowLocked
                          : copy.detail.consequenceUnavailable}</td>
                </tr>
              );
            })}
            <tr>
              <th scope="row">{copy.detail.deliveryFee}</th>
              <td><code>{String(order.delivery_fee)} wei</code></td>
              <td>
                {resolution ? (
                  <><span>{copy.detail.deliveryOutcomes[resolution.delivery_outcome]}</span><code>{resolution.delivery_outcome}</code></>
                ) : cancelled ? (
                  <><span>{copy.detail.cancelledOutcome}</span><code>{order.state}</code></>
                ) : (
                  <span>{unavailable ? copy.detail.consequenceUnavailable : copy.detail.noStoredOutcome}</span>
                )}
              </td>
              <td>{mutualSettlement
                ? mutualDeliveryAllocation(mutualSettlement.delivery_allocation, copy)
                : cancelled
                  ? copy.detail.customerRefund
                  : resolution && !unavailable
                    ? deliveryAllocation(resolution.delivery_outcome, copy)
                    : lockedBeforeResolution
                      ? copy.detail.escrowLocked
                      : copy.detail.consequenceUnavailable}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
