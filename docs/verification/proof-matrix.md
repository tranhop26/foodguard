# FoodGuard verification proof matrix

This file is a template for evidence gathered **after separately confirmed live actions**. It currently asserts no deployed address, transaction hash, explorer record, Vercel URL, or live StudioNet result. Never populate a cell from an expectation, local mock, wallet popup, or submitted hash.

## Deployment record shown by the proof page

The read-only proof page shows a deployment source hash and deployment transaction lifecycle as **reviewed, unverified metadata** only after a complete public record is configured: a StudioNet chain ID (`61999`), a nonzero StudioNet address, the same nonzero address repeated in the reviewed deployment record, nonzero SHA-256 source hash, nonzero deployment transaction hash, `FINALIZED`, `EXECUTION_SUCCESS`, `READBACK_CONFIRMED`, and an independently checked source-hash-match declaration. Missing, malformed, or mismatched data is displayed as unavailable; it must never be replaced with a placeholder.

Populate those public values only from a reviewed, real `deploy/studionet-manifest.json` after the checks below. The environment values bind a reviewed record to the UI; they do not establish live proof by themselves, and the non-deployable example manifest is never a source for them. The page may show **VERIFIED** only after its StudioNet RPC session independently confirms all of the following for the displayed order: the selected StudioNet chain, a finalized deployment transaction with successful execution, deploy type/address/code binding, current deployed-code byte equality and SHA-256 equality, and an authoritative `get_order(order_id)` readback at `latest-final`. If any runtime check fails or cannot run, the record remains reviewed/unverified with the failure reason.

## Local verification (not live proof)

The deterministic browser fixture also covers authoritative creation-pause readback and an escalated mutual-settlement proposal. The committed batch evidence family independently binds its cure to a complete three-item manifest and ordered six-record target history. These remain local behavior checks, not deployment evidence.

`npm run test:e2e` uses deterministic local wallet and RPC doubles. It covers 375/1440 marketplace layout, bilingual filtering, three-wallet/payable preview, `DEPLOYMENT_REQUIRED`, keyboard focus, finality → execution → full readback, `UNRESOLVED` cure, consensus-failed unchanged state, operation-specific retry, and three stale customer claims corrected by one atomic batch. The batch scenario records exactly one local wallet request, then reads active indices `0, 1, 2, 6`. These checks exercise the real browser application but **must not be counted as StudioNet deployment evidence**.

| Local-only scenario | Actor | Method | Deterministic lifecycle | Authoritative local readback | Source/test | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| Three stale customer claims → one atomic cure | Synthetic customer fixture | `submit_cure_evidence("fg-batch-1", envelope_json)` once | `FINALIZED` / `EXECUTION_SUCCESS` / `READBACK_CONFIRMED` from local doubles | One new history index `6`; active `0, 1, 2, 6`; stale `3, 4, 5` absent | `public/evidence/order-fg-batch-demo-*.json`; `tests/web/evidence.test.ts`; `tests/e2e/order-unresolved.spec.ts` | Local deterministic evidence only; no StudioNet address, transaction, explorer receipt, wallet, or live URL |

## Live proof rows

For each live row, record raw values only after checking network, actor, contract, transaction receipt, execution result, authoritative readback, repository commit, and source hash. Add rows rather than overwriting earlier evidence.

| Scenario | Actor wallet | User action | Contract method | Transaction hash | Finality | Execution result | Authoritative readback | Public evidence / test link | Git commit | Contract source SHA-256 | Contract address | Explorer URL | Vercel URL | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Happy path through settlement | Live verification required | Live verification required | `execute_settlement` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Unaccepted cancellation/refund | Live verification required | Live verification required | `cancel_unaccepted` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Stalled accepted fulfillment refund | Live verification required | Live verification required | `cancel_fulfillment_timeout` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Confirm exact deadline and full customer refund |
| UNRESOLVED → cure → re-resolution | Live verification required | Live verification required | `request_resolution` / `submit_cure_evidence` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Three stale claims → atomic batch cure → re-resolution | Live verification required | Select all three active caller-owned records and submit one verified public batch | `submit_cure_evidence` / `request_resolution` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Confirm one new history slot, direct targets absent, and fresh active indices before re-resolution |
| Appeal and later resolution | Live verification required | Live verification required | `appeal` / `request_resolution` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Escalated mutual settlement | Live verification required | Live verification required | `propose_mutual_settlement` / `sign_mutual_settlement` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Record proposal digest, round, active-evidence digest, and all signatures |
| Outsider permissionless resolution/settlement | Live verification required | Live verification required | `request_resolution` / `execute_settlement` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Consensus failure and same-operation retry | Live verification required | Live verification required | Record exact failed/retried method | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | State/reserves must be compared before and after failure |

## Population rules

1. Capture the transaction hash only after submission, but do not mark success yet.
2. Record finality and `txExecutionResultName` separately.
3. Re-read the exact order and accounting views after successful execution.
4. Cross-check the deployment chain/address/source hash against `deploy/studionet-manifest.json`; never use the non-deployable example.
5. Link public evidence only when the fetched canonical bytes match the committed digest.
6. Record the exact Git commit tested and deployed.
7. Record limitations and failures without deleting them.
8. Do not place credentials, private keys, mnemonics, seed phrases, or deployment tokens in this file.
