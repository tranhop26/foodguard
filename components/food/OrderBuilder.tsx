"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, zeroAddress } from "viem";

import type { EvidenceDocument, HexDigest, OrderItem } from "../../lib/domain";
import { canonicalizeEvidence, hashEvidence } from "../../lib/evidence";
import { readFoodGuard, writeFoodGuard } from "../../lib/genlayer/client";
import {
  getFoodGuardConfiguration,
  getFoodGuardPublicAppOriginConfiguration,
  type FoodGuardPublicAppOriginConfiguration,
} from "../../lib/genlayer/config";
import { trackTransaction, type TxStage } from "../../lib/genlayer/transactions";
import { useLocale } from "../../lib/i18n";
import { RoleConsole, type FoodGuardOrderView } from "../order/RoleConsole";
import { WalletButton, type WalletSnapshot } from "../wallet/WalletButton";

export type OrderActors = [customer: string, restaurant: string, courier: string];

export type OrderBuilderConfiguration =
  | {
      address: string;
      status: "READY";
      writesEnabled: true;
    }
  | {
      address: null;
      message: string;
      status: "DEPLOYMENT_REQUIRED";
      writesEnabled: false;
    };

interface OrderBuilderProps {
  configuration?: OrderBuilderConfiguration;
  deliveryFeeWei?: string;
  initialActors?: OrderActors;
  item?: OrderItem;
  orderId?: string;
  publicAppConfiguration?: FoodGuardPublicAppOriginConfiguration;
}

const DEMO_ITEM: OrderItem = {
  conditions: ["giao đúng món và còn nguyên niêm phong"],
  item_id: "foodguard-demo-item",
  name: "Món Việt demo",
  permitted_substitutions: [],
  price_wei: "400000000000000000",
  quantity: 1,
};

const EMPTY_WALLET: WalletSnapshot = {
  address: null,
  chainId: null,
  role: "OUTSIDER",
  status: "DISCONNECTED",
};

const MAX_U256 = (1n << 256n) - 1n;

interface FrozenCommitment {
  actors: OrderActors;
  amounts: ReturnType<typeof calculateOrderValueWei>;
  canonicalEvidence: string;
  canonicalManifest: string;
  deadlinesJson: string;
  deliveryFeeWei: string;
  digest: HexDigest;
  orderId: string;
}

function configuredContract(): OrderBuilderConfiguration {
  const configuration = getFoodGuardConfiguration();
  return configuration.status === "READY"
    ? {
        address: configuration.address,
        status: "READY",
        writesEnabled: true,
      }
    : {
        address: null,
        message: configuration.message,
        status: "DEPLOYMENT_REQUIRED",
        writesEnabled: false,
      };
}

function canonicalItem(item: OrderItem): OrderItem {
  return {
    conditions: [...item.conditions],
    item_id: item.item_id,
    name: item.name,
    permitted_substitutions: [...item.permitted_substitutions],
    price_wei: item.price_wei,
    quantity: item.quantity,
  };
}

export function canonicalOrderManifest(items: readonly OrderItem[]): string {
  return JSON.stringify({ items: items.map(canonicalItem) });
}

function parseWei(value: string, allowZero: boolean): bigint {
  const pattern = allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(value)) throw new TypeError("invalid wei amount");
  const amount = BigInt(value);
  if (amount > MAX_U256) throw new RangeError("wei amount exceeds u256");
  return amount;
}

export function calculateOrderValueWei(
  items: readonly OrderItem[],
  deliveryFeeWei: string,
): { deliveryFee: bigint; subtotal: bigint; total: bigint } {
  const deliveryFee = parseWei(deliveryFeeWei, true);
  let subtotal = 0n;
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new TypeError("quantity must be a positive safe integer");
    }
    subtotal += parseWei(item.price_wei, false) * BigInt(item.quantity);
    if (subtotal > MAX_U256) throw new RangeError("subtotal exceeds u256");
  }
  const total = subtotal + deliveryFee;
  if (total > MAX_U256) throw new RangeError("total exceeds u256");
  return { deliveryFee, subtotal, total };
}

function validActor(address: string): boolean {
  return (
    isAddress(address, { strict: false }) &&
    address.toLowerCase() !== zeroAddress
  );
}

function actorValidation(actors: OrderActors): "VALID" | "INVALID" | "DUPLICATE" {
  if (!actors.every(validActor)) return "INVALID";
  if (new Set(actors.map((actor) => actor.toLowerCase())).size !== actors.length) {
    return "DUPLICATE";
  }
  return "VALID";
}

