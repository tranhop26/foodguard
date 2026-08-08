# FoodGuard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a bilingual, three-wallet FoodGuard marketplace whose GenLayer Intelligent Contract holds simulated StudioNet GEN, evaluates hash-bound public delivery evidence per item, and settles restaurant, courier, and customer allocations without an operator-selected outcome.

**Architecture:** A single intentionally frozen Python Intelligent Contract is the authority for order state, evidence, consensus decisions, accounting, and transfers. A Next.js application provides the marketplace, wallet actions, immutable evidence views, transaction lifecycle, and proof pages; static versioned JSON supplies the public demo catalog and evidence. All settlement-critical reasoning occurs inside the contract through independent leader/validator derivation.

**Tech Stack:** Python 3.12+, `genlayer-test==0.29.2`, pytest, Next.js 16.3.0, React 19.2.8, TypeScript, `genlayer-js==1.1.8`, `viem==2.55.11`, Tailwind CSS 4.3.3, Vitest 4.1.10, Playwright 1.62.1, Vercel.

## Global Constraints

- Target GenLayer StudioNet; every value display must say `Simulated GEN`.
- Three distinct wallets are mandatory: customer, restaurant, and courier.
- The Intelligent Contract is `INTENTIONALLY_FROZEN`; no upgrade, admin withdrawal, or verdict override method.
- Vietnamese is the default UI language; English is available; contract names, enums, prompts, tests, and primary technical documentation are English.
- Evidence is public canonical JSON bound by SHA-256, schema `foodguard-evidence/1`, source URL, subject, issuer, version, timestamps, chain, contract, action, and nonce.
- Stable outcomes are `MATCHED`, `MISSING`, `MISMATCHED`, `DELIVERY_FAILED`, and `UNRESOLVED`.
- Missing, stale, malformed, contradictory, or hash-mismatched evidence must become `UNRESOLVED`, never a payout or refund by default.
- V1 has no platform fee and must preserve `total_inflows = reserved_items + reserved_delivery + restaurant_payouts_emitted + courier_payouts_emitted + customer_refunds_emitted`.
- Frontend state must never advance beyond contract readback; show submission, consensus, `FINALIZED`, execution result, and readback separately.
- Do not commit secrets, private keys, generated build output, private task material, or a fake deployed contract address.
- Contract deployment, Vercel deployment, and GitHub push each require a separate action-time identity check and user confirmation.

## File Map

### Contract and tests

- `contracts/food_guard.py` — storage types, authorization, workflow, consensus, accounting, and value transfers.
- `tests/contract/conftest.py` — direct VM fixtures, four actor addresses, and evidence/LLM mocks.
- `tests/contract/test_order_lifecycle.py` — payable creation, acceptances, timeouts, authorization, and pause.
- `tests/contract/test_evidence.py` — evidence binding, freshness, append-only history, and replay rejection.
- `tests/contract/test_resolution.py` — independent validator decisions, mixed item outcomes, and unresolved behavior.
- `tests/contract/test_appeal.py` — cure, retry, appeal, escalation, and mutual settlement.
- `tests/contract/test_accounting.py` — solvency, conservation, transfer emission, and idempotency.
- `pyproject.toml` — Python tooling and pytest configuration.

### Web application

- `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs` — pinned web toolchain.
- `app/layout.tsx`, `app/globals.css`, `app/page.tsx` — shell, design system, and Proof Marketplace landing page.
- `app/create/page.tsx` — order builder and manifest preview.
- `app/orders/page.tsx` — wallet-scoped order list.
- `app/orders/[id]/page.tsx` — authoritative order workflow.
- `app/orders/[id]/proof/page.tsx` — fixed proof/readback view.
- `components/food/Hero.tsx`, `CategoryChips.tsx`, `RestaurantCard.tsx`, `ProofStrip.tsx`, `OrderBuilder.tsx` — discovery, cart, and marketplace components.
- `components/order/RoleConsole.tsx`, `OrderTimeline.tsx`, `ItemOutcomeTable.tsx`, `EvidenceDrawer.tsx`, `ConsensusPanel.tsx`, `AppealPanel.tsx`, `TransactionLifecycle.tsx` — role actions, evidence, resolution, and settlement components.
- `components/wallet/WalletButton.tsx` — connect, address, network, and role display.
- `lib/domain.ts` — shared enums and TypeScript domain types.
- `lib/evidence.ts` — canonical JSON and SHA-256 utilities.
- `lib/genlayer/config.ts` — StudioNet chain configuration and deployed-address validation.
- `lib/genlayer/client.ts` — reads, payable writes, and write encoding.
- `lib/genlayer/transactions.ts` — finality, execution-result, and readback reconciliation.
- `lib/i18n.tsx`, `locales/vi.ts`, `locales/en.ts` — bilingual copy.
- `public/catalog/catalog-v1.json` — versioned restaurant/item catalog.
- `public/evidence/order-fg-demo-manifest.json`, `order-fg-demo-packed.json`, `order-fg-demo-pickup.json`, `order-fg-demo-delivered.json`, `order-fg-demo-claim-missing-item.json` — public demo evidence fixtures.
- `tests/web/evidence.test.ts`, `transactions.test.ts`, `landing.test.tsx`, `order-builder.test.tsx`, `i18n.test.tsx`, `order-detail.test.tsx` — domain, evidence, state mapping, and component tests.
- `tests/e2e/marketplace.spec.ts`, `order-happy-path.spec.ts`, `order-unresolved.spec.ts`, `accessibility.spec.ts` — responsive and wallet-workflow browser tests.

