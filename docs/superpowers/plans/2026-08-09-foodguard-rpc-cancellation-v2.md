# FoodGuard RPC Resilience and Participant Cancellation V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new frozen FoodGuard contract version where any named participant can cancel before packing, and make the frontend recover safely when StudioNet rate limiting or post-broadcast wallet transport failures make a successful transaction look failed.

**Architecture:** Keep custody and authorization in the Intelligent Contract. Add one participant-only pre-packing cancellation entry point that reuses the existing allocation ledger. Add a small RPC resilience boundary around StudioNet reads and transaction polling, then run all UI writes through an operation coordinator that never resends automatically and accepts success only from operation-specific authoritative readback.

**Tech Stack:** Python 3.12, GenLayer SDK `0.2.16`, `genlayer-test` `0.29.2`, TypeScript `5.9.3`, Next.js `16.3.0`, React `19.2.8`, `genlayer-js` `1.1.8`, viem `2.55.11`, Vitest `4.1.10`, Playwright `1.62.1`.

## Global Constraints

- Contract V2 remains `INTENTIONALLY_FROZEN`; do not add an upgrade or owner escape hatch.
- V1 address `0x9214256f05c613Bacaba8e7E8762C62B5BDB52A5` and its orders remain unchanged.
- New cancellation applies only in `FUNDED`, `PARTIALLY_ACCEPTED`, and `ACCEPTED`, before any successful `PACKED` transition.
- Only the stored customer, restaurant, or courier may use participant cancellation.
- Cancellation refunds the exact total reserve to the customer through `_allocate_once`; no second allocation or transfer is possible.
- Never retry a wallet write automatically.
- Success remains contract-first: transaction finality, execution, and authoritative readback are distinct claims.
- When no transaction hash is recoverable, do not fabricate `FINALIZED` or `EXECUTION_SUCCESS`; report only verified readback state.
- StudioNet GEN is always labeled simulated GEN.
- GitHub push, StudioNet deployment, Vercel deployment, and deployment-record push require separate action-time user confirmation.

## File structure

- `contracts/food_guard.py`: V2 cancellation authorization and one-time refund effect.
- `tests/contract/test_participant_cancellation.py`: exhaustive cancellation, authorization, packing lockout, replay, and conservation tests.
- `lib/genlayer/rpcResilience.ts`: structured RPC failure classification, retry delay extraction, bounded backoff, and single-flight reads.
- `lib/genlayer/client.ts`: route authoritative reads through single-flight and expose typed ambiguous-write classification.
- `lib/genlayer/transactions.ts`: quota-safe polling and explicit reconciliation stages.
- `lib/genlayer/operations.ts`: one write/track/reconcile coordinator with operation-specific readback predicates.
- `components/food/OrderBuilder.tsx`: create-order reconciliation using the frozen preview.
- `components/order/RoleConsole.tsx`: multiple simultaneous actions, participant cancellation, and reconciled accept/cancel writes.
- `components/order/TransactionLifecycle.tsx`: truthful `RECONCILING` and `OUTCOME_UNKNOWN` presentation.
- `components/order/ItemOutcomeTable.tsx`: simulated GEN formatting while retaining exact wei detail.
- `locales/vi.ts`, `locales/en.ts`: cancellation and reconciliation copy.
- `tests/web/transactions.test.ts`: RPC/backoff/write reconciliation unit coverage.
- `tests/web/order-builder.test.tsx`: exact create-order predicate and ambiguous outcome recovery.
- `tests/web/order-detail.test.tsx`: all-role cancellation UI, lockout, and formatting coverage.
- `tests/e2e/order-happy-path.spec.ts`, `tests/e2e/support/foodguard-fixture.ts`: deterministic broadcast-then-fetch-error recovery and participant cancellation smoke.
- `README.md`, `docs/recovery-runbook.md`, `docs/verification/proof-matrix.md`: V1/V2 boundary and evidence limitations.

---

### Task 1: Participant cancellation in the Intelligent Contract

**Files:**
- Create: `tests/contract/test_participant_cancellation.py`
- Modify: `contracts/food_guard.py`

**Interfaces:**
- Consumes: existing `FoodGuard._allocate_once(order_id, order, basis, customer_wei, restaurant_wei, courier_wei, terminal_state)`.
- Produces: public write `cancel_before_packed(order_id: str) -> None`.

- [ ] **Step 1: Write failing authorization and state tests**

