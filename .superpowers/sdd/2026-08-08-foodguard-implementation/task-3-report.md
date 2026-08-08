# Task 3 Report: Append-only Evidence Workflow

## Status

Implemented the Task 3 append-only evidence workflow on top of the reviewed payable lifecycle. The contract now accepts role-authorized packing, pickup, delivery, and customer-claim evidence; binds every envelope to the actual transaction chain and contract; appends immutable history; rejects replay; and performs only the Task 3 state transitions.

Task 5's `submit_cure_evidence` was not implemented. Replay coverage uses a duplicate `submit_claim_evidence` call while the order remains in `REVIEW_WINDOW`.

## Files

- `contracts/food_guard.py`
  - Added the storage-safe `Evidence` record.
  - Added append-only evidence storage, per-order counts, replay keys, and one-base-claim-per-item tracking.
  - Added `_append_evidence(order_id, expected_action, envelope_json, expected_actor)`.
  - Added `submit_packed_evidence`, `submit_pickup_evidence`, `submit_delivery_evidence`, and `submit_claim_evidence`.
  - Added `get_evidence` and `get_evidence_count`.
- `tests/contract/test_evidence.py`
  - Added 21 focused cases for transitions, actor authorization, envelope binding, freshness, digest binding, history, claims, and replay.
- `tests/contract/test_order_lifecycle.py`
  - Updated the intentionally frozen public ABI assertion to include only the Task 3 public methods.

## Trusted context evidence

The pinned v0.2.16 GenLayer SDK exposes both required values on `gl.message`:

- `gl.message.chain_id: u256`
- `gl.message.contract_address: Address`

The installed genlayer-test 0.29.2 direct VM supplies these from its transaction message (`VMContext._chain_id` and the deployed contract address). `_append_evidence` compares the caller-provided envelope values to these actual context values. It does not accept an unverified contract identity.

The replay digest uses exactly these seven ordered fields and no others:

`chain_id | contract_address | order_id | item_id | action | actor_wallet | nonce`

The ordered tuple is canonicalized as JSON before SHA-256 so delimiters inside IDs cannot create ambiguous preimages.

## RED evidence

Initial focused RED:

```text
python -m pytest tests/contract/test_evidence.py -v
collected 16 items
11 failed, 5 errors
Expected cause: FoodGuard had no submit_packed_evidence or related evidence APIs.
```

Authorization/actor mutation RED during self-review:

```text
python -m pytest tests/contract/test_evidence.py -k "wrong_wallet or another_actor" -v
5 selected
4 failed, 1 passed
Expected cause: removing courier pickup, courier delivery, customer claim, and envelope actor guards allowed the forbidden calls.
```

Freshness boundary RED:

```text
python -m pytest tests/contract/test_evidence.py::test_accepts_evidence_submitted_in_the_past_while_it_remains_unexpired -v
1 failed
Expected cause: the first implementation incorrectly treated any past submitted_at value as stale.
```

## GREEN evidence

Focused evidence suite after the final freshness correction:

```text
python -m pytest tests/contract/test_evidence.py -v
21 passed in 0.57s
```

Fresh full contract suite immediately before reporting:

```text
python -m pytest -v
61 passed in 1.38s
```

This includes all 40 reviewed Task 2 lifecycle cases and all 21 Task 3 evidence cases.

## Behavior and validation

- `ACCEPTED -> READY_FOR_PICKUP` is restaurant-only and requires `PACKED` evidence.
- `READY_FOR_PICKUP -> IN_TRANSIT` is assigned-courier-only and requires `PICKED_UP` evidence.
- `IN_TRANSIT -> REVIEW_WINDOW` is assigned-courier-only and requires `DELIVERED` evidence.
- Customer claims append during `REVIEW_WINDOW`, remain in `REVIEW_WINDOW`, require a manifest item, and are strictly before `review_deadline`.
- Canonical envelope JSON and its digest-free SHA-256 preimage are verified before append.
- Order, subject, action, actor wallet, chain ID, contract address, schema, item membership, and timestamp ordering are bound independently.
- Timestamp freshness is `observed_at <= submitted_at <= transaction_time <= expires_at`; expired evidence is stale and evidence claiming submission after the transaction is future evidence.
- Replay is checked before the per-item base-claim uniqueness rule, so the duplicate same-action claim test proves true replay rejection rather than failing on a different precondition.
- Evidence count and indexed records are only appended; no replacement method exists.

## Self-review

- Scope: confirmed no cure, resolution, appeal, payout, or future-task method was added.
- Authorization: mutation-tested all four submitting roles plus envelope actor binding.
- Failure isolation: separate tests cover invalid transition, wrong action, wrong subject, wrong order, wrong actor, wrong chain/contract, stale evidence, future evidence, digest mismatch, unknown item, duplicate base claim, and true replay.
- Replay domain: confirmed it contains exactly the required seven components and uses trusted context for chain and contract.
- State safety: rejected calls assert unchanged state and unchanged evidence counts.
- ABI: lifecycle ABI test includes the six Task 3 public additions and continues to reject privileged escape hatches.
- Diff hygiene: no unrelated application code was changed.

## Concerns

- genlayer-test emits its existing warning that `gltest.config.yaml` is absent and uses localnet defaults; it does not affect direct-mode verification.
- Task 3 validates the committed envelope digest. Independent retrieval of `source_url` and comparison with fetched public evidence remains correctly deferred to Task 4 consensus work.
- A previously submitted but unexpired envelope is accepted; clients must still ensure its `expires_at` covers the eventual on-chain transaction time.