### Operations and evidence

- `.env.example` — public variable names only.
- `scripts/verify-no-secrets.mjs` — repository hygiene scan.
- `deploy/studionet-manifest.example.json` — manifest schema without a deployed address.
- `docs/recovery-runbook.md` — intentionally frozen recovery process.
- `docs/verification/proof-matrix.md` — live evidence table populated only after real verification.
- `README.md` — bilingual user/developer guide and simulated-value disclosure.

---

### Task 1: Deterministic Domain and Evidence Foundation

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `postcss.config.mjs`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `lib/domain.ts`
- Create: `lib/evidence.ts`
- Create: `tests/web/evidence.test.ts`

**Interfaces:**
- Produces: `canonicalizeEvidence(value: EvidenceDocument): string`, `hashEvidence(value: EvidenceDocument): Promise<HexDigest>`, `validateEvidenceDocument(value: unknown): EvidenceDocument`.
- Produces: `OrderState`, `ItemOutcome`, `DeliveryOutcome`, `EvidenceAction`, `EvidenceDocument`, and `OrderItem`.

- [ ] **Step 1: Add the pinned web toolchain and test command**

Create scripts `dev`, `build`, `lint`, `test`, and `test:e2e`; pin Next 16.3.0, React 19.2.8, `genlayer-js` 1.1.8, viem 2.55.11, Tailwind 4.3.3, Vitest 4.1.10, and Playwright 1.62.1. Run `npm install` to generate `package-lock.json`.

- [ ] **Step 2: Write failing canonicalization tests**

```ts
it("produces one digest for differently ordered object keys", async () => {
  expect(await hashEvidence(fixtureA)).toBe(await hashEvidence(fixtureB));
});

it.each(["order_id", "actor_wallet", "source_url", "sha256", "nonce"])(
  "rejects a missing %s binding",
  (key) => expect(() => validateEvidenceDocument(without(validEvidence, key))).toThrow()
);
```

- [ ] **Step 3: Run the evidence test and confirm failure**

Run: `npm test -- tests/web/evidence.test.ts`  
Expected: FAIL because `lib/evidence.ts` does not exist.

- [ ] **Step 4: Implement exact domain types and canonical SHA-256**

```ts
export type EvidenceAction =
  | "ORDER_MANIFEST" | "PACKED" | "PICKED_UP" | "DELIVERED"
  | "CUSTOMER_CLAIM" | "CURE" | "APPEAL";
export type ItemOutcome =
  | "MATCHED" | "MISSING" | "MISMATCHED" | "DELIVERY_FAILED" | "UNRESOLVED";
export type HexDigest = `0x${string}`;

export async function hashEvidence(value: EvidenceDocument): Promise<HexDigest> {
  const bytes = new TextEncoder().encode(canonicalizeEvidence(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}`;
}
```

- [ ] **Step 5: Run tests, typecheck, and commit**

Run: `npm test -- tests/web/evidence.test.ts && npm run lint`  
Expected: PASS.  
Commit: `git commit -am "feat: add deterministic FoodGuard evidence model"` after staging new files.

---

### Task 2: Payable Order Creation, Acceptance, and Frozen Authority

**Files:**
- Create: `pyproject.toml`
- Create: `contracts/food_guard.py`
- Create: `tests/contract/conftest.py`
- Create: `tests/contract/test_order_lifecycle.py`

**Interfaces:**
- Produces contract methods: `create_order`, `accept_restaurant`, `accept_courier`, `cancel_unaccepted`, `set_creation_paused`, `get_order`, `get_item`, `get_accounting`.
- Consumes item manifest fields defined in Task 1; on-chain arguments use delimiter-safe canonical JSON strings rather than parallel pipe-separated strings.

- [ ] **Step 1: Write failing lifecycle and authorization tests**

```python
def test_create_order_reserves_exact_value(food_guard, vm, customer, restaurant, courier):
    vm.sender, vm.value = customer, 130
    food_guard.create_order("fg-1", addr(restaurant), addr(courier), MANIFEST, 30, DEADLINES)
    order = food_guard.get_order("fg-1")
    assert order.state == FUNDED
    assert food_guard.get_accounting().reserved_items == 100
    assert food_guard.get_accounting().reserved_delivery == 30

def test_rejects_same_actor_wallets(contract, vm, customer, restaurant):
    vm.sender, vm.value = customer, 130
    with vm.expect_revert("three distinct wallets required"):
        contract.create_order("same", addr(restaurant), addr(restaurant), MANIFEST, 30, DEADLINES)

def test_rejects_inexact_value(contract, vm, customer, restaurant, courier):
    vm.sender, vm.value = customer, 129
    with vm.expect_revert("exact order value required"):
        contract.create_order("short", addr(restaurant), addr(courier), MANIFEST, 30, DEADLINES)