Add parameterized tests that construct `FUNDED`, `PARTIALLY_ACCEPTED`, and `ACCEPTED` orders, call the new method as each stored participant, and assert the exact terminal record:

```python
@pytest.mark.parametrize("actor_name", ["customer", "restaurant", "courier"])
@pytest.mark.parametrize("starting_state", ["FUNDED", "PARTIALLY_ACCEPTED", "ACCEPTED"])
def test_named_participant_cancels_before_packing(
    cancellable_order, actor_name, starting_state, vm, emitted_messages
):
    contract, actors = cancellable_order(starting_state)
    vm.sender = actors[actor_name]

    contract.cancel_before_packed("fg-cancel-v2")

    order = contract.get_order("fg-cancel-v2")
    assert order.state == "CANCELLED_REFUNDED"
    assert order.refund_emitted is True
    assert order.restaurant_accepted is False
    assert order.courier_accepted is False
    assert len(emitted_messages) == 1
    assert emitted_messages[0]["value"] == 130
```

Use only reachable state/flag combinations: `FUNDED=(False,False)`, both partial variants, and `ACCEPTED=(True,True)`.

- [ ] **Step 2: Run the focused tests and capture RED**

Run: `python -m pytest tests/contract/test_participant_cancellation.py -v`

Expected: failures because `FoodGuard.cancel_before_packed` is absent.

- [ ] **Step 3: Add adversarial failing tests**

Add literal `gl.vm.UserError` assertions for outsider calls, missing order, `READY_FOR_PICKUP`, `IN_TRANSIT`, `REVIEW_WINDOW`, all resolution states, and `SETTLED`. Add a replay test that snapshots accounting and emitted messages before the second call. Add a conservation assertion:

```python
accounting = contract.get_accounting()
assert accounting.total_inflows == (
    accounting.reserved_items
    + accounting.reserved_delivery
    + accounting.restaurant_payouts_emitted
    + accounting.courier_payouts_emitted
    + accounting.customer_refunds_emitted
)
```

- [ ] **Step 4: Implement the minimal contract method**

Add the public method beside `cancel_unaccepted`:

```python
@gl.public.write
def cancel_before_packed(self, order_id: str) -> None:
    if order_id not in self.orders:
        raise gl.vm.UserError("[EXPECTED] order not found")
    order = self.orders[order_id]
    if order.state == "CANCELLED_REFUNDED":
        return
    if order.state not in ("FUNDED", "PARTIALLY_ACCEPTED", "ACCEPTED"):
        raise gl.vm.UserError("[EXPECTED] participant cancellation closed")
    if gl.message.sender_address not in (
        order.customer,
        order.restaurant,
        order.courier,
    ):
        raise gl.vm.UserError("[EXPECTED] order participant required")
    if order.refund_emitted:
        raise gl.vm.UserError("[EXPECTED] accounting conservation violated")
    self._allocate_once(
        order_id,
        order,
        "participant-cancellation-before-packed",
        int(order.total_value),
        0,
        0,
        "CANCELLED_REFUNDED",
    )
```

Extend the frozen public ABI test with `cancel_before_packed`. Do not modify the legacy `cancel_unaccepted` timeout behavior.

- [ ] **Step 5: Run focused and full contract verification**

Run:

```powershell
python -m pytest tests/contract/test_participant_cancellation.py -v
python -m pytest -v
```

Expected: all tests pass; direct-mode PostMessage assertions remain explicitly local-only evidence.

- [ ] **Step 6: Review and commit Task 1**

Check `git diff --check`, inspect the ABI diff, and commit only contract/test files:

```powershell
git add contracts/food_guard.py tests/contract/test_participant_cancellation.py tests/contract/test_order_lifecycle.py
git commit -m "feat(contract): allow participant cancellation before packing"
```

---

### Task 2: Quota-safe StudioNet RPC boundary

**Files:**
- Create: `lib/genlayer/rpcResilience.ts`
- Modify: `lib/genlayer/client.ts`
- Modify: `lib/genlayer/transactions.ts`
- Modify: `tests/web/transactions.test.ts`

**Interfaces:**
- Produces `class StudioNetRateLimitError extends Error { retryAfterMs: number }`.
- Produces `class AmbiguousWalletOutcomeError extends Error { cause: unknown }`.
- Produces `class OutcomeUnknownError extends Error`.
- Produces `classifyRpcFailure(error: unknown): "RATE_LIMIT" | "TRANSIENT" | "DEFINITIVE"`.
- Produces `withStudioNetBackoff<T>(operation, options) -> Promise<T>` and `singleFlight<T>(key, operation) -> Promise<T>`.

