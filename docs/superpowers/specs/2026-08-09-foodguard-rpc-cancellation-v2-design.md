# FoodGuard RPC Resilience and Participant Cancellation V2

**Date:** 2026-08-09
**Status:** Approved in conversation; written review pending
**Contract classification:** `INTENTIONALLY_FROZEN`

## Problem

FoodGuard can currently show `An unknown RPC error occurred. Details: Failed to fetch Version: viem@2.55.11` after MetaMask has already broadcast a valid StudioNet transaction. The deployed frontend polls transaction state every 1.5 seconds and also performs several authoritative reads. StudioNet enforces a 30-request-per-minute limit, so this pattern can exhaust the RPC allowance. The wallet may then report a transport failure even though the transaction later finalizes, producing a dangerous false negative and encouraging duplicate writes.

The deployed V1 contract also prevents a participant from cancelling a partially or fully accepted order before packing. The user has approved a V2 rule in which any named participant may cancel before authoritative `PACKED` evidence exists, while later cancellation requires mutual settlement or GenLayer resolution.

## Considered approaches

1. **Only slow transaction polling.** Simple, but it does not recover a wallet call that broadcasts and then throws, and unrelated page reads can still consume the quota.
2. **Adaptive RPC coordination plus authoritative reconciliation (selected).** Bound transaction polling below the StudioNet quota, honor explicit retry timing, deduplicate reads, and reconcile ambiguous wallet outcomes against contract state without ever resending automatically.
3. **Route all StudioNet traffic through a server proxy.** Could centralize caching, but introduces a trusted availability component, shared Vercel-instance limits, and unnecessary operational scope for this project.

## Trust and safety rules

| Actor or component | Cannot be trusted for | Manipulation or failure | Defense |
|---|---|---|---|
| Browser wallet | A truthful post-broadcast return value | Broadcasts, then throws a transport error | Never resend automatically; reconcile against latest-final contract state |
| StudioNet RPC | Unlimited availability | Rate limit, temporary fetch failure, delayed indexing | Bounded adaptive polling, single-flight reads, server-provided retry delay |
| Frontend | Final transaction outcome | May display stale or optimistic state | Contract state remains authoritative; success requires readback |
| Customer | Cancelling after providers performed work | Could seek a full refund after packing | Unilateral cancellation closes once valid active `PACKED` evidence exists |
| Restaurant or courier | Cancelling an order they do not belong to | Could disrupt unrelated escrow | Cancellation restricted to the three stored participant addresses |

The exact GenLayer decision and settlement logic are unchanged. This change affects cancellation authorization before fulfillment evidence and the frontend's ability to observe authoritative results reliably.

## Contract V2 cancellation design

Add a public write method `cancel_before_packed(order_id)`.

Preconditions:

- The order exists and is not terminal.
- State is `FUNDED`, `PARTIALLY_ACCEPTED`, or `ACCEPTED`.
- `gl.message.sender_address` equals the stored customer, restaurant, or courier.
- No active evidence record has effective action `PACKED`.
- No prior refund or settlement allocation has been emitted.

Effects:

- Allocate the entire remaining item reserve and delivery reserve to the customer through the existing single-allocation ledger.
- Emit exactly one finalized transfer to the customer.
- Clear both acceptance flags.
- Set the terminal state to `CANCELLED_REFUNDED` and `refund_emitted = true`.
- A replay on an already cancelled order is idempotent and emits no second transfer.

After valid active `PACKED` evidence exists, no participant may cancel unilaterally. The existing evidence, cure, resolution, appeal, timeout, and mutual-settlement paths remain authoritative.

The conservation invariant remains:

`total inflows = available + reserved items + reserved delivery + completed payouts + completed refunds + fees`

V1 is frozen and cannot be patched. Existing V1 orders remain governed by V1. New cancellation behavior requires a new StudioNet contract deployment and only applies to orders created on V2.

## Frontend RPC design

### Request budget