def test_partial_acceptance_timeout_refunds(contract, vm, created_order, restaurant):
    vm.sender = restaurant
    contract.accept_restaurant("fg-1")
    vm.set_block_timestamp(ACCEPTANCE_DEADLINE + 1)
    contract.cancel_unaccepted("fg-1")
    assert contract.get_order("fg-1").state == CANCELLED_REFUNDED

def test_pause_only_blocks_new_orders(contract, vm, deployer, active_order):
    vm.sender = deployer
    contract.set_creation_paused(True)
    assert contract.get_order("fg-1").state == ACCEPTED
```

- [ ] **Step 2: Run the lifecycle suite and confirm failure**

Run: `python -m pytest tests/contract/test_order_lifecycle.py -v`  
Expected: FAIL because the contract and fixtures do not exist.

- [ ] **Step 3: Implement storage types and payable creation**

```python
@gl.public.write.payable
def create_order(self, order_id: str, restaurant: str, courier: str,
                 manifest_json: str, delivery_fee: u256, deadlines_json: str) -> None:
    self._require_creation_open()
    self._require_distinct_actors(gl.message.sender_address, Address(restaurant), Address(courier))
    items, subtotal = self._parse_and_validate_manifest(manifest_json)
    if gl.message.value != subtotal + delivery_fee:
        raise gl.vm.UserError("[EXPECTED] exact order value required")
    self._reserve_order(order_id, items, delivery_fee)
```

Implement `set_creation_paused` so only the immutable deployer can toggle creation; verify every existing-order method ignores this flag.

- [ ] **Step 4: Implement both acceptance paths and deterministic cancellation**

Record restaurant and courier acceptance independently. Before the deadline, cancellation succeeds only when neither accepted. After the deadline, incomplete dual acceptance permits a full one-time refund and invalidates the partial acceptance.

- [ ] **Step 5: Run lifecycle tests and commit**

Run: `python -m pytest tests/contract/test_order_lifecycle.py -v`  
Expected: PASS.  
Commit: `git commit -am "feat: add payable order lifecycle and role authorization"` after staging new files.

---

### Task 3: Append-only Evidence Workflow

**Files:**
- Modify: `contracts/food_guard.py`
- Create: `tests/contract/test_evidence.py`

**Interfaces:**
- Produces: `submit_packed_evidence(order_id, envelope_json)`, `submit_pickup_evidence`, `submit_delivery_evidence`, `submit_claim_evidence`, `get_evidence(order_id, evidence_index)`, `get_evidence_count(order_id)`.
- Produces internal `_append_evidence(order_id: str, expected_action: str, envelope_json: str, expected_actor: Address)`.

- [ ] **Step 1: Write failing transition and binding tests**

```python
def test_packed_pickup_delivery_transitions(food_guard_active, vm, restaurant, courier):
    vm.sender = restaurant
    food_guard_active.submit_packed_evidence("fg-1", packed_json())
    assert food_guard_active.get_order("fg-1").state == READY_FOR_PICKUP
    vm.sender = courier
    food_guard_active.submit_pickup_evidence("fg-1", pickup_json())
    food_guard_active.submit_delivery_evidence("fg-1", delivery_json())
    assert food_guard_active.get_order("fg-1").state == REVIEW_WINDOW

def test_rejects_wrong_actor(contract, vm, active_order, customer):
    vm.sender = customer
    with vm.expect_revert("restaurant wallet required"):
        contract.submit_packed_evidence("fg-1", packed_json())

def test_rejects_replayed_nonce(contract, vm, active_order, restaurant):
    vm.sender = restaurant
    envelope = packed_json(nonce="pack-1")
    contract.submit_packed_evidence("fg-1", envelope)
    with vm.expect_revert("evidence replay"):
        contract.submit_cure_evidence("fg-1", envelope)

def test_evidence_history_cannot_be_replaced(contract, vm, active_order, restaurant):
    vm.sender = restaurant
    contract.submit_packed_evidence("fg-1", packed_json(nonce="pack-1"))
    assert contract.get_evidence_count("fg-1") == 1
    assert contract.get_evidence("fg-1", 0).nonce == "pack-1"
```

- [ ] **Step 2: Run the evidence suite and confirm failure**

Run: `python -m pytest tests/contract/test_evidence.py -v`  
Expected: FAIL on missing submission methods.

- [ ] **Step 3: Implement evidence parsing and replay domain**

Store the envelope fields and calculate the unique replay key as SHA-256 of canonical `chain_id|self_address|order_id|item_id|action|actor_wallet|nonce`. Reject an already-used key. Compare `submitted_at` to the VM block time and require `observed_at <= submitted_at <= expires_at`.

- [ ] **Step 4: Implement authorized transitions and review window**

Restaurant alone moves `ACCEPTED → READY_FOR_PICKUP`; assigned courier alone moves through pickup and delivery. Customer claims append evidence during `REVIEW_WINDOW` but never change an outcome.

- [ ] **Step 5: Run evidence and lifecycle tests and commit**

Run: `python -m pytest tests/contract/test_evidence.py tests/contract/test_order_lifecycle.py -v`  
Expected: PASS.  
Commit: `git commit -am "feat: bind delivery evidence to actors and order state"`.

---

### Task 4: Evidence-grounded GenLayer Resolution

**Files:**
- Modify: `contracts/food_guard.py`
- Create: `tests/contract/test_resolution.py`

**Interfaces:**
- Produces: `request_resolution(order_id: str) -> str`, `get_resolution(order_id: str) -> str`.
- Produces structured consensus result: `{"items":[{"item_id":str,"outcome":ItemOutcome,"facts":[str]}],"delivery_outcome":DeliveryOutcome,"evidence_hashes":[str]}`.

- [ ] **Step 1: Write failing consensus tests**

```python
def test_mixed_item_outcomes_are_stored(food_guard_review, vm, outsider):
    vm.sender = outsider
    vm.mock_web(EVIDENCE_URL_PATTERN, VALID_EVIDENCE)
    vm.mock_llm(RESOLUTION_PROMPT_PATTERN, MIXED_RESULT_JSON)
    food_guard_review.request_resolution("fg-1")
    assert food_guard_review.get_item("fg-1", "rice").outcome == MATCHED
    assert food_guard_review.get_item("fg-1", "tea").outcome == MISSING

