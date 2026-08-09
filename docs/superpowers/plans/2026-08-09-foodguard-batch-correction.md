# FoodGuard Batch Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate permanent escrow lock when one participant owns three or more stale active evidence records by adding atomic, bounded batch correction to cure and appeal.

**Architecture:** Keep the public `submit_cure_evidence(order_id, envelope_json)` and `appeal(order_id, envelope_json)` ABI methods, but make their canonical evidence document contain a sorted target-index list and a positionally bound typed statement list. The contract validates the full batch before mutation, stores one append-only batch record, supersedes every direct target, and expands validated statements into safe consensus facts. The web app builds the same exact schema from authoritative active evidence and waits for finalized execution plus authoritative readback.

**Tech Stack:** Python 3.12, `py-genlayer` v0.2.16, `genlayer-test` 0.29.2, Next.js 16.3, React 19.2, TypeScript 5.9, `genlayer-js` 1.1.8, Vitest 4.1, Playwright 1.62.

## Global Constraints

- Contract classification remains `INTENTIONALLY_FROZEN`; no privileged upgrade path may be added.
- StudioNet chain ID remains exactly `61999`.
- `MAX_ITEMS = 100`, `MAX_ACTIVE_EVIDENCE = 103`, and `MAX_EVIDENCE_HISTORY = 112` remain unchanged.
- `CURE` and `APPEAL` keep `schema_version = "foodguard-evidence/1"` before the first deployment.
- Batch outer subject is exactly `order:<order_id>` and contains no outer `item_id`, singular `effective_action`, or singular `supersedes_evidence_index`.
- Batch fields are exactly `supersedes_evidence_indices` plus `statements`; targets are strictly increasing and statements are positionally bound to flattened target slots.
- Each statement uses only `PACKED`, `PICKED_UP`, `DELIVERED`, or `CUSTOMER_CLAIM` and the existing exact typed enum schema for that action.
- The contract validates every target and statement before appending evidence, consuming replay/quota state, or writing a supersession key.
- A later batch may supersede an active earlier batch and must preserve its ordered semantic action/item slots.
- Consensus input contains only contract-generated indices, codes, integer quantities, and integer timestamps; never raw names, conditions, substitutions, URLs, issuer prose, verdicts, requested outcomes, or arbitrary prompt text.
- Evidence remains public HTTPS plus canonical SHA-256, transaction-bound by chain, contract, order, action, actor, and nonce.
- Unavailable, stale, contradictory, malformed, or hash-mismatched evidence remains `UNRESOLVED`; it never defaults to a payout.
- One successful batch consumes one history slot regardless of statement count and remains subject to the existing one-cure-per-role-per-round and one-appeal-per-role quotas.
- The UI defaults to Vietnamese, supports English, never preselects affirmative evidence facts, and shows pending, `FINALIZED`, execution success, authoritative readback, and errors separately.
- No StudioNet deployment, GitHub push, Vercel deployment, token use, wallet selection, or live-proof claim is authorized by this plan.

---

### Task 1: Atomic batch correction in the Intelligent Contract

**Files:**
- Create: `tests/contract/test_batch_correction.py`
- Modify: `contracts/food_guard.py`
- Modify: `tests/contract/test_appeal.py`
- Modify: `tests/contract/test_accounting.py`
- Modify: `tests/contract/test_maximum_workflow.py`
- Modify: `tests/contract/test_order_lifecycle.py`

**Interfaces:**
- Consumes: existing `FoodGuard.submit_cure_evidence(order_id: str, envelope_json: str) -> None`, `FoodGuard.appeal(order_id: str, envelope_json: str) -> None`, `_active_evidence_indices`, `_append_evidence`, `Evidence`, typed action enums, resolution, settlement, and accounting invariants.
- Produces: the same public cure/appeal method signatures; canonical batch fields `supersedes_evidence_indices: list[int]` and `statements: list[dict]`; stored batch records with `effective_action == "BATCH_CORRECTION"`; removal of obsolete stored `has_supersedes` and `supersedes_index`; batch-aware active-set and consensus expansion.

