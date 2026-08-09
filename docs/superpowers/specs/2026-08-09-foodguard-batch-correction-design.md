# FoodGuard Batch Correction Design

**Status:** Approved approach; written specification awaiting user review

**Contract classification:** `INTENTIONALLY_FROZEN`

**Scope:** Remove the multi-record cure exhaustion custody-liveness defect before StudioNet deployment.

## Problem

FoodGuard stores evidence as append-only records. A corrective `CURE` or `APPEAL` record currently supersedes exactly one active record, while each participant may submit only one cure per resolution round and one appeal. If three or more independently stale records belong to the same participant, cure plus the single escalated retry cannot replace every stale record. At least one stale record can therefore remain active forever, every later resolution can remain `UNRESOLVED`, and the escrow can become permanently locked.

This is a pre-deployment source defect. No StudioNet or Vercel deployment may proceed until the regression is fixed and reviewed.

## Decision

Replace single-record corrective evidence with an atomic batch correction document. One `CURE` or `APPEAL` submission may supersede multiple exact active records owned by the submitting participant and provide a positionally bound typed replacement statement for every semantic slot contained by those records.

The contract continues to allow only one cure submission per role and resolution round, and only one appeal per role. The batch makes that single submission sufficient to replace every correctable active record for the role.

## Alternatives Rejected

### Multiple independent cure transactions

Allowing one transaction per stale record is simpler locally, but increases wallet prompts, permits partial completion, and can exceed the append-only history bound. It does not provide a strong atomic recovery guarantee.

### Ignore expired records or refund automatically

Silently removing expired evidence lets a participant erase unfavorable evidence by choosing a short expiry. Automatically refunding after evidence failure also assigns a favorable outcome without GenLayer establishing the delivery facts. Both weaken the trust model.

## Trust and Consequence

| Actor | Cannot trust | Manipulation capability | Contract defense | Required proof |
|---|---|---|---|---|
| Customer | Restaurant and courier | Submit several claims, short-lived URLs, mismatched item corrections | Batch indices must be active, customer-owned, unique, ordered, and exactly item/action-bound | Three independently stale customer claims are atomically superseded and resolution can progress |
| Restaurant | Customer and courier | Replace another actor's evidence or change the corrected action | Every target actor must equal the caller; typed facts must match the target action and manifest | Cross-actor and action-mismatch batches revert without mutation |
| Courier | Customer and restaurant | Replace order-level delivery evidence with unrelated facts | Order-level subject and exact pickup/delivery typed schemas | Mixed valid/invalid batch reverts atomically |
| Frontend | All participants | Omit active records, reorder targets, or construct favorable free-form facts | Contract validates the complete canonical document; outcome fields and free-form prompts remain forbidden | Contract tests pass against hand-built canonical envelopes independent of UI helpers |
| Evidence host | Submitter and validators | Return unavailable or altered bytes | Public HTTPS URL, canonical SHA-256, freshness, replay domain, leader/validator refetch | Byte mismatch and stale/unavailable sources stay `UNRESOLVED` |

**Decision established by GenLayer:** for every order item and the delivery fee, whether the active, bound evidence proves the ordered condition and delivery outcome.

**On-chain consequence:** the existing resolution and settlement rules allocate the reserved item and delivery amounts exactly once. Batch correction changes only which append-only evidence records form the active set; it cannot directly select an outcome or transfer value.

## Canonical Batch Envelope

`CURE` and `APPEAL` use the existing `foodguard-evidence/1` envelope before the first frozen deployment, but replace the singular `effective_action`, `supersedes_evidence_index`, optional outer `item_id`, and outer typed-fact fields with two required arrays: `supersedes_evidence_indices` and `statements`.

The outer document remains bound to:

- exact order ID and order-level subject `order:<order_id>`;
- caller wallet, issuer, chain ID, contract address, action, nonce, timestamps, public HTTPS source URL, and canonical SHA-256;
- the existing replay key `(chain, contract, order, action, actor, nonce)`.