def test_validator_independently_rejects_malicious_leader(food_guard_review, vm, outsider):
    vm.sender = outsider
    vm.mock_web(EVIDENCE_URL_PATTERN, VALID_EVIDENCE)
    vm.mock_llm(RESOLUTION_PROMPT_PATTERN, MALICIOUS_MATCH_ALL_JSON)
    food_guard_review.request_resolution("fg-1")
    vm.clear_mocks()
    vm.mock_web(EVIDENCE_URL_PATTERN, VALID_EVIDENCE)
    vm.mock_llm(RESOLUTION_PROMPT_PATTERN, INDEPENDENT_MISSING_TEA_JSON)
    assert vm.run_validator() is False

def test_unavailable_evidence_becomes_unresolved(food_guard_review, vm, outsider):
    vm.sender = outsider
    vm.mock_web(EVIDENCE_URL_PATTERN, "")
    food_guard_review.request_resolution("fg-1")
    assert food_guard_review.get_item("fg-1", "tea").outcome == UNRESOLVED

def test_outsider_can_trigger_resolution(food_guard_review, vm, outsider):
    vm.sender = outsider
    food_guard_review.request_resolution("fg-1")
    assert food_guard_review.get_round("fg-1") == 1
```

- [ ] **Step 2: Run the resolution suite and confirm failure**

Run: `python -m pytest tests/contract/test_resolution.py -v`  
Expected: FAIL on missing resolution methods.

- [ ] **Step 3: Implement deterministic pre-checks and structured leader output**

Fetch each committed URL inside the nondeterministic block. Canonicalize, hash, and extract stable facts before prompting. Request JSON only and constrain each item ID and enum to the locked manifest.

- [ ] **Step 4: Implement independent validator derivation**

```python
def validator_fn(leader_result):
    if not isinstance(leader_result, gl.vm.Return):
        return False
    independent = derive_resolution_from_sources()
    return stable_decisions(independent) == stable_decisions(leader_result.calldata)

result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
```

Do not accept a leader result merely because its JSON shape is valid. Convert fetch, digest, schema, freshness, and consensus failures to item or delivery `UNRESOLVED` without allocating value.

- [ ] **Step 5: Run resolution tests and commit**

Run: `python -m pytest tests/contract/test_resolution.py tests/contract/test_evidence.py -v`  
Expected: PASS.  
Commit: `git commit -am "feat: resolve item evidence through independent consensus"`.

---

### Task 5: Cure, Appeal, Escalation, and Mutual Settlement

**Files:**
- Modify: `contracts/food_guard.py`
- Create: `tests/contract/test_appeal.py`

**Interfaces:**
- Produces: `submit_cure_evidence`, `appeal`, `propose_mutual_settlement`, `sign_mutual_settlement`, `get_round`, `get_settlement_proposal`.
- Mutual proposal digest includes order ID, item allocations, delivery allocation, contract address, chain ID, and proposal nonce.

- [ ] **Step 1: Write failing secondary-branch tests**

```python
def test_first_unresolved_opens_one_cure_round(unresolved_order):
    assert unresolved_order.get_order("fg-1").state == EVIDENCE_CURE
    assert unresolved_order.get_round("fg-1") == 1

def test_cure_appends_and_retry_can_resolve(unresolved_order, vm, restaurant, outsider):
    vm.sender = restaurant
    unresolved_order.submit_cure_evidence("fg-1", cure_json(nonce="cure-1"))
    vm.sender = outsider
    unresolved_order.request_resolution("fg-1")
    assert unresolved_order.get_order("fg-1").state == RESOLVED

def test_affected_actor_can_appeal_once(resolved_order, vm, customer):
    vm.sender = customer
    resolved_order.appeal("fg-1", appeal_json(nonce="appeal-1"))
    with vm.expect_revert("appeal already used"):
        resolved_order.appeal("fg-1", appeal_json(nonce="appeal-2"))

def test_second_unresolved_escalates_without_transfer(second_unresolved_order):
    assert second_unresolved_order.get_order("fg-1").state == ESCALATED
    assert second_unresolved_order.get_accounting().reserved_items == 100