- [ ] **Step 1: Write the primary custody-liveness RED test**

Create `tests/contract/test_batch_correction.py` using the existing real contract fixtures and canonical public-source mocks. The first test must be named:

Name the test `test_one_batch_cure_supersedes_three_stale_claims_and_allows_settlement`. Its arrange/act/assert sequence is fixed:

```python
old_indices = [3, 4, 5]
old_count = 6
target_allocations = {
    "customer_wei": 0,
    "restaurant_wei": item_total_wei,
    "courier_wei": delivery_fee_wei,
}

# After the real fixture creates, accepts, packs, picks up, delivers, submits
# three claims, advances time, and receives the first UNRESOLVED result:
food_guard.submit_cure_evidence("fg-batch-1", canonical_batch_json)

assert int(food_guard.get_evidence_count("fg-batch-1")) == old_count + 1
assert food_guard.get_resolution_active_indices("fg-batch-1", 2) == [0, 1, 2, 6]
assert [food_guard.get_evidence("fg-batch-1", index).sha256 for index in old_indices] == old_hashes
assert food_guard.execute_settlement("fg-batch-1") == settlement_id
assert food_guard.get_order_settlement("fg-batch-1") == target_allocations
assert food_guard.get_accounting() == hand_derived_conserved_accounting
assert food_guard.execute_settlement("fg-batch-1") == settlement_id
```

Use the repository's real getter names where their current ABI differs, while keeping the literal indices, one-record history delta, allocations, and idempotency assertions above.

The expected active indices, evidence hashes, allocations, evidence count delta, and accounting values must be hand-derived literals rather than values produced by contract helpers.

- [ ] **Step 2: Run the primary test and record genuine RED**

Run:

```powershell
python -m pytest tests/contract/test_batch_correction.py::test_one_batch_cure_supersedes_three_stale_claims_and_allows_settlement -v
```

Expected: FAIL because the current singular correction schema rejects `supersedes_evidence_indices` and `statements`, leaving the three-record exhaustion path unrecoverable.

- [ ] **Step 3: Add adversarial and retry RED tests before production changes**

Add tests with these exact observable behaviors:

Add tests with these exact names:

- `test_batch_can_replace_an_unavailable_prior_batch_without_recursive_storage`
- `test_mixed_validity_batch_reverts_without_partial_supersession_or_quota_use`
- `test_batch_rejects_empty_oversized_duplicate_unsorted_or_unknown_targets`
- `test_batch_rejects_cross_actor_action_item_and_positional_slot_mismatches`
- `test_batch_rejects_unknown_fields_free_form_facts_outcomes_and_invalid_enums`
- `test_batch_replay_and_already_superseded_targets_are_rejected`
- `test_batch_history_and_flattened_statement_bounds_hold_at_100_items`

Use a literal invalid-case table whose expected result is always `gl.vm.UserError`. The prior-batch case must assert that targeting one active batch carrying three statements accepts exactly three new statements with the same ordered `(effective_action, item_id)` sequence and rejects any reordered sequence.

For the mixed-validity case, snapshot evidence count, active indices, replay usability, cure/appeal quota usability, and every target's superseded state before the call; assert all remain unchanged after `UserError`.

- [ ] **Step 4: Run the complete new test file and confirm feature-specific RED**

Run:

```powershell
python -m pytest tests/contract/test_batch_correction.py -v
```

Expected: every new behavior fails because batch validation/storage/expansion does not exist, not because of fixture import or setup errors.

- [ ] **Step 5: Implement exact batch parsing and preflight validation**

In `contracts/food_guard.py`, replace singular correction parsing with helpers equivalent to these interfaces:

```python
def _typed_statement_slot(self, order_id: str, statement):
    # Validate exact fields and existing bounded enums.
    # Return (effective_action: str, item_id: str).

def _stored_evidence_slots(self, order_id: str, evidence: Evidence):
    # Base record -> [(effective_action, item_id)].
    # CURE/APPEAL batch -> parse its already validated envelope_json and return
    # ordered action/item pairs from statements without recursion.

def _validate_batch_correction(self, order_id: str, envelope, expected_actor: Address):
    # Return (target_indices: list[int], statements: list[dict]) only after
    # exact schema, bounds, active status, actor ownership, positional slot,
    # typed facts, and unknown-field checks all pass.
```

