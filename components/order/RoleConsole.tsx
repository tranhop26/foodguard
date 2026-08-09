"use client";

import { useCallback, useEffect, useState } from "react";

import type { OrderState } from "../../lib/domain";
import { readFoodGuard, writeFoodGuard } from "../../lib/genlayer/client";
import { trackTransaction, type TxStage } from "../../lib/genlayer/transactions";
import { useLocale } from "../../lib/i18n";
import {
  deriveWalletRole,
  WalletButton,
  type WalletRole,
  type WalletSnapshot,
} from "../wallet/WalletButton";
import { authoritativeNowMs, type AuthoritativeClock } from "./authoritativeClock";

export interface FoodGuardOrderView {
  acceptance_deadline?: bigint | number | string;
  courier: string;
  courier_accepted: boolean;
  customer: string;
  delivery_deadline?: bigint | number | string;
  order_id: string;
  packing_deadline?: bigint | number | string;
  restaurant: string;
  restaurant_accepted: boolean;
  review_deadline?: bigint | number | string;
  state: OrderState;
  [key: string]: unknown;
}

export type RoleActionId =
  | "acceptRestaurant"
  | "acceptCourier"
  | "pack"
  | "pickup"
  | "deliver"
  | "claim"
  | "cancel"
  | "cancelFulfillmentTimeout";

export interface RoleAction {
  id: RoleActionId;
  method:
    | "accept_restaurant"
    | "accept_courier"
    | "submit_packed_evidence"
    | "submit_pickup_evidence"
    | "submit_delivery_evidence"
    | "submit_claim_evidence"
    | "cancel_unaccepted"
    | "cancel_fulfillment_timeout";
  requiresEvidence: boolean;
}

interface RoleConsoleProps {
  address?: string | null;
  clock?: AuthoritativeClock | null;
  evidenceWritesEnabled?: boolean;
  onAction?(action: RoleAction, order: FoodGuardOrderView): Promise<FoodGuardOrderView>;
  order: FoodGuardOrderView;
  writesEnabled?: boolean;
}

function acceptedState(state: OrderState): boolean {
  return state === "FUNDED" || state === "PARTIALLY_ACCEPTED";
}

const MAX_U64 = (1n << 64n) - 1n;

function parseDeadline(
  deadline: bigint | number | string | undefined,
): bigint | null {
  try {
    let parsed: bigint;
    if (typeof deadline === "bigint") parsed = deadline;
    else if (typeof deadline === "number" && Number.isSafeInteger(deadline)) {
      parsed = BigInt(deadline);
    } else if (typeof deadline === "string" && /^(0|[1-9][0-9]*)$/.test(deadline)) {
      parsed = BigInt(deadline);
    } else {
      return null;
    }
    return parsed >= 0n && parsed <= MAX_U64 ? parsed : null;
  } catch {
    return null;
  }
}

type DeadlinePhase = "BEFORE" | "EXPIRED" | "INVALID";

function deadlinePhase(
  deadline: bigint | number | string | undefined,
  nowSeconds: bigint | null,
): DeadlinePhase {
  const parsed = parseDeadline(deadline);
  if (parsed === null || nowSeconds === null) return "INVALID";
  return nowSeconds < parsed ? "BEFORE" : "EXPIRED";
}