def test_mutual_settlement_requires_all_three_signatures(escalated_order, vm, actors):
    digest = escalated_order.propose_mutual_settlement("fg-1", MUTUAL_ALLOCATION)
    for actor in actors[:2]:
        vm.sender = actor
        escalated_order.sign_mutual_settlement("fg-1", digest)
    assert escalated_order.get_order("fg-1").state == ESCALATED
    vm.sender = actors[2]
    escalated_order.sign_mutual_settlement("fg-1", digest)
    assert escalated_order.get_order("fg-1").state == SETTLED

def test_mutual_allocation_must_conserve_order_value(escalated_order, vm, customer):
    vm.sender = customer
    with vm.expect_revert("allocation must conserve order value"):
        escalated_order.propose_mutual_settlement("fg-1", OVER_ALLOCATED_PROPOSAL)
```

- [ ] **Step 2: Run appeal tests and confirm failure**

Run: `python -m pytest tests/contract/test_appeal.py -v`  
Expected: FAIL on missing branch methods.

- [ ] **Step 3: Implement one append-only cure round and one appeal**

Only affected actors may add cure or appeal evidence. Preserve prior evidence and decisions. Block settlement until the appeal deadline. A second unresolved resolution enters `ESCALATED` with every reserve unchanged.

- [ ] **Step 4: Implement matching three-party fallback signatures**

Each role signs the same stored proposal digest through its own transaction. Reject changed allocations, missing recipients, excess allocations, reused nonce, or repeat signatures. Execute only after customer, restaurant, and courier signatures are recorded.

- [ ] **Step 5: Run appeal and resolution suites and commit**

Run: `python -m pytest tests/contract/test_appeal.py tests/contract/test_resolution.py -v`  
Expected: PASS.  
Commit: `git commit -am "feat: add cure appeal and escalation workflow"`.

---

### Task 6: Solvent, Idempotent Settlement

**Files:**
- Modify: `contracts/food_guard.py`
- Create: `tests/contract/test_accounting.py`

**Interfaces:**
- Produces: `execute_settlement(order_id: str) -> str`, internal `_allocate_once`, `_assert_conservation`, `_emit_eoa_transfer`.
- `get_accounting()` returns all five invariant terms; `get_order_settlement(order_id)` returns settlement ID and recipient allocations.

- [ ] **Step 1: Write failing accounting and replay tests**

```python
def assert_conserved(contract):
    a = contract.get_accounting()
    assert a.total_inflows == (
        a.reserved_items + a.reserved_delivery + a.restaurant_payouts_emitted
        + a.courier_payouts_emitted + a.customer_refunds_emitted
    )

def test_mixed_outcomes_conserve_and_emit_each_transfer_once(resolved_order, vm, outsider):
    vm.sender = outsider
    settlement_id = resolved_order.execute_settlement("fg-1")
    assert settlement_id
    assert len(vm.emitted_transfers) == 3
    assert_conserved(resolved_order)

def test_double_execute_returns_same_id_without_new_transfer(settled_order, vm, outsider):
    vm.sender = outsider
    before = len(vm.emitted_transfers)
    first = settled_order.execute_settlement("fg-1")
    second = settled_order.execute_settlement("fg-1")
    assert first == second
    assert len(vm.emitted_transfers) == before

def test_insolvency_aborts_before_ledger_mutation(resolved_order, vm, outsider):
    before = resolved_order.get_accounting()
    vm.set_contract_balance(1)
    vm.sender = outsider
    with vm.expect_revert("insufficient contract balance"):
        resolved_order.execute_settlement("fg-1")
    assert resolved_order.get_accounting() == before

def test_refund_conserves(cancelled_order):
    assert_conserved(cancelled_order)