Validation order must be read-only. Require `1 <= len(statements) <= MAX_ACTIVE_EVIDENCE`; require at least one direct target; require strictly increasing integer targets; flatten target slots in target order; require the flattened slot count to equal statement count and not exceed `MAX_ACTIVE_EVIDENCE`; then validate each statement against its corresponding slot.

- [ ] **Step 6: Apply batch storage atomically after preflight**

Update `Evidence` so pre-deployment storage no longer exposes singular supersession fields:

```python
@allow_storage
@dataclass
class Evidence:
    # existing provenance and envelope fields stay unchanged
    effective_action: str  # base action or "BATCH_CORRECTION"
```

After every envelope, digest, replay, quota, history, target, and statement check has passed:

```python
# 1. append one Evidence with action CURE/APPEAL, item_id="",
#    subject order:<order_id>, effective_action="BATCH_CORRECTION"
# 2. mark each direct target key superseded
# 3. consume the replay key
# 4. return, then let submit_cure_evidence/appeal consume their quota key
```

No write may occur before the full preflight completes. Keep the existing public methods and one-submission quotas unchanged.

- [ ] **Step 7: Expand batch statements into safe consensus facts**

Update resolution payload construction so one active batch record contributes its ordered typed statements but only one record-level history index and SHA-256 hash to `evidence_indices` and `evidence_hashes`. The leader and validator must refetch and digest-check the outer batch document independently. Encode statements using only action codes, manifest-derived item indices, criterion indices/kinds, enum codes, integer quantities, and integer timestamps.

Do not copy source URLs, raw actor/issuer IDs, item names, condition prose, substitution prose, `facts`, `prompt`, `outcome`, or `verdict` into the model prompt.

- [ ] **Step 8: Migrate existing contract fixtures to the batch ABI**

Replace every singular CURE/APPEAL envelope in `test_appeal.py`, `test_accounting.py`, and `test_maximum_workflow.py` with a one-target batch:

```json
{
  "supersedes_evidence_indices": [0],
  "statements": [{
    "effective_action": "PACKED",
    "item_observations": []
  }]
}
```

Use the real manifest-length observation list rather than the illustrative empty list. Update the frozen ABI allowlist in `test_order_lifecycle.py` only if the dataclass getter shape is asserted; public method names remain unchanged.

- [ ] **Step 9: Run focused GREEN and the full contract suite**

Run:

```powershell
python -m pytest tests/contract/test_batch_correction.py tests/contract/test_appeal.py tests/contract/test_accounting.py tests/contract/test_maximum_workflow.py -v
python -m pytest -v
```

Expected: all tests pass; the full count is at least the existing 130 plus the new batch regressions.

- [ ] **Step 10: Self-review, write the task report, and commit**

Perform a mutation check for missing target uniqueness, wrong actor, wrong position, partial writes, prompt prose leakage, prior-batch replacement, and settlement conservation. Write the required ignored task report with RED command/output, GREEN command/output, source limitations, and direct-runner consensus/PostMessage limitations. Then commit:

```powershell
git add contracts/food_guard.py tests/contract
git commit -m "fix(contract): add atomic batch evidence correction"
```

---

### Task 2: Batch evidence schema and recovery UI

**Files:**
- Modify: `lib/domain.ts`
- Modify: `lib/evidence.ts`
- Modify: `components/order/EvidenceDrawer.tsx`
- Modify: `components/order/AppealPanel.tsx`
- Modify: `components/order/ItemOutcomeTable.tsx`
- Modify: `app/orders/[id]/page.tsx`
- Modify: `locales/vi.ts`
- Modify: `locales/en.ts`
- Modify: `app/globals.css`
- Modify: `tests/web/evidence.test.ts`
- Modify: `tests/web/order-detail.test.tsx`

