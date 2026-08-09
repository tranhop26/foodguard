"use client";

import { useEffect, useMemo, useState } from "react";

import type { OrderItem } from "../../lib/domain";
import { useLocale } from "../../lib/i18n";
import { deriveWalletRole, type WalletRole } from "../wallet/WalletButton";
import type { OrderDetailView } from "./ItemOutcomeTable";

const MAX_U256 = (1n << 256n) - 1n;

export interface MutualSettlementPanelConfiguration {
  chainId: string;
  contractAddress: string | null;
  writesEnabled: boolean;
}

/** A normalized, digest-keyed proposal read from the FoodGuard contract. */
export interface MutualSettlementProposalView {
  active_evidence_digest: string;
  courier_signed: boolean;
  courier_wei: string;
  customer_signed: boolean;
  customer_wei: string;
  digest: string;
  /** True only when this offer still binds the latest resolution round and active evidence. */
  is_current: boolean;
  proposal_json: string;
  proposal_nonce: string;
  proposal_version: string;
  resolution_round: string;
  restaurant_signed: boolean;
  restaurant_wei: string;
}

interface ManifestSettlementItem {
  item_id: string;
  label: string;
  totalWei: bigint;
}

interface MutualSettlementPanelProps {
  address?: string | null;
  configuration: MutualSettlementPanelConfiguration;
  disabled?: boolean;
  /** The latest authoritative chain time in whole seconds, or null when unavailable. */
  nowSeconds?: bigint | null;
  /** Receives the exact canonical caller payload accepted by propose_mutual_settlement. */
  onPropose?(allocationJson: string): Promise<unknown> | unknown;
  /** Receives the selected contract-stored proposal digest. */
  onSign?(digest: string): Promise<unknown> | unknown;
  order: OrderDetailView;
  proposals: readonly MutualSettlementProposalView[];
}

function parseU256(value: unknown): bigint | null {
  try {
    let parsed: bigint;
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
    else return null;
    return parsed >= 0n && parsed <= MAX_U256 ? parsed : null;
  } catch {
    return null;
  }
}

function parseManifestItems(manifestJson: string): ManifestSettlementItem[] | null {
  try {
    const parsed: unknown = JSON.parse(manifestJson);
    if (typeof parsed !== "object" || parsed === null || !("items" in parsed)) return null;
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const ids = new Set<string>();
    const result: ManifestSettlementItem[] = [];
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) return null;
      const item = raw as Partial<OrderItem>;
      const quantity = item.quantity;
      if (
        typeof item.item_id !== "string" ||
        !item.item_id ||
        ids.has(item.item_id) ||
        typeof item.name !== "string" ||
        !item.name ||
        !Number.isSafeInteger(quantity) ||
        quantity === undefined ||
        quantity <= 0
      ) return null;
      const price = parseU256(item.price_wei);
      if (price === null) return null;
      const totalWei = price * BigInt(quantity);
      if (totalWei > MAX_U256) return null;
      ids.add(item.item_id);
      result.push({ item_id: item.item_id, label: item.name, totalWei });
    }
    return result;
  } catch {
    return null;
  }
}

function parseDeadline(value: unknown): bigint | null {
  return parseU256(value);
}

