# FoodGuard — Contract-first Food Delivery Escrow

Date: 2026-08-08  
Status: Approved design, awaiting written-spec review  
Target network: GenLayer StudioNet  
Contract classification: `INTENTIONALLY_FROZEN`

## 1. Product statement

FoodGuard is a three-party food-delivery marketplace in which a customer funds an order, a restaurant prepares item-level deliverables, and a courier carries the order. A GenLayer Intelligent Contract independently evaluates public, hash-bound evidence and settles each menu item plus the delivery fee.

The web experience uses the approved **Proof Marketplace** visual direction: familiar food discovery and ordering patterns with an explicit evidence, consensus, and escrow layer. The interface is bilingual, with Vietnamese as the default and English available as a toggle.

StudioNet GEN is simulated value. The UI, README, and evidence package must never describe it as real money or production settlement.

## 2. Scope

### In scope

- Three wallet roles: customer, restaurant, and courier.
- A static demo catalog plus support for public evidence URLs.
- One payable Intelligent Contract as the authority for order state, evidence commitments, item outcomes, custody, and settlement.
- Item-level restaurant payouts or customer refunds.
- A separately accounted delivery fee.
- Evidence cure, one appeal, retry, escalation, and mutually signed fallback settlement.
- Responsive bilingual web UI deployed to Vercel after action-time confirmation.
- Direct-mode contract tests, frontend tests, browser tests, and live StudioNet verification.

### Out of scope for V1

- Real fiat or production-value settlement.
- Private medical, identity, address, or payment data in public evidence.
- A persistent marketplace database, account/password system, chat, ratings, promotions engine, or restaurant onboarding portal.
- Cross-chain bridging.
- Arbitrary owner verdicts, admin withdrawals, or hidden upgrades.
- Automatic terminal allocation when consensus remains insufficient.

## 3. Actors and trust model

| Actor | Cannot trust | Can manipulate | Contract defense | Required test/evidence |
|---|---|---|---|---|
| Customer | Restaurant and courier | False claim, unrelated evidence URL, replayed evidence | Wallet authorization, action-scoped evidence commitment, freshness, nonce, cross-evidence comparison | Unauthorized claim, wrong subject, replay rejection |
| Restaurant | Customer and courier | Mutable manifest, misleading packaging proof | Manifest locks on order creation; packaging evidence is append-only and hash-bound | Manifest immutability and hash mismatch tests |
| Courier | Customer and restaurant | False pickup/delivery proof, timestamp manipulation | Wallet binding, order/action replay domain, on-chain submission time, evidence comparison | Wrong courier, stale proof, duplicate delivery tests |
| Vercel/operator | All parties | Change catalog or URL contents, compute a desired verdict off-chain | Contract checks committed hash and schema; Intelligent Contract derives outcome; no verdict input method | Modified content becomes unresolved; no admin verdict path |
| Validator leader | Other validators | Propose an incorrect structured result | Validators fetch the same evidence and independently derive stable decision fields | Dissent and malicious-leader tests |
| Contract deployer | Users | Pause service, attempt withdrawal or outcome override | Pause affects new orders only; no withdrawal, upgrade, or verdict methods | Existing-order liveness during pause; interface audit |
| Unrelated caller | Participants | Spam resolution or settlement | Permissionless calls are allowed only when preconditions hold and are idempotent | Third-party trigger proof and replay tests |

No frontend, backend, caller, owner, restaurant, courier, or customer can directly select an item outcome.

## 4. Decision and consequence

### Decision statement

For each item, GenLayer establishes whether the public evidence proves that the restaurant prepared the item according to the locked manifest and the courier delivered it under the agreed delivery conditions.

Stable item decision fields are:

- `MATCHED`: correct item, committed attributes and quantity, with valid delivery evidence.
- `MISSING`: the item or required quantity is absent.
- `MISMATCHED`: the delivered item conflicts with committed attributes.
- `DELIVERY_FAILED`: valid delivery evidence is absent or establishes non-delivery.
- `UNRESOLVED`: validators agree that evidence is inaccessible, malformed, stale, hash-mismatched, contradictory, or insufficient.

An actual network consensus failure cannot mutate contract storage. In that case the contract stays in its prior state, reserved value does not move, and the UI presents `CONSENSUS_FAILED / UNRESOLVED` with a permissionless retry action.

Delivery-fee decisions are `DELIVERED`, `DELIVERY_FAILED`, or `UNRESOLVED` and are evaluated independently from restaurant item quality.

### Consequence statement