- [ ] **Step 1: Write structured failure-classification RED tests**

Cover nested viem errors with `cause.code === -32029`, `cause.data.retry_after_seconds === 60`, plain `Failed to fetch`, user rejection code `4001`, chain/account errors, and contract `UserError`. Assert that only rate-limit/transient transport errors are ambiguous.

```ts
expect(classifyRpcFailure({
  cause: { code: -32029, data: { retry_after_seconds: 60 } },
})).toEqual({ kind: "RATE_LIMIT", retryAfterMs: 60_000 });
expect(classifyRpcFailure({ code: 4001 })).toEqual({ kind: "DEFINITIVE" });
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/web/transactions.test.ts`

Expected: import/API failures for the new resilience module.

- [ ] **Step 3: Write backoff and single-flight RED tests**

Use fake timers. Assert two same-key concurrent reads call the underlying operation once. Assert a rate-limit retry uses the exact server delay, does not exceed the deadline, and clears timers after resolution. Assert different keys remain independent.

- [ ] **Step 4: Implement the resilience module**

Use a module-local `Map<string, Promise<unknown>>` for in-flight reads. Traverse `error`, `cause`, and `details` without stringifying secrets. Clamp retry delay to `1_000..60_000ms`; use exponential delays `2_000, 4_000, 8_000` only when no server delay exists. Never wrap wallet writes in this retry helper.

- [ ] **Step 5: Make transaction polling quota-safe**

Change `trackTransaction` defaults to `pollIntervalMs = 3_000` and `timeoutMs = 120_000`. Wrap only `client.getTransaction` and authoritative readback operations with bounded transient backoff. A single tracking operation must issue at most 20 status polls per minute before any explicit server delay.

Add `RECONCILING` and `OUTCOME_UNKNOWN` to `TxStage`; keep `CONSENSUS_FAILED` retryable only when a real transaction hash and explicit consensus failure status exist.

- [ ] **Step 6: Route readFoodGuard through single-flight**

Build a canonical key from chain ID, contract address, method, and JSON-safe arguments. Share only concurrent calls; remove the key in `finally` so later latest-final reads remain fresh.

- [ ] **Step 7: Run GREEN and regression checks**

Run:

```powershell
npm test -- --run tests/web/transactions.test.ts
npx tsc --noEmit
```

Expected: all transaction tests and type checking pass.

- [ ] **Step 8: Review and commit Task 2**

```powershell
git add lib/genlayer/rpcResilience.ts lib/genlayer/client.ts lib/genlayer/transactions.ts tests/web/transactions.test.ts
git commit -m "fix(web): coordinate StudioNet RPC retries"
```

---

### Task 3: Write-once authoritative reconciliation

**Files:**
- Create: `lib/genlayer/operations.ts`
- Modify: `components/food/OrderBuilder.tsx`
- Modify: `components/order/RoleConsole.tsx`
- Modify: `tests/web/order-builder.test.tsx`
- Modify: `tests/web/order-detail.test.tsx`

**Interfaces:**
- Produces `executeFoodGuardOperation<T>(input: FoodGuardOperation<T>): Promise<T>`.
- `FoodGuardOperation<T>` contains `method`, `args`, `value`, `expectedAccount`, `onStage`, `readback`, and `matches`.

- [ ] **Step 1: Write the broadcast-then-error RED test**

Make `writeFoodGuard` reject once with a nested `Failed to fetch` error after the simulated wallet boundary. Make `readback` return the expected changed contract state. Assert one write call, one or more reads, `RECONCILING`, and successful return.

```ts
await expect(executeFoodGuardOperation({
  method: "accept_restaurant",
  args: ["fg-1"],
  value: 0n,
  expectedAccount: RESTAURANT,
  onStage: (stage) => stages.push(stage),
  readback: async () => ({ ...ORDER, restaurant_accepted: true }),
  matches: (order) => order.restaurant_accepted === true,
})).resolves.toMatchObject({ restaurant_accepted: true });
expect(write).toHaveBeenCalledTimes(1);
expect(stages).toContain("RECONCILING");
```

- [ ] **Step 2: Write definitive and unknown-outcome RED tests**