`supersedes_evidence_indices` is a strictly increasing list of active append-only history indices. A target base record contributes one semantic slot `(effective_action, item_id)`. A target batch record contributes the ordered semantic slots already stored in its `statements` array. This lets a later cure replace an unavailable earlier batch as one active record without losing any of its underlying action/item bindings.

`statements` contains exactly one positionally corresponding replacement for every flattened target slot. Each statement is an exact object containing:

- `effective_action`: one of `PACKED`, `PICKED_UP`, `DELIVERED`, or `CUSTOMER_CLAIM`;
- `item_id` only when `effective_action` is `CUSTOMER_CLAIM`;
- the exact typed fact fields already required for that effective action.

Example with three customer claims:

```json
{
  "action": "CURE",
  "actor_wallet": "0x1111111111111111111111111111111111111111",
  "chain_id": "61999",
  "contract_address": "0x2222222222222222222222222222222222222222",
  "statements": [
    {
      "claim_category": "ABSENT_AT_RECEIPT",
      "criterion_index": 0,
      "criterion_kind": "ITEM",
      "effective_action": "CUSTOMER_CLAIM",
      "item_id": "item-1"
    },
    {
      "claim_category": "NOT_AS_ORDERED",
      "criterion_index": 0,
      "criterion_kind": "QUANTITY",
      "effective_action": "CUSTOMER_CLAIM",
      "item_id": "item-2"
    },
    {
      "claim_category": "HANDOFF_NOT_RECEIVED",
      "criterion_index": -1,
      "criterion_kind": "DELIVERY",
      "effective_action": "CUSTOMER_CLAIM",
      "item_id": "item-3"
    }
  ],
  "expires_at": "2030-01-02T00:00:00.000Z",
  "issuer_id": "foodguard-web",
  "nonce": "batch-cure-1",
  "observed_at": "2030-01-01T00:00:00.000Z",
  "order_id": "fg-1",
  "schema_version": "foodguard-evidence/1",
  "sha256": "0x068241e2ab5daf5e25a9f3073efa43889a9a6d2e035ad520238b28ade8bee95b",
  "source_url": "https://evidence.foodguard.app/fg-1/batch-cure-1.json",
  "subject": "order:fg-1",
  "supersedes_evidence_indices": [3, 4, 5],
  "submitted_at": "2030-01-01T00:00:00.000Z"
}
```

The displayed digest is the actual SHA-256 of the canonical example preimage with the `sha256` field omitted.

## Contract Validation and Atomicity

The contract validates the complete batch before appending the new record or writing any supersession key.

The two arrays must:

- contain at least one target and at most `MAX_ACTIVE_EVIDENCE` flattened statements;
- use strictly increasing target indices, which guarantees uniqueness and deterministic flattening;
- target records that exist, are active, and have not already been superseded;
- target only records whose actor wallet equals the caller;
- give every flattened target slot exactly one statement in the same position;
- preserve every slot's effective action and item ID exactly;
- use the exact typed schema and bounded enums for that effective action;
- contain no outcome, verdict, prompt, narrative facts, unknown keys, floats, or non-JSON values.

If any entry fails, the entire transaction raises `UserError`. Evidence count, replay keys, cure/appeal quota keys, active evidence, and supersession keys remain unchanged.

On success, the contract appends one batch evidence record, then marks every direct target record superseded. The batch record becomes active. Replacing `N` direct records therefore changes the active record count by `1 - N` and the history count by exactly `1`. Its stored `effective_action` is the contract-only marker `BATCH_CORRECTION`; semantic resolution always reads the validated `statements` array. The obsolete singular `has_supersedes` and `supersedes_index` storage fields are removed before deployment.

The existing history bound remains `MAX_EVIDENCE_HISTORY = 112`. The existing active bound remains `MAX_ACTIVE_EVIDENCE = 103`. A batch consumes one history slot regardless of its correction count, preserving the already tested maximum workflow.

## Consensus Input