- `MATCHED` moves the item's reserved amount to a restaurant payout.
- `MISSING`, `MISMATCHED`, or `DELIVERY_FAILED` moves the item's reserved amount to a customer refund.
- Delivery fee `DELIVERED` moves the reserved delivery fee to the courier.
- Delivery fee `DELIVERY_FAILED` moves the fee to a customer refund.
- `UNRESOLVED` moves no value and opens the evidence-cure branch.
- A second unresolved evaluation enters `ESCALATED`; value stays reserved until a valid retry or a matching multi-party settlement proposal succeeds.

## 5. Evidence model

Evidence is public JSON referenced by URL and committed by SHA-256. The canonical representation uses UTF-8 JSON with object keys sorted, no insignificant whitespace, integers represented as decimal numbers, and no floating-point amounts. Amounts are integer wei strings in evidence and `u256` in contract storage.

Each evidence record includes:

- `order_id` and optional `item_id`.
- `action`: `ORDER_MANIFEST`, `PACKED`, `PICKED_UP`, `DELIVERED`, `CUSTOMER_CLAIM`, `CURE`, or `APPEAL`.
- `actor_wallet` and `issuer_id`.
- `source_url` and `sha256`.
- `schema_version`, initially `foodguard-evidence/1`.
- `observed_at`, on-chain `submitted_at`, and `expires_at`.
- `chain_id`, deployed `contract_address`, and unique `nonce`.

The replay domain is:

`chain_id | contract_address | order_id | item_id | action | actor_wallet | nonce`

The manifest identifies every item by stable item ID, normalized name, quantity, permitted substitutions, price, and any explicit condition the evidence can reasonably prove. Open-ended food-quality claims such as “tastes good” are not settlement criteria.

Validators must:

1. Fetch the same public source independently.
2. Canonicalize and check the committed digest.
3. Validate subject, actor, schema version, timestamps, freshness, and replay domain.
4. Extract programmatically checkable facts before LLM judgment.
5. Independently derive structured decision fields.
6. Compare the stable fields rather than exact explanations or raw pages.

Unavailable or invalid evidence never becomes approval, payout, or refund by default. It becomes `UNRESOLVED`.

Validator disagreement that prevents transaction consensus leaves storage unchanged. It is an unresolved transaction condition, not a stored item verdict; retry is safe because no resolution round or allocation was committed.

## 6. State machine

### Order states

`FUNDED`, `PARTIALLY_ACCEPTED`, `ACCEPTED`, `READY_FOR_PICKUP`, `IN_TRANSIT`, `REVIEW_WINDOW`, `RESOLVING`, `EVIDENCE_CURE`, `RESOLVED`, `APPEALED`, `ESCALATED`, `SETTLED`, `CANCELLED_REFUNDED`.

### Main transitions

| From | Actor | Method | Preconditions | On-chain effect | To | Replay behavior |
|---|---|---|---|---|---|---|
| — | Customer | `create_order` payable | Three distinct nonzero wallets; valid future deadlines; exact value equals item subtotal plus fee | Stores locked manifest and reserves value | `FUNDED` | Duplicate order ID rejected |
| `FUNDED`/`PARTIALLY_ACCEPTED` | Restaurant | `accept_restaurant` | Sender is restaurant; before acceptance deadline | Records acceptance | `PARTIALLY_ACCEPTED` or `ACCEPTED` | Duplicate rejected |
| `FUNDED`/`PARTIALLY_ACCEPTED` | Courier | `accept_courier` | Sender is courier; before acceptance deadline | Records acceptance | `PARTIALLY_ACCEPTED` or `ACCEPTED` | Duplicate rejected |
| `FUNDED`/`PARTIALLY_ACCEPTED` | Customer before any acceptance; anyone after timeout | `cancel_unaccepted` | Before the deadline, neither restaurant nor courier has accepted; after the deadline, both acceptances were not recorded | Queues full refund and invalidates any partial acceptance | `CANCELLED_REFUNDED` | Idempotent no-op/readback after completion |
| `ACCEPTED` | Restaurant | `submit_packed_evidence` | Authorized, fresh, unused nonce | Appends evidence | `READY_FOR_PICKUP` | Duplicate nonce rejected |
| `READY_FOR_PICKUP` | Courier | `submit_pickup_evidence` | Authorized, fresh, unused nonce | Appends evidence | `IN_TRANSIT` | Duplicate nonce rejected |
| `IN_TRANSIT` | Courier | `submit_delivery_evidence` | Authorized, fresh, unused nonce | Appends evidence and opens fixed review window | `REVIEW_WINDOW` | Duplicate nonce rejected |
| `REVIEW_WINDOW` | Customer | `submit_claim_evidence` | Before review deadline; item IDs belong to order | Appends claim; does not set outcome | `REVIEW_WINDOW` | One base claim per item; cure is versioned |
| `REVIEW_WINDOW`/`EVIDENCE_CURE`/`APPEALED` | Any address | `request_resolution` | Relevant deadline reached; no resolution in flight | Runs evidence-grounded consensus | `RESOLVED`, `EVIDENCE_CURE`, or `ESCALATED` | In-flight and completed round rejected |
| `EVIDENCE_CURE` | Authorized actor | `submit_cure_evidence` | Cure window open; one appended cure version per actor/action | Adds evidence without replacing history | `EVIDENCE_CURE` | Duplicate/replacement rejected |
| `RESOLVED` | Affected actor | `appeal` | Appeal window open; actor affected by at least one decision; no prior appeal | Freezes settlement and appends appeal evidence | `APPEALED` | Second appeal rejected |
| `RESOLVED` | Any address | `execute_settlement` | Appeal window expired; amounts conserved; not executed | Moves each reserve once, stores settlement ID, and emits finalized transfers | `SETTLED` | Subsequent call returns existing settlement ID without transfers |
| `ESCALATED` | Affected parties | `propose_mutual_settlement` / `sign_mutual_settlement` | Proposal conserves all reserved value; customer, restaurant, and courier sign the identical digest | Stores the agreed allocation and emits finalized transfers | `SETTLED` | Digest and signature replay rejected |