Assert user rejection performs zero reconciliation reads. Assert repeated nonmatching readback ends in `OutcomeUnknownError`, emits `OUTCOME_UNKNOWN`, and still performs exactly one write attempt.

- [ ] **Step 3: Implement the operation coordinator**

Call `writeFoodGuard` once. If it returns a hash, call `trackTransaction`. If it throws a definitive error, rethrow. If it throws an ambiguous transport error, emit `RECONCILING` and poll only `readback` through `withStudioNetBackoff` until `matches` succeeds or the reconciliation deadline expires. Never call `writeFoodGuard` from the catch path.

- [ ] **Step 4: Bind create-order reconciliation to the frozen preview**

In `OrderBuilder`, replace the direct write/track sequence with `executeFoodGuardOperation`. The predicate must compare exact order ID, normalized actors, canonical manifest JSON, delivery fee, total value, and every deadline from `FrozenCommitment`. Add tests where one mismatched field prevents success.

- [ ] **Step 5: Bind role actions to exact state changes**

For `accept_restaurant`, require the expected stored restaurant plus `restaurant_accepted === true`. For `accept_courier`, require the expected courier plus `courier_accepted === true`. For `cancel_before_packed`, require `state === "CANCELLED_REFUNDED"`, `refund_emitted === true`, and cleared acceptance flags. Preserve the custom evidence-action path in `app/orders/[id]/page.tsx`.

- [ ] **Step 6: Run focused GREEN**

Run:

```powershell
npm test -- --run tests/web/transactions.test.ts tests/web/order-builder.test.tsx tests/web/order-detail.test.tsx
npx tsc --noEmit
```

- [ ] **Step 7: Review and commit Task 3**

```powershell
git add lib/genlayer/operations.ts components/food/OrderBuilder.tsx components/order/RoleConsole.tsx tests/web/transactions.test.ts tests/web/order-builder.test.tsx tests/web/order-detail.test.tsx
git commit -m "fix(web): reconcile ambiguous StudioNet writes"
```

---

### Task 4: Three-role cancellation UI and simulated GEN formatting

**Files:**
- Modify: `components/order/RoleConsole.tsx`
- Modify: `components/order/TransactionLifecycle.tsx`
- Modify: `components/order/ItemOutcomeTable.tsx`
- Modify: `lib/domain.ts`
- Modify: `locales/vi.ts`
- Modify: `locales/en.ts`
- Modify: `tests/web/order-detail.test.tsx`

**Interfaces:**
- Replace `actionFor(...) -> RoleAction | null` with `actionsFor(...) -> RoleAction[]`.
- Add action ID `cancelBeforePacked` and method `cancel_before_packed`.
- Produce `formatSimulatedGenWei(value: bigint | string) -> string` in `lib/domain.ts`.

- [ ] **Step 1: Write cancellation-action RED tests**