function actionFor(
  role: WalletRole,
  order: FoodGuardOrderView,
  nowSeconds: bigint | null,
): RoleAction | null {
  const acceptancePhase = deadlinePhase(order.acceptance_deadline, nowSeconds);
  const fulfillmentDeadline = order.state === "ACCEPTED"
    ? order.packing_deadline
    : order.state === "READY_FOR_PICKUP" || order.state === "IN_TRANSIT"
      ? order.delivery_deadline
      : undefined;
  if (deadlinePhase(fulfillmentDeadline, nowSeconds) === "EXPIRED") {
    return {
      id: "cancelFulfillmentTimeout",
      method: "cancel_fulfillment_timeout",
      requiresEvidence: false,
    };
  }
  if (role === "RESTAURANT") {
    if (
      acceptedState(order.state) &&
      !order.restaurant_accepted &&
      acceptancePhase === "BEFORE"
    ) {
      return { id: "acceptRestaurant", method: "accept_restaurant", requiresEvidence: false };
    }
    if (order.state === "ACCEPTED") {
      return { id: "pack", method: "submit_packed_evidence", requiresEvidence: true };
    }
  }
  if (role === "COURIER") {
    if (
      acceptedState(order.state) &&
      !order.courier_accepted &&
      acceptancePhase === "BEFORE"
    ) {
      return { id: "acceptCourier", method: "accept_courier", requiresEvidence: false };
    }
    if (order.state === "READY_FOR_PICKUP") {
      return { id: "pickup", method: "submit_pickup_evidence", requiresEvidence: true };
    }
    if (order.state === "IN_TRANSIT") {
      return { id: "deliver", method: "submit_delivery_evidence", requiresEvidence: true };
    }
  }
  if (
    role === "CUSTOMER" &&
    order.state === "REVIEW_WINDOW" &&
    deadlinePhase(order.review_deadline, nowSeconds) === "BEFORE"
  ) {
    return { id: "claim", method: "submit_claim_evidence", requiresEvidence: true };
  }
  if (
    acceptedState(order.state) &&
    (
      (
        acceptancePhase === "BEFORE" &&
        role === "CUSTOMER" &&
        !order.restaurant_accepted &&
        !order.courier_accepted
      ) ||
      (
        acceptancePhase === "EXPIRED" &&
        !(order.restaurant_accepted && order.courier_accepted)
      )
    )
  ) {
    return { id: "cancel", method: "cancel_unaccepted", requiresEvidence: false };
  }
  return null;
}