Timeouts do not manufacture an AI verdict. They only enable the next explicitly defined transition.

## 7. Custody and accounting

`create_order` is payable and requires the exact item subtotal plus delivery fee. There is no platform fee in V1.

The contract tracks:

- `total_inflows`.
- `reserved_items`.
- `reserved_delivery`.
- `restaurant_payouts_emitted`.
- `courier_payouts_emitted`.
- `customer_refunds_emitted`.

Conservation invariant:

`total_inflows = reserved_items + reserved_delivery + restaurant_payouts_emitted + courier_payouts_emitted + customer_refunds_emitted`

For each order, the sum of all item allocations plus the delivery-fee allocation must equal the original order deposit. Each reserve has a `settled` flag and immutable settlement ID. A transfer is emitted only once, after all deterministic solvency and conservation checks pass, using finalized external messages.

`SETTLED` records the contract's finalized allocation and one-time transfer emission. The UI must still show transaction finality, execution result, and post-execution readback separately. It must not interpret `FINALIZED` alone as a successful payout.

## 8. Contract recoverability

FoodGuard V1 is `INTENTIONALLY_FROZEN`.

- There is no upgrade method, proxy, arbitrary delegate, owner withdrawal, or verdict override.
- A deployer-controlled emergency pause may block only new order creation.
- The pause cannot block evidence, resolution, appeal, retry, mutual settlement, refund, or settlement for existing orders.
- Deployment records the exact source hash and immutable configuration.
- A defective V1 is replaced by deploying V2 at a new address.
- Existing V1 orders are resolved under V1 rules. If they remain escalated, affected parties can use the matching multi-party settlement path.

The recovery runbook must document pause, evidence export, active-order audit, V2 deployment, frontend migration, and V1 read-only preservation.

## 9. Frontend architecture

The application is a Next.js TypeScript project designed for Vercel. The Intelligent Contract is the source of truth. The frontend may cache reads but may not advance its local workflow ahead of contract readback.

### Pages

- Landing and Explore: image-led hero, search, category chips, and proof-ready restaurant cards.
- Create Order: cart, actor wallet selection, manifest preview, canonical hash preview, and payable wallet transaction.
- Role Console: actions derived from the connected wallet and authoritative state.
- Order Detail: lifecycle timeline, item outcome table, reserved-value breakdown, and live consensus.
- Evidence Drawer: source, digest, subject, issuer, version, freshness, and validation status.
- Resolution and Appeal: structured outcome, rationale, cited evidence, countdowns, cure, and appeal controls.
- Proof Page: contract, source hash, transaction identifiers, finality, execution result, and readback.

### UX rules

- Vietnamese is default; English is available without changing on-chain fields.
- Contract methods, enums, prompts, tests, and primary README technical language are English.
- Every write shows wallet confirmation, submission, consensus progress, `FINALIZED`, execution `SUCCESS` or error, and readback as distinct stages.
- Disabled actions explain the failed precondition.
- Wrong-network and wrong-role states offer a clear recovery action.
- The interface is responsive, keyboard accessible, and does not rely on color alone.

