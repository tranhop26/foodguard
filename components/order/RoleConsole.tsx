"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { OrderState } from "../../lib/domain";
import { readFoodGuard } from "../../lib/genlayer/client";
import { executeFoodGuardOperation } from "../../lib/genlayer/operations";
import type { TxStage } from "../../lib/genlayer/transactions";
import { useLocale } from "../../lib/i18n";
import {
  deriveWalletRole,
  WalletButton,
  type WalletRole,
  type WalletSnapshot,
} from "../wallet/WalletButton";
import { authoritativeNowMs, type AuthoritativeClock } from "./authoritativeClock";
import { TransactionLifecycle } from "./TransactionLifecycle";

export interface FoodGuardOrderView {
  acceptance_deadline?: bigint | number | string;
  courier: string;
  courier_accepted: boolean;
  customer: string;
  delivery_deadline?: bigint | number | string;
  order_id: string;
  packing_deadline?: bigint | number | string;
  refund_emitted?: boolean;
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
  | "cancelBeforePacked"
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
    | "cancel_before_packed"
    | "cancel_unaccepted"
    | "cancel_fulfillment_timeout";
  requiresEvidence: boolean;
}

export interface RoleOperationState {
  actorAddress: string | null;
  method: RoleAction["method"] | null;
  pending: boolean;
  stage: TxStage | null;
}

interface RoleConsoleProps<TOrder extends FoodGuardOrderView> {
  address?: string | null;
  clock?: AuthoritativeClock | null;
  evidenceWritesEnabled?: boolean;
  onAction?(action: RoleAction, order: TOrder): Promise<TOrder>;
  onOperationStateChange?(state: RoleOperationState): void;
  onOrderChange?(order: TOrder): void;
  operationLocked?: boolean;
  order: TOrder;
  readOrder?(orderId: string): Promise<TOrder>;
  showLifecycle?: boolean;
  writesEnabled?: boolean;
}

function acceptedState(state: OrderState): boolean {
  return state === "FUNDED" || state === "PARTIALLY_ACCEPTED";
}

function sameActor(left: string, right: string | undefined): boolean {
  return Boolean(right && left.toLowerCase() === right.toLowerCase());
}