**Interfaces:**
- Consumes: Task 1 exact batch ABI and authoritative evidence readback.
- Produces: `CorrectionStatement`, `BatchCorrectionFacts`, exact client-side validation/canonicalization, and a batch editor driven only by authoritative active caller-owned records.

- [ ] **Step 1: Write schema RED tests**

In `tests/web/evidence.test.ts`, add literal fixtures and tests proving:

Use these exact test names and literal expectations:

```typescript
const targetIndices = [3, 4, 5];
const expectedDigest = "0x068241e2ab5daf5e25a9f3073efa43889a9a6d2e035ad520238b28ade8bee95b";

expect(validated.supersedes_evidence_indices).toEqual(targetIndices);
expect(await hashEvidence(canonicalFixture)).toBe(expectedDigest);
expect(() => validateEvidenceDocument(invalidDocument, now)).toThrow(TypeError);
expect(replacement.statements.map(statementSlot)).toEqual([
  ["CUSTOMER_CLAIM", "item-1"],
  ["CUSTOMER_CLAIM", "item-2"],
  ["CUSTOMER_CLAIM", "item-3"],
]);
```

Name the cases `canonicalizes a three-target batch and binds its hand-computed SHA-256`, `rejects malformed batch: %s`, and `revalidates a replacement batch with the same ordered semantic slots`.

Invalid cases must include empty arrays, unequal flattened statement count, duplicate/unsorted targets, floats, unknown keys, outer item/action fields, free-form facts, outcome/verdict/prompt, and malformed action-specific typed facts.

- [ ] **Step 2: Write batch editor RED tests**

In `tests/web/order-detail.test.tsx`, render the real `EvidenceDrawer` and order page with three active customer claim records. Prove that the participant can select all three, must explicitly choose typed facts for each, gets one public canonical document and digest, cannot submit before byte-for-byte source verification, and sends exactly one `submit_cure_evidence` write.

Also prove pending account/chain/prop changes do not mutate the submitted batch, a failed write leaves the editor open, and successful finalized/executed/readback confirmation refreshes authoritative evidence before showing completion.

- [ ] **Step 3: Run focused tests and record genuine RED**

Run:

```powershell
npm test -- --run tests/web/evidence.test.ts tests/web/order-detail.test.tsx
```

Expected: fail on missing batch types, schema validation, selection UI, or write payload; existing unrelated cases remain green.

- [ ] **Step 4: Implement shared exact batch types and validation**

In `lib/domain.ts`, add:

```typescript
export type CorrectionEffectiveAction = "PACKED" | "PICKED_UP" | "DELIVERED" | "CUSTOMER_CLAIM";

export type CorrectionStatement =
  | { effective_action: "PACKED"; item_observations: Array<{
      item_id: string;
      item_status: "AS_ORDERED" | "PERMITTED_SUBSTITUTION" | "ABSENT" | "DIFFERENT" | "UNKNOWN";
      quantity_status: "EXACT" | "SHORT" | "EXCESS" | "UNKNOWN";
      substitution_index: number;
      condition_statuses: Array<{ condition_index: number; status: "MET" | "NOT_MET" | "UNKNOWN" }>;
    }> }
  | { effective_action: "PICKED_UP"; pickup_observation: "PICKUP_CONFIRMED" | "PICKUP_FAILED" | "UNKNOWN" }
  | { effective_action: "DELIVERED"; delivery_observation: "HANDOFF_CONFIRMED" | "HANDOFF_FAILED" | "UNKNOWN" }
  | { effective_action: "CUSTOMER_CLAIM"; item_id: string;
      claim_category: "ABSENT_AT_RECEIPT" | "NOT_AS_ORDERED" | "HANDOFF_NOT_RECEIVED";
      criterion_kind: "ITEM" | "SUBSTITUTION" | "CONDITION" | "QUANTITY" | "DELIVERY";
      criterion_index: number };

export interface BatchCorrectionFacts {
  supersedes_evidence_indices: number[];
  statements: CorrectionStatement[];
}
```