### Off-chain content

The demo catalog and reference evidence are versioned static JSON files. User-supplied evidence must be public. Vercel stores no participant private keys. No backend computes or submits a final verdict.

The real contract address is added only after deployment. There is no contract-address placeholder in committed runtime source or environment files.

## 10. Testing strategy

### Intelligent Contract

- Full three-wallet happy path.
- Distinct actor enforcement and unauthorized method calls.
- Exact payable value, zero-value, insufficient-value, and malformed item amounts.
- Every invalid transition and already-terminal state.
- Duplicate accept, evidence nonce, resolution, appeal, settlement, refund, and callback/retry.
- Unavailable, malformed, stale, mismatched, contradictory, and replayed evidence.
- Independent validator agreement, dissent, malicious leader, and `UNRESOLVED`.
- Network consensus failure leaves the order and accounting unchanged and exposes an idempotent retry.
- Cure success, cure failure, appeal success, second unresolved result, escalation, and matching/mismatching mutual settlement signatures.
- Restaurant item payout, customer item refund, courier payout, delivery-fee refund, and mixed item outcomes.
- Conservation and solvency after every material branch.
- Permissionless resolution and settlement from an unrelated fourth wallet.
- Pause behavior and proof that privileged upgrade/withdraw/verdict paths do not exist.

### Frontend and browser

- Manifest canonicalization and hashing.
- State and amount mapping.
- Bilingual content and stable on-chain enums.
- Wallet rejection, wrong network, timeout, execution error, retry, and stale cache reconciliation.
- Desktop and mobile responsive layouts, keyboard navigation, labels, focus, contrast, and reduced-motion support.
- Live happy path plus refund, appeal, and unresolved branches on StudioNet.

Every fixed defect receives a regression test.

## 11. Deployment workflow and action-time gates

1. Build and verify locally.
2. Before contract deployment, inspect and state the deployment wallet and exact source hash, then obtain user confirmation.
3. Deploy to StudioNet and record address, deployment transaction, source hash, and explorer evidence.
4. Add the real contract address, rebuild, lint, test, and scan for placeholders and secrets.
5. Before Vercel deployment, inspect and state the active Vercel account, team, and project, then obtain user confirmation. The Vercel token is supplied securely and never committed or printed.
6. Deploy and exercise the real web URL.
7. Before any GitHub push, inspect Git author, GitHub CLI account, repository owner, remote, staged files, and untracked files; state the exact push; obtain separate user confirmation.

General approval of this specification does not authorize any contract deployment, Vercel deployment, or GitHub push.

## 12. Completion evidence

Completion requires a fixed package containing:

- Exact Git commit and source hash.
- StudioNet contract address and deployment transaction.
- Explorer link.
- Live Vercel URL.
- Test, build, lint, and browser verification results.
- Known limitations.
- Live proof for happy path and each promoted terminal branch.
- A proof matrix:

| Actor | Action | Contract method | Transaction hash | `FINALIZED` / execution `SUCCESS` | Readback | Source/test |
|---|---|---|---|---|---|---|
| Customer | Create and fund order | `create_order` | Captured during verification | Required | Order and reserved balance | Contract source and test |
| Restaurant | Accept and submit packing evidence | `accept_restaurant`, `submit_packed_evidence` | Captured during verification | Required | Role acceptance and evidence record | Contract source and test |
| Courier | Accept, pickup, and deliver | Courier methods | Captured during verification | Required | Delivery evidence and state | Contract source and test |
| Third party | Trigger resolution and settlement | `request_resolution`, `execute_settlement` | Captured during verification | Required | Outcomes and allocations | Permissionless test |
| Affected actor | Cure or appeal | Cure/appeal methods | Captured during verification | Required | New round and immutable history | Adversarial test |

Claims without matching evidence remain known limitations and are not advertised as complete.

## 13. References

- Reference workflow: https://github.com/emark-cloud/agent_escrow
- GenLayer value transfers: https://docs.genlayer.com/developers/intelligent-contracts/features/value-transfers
- GenLayer transaction result handling: https://docs.genlayer.com/api-references/genlayer-py
- GenLayer Equivalence Principle: https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle
- GenLayer prompt and data techniques: https://docs.genlayer.com/developers/intelligent-contracts/crafting-prompts
- GenLayer testing: https://docs.genlayer.com/developers/intelligent-contracts/testing