function canonicalDeadlines(createdAtMs: number): string {
  const base = BigInt(Math.floor(createdAtMs / 1_000));
  const minute = 60n;
  const acceptanceDeadline = base + 30n * minute;
  const packingDeadline = base + 120n * minute;
  const deliveryDeadline = base + 240n * minute;
  const reviewDeadline = base + 360n * minute;
  const appealDeadline = base + 480n * minute;
  return JSON.stringify({
    acceptance_deadline: Number(acceptanceDeadline),
    appeal_deadline: Number(appealDeadline),
    delivery_deadline: Number(deliveryDeadline),
    packing_deadline: Number(packingDeadline),
    review_deadline: Number(reviewDeadline),
  });
}

function sameAddress(left: string | null, right: string): boolean {
  return Boolean(left && left.toLowerCase() === right.toLowerCase());
}

export function OrderBuilder({
  configuration = configuredContract(),
  deliveryFeeWei: initialDeliveryFee = "50000000000000000",
  initialActors = ["", "", ""],
  item = DEMO_ITEM,
  orderId: initialOrderId = "fg-demo-order",
  publicAppConfiguration = getFoodGuardPublicAppOriginConfiguration(),
}: OrderBuilderProps) {
  const { copy } = useLocale();
  const [actors, setActors] = useState<OrderActors>(initialActors);
  const [deliveryFeeWei, setDeliveryFeeWei] = useState(initialDeliveryFee);
  const [orderId, setOrderId] = useState(initialOrderId);
  const [createdAtMs, setCreatedAtMs] = useState<number | null>(null);
  const [deadlineBaseMs, setDeadlineBaseMs] = useState<number | null>(null);
  const [wallet, setWallet] = useState<WalletSnapshot>(EMPTY_WALLET);
  const [digest, setDigest] = useState<HexDigest | null>(null);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<TxStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creationPaused, setCreationPaused] = useState<boolean | null>(null);
  const [creationPauseUnavailable, setCreationPauseUnavailable] = useState(false);
  const [authoritativeOrder, setAuthoritativeOrder] = useState<FoodGuardOrderView | null>(null);
  const [frozenCommitment, setFrozenCommitment] = useState<FrozenCommitment | null>(null);

  const items = useMemo(() => [canonicalItem(item)], [item]);
  const canonicalManifest = useMemo(() => canonicalOrderManifest(items), [items]);
  const deadlinesJson = useMemo(
    () => deadlineBaseMs === null ? "CLOCK_REQUIRED" : canonicalDeadlines(deadlineBaseMs),
    [deadlineBaseMs],
  );
  const evidenceSourceUrl = publicAppConfiguration.status === "READY"
    ? publicAppConfiguration.createOrderSourceUrl
    : "PUBLIC_APP_ORIGIN_REQUIRED";
  const amounts = useMemo(() => {
    try {
      return calculateOrderValueWei(items, deliveryFeeWei);
    } catch {
      return null;
    }
  }, [deliveryFeeWei, items]);
  const validation = actorValidation(actors);

  const manifestEvidence = useMemo<EvidenceDocument | null>(() => {
    if (createdAtMs === null) return null;
    const observedAt = new Date(createdAtMs).toISOString();
    return {
      action: "ORDER_MANIFEST",
      actor_wallet: actors[0] || "CUSTOMER_WALLET_REQUIRED",
      chain_id: "61999",
      contract_address: configuration.address ?? "DEPLOYMENT_REQUIRED",
      expires_at: new Date(createdAtMs + 86_400_000).toISOString(),
      issuer_id: "foodguard-web",
      items,
      nonce: orderId || "ORDER_ID_REQUIRED",
      observed_at: observedAt,
      order_id: orderId || "ORDER_ID_REQUIRED",
      schema_version: "foodguard-evidence/1",
      sha256: `0x${"0".repeat(64)}`,
      source_url: evidenceSourceUrl,
      subject: "FoodGuard canonical order manifest",
      submitted_at: observedAt,
    };
  }, [actors, configuration.address, createdAtMs, evidenceSourceUrl, items, orderId]);
  const canonicalEvidence = useMemo(
    () => manifestEvidence ? canonicalizeEvidence(manifestEvidence) : "CLOCK_REQUIRED",
    [manifestEvidence],
  );
  const visibleActors = frozenCommitment?.actors ?? actors;
  const visibleAmounts = frozenCommitment?.amounts ?? amounts;
  const visibleCanonicalEvidence = frozenCommitment?.canonicalEvidence ?? canonicalEvidence;
  const visibleCanonicalManifest = frozenCommitment?.canonicalManifest ?? canonicalManifest;
  const visibleDeadlinesJson = frozenCommitment?.deadlinesJson ?? deadlinesJson;
  const visibleDeliveryFeeWei = frozenCommitment?.deliveryFeeWei ?? deliveryFeeWei;
  const visibleDigest = frozenCommitment?.digest ?? digest;
  const visibleOrderId = frozenCommitment?.orderId ?? orderId;

  useEffect(() => {
    if (!manifestEvidence) {
      setDigest(null);
      return;
    }
    let active = true;
    setDigest(null);
    hashEvidence(manifestEvidence).then(
      (value) => {
        if (active) setDigest(value);
      },
      (caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Manifest hashing failed");
      },
    );
    return () => {
      active = false;
    };
  }, [manifestEvidence]);

  useEffect(() => {
    if (pending) return;
    const refreshClock = () => {
      const now = Date.now();
      setCreatedAtMs((current) => current ?? now);
      setDeadlineBaseMs(now);
    };
    refreshClock();
    const timer = window.setInterval(refreshClock, 60_000);
    return () => window.clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    let active = true;
    if (configuration.status !== "READY") {
      setCreationPaused(false);
      setCreationPauseUnavailable(false);
      return () => { active = false; };
    }
    setCreationPaused(null);
    setCreationPauseUnavailable(false);
    void readFoodGuard<unknown>("get_creation_paused", []).then(
      (value) => {
        if (!active) return;
        if (typeof value !== "boolean") throw new TypeError("Creation pause readback is malformed");
        setCreationPaused(value);
      },
      () => {
        if (!active) return;
        setCreationPaused(null);
        setCreationPauseUnavailable(true);
      },
    ).catch(() => {
      if (!active) return;
      setCreationPaused(null);
      setCreationPauseUnavailable(true);
    });
    return () => { active = false; };
  }, [configuration.address, configuration.status]);

  const handleWalletChange = useCallback((nextWallet: WalletSnapshot) => {
    setWallet(nextWallet);
    if (nextWallet.status === "READY" && !pending) setDeadlineBaseMs(Date.now());
  }, [pending]);

  const customerConnected = sameAddress(wallet.address, actors[0]);
  const canCreate =
    configuration.writesEnabled &&
    creationPaused === false &&
    publicAppConfiguration.writesEnabled &&
    validation === "VALID" &&
    wallet.status === "READY" &&
    customerConnected &&
    Boolean(digest) &&
    Boolean(amounts) &&
    manifestEvidence !== null &&
    deadlineBaseMs !== null &&
    Boolean(orderId.trim()) &&
    !authoritativeOrder &&
    !pending;

  function setActor(index: number, value: string) {
    setActors((current) => {
      const next: OrderActors = [...current];
      next[index] = value.trim();
      return next;
    });
  }

  async function createOrder() {
    if (!canCreate || !amounts || !digest || !manifestEvidence) return;
    const commitment: FrozenCommitment = {
      actors: [...actors],
      amounts,
      canonicalEvidence,
      canonicalManifest,
      deadlinesJson,
      deliveryFeeWei,
      digest,
      orderId,
    };
    setFrozenCommitment(commitment);
    setPending(true);
    setError(null);
    setAuthoritativeOrder(null);
    try {
      const hash = await writeFoodGuard(
        "create_order",
        [
          commitment.orderId,
          commitment.actors[1],
          commitment.actors[2],
          commitment.canonicalManifest,
          commitment.amounts.deliveryFee,
          commitment.deadlinesJson,
        ],
        commitment.amounts.total,
        setStage,
        commitment.actors[0],
      );
      const readback = await trackTransaction<FoodGuardOrderView>(hash, setStage);
      setAuthoritativeOrder(readback);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "FoodGuard write failed");
    } finally {
      setPending(false);
      setFrozenCommitment(null);
    }
  }

  return (
    <div className="order-workflow">
      <section className="order-builder" aria-labelledby="order-builder-title">
        <p className="eyebrow">{copy.order.eyebrow}</p>
        <h1 id="order-builder-title">{copy.order.title}</h1>
        <p className="order-builder__intro">{copy.order.intro}</p>

        <div className="actor-grid">
          {([copy.order.customer, copy.order.restaurant, copy.order.courier] as const).map(
            (label, index) => (
              <label key={label}>
                <span>{label}</span>
                <input
                  aria-label={label}
                  autoComplete="off"
                  disabled={pending}
                  onChange={(event) => setActor(index, event.target.value)}
                  spellCheck={false}
                  type="text"
                  value={visibleActors[index]}
                />
              </label>
            ),
          )}
        </div>
        {validation === "DUPLICATE" && (
          <p className="form-notice form-notice--error" role="alert">{copy.order.threeDistinct}</p>
        )}
        {validation === "INVALID" && (
          <p className="form-notice" role="status">{copy.order.threeValid}</p>
        )}

        <div className="order-fields">
          <label>
            <span>{copy.order.orderId}</span>
            <input
              autoComplete="off"
              disabled={pending}
              onChange={(event) => setOrderId(event.target.value)}
              type="text"
              value={visibleOrderId}
            />
          </label>
          <label>
            <span>{copy.order.deliveryFee}</span>
            <input
              inputMode="numeric"
              disabled={pending}
              onChange={(event) => setDeliveryFeeWei(event.target.value.trim())}
              type="text"
              value={visibleDeliveryFeeWei}
            />
          </label>
        </div>

        <dl className="amount-summary">
          <div><dt>{copy.order.itemSubtotal}</dt><dd><code>{visibleAmounts?.subtotal.toString() ?? "INVALID"}</code></dd></div>
          <div><dt>{copy.order.deliveryFee}</dt><dd><code>{visibleAmounts?.deliveryFee.toString() ?? "INVALID"}</code></dd></div>
          <div><dt>{copy.order.total}</dt><dd><code>{visibleAmounts?.total.toString() ?? "INVALID"}</code></dd></div>
        </dl>
        {!amounts && <p className="form-notice form-notice--error" role="alert">{copy.order.invalidAmount}</p>}

        <section className="manifest-preview" aria-labelledby="manifest-title">
          <h2 id="manifest-title">{copy.order.manifest}</h2>
          <pre data-testid="canonical-manifest">{visibleCanonicalManifest}</pre>
          <h3>{copy.order.deadlines}</h3>
          <pre data-testid="canonical-deadlines">{visibleDeadlinesJson}</pre>
          <h3>{copy.order.evidenceManifest}</h3>
          <pre data-testid="canonical-evidence">{visibleCanonicalEvidence}</pre>
          <h3>{copy.order.digest}</h3>
          <code className="digest" data-testid="manifest-digest">
            {visibleDigest ?? copy.order.awaitingDigest}
          </code>
        </section>

        {configuration.status === "DEPLOYMENT_REQUIRED" && (
          <div className="deployment-note" role="status">
            <strong>DEPLOYMENT_REQUIRED</strong>
            <span>{copy.order.deploymentRequired}</span>
          </div>
        )}
        {configuration.status === "READY" && creationPaused === true && (
          <div className="deployment-note" role="status">
            <strong>CREATION_PAUSED</strong>
            <span>{copy.order.creationPaused}</span>
          </div>
        )}
        {configuration.status === "READY" && creationPauseUnavailable && (
          <div className="deployment-note" role="status">
            <strong>CREATION_PAUSE_READBACK_REQUIRED</strong>
            <span>{copy.order.creationPauseUnavailable}</span>
          </div>
        )}
        {publicAppConfiguration.status === "PUBLIC_APP_ORIGIN_REQUIRED" && (
          <div className="deployment-note" role="status">
            <strong>PUBLIC_APP_ORIGIN_REQUIRED</strong>
            <span>{publicAppConfiguration.message}</span>
          </div>
        )}

        <WalletButton actors={visibleActors} onChange={handleWalletChange} />
        {wallet.status === "READY" && !customerConnected && (
          <p className="form-notice form-notice--error" role="alert">{copy.order.customerMustConnect}</p>
        )}

        <button
          className="button button--primary order-builder__submit"
          disabled={!canCreate}
          onClick={createOrder}
          type="button"
        >
          {copy.order.create}
        </button>
        {pending && <p className="form-notice" role="status">{copy.order.writing}</p>}
        {stage && (
          <p className={`transaction-stage${stage === "CONSENSUS_FAILED" || stage === "EXECUTION_ERROR" ? " transaction-stage--failure" : ""}`}>
            <code>{stage}</code>
          </p>
        )}
        {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
      </section>

      {authoritativeOrder && (
        <div>
          <h2 className="sr-only">{copy.order.authoritativeState}</h2>
          <RoleConsole address={wallet.address} order={authoritativeOrder} />
        </div>
      )}
    </div>
  );
}