- Transaction polling defaults to one request every 3 seconds, with a bounded overall deadline.
- A rate-limit response is recognized from structured RPC data, including code `-32029` and `retry_after_seconds`.
- The client waits automatically using the server-provided delay or bounded exponential backoff; the user is not instructed to resend or manually time the retry window.
- Identical in-flight reads share one promise. Short-lived latest-final read results may be reused within one reconciliation cycle.
- A page must not start parallel duplicate reads for the same method and arguments.

### Ambiguous wallet outcomes

Classify wallet failures into:

- **Definitive rejection:** user rejection, wrong chain, wrong account, malformed request, or a contract precondition known before broadcast. Show the specific failure; do not reconcile as success.
- **Ambiguous transport outcome:** `Failed to fetch`, temporary RPC unavailability, rate limiting, or provider failure after wallet confirmation. Move the UI to `RECONCILING`; never call the write again automatically.

Each operation supplies an authoritative success predicate:

- `create_order`: the exact order ID exists and customer, restaurant, courier, manifest, deadlines, fee, and total match the frozen preview.
- `accept_restaurant`: `restaurant_accepted` becomes true for the expected restaurant.
- `accept_courier`: `courier_accepted` becomes true for the expected courier.
- `cancel_before_packed`: state becomes `CANCELLED_REFUNDED`, reserves are released, and the refund flag is true.
- Other writes retain their existing operation-specific final readback validation.

If reconciliation proves the predicate, show `FINALIZED`, `EXECUTION_SUCCESS`, and `READBACK_CONFIRMED` based on the available transaction/readback evidence. If no transaction hash is recoverable, the UI must label finality/execution as unavailable and report only the authoritative state transition; it must not fabricate transaction proof.

If the bounded reconciliation window ends without proof, show `OUTCOME_UNKNOWN — do not resend` with a manual `Check contract state` action. A later readback may complete the operation. The UI must never describe this state as a safe retry.

### UI cancellation behavior

- Before packing, the customer, restaurant, and courier each see a role-specific cancel action.
- The confirmation text states that the full simulated GEN reserve returns to the customer.
- Once active `PACKED` evidence exists, unilateral cancellation disappears and the UI points participants to mutual settlement or dispute resolution.
- Outsiders remain read-only.
- Raw wei values in the outcome table are formatted as simulated GEN while retaining exact wei in accessible detail.

## Tests

Contract tests must cover:

- Cancellation by each of the three named roles in `FUNDED`, `PARTIALLY_ACCEPTED`, and `ACCEPTED` where reachable.
- Outsider rejection.
- Rejection after active `PACKED` evidence.
- Superseded or invalid evidence cannot incorrectly close cancellation.
- Full refund, cleared reserves, conservation, finalized transfer, replay idempotency, and terminal-action rejection.

Frontend tests must cover:

- Structured rate-limit detection and server-provided delay.
- Polling remains below the 30-request-per-minute limit.
- Identical reads are single-flight.
- A broadcast-then-fetch-error does not trigger a second write.
- Create, accept, and cancel ambiguous outcomes complete only after matching authoritative readback.
- Mismatched readback never reports success.
- User rejection remains a definitive failure.
- All three participant cancellation buttons and the post-`PACKED` lockout.
- Simulated GEN formatting.

Deterministic browser tests must reproduce the observed failure: wallet broadcasts, provider throws `Failed to fetch`, StudioNet readback later changes, and the UI recovers without a duplicate wallet request. Live verification after deployment must record the transaction hash, finality, execution result, and authoritative readback separately.

## Deployment and evidence

Implementation can be committed locally without external action. A GitHub push, V2 StudioNet deployment, Vercel production deployment, and deployment-record push each require a fresh action-time confirmation with the exact account/team context.

The final proof package must identify the V1 and V2 addresses separately, state that StudioNet GEN is simulated, and explicitly note that V1 orders do not inherit V2 cancellation rules.