export function RoleConsole({
  address,
  clock,
  evidenceWritesEnabled = true,
  onAction,
  order,
  writesEnabled = true,
}: RoleConsoleProps) {
  const { copy } = useLocale();
  const [authoritativeOrder, setAuthoritativeOrder] = useState(order);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<TxStage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null);
  const actors = [
    authoritativeOrder.customer,
    authoritativeOrder.restaurant,
    authoritativeOrder.courier,
  ] as const;
  const role = address ? deriveWalletRole(address, actors) : null;
  const action = role ? actionFor(role, authoritativeOrder, nowSeconds) : null;

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const refreshAtBoundary = () => {
      if (!active) return;
      const nowMs = authoritativeNowMs(clock);
      if (nowMs === null) {
        setNowSeconds(null);
        return;
      }
      const currentSeconds = nowMs / 1_000n;
      setNowSeconds(currentSeconds);

      const nextDeadline = [
        parseDeadline(authoritativeOrder.acceptance_deadline),
        parseDeadline(authoritativeOrder.packing_deadline),
        parseDeadline(authoritativeOrder.delivery_deadline),
        parseDeadline(authoritativeOrder.review_deadline),
      ].reduce<bigint | null>((next, deadline) => {
        if (deadline === null || deadline <= currentSeconds) return next;
        return next === null || deadline < next ? deadline : next;
      }, null);
      if (nextDeadline === null) return;

      const remainingMs = nextDeadline * 1_000n - nowMs;
      const boundedDelay = remainingMs > 2_147_483_647n
        ? 2_147_483_647
        : Number(remainingMs);
      timer = window.setTimeout(refreshAtBoundary, boundedDelay);
    };

    refreshAtBoundary();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [authoritativeOrder.acceptance_deadline, authoritativeOrder.review_deadline, clock]);

  async function performAction() {
    if (!action || pending || !writesEnabled || (action.requiresEvidence && !evidenceWritesEnabled)) return;
    setError(null);
    setNotice(null);
    if (action.requiresEvidence && !onAction) {
      setNotice(copy.console.evidenceRequired);
      return;
    }
    setPending(true);
    try {
      const readback = onAction
        ? await onAction(action, authoritativeOrder)
        : await (async () => {
            const hash = await writeFoodGuard(
              action.method,
              [authoritativeOrder.order_id],
              0n,
              setStage,
              address ?? undefined,
            );
            return trackTransaction<FoodGuardOrderView>(hash, setStage);
          })();
      setAuthoritativeOrder(readback);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "FoodGuard write failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="role-console" aria-labelledby="role-console-title">
      <p className="eyebrow">{copy.console.eyebrow}</p>
      <h2 id="role-console-title">{copy.console.title}</h2>
      <dl className="role-console__facts">
        <div>
          <dt>Order ID</dt>
          <dd><code>{authoritativeOrder.order_id}</code></dd>
        </div>
        <div>
          <dt>{copy.console.state}</dt>
          <dd><code data-testid="raw-order-state">{authoritativeOrder.state}</code></dd>
        </div>
        {address && (
          <div>
            <dt>Address</dt>
            <dd><code>{address}</code></dd>
          </div>
        )}
      </dl>

      {!address && <p className="form-notice">{copy.console.connect}</p>}
      {role === "OUTSIDER" && !action && <p className="form-notice">{copy.console.readOnly}</p>}
      {role && role !== "OUTSIDER" && !action && (
        <p className="form-notice">{copy.console.noAction}</p>
      )}
      {action && (
        <button
          className="button button--primary"
          disabled={pending || !writesEnabled || (action.requiresEvidence && !evidenceWritesEnabled)}
          onClick={performAction}
          type="button"
        >
          {copy.console.actions[action.id]}
        </button>
      )}
      {pending && <p className="form-notice" role="status">{copy.console.pending}</p>}
      {stage && (
        <p className={`transaction-stage${stage === "CONSENSUS_FAILED" || stage === "EXECUTION_ERROR" ? " transaction-stage--failure" : ""}`}>
          <code>{stage}</code>
        </p>
      )}
      {notice && <p className="form-notice" role="status">{notice}</p>}
      {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
    </section>
  );
}

type OrdersWorkspaceConfiguration =
  | { address: string; status: "READY"; writesEnabled: true }
  | {
      address: null;
      message: string;
      status: "DEPLOYMENT_REQUIRED";
      writesEnabled: false;
    };

const EMPTY_ACTORS = ["", "", ""] as const;

export function OrdersWorkspace({
  configuration,
}: {
  configuration: OrdersWorkspaceConfiguration;
}) {
  const { copy } = useLocale();
  const [orderId, setOrderId] = useState("");
  const [order, setOrder] = useState<FoodGuardOrderView | null>(null);
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actors = order
    ? ([order.customer, order.restaurant, order.courier] as const)
    : EMPTY_ACTORS;

  const handleWalletChange = useCallback((snapshot: WalletSnapshot) => {
    setWallet(snapshot);
  }, []);

  async function loadOrder() {
    if (!orderId.trim() || !configuration.writesEnabled || pending) return;
    setPending(true);
    setError(null);
    setOrder(null);
    try {
      const readback = await readFoodGuard<FoodGuardOrderView>("get_order", [orderId.trim()]);
      setOrder(readback);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "FoodGuard read failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="orders-workspace">
      <form
        className="order-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          void loadOrder();
        }}
      >
        <label>
          <span>{copy.order.orderId}</span>
          <input
            aria-label={copy.order.orderId}
            autoComplete="off"
            onChange={(event) => setOrderId(event.target.value)}
            type="text"
            value={orderId}
          />
        </label>
        <button
          className="button button--primary"
          disabled={!configuration.writesEnabled || !orderId.trim() || pending}
          type="submit"
        >
          {copy.pages.loadOrder}
        </button>
      </form>
      {configuration.status === "DEPLOYMENT_REQUIRED" && (
        <div className="deployment-note" role="status">
          <strong>DEPLOYMENT_REQUIRED</strong>
          <span>{copy.order.deploymentRequired}</span>
        </div>
      )}
      {pending && <p className="form-notice" role="status">{copy.order.writing}</p>}
      {error && <p className="form-notice form-notice--error" role="alert">{error}</p>}
      {order && (
        <div className="orders-workspace__console">
          <WalletButton actors={actors} onChange={handleWalletChange} />
          <RoleConsole
            address={wallet?.address}
            order={order}
            writesEnabled={configuration.writesEnabled && wallet?.status === "READY"}
          />
        </div>
      )}
    </div>
  );
}
