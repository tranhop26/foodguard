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

export function ItemOutcomeTable({ order }: { order: OrderDetailView }) {
  const { copy } = useLocale();
  const items = readManifestItems(order.manifest_json);
  const resolution = items && validResolution(order.resolution, items)
    ? order.resolution
    : null;

  if (!items || !resolution) {
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
              const result = resolution.items[index];
              return (
                <tr key={item.item_id}>
                  <th scope="row">
                    {item.name}
                    <code>{item.item_id}</code>
                  </th>
                  <td><code>{itemValueWei(item)} wei</code></td>
                  <td>
                    <span>{copy.outcomes[result.outcome]}</span>
                    <code>{result.outcome}</code>
                  </td>
                  <td>{itemAllocation(result.outcome, copy)}</td>
                </tr>
              );
            })}
            <tr>
              <th scope="row">{copy.detail.deliveryFee}</th>
              <td><code>{String(order.delivery_fee)} wei</code></td>
              <td>
                <span>{copy.detail.deliveryOutcomes[resolution.delivery_outcome]}</span>
                <code>{resolution.delivery_outcome}</code>
              </td>
              <td>{deliveryAllocation(resolution.delivery_outcome, copy)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
