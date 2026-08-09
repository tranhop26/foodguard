# FoodGuard frozen-contract recovery runbook

This runbook applies after a confirmed defect, compromised deployment context, unsafe frontend binding, or evidence-service incident. FoodGuard V1's exact contract classification is `INTENTIONALLY_FROZEN`: it is frozen and non-upgradeable. The deployer can pause new creation with `set_creation_paused`; that control does not rewrite or migrate active orders and must not be represented as a full contract pause.

## 1. Declare and bound the incident

Record the discovery time, reporter, affected Git commit/source hash, configured chain ID, contract address from the verified deployment record, and observed symptoms. Do not copy credentials into the incident record. Classify separately:

- new-order creation safety;
- active-order lifecycle safety;
- public evidence availability/integrity;
- frontend/RPC binding;
- settlement/accounting risk.

Preserve logs and readbacks. Do not infer a transaction outcome from a wallet popup, submitted hash, or finality alone.

Treat a wallet/RPC transport error after submission as an ambiguous outcome. The application and operator must reconcile authoritative contract state and must never automatically resend the wallet write. If the provider returned no transaction hash, transaction finality and execution proof are unavailable even when a later `latest-final` readback confirms the expected effect. Record that narrower result as `STATE_READBACK_CONFIRMED`; do not manufacture a hash, receipt, execution result, or normal tracked `READBACK_CONFIRMED` lifecycle.

## 2. Confirm and pause new creation

Before calling `set_creation_paused(true)`, display:

- exact StudioNet chain ID `61999`;
- verified V1 contract address from the real deployment manifest;
- deployer wallet currently connected;
- method and argument `set_creation_paused(true)`;
- expected consequence: new `create_order` calls fail; existing order actions remain available;
- authoritative recovery readback: `get_creation_paused()` must return `true`.

Obtain explicit action-time confirmation. Submit with the deployer wallet, then require `FINALIZED`, `EXECUTION_SUCCESS`, and an authoritative `get_creation_paused()` readback returning `true`. The new-order surface must fail closed whenever that getter is unavailable or malformed; this blocks only new funding and does not suspend active-order readback or safe lifecycle actions. If consensus fails, state is unchanged; reconcile the hash and retry only the same reviewed operation.

## 3. Audit every active V1 order

Create an append-only audit inventory from authoritative views. Do not use browser-local state as the inventory source. For every known order ID record:

- raw order state and all actor addresses;
- item manifest and exact reserved values;
- every deadline and acceptance/settlement flag;
- evidence count, each envelope, source URL, digest, actor, action, subject, nonce, direct supersession targets, and flattened typed statement slots;
- resolution round/result when present;
- settlement proposal/signatures when present;
- final settlement allocation/ID when present;
- latest relevant transaction hashes with finality, execution result, and readback.

Reconcile the total active reserves against `get_accounting`. Stop if any order or accounting read is malformed; do not guess a corrective allocation.

## 4. Export and verify evidence

For each order, export the exact canonical `envelope_json` and the fetched public document. Recompute SHA-256 over the canonical preimage without `sha256`; compare it with the stored digest and the resolution’s ordered `evidence_hashes`. Record unavailable or mismatched sources as failures, not as missing-but-assumed-valid evidence.

Keep the export outside public source until it has been reviewed for credentials and personal data. Never export wallet secrets, browser storage, seed phrases, or deployment tokens. The fixed files under `public/evidence/` are offline examples only and are not incident evidence.

## 5. Decide active-order handling

V1 has no admin rewrite, upgrade proxy, rescue sweep, or automatic migration. Therefore:

- safe lifecycle actions continue on V1 under their original wallets and deadlines;
- `UNRESOLVED` value remains locked for cure/re-resolution. When one actor owns several stale active records, submit one atomic `submit_cure_evidence(order_id, envelope_json)` batch with strictly increasing direct targets and one typed statement per flattened semantic slot;
- preflight the complete batch before wallet confirmation: every target must still be active, earlier than the new record, owned by the connected actor, and positionally action/item compatible. Never split a required three-record repair across partial writes;
- after `FINALIZED` and execution success, re-read the append-only history. Confirm one new `BATCH_CORRECTION` record, all direct targets inactive, and the expected authoritative active set before retrying resolution;
- if the public source for an earlier active batch is unavailable, a later valid batch may directly replace that one batch record while preserving all of its ordered statement slots; do not recursively copy history records;
- one accepted batch consumes one history slot and the existing one-cure or one-appeal quota for that actor/round. The limits remain `MAX_ITEMS = 100`, `MAX_ACTIVE_EVIDENCE = 103`, and `MAX_EVIDENCE_HISTORY = 112`;
- later unresolved/escalated orders require a valid fully signed mutual settlement when the contract allows it;
- no operator may manufacture evidence, signatures, outcomes, or transfers;
- do not recreate an active V1 order on V2 while its V1 value remains reserved.

Publish participant guidance that names the exact permitted method and consequence for each affected state.

The committed `order-fg-batch-demo-*.json` history and Playwright three-claim scenario are rehearsal material only. The history contains a three-item manifest, the ordered `PACKED`/`PICKED_UP`/`DELIVERED` records, three distinct item claims at indices `3`, `4`, and `5`, and the single cure bound to those authoritative targets. They prove canonical bytes and deterministic local behavior, including active indices `0, 1, 2, 6`; they are not incident evidence, StudioNet finality, or permission to perform a wallet action.

## 6. Review and deploy V2

Fix the defect in a new contract version with regression tests. Run contract, web, browser, lint, typecheck, build, and secret checks. Independently verify the exact source SHA-256 and Git commit.

V1 remains the frozen, unchanged live contract. The current V2 source adds participant-initiated `cancel_before_packed` in `FUNDED`, `PARTIALLY_ACCEPTED`, and `ACCEPTED` before packing, with one conserved full-customer-refund settlement. This capability is not live merely because its source and deterministic tests exist. Keep it labelled source-only until a separately confirmed deployment supplies a verified V2 address, transaction finality, successful execution, source-hash match, and authoritative readback.

Before deployment, display the deployer wallet, StudioNet network, reviewed source hash, commit, constructor inputs, exact contract classification token `INTENTIONALLY_FROZEN`, and exact deployment command. Deploy only after explicit confirmation of that identity and action. Require a receipt plus finality, execution success, contract readback, explorer record, and source-hash match before recording V2 as verified.

## 7. Migrate the frontend, not active custody

Bind **new order creation** to the verified V2 address only after review. Preserve an explicit V1 route/read client so V1 participants can complete, cure, appeal, mutually settle, and prove old orders. Label the version/address/chain beside every order action so a wallet cannot unknowingly act on the wrong contract.

Before production frontend deployment, display the authenticated Vercel identity/team, project, target, public V1/V2 bindings, and exact deployment action. Obtain a separate action-time confirmation. Provide credentials only through a secure environment channel and never echo or persist them.

## 8. Preserve V1 and close recovery

Do not remove V1 evidence or proof pages. Monitor V1 until every order is terminal and accounting shows no active reserves. Preserve the V1 source, deployment manifest, proof matrix, evidence exports, and reconciliation output. There is no recovery step that sweeps remaining value.

Only after the active-order audit is empty may the team consider leaving V1 creation paused permanently. Record that decision, the final accounting readback, and the exact commits and production URLs. A GitHub push still requires separate confirmation of account, remote, branch, commits, staged files, and untracked files.