export function matchesRoleActionReadback(
  method: RoleAction["method"],
  candidate: FoodGuardOrderView,
  submittedOrder: FoodGuardOrderView,
  expectedActor: string | undefined,
): boolean {
  if (candidate.order_id !== submittedOrder.order_id) return false;

  if (method === "accept_restaurant") {
    return (
      sameActor(submittedOrder.restaurant, expectedActor) &&
      sameActor(candidate.restaurant, expectedActor) &&
      candidate.restaurant_accepted === true &&
      candidate.courier_accepted === submittedOrder.courier_accepted &&
      candidate.state === (
        submittedOrder.courier_accepted ? "ACCEPTED" : "PARTIALLY_ACCEPTED"
      )
    );
  }
  if (method === "accept_courier") {
    return (
      sameActor(submittedOrder.courier, expectedActor) &&
      sameActor(candidate.courier, expectedActor) &&
      candidate.courier_accepted === true &&
      candidate.restaurant_accepted === submittedOrder.restaurant_accepted &&
      candidate.state === (
        submittedOrder.restaurant_accepted ? "ACCEPTED" : "PARTIALLY_ACCEPTED"
      )
    );
  }
  if (method === "cancel_before_packed") {
    const submittedActors = [
      submittedOrder.customer,
      submittedOrder.restaurant,
      submittedOrder.courier,
    ];
    const actorsUnchanged = (
      sameActor(candidate.customer, submittedOrder.customer) &&
      sameActor(candidate.restaurant, submittedOrder.restaurant) &&
      sameActor(candidate.courier, submittedOrder.courier)
    );
    return (
      Boolean(expectedActor) &&
      submittedActors.some((actor) => sameActor(actor, expectedActor)) &&
      actorsUnchanged &&
      candidate.state === "CANCELLED_REFUNDED" &&
      candidate.refund_emitted === true &&
      candidate.restaurant_accepted === false &&
      candidate.courier_accepted === false
    );
  }
  if (method === "cancel_unaccepted") {
    return (
      candidate.state === "CANCELLED_REFUNDED" &&
      candidate.refund_emitted === true &&
      candidate.restaurant_accepted === false &&
      candidate.courier_accepted === false
    );
  }
  if (method === "cancel_fulfillment_timeout") {
    return (
      candidate.state === "FULFILLMENT_TIMEOUT_REFUNDED" &&
      candidate.refund_emitted === true
    );
  }
  return false;
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

function actionsFor(
  role: WalletRole,
  order: FoodGuardOrderView,
  nowSeconds: bigint | null,
): RoleAction[] {
  const actions: RoleAction[] = [];
  const acceptancePhase = deadlinePhase(order.acceptance_deadline, nowSeconds);
  const fulfillmentDeadline = order.state === "ACCEPTED"
    ? order.packing_deadline
    : order.state === "READY_FOR_PICKUP" || order.state === "IN_TRANSIT"
      ? order.delivery_deadline
      : undefined;
  const fulfillmentExpired = deadlinePhase(fulfillmentDeadline, nowSeconds) === "EXPIRED";
  if (fulfillmentExpired) {
    actions.push({
      id: "cancelFulfillmentTimeout",
      method: "cancel_fulfillment_timeout",
      requiresEvidence: false,
    });
  }
  if (role === "RESTAURANT") {
    if (
      acceptedState(order.state) &&
      !order.restaurant_accepted &&
      acceptancePhase === "BEFORE"
    ) {
      actions.push({ id: "acceptRestaurant", method: "accept_restaurant", requiresEvidence: false });
    }
    if (order.state === "ACCEPTED" && !fulfillmentExpired) {
      actions.push({ id: "pack", method: "submit_packed_evidence", requiresEvidence: true });
    }
  }
  if (role === "COURIER") {
    if (
      acceptedState(order.state) &&
      !order.courier_accepted &&
      acceptancePhase === "BEFORE"
    ) {
      actions.push({ id: "acceptCourier", method: "accept_courier", requiresEvidence: false });
    }
    if (order.state === "READY_FOR_PICKUP" && !fulfillmentExpired) {
      actions.push({ id: "pickup", method: "submit_pickup_evidence", requiresEvidence: true });
    }
    if (order.state === "IN_TRANSIT" && !fulfillmentExpired) {
      actions.push({ id: "deliver", method: "submit_delivery_evidence", requiresEvidence: true });
    }
  }
  if (
    role === "CUSTOMER" &&
    order.state === "REVIEW_WINDOW" &&
    deadlinePhase(order.review_deadline, nowSeconds) === "BEFORE"
  ) {
    actions.push({ id: "claim", method: "submit_claim_evidence", requiresEvidence: true });
  }

  if (
    role !== "OUTSIDER" &&
    (order.state === "FUNDED" || order.state === "PARTIALLY_ACCEPTED" || order.state === "ACCEPTED")
  ) {
    actions.push({
      id: "cancelBeforePacked",
      method: "cancel_before_packed",
      requiresEvidence: false,
    });
  }

  if (
    acceptedState(order.state) &&
    acceptancePhase === "EXPIRED" &&
    !(order.restaurant_accepted && order.courier_accepted)
  ) {
    actions.push({ id: "cancel", method: "cancel_unaccepted", requiresEvidence: false });
  }
  return actions;
}

export function RoleConsole<TOrder extends FoodGuardOrderView = FoodGuardOrderView>({
  address,
  clock,
  evidenceWritesEnabled = true,
  onAction,
  onOperationStateChange,
  onOrderChange,
  operationLocked = false,
  order,
  readOrder,
  showLifecycle = true,
  writesEnabled = true,
}: RoleConsoleProps<TOrder>) {
  const { copy } = useLocale();
  const [authoritativeOrder, setAuthoritativeOrder] = useState(order);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<TxStage | null>(null);
  const [stageOperation, setStageOperation] = useState<RoleAction["method"] | null>(null);
  const stageRef = useRef<TxStage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null);
  const actors = [
    authoritativeOrder.customer,
    authoritativeOrder.restaurant,
    authoritativeOrder.courier,
  ] as const;
  const role = address ? deriveWalletRole(address, actors) : null;
  const actions = role ? actionsFor(role, authoritativeOrder, nowSeconds) : [];

  function publishOperationState(
    method: RoleAction["method"] | null,
    nextPending: boolean,
    nextStage: TxStage | null,
  ) {
    onOperationStateChange?.({
      actorAddress: address ?? null,
      method,
      pending: nextPending,
      stage: nextStage,
    });
  }

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

  async function performAction(action: RoleAction) {
    if (
      !action ||
      pending ||
      stage === "OUTCOME_UNKNOWN" ||
      operationLocked ||
      !writesEnabled ||
      (action.requiresEvidence && !evidenceWritesEnabled)
    ) return;
    setError(null);
    setNotice(null);
    if (
      action.id === "cancelBeforePacked" &&
      !window.confirm(copy.console.cancelBeforePackedConfirmation)
    ) return;
    if (action.requiresEvidence && !onAction) {
      setNotice(copy.console.evidenceRequired);
      return;
    }
    stageRef.current = null;
    setStage(null);
    setStageOperation(action.method);
    setPending(true);
    publishOperationState(action.method, true, null);
    const submittedAction = action;
    const submittedOrder = authoritativeOrder;
    const expectedActor = address ?? undefined;
    try {
      const readback = submittedAction.requiresEvidence
        ? await onAction!(submittedAction, submittedOrder)
        : await executeFoodGuardOperation<TOrder>({
            method: submittedAction.method,
            args: [submittedOrder.order_id],
            value: 0n,
            expectedAccount: expectedActor,
            onStage: (nextStage) => {
              stageRef.current = nextStage;
              setStage(nextStage);
              publishOperationState(submittedAction.method, true, nextStage);
            },
            readback: () => readOrder
              ? readOrder(submittedOrder.order_id)
              : readFoodGuard<TOrder>("get_order", [submittedOrder.order_id]),
            matches: (candidate) => matchesRoleActionReadback(
              submittedAction.method,
              candidate,
              submittedOrder,
              expectedActor,
            ),
          });
      setAuthoritativeOrder(readback);
      if (!submittedAction.requiresEvidence) onOrderChange?.(readback);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "FoodGuard write failed");
    } finally {
      setPending(false);
      publishOperationState(submittedAction.method, false, stageRef.current);
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
      {role === "OUTSIDER" && actions.length === 0 && <p className="form-notice">{copy.console.readOnly}</p>}
      {role && role !== "OUTSIDER" && actions.length === 0 && (
        <p className="form-notice">{copy.console.noAction}</p>
      )}
      {actions.map((action) => (
        <button
          key={action.id}
          className="button button--primary"
          disabled={pending || stage === "OUTCOME_UNKNOWN" || operationLocked || !writesEnabled || (action.requiresEvidence && !evidenceWritesEnabled)}
          onClick={() => void performAction(action)}
          type="button"
        >
          {copy.console.actions[action.id]}
        </button>
      ))}
      {pending && <p className="form-notice" role="status">{copy.console.pending}</p>}
      {showLifecycle && (
        <TransactionLifecycle
          actorAddress={address}
          operation={stageOperation}
          stage={stage}
        />
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