```

- [ ] **Step 2: Run accounting tests and confirm failure**

Run: `python -m pytest tests/contract/test_accounting.py -v`  
Expected: FAIL on missing settlement implementation.

- [ ] **Step 3: Implement checks-effects-finalized-transfer ordering**

Check terminal decisions, appeal deadline, exact allocations, per-reserve settled flags, contract balance, and the conservation equation. Update the immutable settlement ledger once, then emit EOA transfers on finalization. An existing settlement ID is returned without another emission.

- [ ] **Step 4: Run all contract tests**

Run: `python -m pytest tests/contract -v`  
Expected: every lifecycle, evidence, resolution, appeal, accounting, pause, and outsider test passes.

- [ ] **Step 5: Commit contract V1**

Run: `git add contracts tests/contract pyproject.toml && git commit -m "feat: complete solvent FoodGuard settlement contract"`.

---

### Task 7: StudioNet Client and Transaction Reconciliation

**Files:**
- Create: `.env.example`
- Create: `lib/genlayer/config.ts`
- Create: `lib/genlayer/client.ts`
- Create: `lib/genlayer/transactions.ts`
- Create: `tests/web/transactions.test.ts`

**Interfaces:**
- Produces: `readFoodGuard<T>(method, args)`, `writeFoodGuard(method, args, value?)`, `trackTransaction(hash, onUpdate)`, `reconcileOrder(orderId)`.
- `TxStage` is `WALLET_CONFIRMATION | SUBMITTED | CONSENSUS_PENDING | FINALIZED | EXECUTION_SUCCESS | EXECUTION_ERROR | READBACK_CONFIRMED`.

- [ ] **Step 1: Write failing transaction-state tests**

```ts
it("does not report success from finality alone", async () => {
  mockReceipt({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR" });
  await expect(trackTransaction(hash, record)).rejects.toThrow("execution failed");
  expect(stages).not.toContain("READBACK_CONFIRMED");
});

it("requires post-success order readback", async () => {
  mockReceipt({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" });
  await trackTransaction(hash, record);
  expect(reconcileOrder).toHaveBeenCalledWith("fg-1");
  expect(stages.at(-1)).toBe("READBACK_CONFIRMED");
});
```

- [ ] **Step 2: Run transaction tests and confirm failure**

Run: `npm test -- tests/web/transactions.test.ts`  
Expected: FAIL because client modules do not exist.

- [ ] **Step 3: Implement strict public configuration**

Require StudioNet chain parameters and a syntactically valid nonzero `NEXT_PUBLIC_FOODGUARD_ADDRESS`. Development without an address renders a deployment-required screen; write methods remain unavailable. `.env.example` lists names and explanations but no address value or credential.

- [ ] **Step 4: Implement payable writes and receipt/readback stages**

Use `genlayer-js` for reads/writes and the connected EIP-1193 wallet. Check `txExecutionResultName` after finality and call `reconcileOrder` before reporting readback confirmation.

- [ ] **Step 5: Run web tests and commit**

Run: `npm test -- tests/web/transactions.test.ts && npm run lint`  
Expected: PASS.  
Commit: `git commit -am "feat: integrate StudioNet transactions and readback"` after staging new files.

---

### Task 8: Proof Marketplace Design System and Landing Page

**Files:**
- Create: `app/layout.tsx`
- Create: `app/globals.css`
- Create: `app/page.tsx`
- Create: `components/food/Hero.tsx`
- Create: `components/food/CategoryChips.tsx`
- Create: `components/food/RestaurantCard.tsx`
- Create: `components/food/ProofStrip.tsx`
- Create: `public/catalog/catalog-v1.json`
- Create: `tests/web/landing.test.tsx`

**Interfaces:**
- Consumes catalog `Restaurant` and `OrderItem` types from `lib/domain.ts`.
- Produces reusable `RestaurantCard`, `CategoryChips`, and `ProofStrip` components.

- [ ] **Step 1: Write failing semantic landing tests**

```tsx
it("renders discovery and simulated-value disclosure", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: /món ngon.*bằng chứng/i })).toBeVisible();
  expect(screen.getByText(/StudioNet · Simulated GEN/i)).toBeVisible();
  expect(screen.getAllByRole("article")).toHaveLength(6);
});
```

- [ ] **Step 2: Run landing test and confirm failure**

Run: `npm test -- tests/web/landing.test.tsx`  
Expected: FAIL because the page and components do not exist.

- [ ] **Step 3: Implement the approved Proof Marketplace visual direction**

Build an image-led hero, dominant search, compact category chips, food-rich cards, restrained orange/coral accent, deep green proof panels, generous white space, and no copied logos or imagery from reference brands. Use optimized local licensed images or generated project-owned assets with alt text.

- [ ] **Step 4: Add responsive and accessible interaction states**

Use semantic landmarks, visible focus, 44px minimum tap targets, non-color status labels, reduced-motion rules, 4.5:1 body-text contrast, and layouts at 375px, 768px, 1280px, and 1440px.

- [ ] **Step 5: Test, build, and commit**

Run: `npm test -- tests/web/landing.test.tsx && npm run lint && npm run build`  
Expected: PASS.  
Commit: `git commit -am "feat: build FoodGuard proof marketplace experience"` after staging new files.

---

### Task 9: Bilingual Wallet, Order Creation, and Role Console

**Files:**
- Create: `lib/i18n.tsx`
- Create: `locales/vi.ts`
- Create: `locales/en.ts`
- Create: `components/wallet/WalletButton.tsx`
- Create: `components/food/OrderBuilder.tsx`
- Create: `components/order/RoleConsole.tsx`
- Create: `app/create/page.tsx`
- Create: `app/orders/page.tsx`
- Create: `tests/web/order-builder.test.tsx`
- Create: `tests/web/i18n.test.tsx`

**Interfaces:**
- Consumes `canonicalizeEvidence`, `hashEvidence`, `writeFoodGuard`, and contract order reads.
- Produces `useLocale()`, `WalletButton`, `OrderBuilder`, and state-derived `RoleConsole` actions.

- [ ] **Step 1: Write failing language, wallet, and manifest tests**

```tsx
it("defaults to Vietnamese and keeps enums unchanged in English", async () => {
  render(<LocaleHarness outcome="UNRESOLVED" />);
  expect(screen.getByText("Cần bổ sung bằng chứng")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "English" }));
  expect(screen.getByTestId("raw-outcome")).toHaveTextContent("UNRESOLVED");
});

it("blocks creation until three distinct wallets are present", () => {
  render(<OrderBuilder initialActors={[CUSTOMER, RESTAURANT, RESTAURANT]} />);
  expect(screen.getByRole("button", { name: /tạo và ký quỹ/i })).toBeDisabled();
  expect(screen.getByText(/ba địa chỉ ví phải khác nhau/i)).toBeVisible();
});