For each named role, assert a cancel button exists in `FUNDED`, both partial states, and `ACCEPTED`. In `ACCEPTED`, restaurant must see both pack and cancel actions. Assert outsiders do not see participant cancellation. Assert `READY_FOR_PICKUP` and later states do not show it.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run tests/web/order-detail.test.tsx`

Expected: failures because the console currently returns only one action and has no `cancel_before_packed` action.

- [ ] **Step 3: Implement multiple truthful actions**

Return an array. Add participant cancellation for roles `CUSTOMER`, `RESTAURANT`, and `COURIER` only when state is `FUNDED`, `PARTIALLY_ACCEPTED`, or `ACCEPTED`. Preserve permissionless legacy `cancel_unaccepted` only after the acceptance deadline when not fully accepted. Render stable keyed buttons and freeze all actions while one is pending.

- [ ] **Step 4: Add reconciliation lifecycle copy**

Vietnamese copy must distinguish:

- `RECONCILING`: “Ví có thể đã gửi giao dịch. FoodGuard đang đối chiếu contract — không gửi lại.”
- `OUTCOME_UNKNOWN`: “Chưa xác minh được kết quả. Không gửi lại; hãy kiểm tra trạng thái contract.”
- Participant cancellation confirmation: “Hủy trước khi đóng gói; toàn bộ simulated GEN được hoàn cho khách hàng.”

English copy must carry the same claims without implying finality when only readback is known.

- [ ] **Step 5: Write and implement simulated GEN formatting**

RED assertions:

```ts
expect(formatSimulatedGenWei("420000000000000000")).toBe("0.42 simulated GEN");
expect(formatSimulatedGenWei("50000000000000000")).toBe("0.05 simulated GEN");
```

Render the formatted value visibly and retain `<code className="sr-only">420000000000000000 wei</code>` for exact auditability.

- [ ] **Step 6: Run focused tests, lint, and typecheck**

```powershell
npm test -- --run tests/web/order-detail.test.tsx
npx eslint components/order/RoleConsole.tsx components/order/TransactionLifecycle.tsx components/order/ItemOutcomeTable.tsx lib/domain.ts locales/vi.ts locales/en.ts
npx tsc --noEmit
```

- [ ] **Step 7: Review and commit Task 4**

```powershell
git add components/order/RoleConsole.tsx components/order/TransactionLifecycle.tsx components/order/ItemOutcomeTable.tsx lib/domain.ts locales/vi.ts locales/en.ts tests/web/order-detail.test.tsx
git commit -m "feat(web): expose safe participant cancellation"
```

---

### Task 5: Deterministic browser recovery and documentation

**Files:**
- Modify: `tests/e2e/order-happy-path.spec.ts`
- Modify: `tests/e2e/support/foodguard-fixture.ts`
- Modify: `README.md`
- Modify: `docs/recovery-runbook.md`
- Modify: `docs/verification/proof-matrix.md`

**Interfaces:**
- The E2E wallet/RPC fixture exposes one scenario where `eth_sendTransaction` records a transaction and then throws `Failed to fetch`, while later latest-final reads expose the changed contract state.

- [ ] **Step 1: Write the failing browser regression**

The test must assert:

```ts
await page.getByRole("button", { name: "Nhà hàng nhận đơn" }).click();
await expect(page.getByText(/đang đối chiếu contract/i)).toBeVisible();
await expect(page.getByTestId("raw-order-state")).toHaveText("PARTIALLY_ACCEPTED");
expect(walletWritesFor("accept_restaurant")).toHaveLength(1);
```

Also add a participant-cancellation smoke that reaches `CANCELLED_REFUNDED` and one refund allocation in the deterministic fixture.

- [ ] **Step 2: Run E2E RED**

Run: `npm run test:e2e -- tests/e2e/order-happy-path.spec.ts`

Expected: the current app renders the viem error and does not reconcile.

- [ ] **Step 3: Extend only the deterministic fixture boundary**

Do not bypass production UI logic. Record decoded wallet write calls, expose delayed authoritative state through the existing RPC double, and make the injected provider throw only after recording the one transaction. Keep the fixture explicitly non-live.

- [ ] **Step 4: Run E2E GREEN**

Run: `npm run test:e2e -- tests/e2e/order-happy-path.spec.ts`

Expected: all named scenarios pass, with exactly one wallet write in the ambiguous-outcome case.

- [ ] **Step 5: Update documentation truthfully**

Document:

- V1 remains frozen and unchanged.
- V2 source adds pre-packing participant cancellation but is not live until a separately confirmed deployment.
- RPC recovery never resends a wallet transaction.
- No transaction hash means finality/execution proof is unavailable even if state readback confirms the effect.
- E2E wallet/RPC doubles are deterministic offline evidence, not StudioNet proof.

- [ ] **Step 6: Run repository-wide verification**

```powershell
python -m pytest -v
npm test -- --run tests/web
npm run test:e2e
npm run lint
npx tsc --noEmit
npm run build
npm run verify:no-secrets
git diff --check
git status --short
```

Expected: all commands exit 0; generated Next/Playwright config drift is restored if present; no secret, build output, or internal task artifact is staged.

- [ ] **Step 7: Request independent code review and fix findings test-first**

Review specifically: custody conservation, authorization, replay, post-packing lockout, no automatic write retry, rate-limit request budget, false-success predicates, stage truthfulness, and V1/V2 documentation separation. Add a failing regression before every production fix.

- [ ] **Step 8: Commit the verified implementation evidence**

```powershell
git add README.md docs/recovery-runbook.md docs/verification/proof-matrix.md tests/e2e/order-happy-path.spec.ts tests/e2e/support/foodguard-fixture.ts
git commit -m "test: verify FoodGuard V2 recovery workflows"
```

Do not push or deploy in this task. Stop with exact local commits and verification results, then perform the external-action identity checks and ask the user for separate confirmation.
