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

## 2. Confirm and pause new creation

Before calling `set_creation_paused(true)`, display:

- exact StudioNet chain ID `61999`;
- verified V1 contract address from the real deployment manifest;
- deployer wallet currently connected;
- method and argument `set_creation_paused(true)`;
- expected consequence: new `create_order` calls fail; existing order actions remain available;
- recovery/readback command.

Obtain explicit action-time confirmation. Submit with the deployer wallet, then require `FINALIZED`, `EXECUTION_SUCCESS`, and an authoritative readback showing `creation_paused = true`. If consensus fails, state is unchanged; reconcile the hash and retry only the same reviewed operation.

## 3. Audit every active V1 order

Create an append-only audit inventory from authoritative views. Do not use browser-local state as the inventory source. For every known order ID record:

- raw order state and all actor addresses;
- item manifest and exact reserved values;
- every deadline and acceptance/settlement flag;
- evidence count, each envelope, source URL, digest, actor, action, subject, and nonce;
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
- `UNRESOLVED` value remains locked for cure/re-resolution;
- later unresolved/escalated orders require a valid fully signed mutual settlement when the contract allows it;
- no operator may manufacture evidence, signatures, outcomes, or transfers;
- do not recreate an active V1 order on V2 while its V1 value remains reserved.

Publish participant guidance that names the exact permitted method and consequence for each affected state.

## 6. Review and deploy V2

Fix the defect in a new contract version with regression tests. Run contract, web, browser, lint, typecheck, build, and secret checks. Independently verify the exact source SHA-256 and Git commit.

Before deployment, display the deployer wallet, StudioNet network, reviewed source hash, commit, constructor inputs, exact contract classification token `INTENTIONALLY_FROZEN`, and exact deployment command. Deploy only after explicit confirmation of that identity and action. Require a receipt plus finality, execution success, contract readback, explorer record, and source-hash match before recording V2 as verified.

## 7. Migrate the frontend, not active custody

Bind **new order creation** to the verified V2 address only after review. Preserve an explicit V1 route/read client so V1 participants can complete, cure, appeal, mutually settle, and prove old orders. Label the version/address/chain beside every order action so a wallet cannot unknowingly act on the wrong contract.

Before production frontend deployment, display the authenticated Vercel identity/team, project, target, public V1/V2 bindings, and exact deployment action. Obtain a separate action-time confirmation. Provide credentials only through a secure environment channel and never echo or persist them.

## 8. Preserve V1 and close recovery

Do not remove V1 evidence or proof pages. Monitor V1 until every order is terminal and accounting shows no active reserves. Preserve the V1 source, deployment manifest, proof matrix, evidence exports, and reconciliation output. There is no recovery step that sweeps remaining value.

Only after the active-order audit is empty may the team consider leaving V1 creation paused permanently. Record that decision, the final accounting readback, and the exact commits and production URLs. A GitHub push still requires separate confirmation of account, remote, branch, commits, staged files, and untracked files.