it("shows the canonical manifest digest before wallet confirmation", async () => {
  render(<OrderBuilder initialActors={[CUSTOMER, RESTAURANT, COURIER]} />);
  expect(await screen.findByTestId("manifest-digest")).toHaveTextContent(/^0x[0-9a-f]{64}$/);
});

it("derives available actions from wallet plus contract state", () => {
  render(<RoleConsole address={COURIER} order={READY_FOR_PICKUP_ORDER} />);
  expect(screen.getByRole("button", { name: /xác nhận nhận hàng/i })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /đóng gói/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -- tests/web/order-builder.test.tsx tests/web/i18n.test.tsx`  
Expected: FAIL on missing components.

- [ ] **Step 3: Implement bilingual copy and wallet network guard**

Persist only the locale preference. Never persist a private key. Require StudioNet and display the connected address plus derived role; expose switch-network instructions on mismatch.

- [ ] **Step 4: Implement order creation and state-derived role actions**

Generate canonical manifest JSON and digest in-browser, calculate item subtotal plus delivery fee in wei, preview all commitments, then call payable `create_order`. Query contract state after every write and render only actions whose actor and preconditions match.

- [ ] **Step 5: Test and commit**

Run: `npm test -- tests/web/order-builder.test.tsx tests/web/i18n.test.tsx && npm run lint`  
Expected: PASS.  
Commit: `git commit -am "feat: add bilingual three-wallet order workflow"` after staging new files.

---

### Task 10: Order Detail, Evidence, Consensus, Appeal, and Proof UI

**Files:**
- Create: `app/orders/[id]/page.tsx`
- Create: `app/orders/[id]/proof/page.tsx`
- Create: `components/order/OrderTimeline.tsx`
- Create: `components/order/ItemOutcomeTable.tsx`
- Create: `components/order/EvidenceDrawer.tsx`
- Create: `components/order/ConsensusPanel.tsx`
- Create: `components/order/AppealPanel.tsx`
- Create: `components/order/TransactionLifecycle.tsx`
- Create: `tests/web/order-detail.test.tsx`

**Interfaces:**
- Consumes `readFoodGuard`, `writeFoodGuard`, `trackTransaction`, `reconcileOrder`, and bilingual copy.
- Produces a readback-backed order page and immutable proof page.

- [ ] **Step 1: Write failing workflow-rendering tests**

```tsx
it("renders every item outcome and separate delivery-fee outcome", () => {
  render(<ItemOutcomeTable order={MIXED_OUTCOME_ORDER} />);
  expect(screen.getAllByRole("row")).toHaveLength(4);
  expect(screen.getByText("Delivery fee")).toBeVisible();
});

it("shows UNRESOLVED as locked funds with cure action", () => {
  render(<AppealPanel order={UNRESOLVED_ORDER} address={RESTAURANT} />);
  expect(screen.getByText(/vẫn được khóa trong escrow/i)).toBeVisible();
  expect(screen.getByRole("button", { name: /bổ sung bằng chứng/i })).toBeEnabled();
});

it("shows finality execution and readback as separate stages", () => {
  render(<TransactionLifecycle stage="EXECUTION_SUCCESS" />);
  expect(screen.getByText("FINALIZED")).toBeVisible();
  expect(screen.getByText("Execution success")).toBeVisible();
  expect(screen.getByText("Readback pending")).toBeVisible();
});

it("hides appeal after deadline", () => {
  render(<AppealPanel order={EXPIRED_APPEAL_ORDER} address={CUSTOMER} />);
  expect(screen.queryByRole("button", { name: /appeal/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run order-detail tests and confirm failure**

Run: `npm test -- tests/web/order-detail.test.tsx`  
Expected: FAIL on missing page and components.

- [ ] **Step 3: Implement authoritative workflow presentation**

Read the contract on initial load and after each write. Render the timeline, per-item allocations, delivery fee, evidence metadata, cure/appeal countdowns, and eligible actions. Never infer completion from local form submission.

- [ ] **Step 4: Implement transaction and proof views**

Render `SUBMITTED`, validator progress, `FINALIZED`, `EXECUTION_SUCCESS` or `EXECUTION_ERROR`, and `READBACK_CONFIRMED` independently. The proof page includes chain, contract, source hash when available, transaction, settlement ID, evidence digests, outcomes, and readback.

- [ ] **Step 5: Test, build, and commit**

Run: `npm test -- tests/web/order-detail.test.tsx && npm run lint && npm run build`  
Expected: PASS.  
Commit: `git commit -am "feat: surface evidence consensus and settlement proof"` after staging new files.

---

### Task 11: Demo Evidence, Adversarial Browser Coverage, and Documentation

**Files:**
- Create: `public/evidence/order-fg-demo-manifest.json`
- Create: `public/evidence/order-fg-demo-packed.json`
- Create: `public/evidence/order-fg-demo-pickup.json`
- Create: `public/evidence/order-fg-demo-delivered.json`
- Create: `public/evidence/order-fg-demo-claim-missing-item.json`
- Create: `tests/e2e/marketplace.spec.ts`
- Create: `tests/e2e/order-happy-path.spec.ts`
- Create: `tests/e2e/order-unresolved.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `playwright.config.ts`
- Create: `scripts/verify-no-secrets.mjs`
- Create: `docs/recovery-runbook.md`
- Create: `deploy/studionet-manifest.example.json`
- Create: `docs/verification/proof-matrix.md`
- Create: `README.md`

**Interfaces:**
- Produces fixed public fixtures whose computed digests are asserted in tests.
- Produces commands: `npm run test:e2e` and `npm run verify:no-secrets`.

- [ ] **Step 1: Add versioned fixtures and digest regression tests**

Each JSON document contains the complete evidence envelope with `foodguard-evidence/1`; use a test to recompute and compare the committed SHA-256 values used by the demo manifest.

- [ ] **Step 2: Write browser tests for promoted flows**

```ts
test("marketplace is usable at 375px and 1440px", async ({ page }) => {
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /bằng chứng/i })).toBeVisible();
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  }
});

test("happy path waits for readback before success", async ({ page }) => {
  await installWalletAndRpcFixture(page, "happy-path");
  await page.goto("/orders/fg-1");
  await page.getByRole("button", { name: /execute settlement/i }).click();
  await expect(page.getByText("FINALIZED")).toBeVisible();
  await expect(page.getByText("Readback confirmed")).toBeVisible();
});

test("unresolved flow locks value and exposes cure", async ({ page }) => {
  await installWalletAndRpcFixture(page, "unresolved");
  await page.goto("/orders/fg-1");
  await expect(page.getByText(/khóa trong escrow/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /bổ sung bằng chứng/i })).toBeEnabled();
});

test("keyboard reaches every enabled order action", async ({ page }) => {
  await installWalletAndRpcFixture(page, "ready-for-pickup");
  await page.goto("/orders/fg-1");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /xác nhận nhận hàng/i })).toBeFocused();
});
```

- [ ] **Step 3: Implement secret scan and frozen recovery documentation**

The scanner fails on private-key patterns, Vercel token patterns, seed phrases, `.env.local`, build output, and tracked `.superpowers` or `work` files. The runbook documents creation pause, active-order audit, evidence export, V2 deployment, frontend migration, and V1 preservation.

- [ ] **Step 4: Write bilingual README and manifest schema**

Document the trust model, exact decision/consequence, simulated GEN disclosure, three-wallet setup, local commands, evidence format, state machine, test coverage, frozen classification, and deployment confirmation gates. The example manifest includes network and source-hash fields but no deployed address.

- [ ] **Step 5: Run full local verification and commit**

Run: `python -m pytest tests/contract -v && npm test && npm run test:e2e && npm run lint && npm run build && npm run verify:no-secrets`  
Expected: all commands exit 0.  
Commit: `git commit -am "test: verify FoodGuard workflows and recovery evidence"` after staging new files.

---

### Task 12: Independent Review and StudioNet/Vercel Evidence Gates

**Files:**
- Modify after confirmed deployment: runtime public configuration file selected by Task 7.
- Create after confirmed deployment: `deploy/studionet-manifest.json`
- Modify after live verification: `docs/verification/proof-matrix.md`
- Modify after live verification: `README.md`

**Interfaces:**
- Consumes the complete tested application and contract.
- Produces fixed deployment and live proof evidence without credentials.

- [ ] **Step 1: Run pre-deployment source and repository review**

Run the complete local verification command, `git diff --check`, `git status --short`, tracked-file secret scan, contract interface audit, accounting invariant review, and a search proving no runtime deployed address exists yet. Fix findings with regression tests and commit each fix.

- [ ] **Step 2: Stop for StudioNet deployment confirmation**

Display the exact deployment wallet address, network, contract classification, source SHA-256, Git commit, and proposed deployment command. Proceed only after the user confirms that wallet and action.

- [ ] **Step 3: Deploy and verify the real StudioNet contract**

After confirmation, deploy the exact reviewed source. Record the address, transaction hash, explorer link, source hash, constructor configuration, deployer, timestamp, and commit in `deploy/studionet-manifest.json`. Exercise happy path, refund, unresolved/cure, appeal, outsider resolution, and settlement; verify finality, execution success, and readback.

- [ ] **Step 4: Bind the real address and repeat all checks**

Add only the real address to public runtime configuration, run all contract/web/browser/build/lint/secret checks, and confirm the deployed source hash matches the repository source.

- [ ] **Step 5: Stop for Vercel identity and deployment confirmation**

Inspect the active Vercel identity, team, and intended project. State the exact project creation/link and production deployment action. Accept `VERCEL_TOKEN` only through a secure environment mechanism; do not echo, persist, or commit it. Proceed only after the user confirms the displayed identity and action.

- [ ] **Step 6: Deploy Vercel and test the live URL**

Deploy production, then run the browser suite against the live URL. Inspect console errors, mobile/desktop layout, three-wallet guidance, public evidence availability, transaction lifecycle, proof page, and simulated-value disclosures.

- [ ] **Step 7: Freeze the evidence package**

Populate every proof-matrix row with actor, action, contract method, transaction hash, finality, execution result, readback, source/test link, exact Git commit, source hash, contract address, explorer, Vercel URL, test outputs, and known limitations. Commit locally.

- [ ] **Step 8: Stop for optional GitHub push confirmation**

Inspect Git author, GitHub CLI account, repository owner, remote, staged files, and untracked files. State the exact branch, commits, and remote target. Push only after the user separately confirms this context.