function makeProposalNonce(): string {
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `mutual-${uuid}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Canonical proposal value is invalid");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function signedByRole(proposal: MutualSettlementProposalView, role: WalletRole | null): boolean {
  if (role === "CUSTOMER") return proposal.customer_signed;
  if (role === "RESTAURANT") return proposal.restaurant_signed;
  if (role === "COURIER") return proposal.courier_signed;
  return true;
}

function allocationError(
  itemRefunds: Record<string, string>,
  items: readonly ManifestSettlementItem[] | null,
  deliveryRefund: string,
  deliveryFee: bigint | null,
): string | null {
  if (!items || deliveryFee === null) return "invalid-order";
  for (const item of items) {
    const refund = parseU256(itemRefunds[item.item_id] ?? "0");
    if (refund === null || refund > item.totalWei) return item.item_id;
  }
  const delivery = parseU256(deliveryRefund);
  return delivery === null || delivery > deliveryFee ? "delivery" : null;
}

export function MutualSettlementPanel({
  address,
  configuration,
  disabled = false,
  nowSeconds = null,
  onPropose,
  onSign,
  order,
  proposals,
}: MutualSettlementPanelProps) {
  const { copy } = useLocale();
  const items = useMemo(() => parseManifestItems(order.manifest_json), [order.manifest_json]);
  const deliveryFee = useMemo(() => parseU256(order.delivery_fee), [order.delivery_fee]);
  const [itemRefunds, setItemRefunds] = useState<Record<string, string>>({});
  const [deliveryRefund, setDeliveryRefund] = useState("0");
  const [proposalNonce, setProposalNonce] = useState(makeProposalNonce);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const role = address
    ? deriveWalletRole(address, [order.customer, order.restaurant, order.courier])
    : null;
  const participant = role !== null && role !== "OUTSIDER";
  const appealDeadline = parseDeadline(order.appeal_deadline);
  const deadlineReached = nowSeconds !== null && appealDeadline !== null && nowSeconds >= appealDeadline;
  const escalated = order.state === "ESCALATED";
  const writeReady = configuration.writesEnabled && Boolean(configuration.contractAddress?.trim());
  const formError = allocationError(itemRefunds, items, deliveryRefund, deliveryFee);
  const canPropose = escalated && deadlineReached && participant && writeReady && Boolean(onPropose);

  useEffect(() => {
    setItemRefunds(Object.fromEntries((items ?? []).map((item) => [item.item_id, "0"])));
    setDeliveryRefund("0");
    setProposalNonce(makeProposalNonce());
    setNotice(null);
    setError(null);
  }, [items, order.order_id]);

  function customerRefundFor(item: ManifestSettlementItem): bigint | null {
    const value = parseU256(itemRefunds[item.item_id] ?? "0");
    return value === null || value > item.totalWei ? null : value;
  }

  async function submitProposal() {
    if (!canPropose || disabled || formError || !items || deliveryFee === null || !onPropose || pending) return;
    const deliveryCustomer = parseU256(deliveryRefund);
    if (deliveryCustomer === null || deliveryCustomer > deliveryFee) return;
    const allocation = {
      delivery_allocation: {
        courier_wei: (deliveryFee - deliveryCustomer).toString(),
        customer_wei: deliveryCustomer.toString(),
      },
      item_allocations: items.map((item) => {
        const customer = customerRefundFor(item);
        if (customer === null) throw new TypeError("Mutual settlement allocation is invalid");
        return {
          customer_wei: customer.toString(),
          item_id: item.item_id,
          restaurant_wei: (item.totalWei - customer).toString(),
        };
      }),
      proposal_nonce: proposalNonce.trim(),
    };
    if (!allocation.proposal_nonce) {
      setError(copy.detail.mutualSettlementInvalid);
      return;
    }
    setError(null);
    setNotice(null);
    setPending("proposal");
    try {
      await onPropose(canonicalJson(allocation));
      setNotice(copy.detail.mutualSettlementProposed);
      setProposalNonce(makeProposalNonce());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.detail.writeFailed);
    } finally {
      setPending(null);
    }
  }

  async function signProposal(digest: string) {
    if (!onSign || !participant || !escalated || !writeReady || disabled || pending) return;
    setError(null);
    setNotice(null);
    setPending(digest);
    try {
      await onSign(digest);
      setNotice(copy.detail.mutualSettlementSignedNotice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.detail.writeFailed);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="order-card mutual-settlement-panel" aria-labelledby="mutual-settlement-title">
      <h2 id="mutual-settlement-title">{copy.detail.mutualSettlementTitle}</h2>
      <p>{copy.detail.mutualSettlementIntro}</p>
      <dl className="order-facts">
        <div><dt>{copy.detail.chainId}</dt><dd><code>{configuration.chainId}</code></dd></div>
        <div><dt>{copy.detail.contractAddress}</dt><dd><code>{configuration.contractAddress ?? "UNCONFIGURED"}</code></dd></div>
        <div><dt>{copy.detail.appealDeadline}</dt><dd><code>{appealDeadline?.toString() ?? "INVALID"}</code></dd></div>
      </dl>

      {escalated && !deadlineReached && (
        <p className="form-notice form-notice--warning">{copy.detail.mutualSettlementDeadline}</p>
      )}
      {!escalated && <p className="form-notice">{copy.detail.mutualSettlementState}</p>}
      {escalated && !participant && <p className="form-notice">{copy.detail.mutualSettlementParticipant}</p>}
      {escalated && participant && !writeReady && <p className="form-notice form-notice--warning">{copy.detail.mutualSettlementWriteLocked}</p>}

      {canPropose && (
        <fieldset className="order-fields">
          <legend>{copy.detail.mutualSettlementBuild}</legend>
          {items?.map((item) => {
            const customer = customerRefundFor(item);
            const restaurant = customer === null ? null : item.totalWei - customer;
            return (
              <label key={item.item_id}>
                <span>{copy.detail.mutualSettlementItemRefund} {item.label} (wei)</span>
                <input
                  aria-label={`${copy.detail.mutualSettlementItemRefund} ${item.label} (wei)`}
                  inputMode="numeric"
                  onChange={(event) => setItemRefunds((current) => ({ ...current, [item.item_id]: event.target.value }))}
                  type="text"
                  value={itemRefunds[item.item_id] ?? "0"}
                />
                <small>{copy.detail.mutualSettlementRestaurantReceives}: <code>{restaurant?.toString() ?? "INVALID"}</code> wei</small>
              </label>
            );
          })}
          <label>
            <span>{copy.detail.mutualSettlementDeliveryRefund} (wei)</span>
            <input
              aria-label={`${copy.detail.mutualSettlementDeliveryRefund} (wei)`}
              inputMode="numeric"
              onChange={(event) => setDeliveryRefund(event.target.value)}
              type="text"
              value={deliveryRefund}
            />
            <small>{copy.detail.mutualSettlementCourierReceives}: <code>{deliveryFee === null || parseU256(deliveryRefund) === null || parseU256(deliveryRefund)! > deliveryFee ? "INVALID" : (deliveryFee - parseU256(deliveryRefund)!).toString()}</code> wei</small>
          </label>
          <label>
            <span>{copy.detail.mutualSettlementNonce}</span>
            <input
              aria-label={copy.detail.mutualSettlementNonce}
              maxLength={128}
              onChange={(event) => setProposalNonce(event.target.value)}
              type="text"
              value={proposalNonce}
            />
          </label>
          {formError && <p className="form-notice form-notice--error" role="alert">{copy.detail.mutualSettlementInvalid}</p>}
          <button
            className="button button--primary"
            disabled={disabled || Boolean(formError) || pending !== null}
            onClick={() => { void submitProposal(); }}
            type="button"
          >
            {copy.detail.mutualSettlementPropose}
          </button>
        </fieldset>
      )}

      <h3>{copy.detail.mutualSettlementOffers}</h3>
      {proposals.length === 0 ? (
        <p className="form-notice">{copy.detail.mutualSettlementNoOffers}</p>
      ) : (
        <ol className="evidence-history">
          {proposals.map((proposal) => {
            const alreadySigned = signedByRole(proposal, role);
            const canSign = participant && escalated && deadlineReached && writeReady && proposal.is_current && Boolean(onSign) && !alreadySigned;
            return (
              <li key={proposal.digest}>
                <code>{proposal.digest}</code>
                <span>{copy.detail.mutualSettlementVersion}: <code>{proposal.proposal_version}</code> · {copy.detail.mutualSettlementRound}: <code>{proposal.resolution_round}</code></span>
                <span>{copy.detail.mutualSettlementEvidence}: <code>{proposal.active_evidence_digest}</code></span>
                {!proposal.is_current && <span className="form-notice form-notice--warning">{copy.detail.mutualSettlementStale}</span>}
                <span>{copy.roles.CUSTOMER}: {proposal.customer_signed ? copy.detail.mutualSettlementSigned : copy.detail.mutualSettlementAwaiting}</span>
                <span>{copy.roles.RESTAURANT}: {proposal.restaurant_signed ? copy.detail.mutualSettlementSigned : copy.detail.mutualSettlementAwaiting}</span>
                <span>{copy.roles.COURIER}: {proposal.courier_signed ? copy.detail.mutualSettlementSigned : copy.detail.mutualSettlementAwaiting}</span>
                <span>{copy.detail.customerRefund}: <code>{proposal.customer_wei}</code> wei · {copy.detail.restaurantAllocation}: <code>{proposal.restaurant_wei}</code> wei · {copy.detail.courierAllocation}: <code>{proposal.courier_wei}</code> wei</span>
                {canSign && (
                  <button
                    className="button button--quiet"
                    disabled={disabled || pending !== null}
                    onClick={() => { void signProposal(proposal.digest); }}
                    type="button"
                  >
                    {copy.detail.mutualSettlementSign}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {pending && <p className="form-notice" role="status">{copy.console.pending}</p>}
      {notice && <p className="form-notice" role="status">{notice}</p>}
      {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
    </section>
  );
}