Define `CorrectionStatement` as the exact discriminated union of the existing contract typed schemas. In `lib/evidence.ts`, validate exact keys, safe integers, strictly increasing targets, equal target-slot/statement binding supplied by authoritative records, action/item preservation, canonical JSON, freshness, and SHA-256. Do not duplicate contract enum values in UI components; export the shared bounded sets or typed option arrays from the evidence module.

- [ ] **Step 5: Implement authoritative batch selection and construction**

Extend `EvidenceDrawer` with an exact prop:

```typescript
interface EvidenceDrawerProps {
  // existing props
  correctableEvidence?: EvidenceRecordView[];
}
```

For `CURE`/`APPEAL`, show only active records whose normalized `actor_wallet` equals the connected participant. When a selected target is an earlier batch, flatten its validated `statements` for editing. Sort direct target indices ascending and render statements in the contract's positional order.

Require explicit action-specific inputs for every statement. Do not reuse an old affirmative value as a selected default. Build an order-level subject, omit outer `item_id`, publish one canonical preimage, calculate one SHA-256, verify exact fetched bytes, and pass one envelope JSON string to the existing write handler.

- [ ] **Step 6: Integrate readback, localization, and responsive states**

In `app/orders/[id]/page.tsx`, derive active evidence from authoritative records plus the latest active indices/digest, pass it into the drawer, and keep the old order snapshot visible until transaction tracking and fresh enriched readback succeed. `AppealPanel` must report batch quota use from authoritative CURE/APPEAL records without counting superseded history as a new local action.

Add concise Vietnamese-default and English copy for target selection, selected count, explicit facts, prior batch replacement, atomic submission, and recovery errors. Add responsive styles that preserve at least 44px interactive targets and no horizontal overflow at 375px.

- [ ] **Step 7: Run focused and full web GREEN checks**

Run:

```powershell
npm test -- --run tests/web/evidence.test.ts tests/web/order-detail.test.tsx
npm test -- --run tests/web
npx eslint lib/evidence.ts lib/domain.ts components/order/EvidenceDrawer.tsx components/order/AppealPanel.tsx components/order/ItemOutcomeTable.tsx 'app/orders/[id]/page.tsx' locales/vi.ts locales/en.ts
npx tsc --noEmit
```

Expected: focused and full web tests pass, lint exits 0, and TypeScript exits 0.

- [ ] **Step 8: Self-review, write the task report, and commit**

Mutation-check wrong active indices, a different connected wallet, item/action reordering, source byte mismatch, expiry at the exact boundary, account change while pending, failed tracking, and stale readback. Write the ignored report with RED/GREEN evidence and commit:

```powershell
git add lib components/order 'app/orders/[id]/page.tsx' locales app/globals.css tests/web
git commit -m "feat(web): build atomic batch correction recovery"
```

---

### Task 3: Fixed fixtures, browser recovery proof, and pre-deployment verification

**Files:**
- Create: `public/evidence/order-fg-demo-cure-batch.json`
- Modify: `tests/e2e/support/foodguard-fixture.ts`
- Modify: `tests/e2e/order-unresolved.spec.ts`
- Modify: `tests/web/evidence.test.ts`
- Modify: `README.md`
- Modify: `docs/recovery-runbook.md`
- Modify: `docs/verification/proof-matrix.md`
- Modify: `deploy/studionet-manifest.example.json`

**Interfaces:**
- Consumes: Task 1 contract schema and Task 2 UI.
- Produces: immutable LF-normalized canonical batch fixture with pinned digest, deterministic local-only browser evidence for the three-claim recovery path, refreshed pre-deployment documentation and manifest hashes.

- [ ] **Step 1: Write fixture and E2E RED tests**

Add a fixture test that expects `public/evidence/order-fg-demo-cure-batch.json`, validates it through the real shared schema, checks its literal pinned SHA-256, asserts canonical bytes plus one LF in both index and worktree, and verifies its target indices/statements against the existing demo order.