The batch's public document is fetched and hash-checked exactly like every other evidence record. Contract-generated prompt input expands `statements` into typed correction facts for semantic evaluation while retaining one append-only history index and one evidence hash for the batch document.

Prompt input must contain only contract-generated numeric indices, enum codes, quantities, and timestamps. It must not contain raw item names, conditions, substitutions, participant prose, source URLs, issuer text, verdicts, requested outcomes, or arbitrary prompt fields.

Leader and validator independently refetch the same batch source and validate its canonical digest. Unavailable, stale, contradictory, or hash-mismatched batch evidence produces `UNRESOLVED`; it never defaults to approval or payout.

## Frontend Behavior

When cure or appeal is available, the order page reads the authoritative append-only evidence list and derives the active, caller-owned records eligible for correction.

The batch editor:

- shows each eligible record with its action, item, history index, and expiry status;
- allows selecting one or more records, including all eligible stale records;
- requires explicit typed observations for every flattened target slot and never preselects an affirmative fact;
- builds one order-level canonical public document and one contract envelope;
- verifies the public URL byte-for-byte before enabling submission;
- freezes the complete batch while the wallet operation is pending;
- shows finality, execution, and authoritative readback separately;
- keeps the editor open on failure and refreshes from contract state after successful readback.

The UI never infers that a record was superseded from local state. It waits for authoritative evidence readback and the active evidence indices of the next resolution round.

Vietnamese remains the default locale and English remains available. Raw contract enums and hashes stay untranslated.

## Recovery Flow

1. Resolution returns `UNRESOLVED` and opens `EVIDENCE_CURE`.
2. An affected participant selects every stale or incorrect active record they own.
3. The participant publishes one fresh canonical batch document and submits its URL-bound envelope.
4. The contract atomically appends the batch and supersedes all targets.
5. After the cure deadline, anyone may call `request_resolution`.
6. GenLayer evaluates the new active set. A resolved result follows the existing appeal and settlement flow.
7. If evidence remains insufficient, the existing `ESCALATED` retry and unanimous mutual-settlement fallback remain available. Batch correction itself does not add a new payout rule.

## Test Design

The primary regression creates at least three independently expiring customer claims, lets all three become unusable to the resolver, reaches `EVIDENCE_CURE`, submits one fresh three-statement batch, and proves:

- all three old records remain readable in history but are absent from the active set;
- the one batch record is active and bound to its exact public URL and digest;
- the next resolution no longer consumes any stale source;
- the order can reach a normal resolved/settled terminal state or the already-defined deterministic allocation path;
- reserved and completed accounting remain conserved and settlement remains one-time.

A second regression makes the first batch source unavailable, enters the allowed retry path, replaces that active batch with a new batch carrying the same ordered semantic slots, and proves that recovery remains possible without recursive or unbounded storage.

Adversarial tests cover empty, oversized, duplicate, unsorted, nonexistent, already-superseded, cross-actor, action-mismatched, item-mismatched, malformed typed-fact, unknown-field, replayed, stale, private-URL, and mixed-validity batches. At least one test snapshots storage before a mixed-validity failure and proves no partial supersession or quota consumption.

Frontend tests cover batch selection, explicit typed facts, canonical digest, public-source verification, pending-state freeze, failed-write recovery, and authoritative readback. Browser E2E covers the three-claim cure path with deterministic local wallet/RPC doubles and is labeled non-live. Full contract, web, E2E, lint, TypeScript, production build, secret scan, and scoped independent review are required before returning to deployment confirmation.

## Deployment Gate

This follow-up changes pre-deployment source and evidence ABI. The frozen contract must not be deployed from an earlier commit. After the fix passes review, the deployment manifest, source hash, fixture hashes, README, recovery runbook, and proof matrix must be regenerated from the reviewed commit.

StudioNet deployment, GitHub push, and Vercel deployment each remain separate action-time confirmation gates. No wallet, repository, Vercel team, token, contract address, transaction, or live proof may be assumed from this approval.