Add a Playwright scenario named:

Name the Playwright scenario `three stale customer claims recover through one atomic batch cure`. Its final assertions must be:

```typescript
await expect(page.getByText("3 evidence selected")).toBeVisible();
await expect(page.getByTestId("transaction-finality")).toContainText("FINALIZED");
await expect(page.getByTestId("transaction-execution")).toContainText("SUCCESS");
await expect(page.getByTestId("transaction-readback")).toContainText("CONFIRMED");
await expect(page.getByTestId("active-evidence-indices")).toHaveText("0, 1, 2, 6");
expect(fixture.walletWrites).toEqual([
  { method: "submit_cure_evidence", args: ["fg-batch-1", expectedEnvelopeJson] },
]);
```

Use locale-specific selectors if the visible copy is Vietnamese, while preserving the raw transaction enums and literal active indices.

The deterministic RPC fixture must expose three active claim records, an `EVIDENCE_CURE` order, successful batch write tracking, and fresh readback with all three old indices absent and the batch index active.

- [ ] **Step 2: Run fixture and E2E RED**

Run:

```powershell
npm test -- --run tests/web/evidence.test.ts
npm run test:e2e -- tests/e2e/order-unresolved.spec.ts
```

Expected: fixture test fails because the batch file is absent and E2E fails because the local RPC/UI path does not yet provide the batch recovery scenario.

- [ ] **Step 3: Add the canonical public fixture and deterministic browser flow**

Create the batch JSON through the same canonicalization rules used by contract and web code, calculate its actual lowercase `0x` SHA-256, and preserve `.gitattributes` `text eol=lf` behavior. Update the RPC/wallet double with the complete real decoded shapes for evidence records, resolution active indices/hashes, transaction finality, execution result, and post-write order readback.

The browser test must assert three selected targets, no preselected affirmative facts, exact public-source verification, one wallet request for `submit_cure_evidence`, distinct finality/execution/readback stages, and the authoritative post-write active set. Label it local deterministic evidence, not StudioNet proof.

- [ ] **Step 4: Refresh human documentation without deployment claims**

Update README, recovery runbook, proof matrix, and non-deployable example manifest to document the batch ABI, one-history-slot behavior, prior-batch replacement, three-record recovery, and unchanged quotas/caps. Put the actual post-contract-change SHA-256 in the example manifest's source field; keep its Git commit empty because a commit cannot truthfully contain its own hash. Keep deployment address, transaction, explorer, wallet, and Vercel URL empty until real action-time deployment.

Do not add a token, wallet address, fabricated transaction, placeholder contract address, or claim of live StudioNet verification.

- [ ] **Step 5: Run full repository verification**

Run from the worktree:

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

Expected: contract count exceeds 130, web count exceeds 227, E2E count exceeds 9, all commands exit 0, generated Next/Playwright drift is removed without touching user files, and status contains only intended Task 3 files before commit.

- [ ] **Step 6: Self-review, write the task report, and commit**

Review the fixed fixture bytes, source hash, contract/frontend schema parity, proof wording, and secret scan scope. Write the ignored report with exact command outputs and known live limitations. Commit:

```powershell
git add public/evidence tests/e2e tests/web/evidence.test.ts README.md docs deploy/studionet-manifest.example.json
git commit -m "test: prove multi-record FoodGuard recovery"
```

---

## Final Review and Deployment Readiness Gate

After Tasks 1–3 receive clean task-scoped reviews:

1. Generate a review package from plan base `bdd3e1f` through final `HEAD`.
2. Dispatch one most-capable whole-follow-up reviewer against this plan, its spec, ledger, reports, and full diff.
3. If Critical/Important findings exist, allow one final fix wave and one scoped re-review exactly as required by Subagent-Driven Development.
4. Re-run the full verification commands on the reviewed commit.
5. Recompute and record exact Git commit and contract source SHA-256.
6. If and only if review is clean, return to Task 12's action-time gates and ask the user to confirm the exact StudioNet deployment wallet. GitHub and Vercel remain separate later confirmations.
