# FoodGuard verification proof matrix

This file records the separately confirmed FoodGuard V1 and V2 deployments and the Vercel production UI, and remains a template for later live workflow evidence. It currently asserts deployment transactions, addresses, source matches, execution results, pause readbacks, and the production URL only. It does not assert a successful live three-wallet order workflow. Never populate a cell from an expectation, local mock, wallet popup, or submitted hash.

The verified V1 deployment is frozen and unchanged. V2 adds participant-initiated cancellation before packing and is separately deployed as another `INTENTIONALLY_FROZEN` contract. Existing V1 orders do not migrate automatically.

## Verified StudioNet deployment

| Network | Deployer | Contract | Transaction | Finality | Execution | Authoritative readback | Git commit | Source SHA-256 | Limitation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GenLayer StudioNet (`61999`) | `0x21b45103dd05c43969daF3CbB4277391777e2eC7` | [`0x9214256f05c613Bacaba8e7E8762C62B5BDB52A5`](https://explorer-studio.genlayer.com/address/0x9214256f05c613Bacaba8e7E8762C62B5BDB52A5) | [`0xab80bf526784d2b4a7d527abf02834bacecdd1a54e3da39e4846f7964ea1e0b0`](https://explorer-studio.genlayer.com/tx/0xab80bf526784d2b4a7d527abf02834bacecdd1a54e3da39e4846f7964ea1e0b0) | `FINALIZED` | `SUCCESS` / `MAJORITY_AGREE` | `get_creation_paused()` returned `false` | `ac9c800daee2a741729588ba79bf24df2c48655a` | `a2d4d113f023a20eba3f24d5287bd82995348c6f3ea2b24a704d7dd531b2f3ee` | Deployment proof only; GEN is simulated and live workflow rows below remain unverified |
| GenLayer StudioNet (`61999`) · V2 | `0x21b45103dd05c43969daF3CbB4277391777e2eC7` | [`0xA672f8EbAdA651ad1bE6a22c0558Fc94c6422423`](https://explorer-studio.genlayer.com/address/0xA672f8EbAdA651ad1bE6a22c0558Fc94c6422423) | [`0xf55f0e058245f21f54e033f376702e607bc5e264dd2e004bdb8939055dfbe90f`](https://explorer-studio.genlayer.com/tx/0xf55f0e058245f21f54e033f376702e607bc5e264dd2e004bdb8939055dfbe90f) | `FINALIZED` | `SUCCESS` / `MAJORITY_AGREE` | `get_creation_paused()` returned `false` at `LATEST_FINAL` | `8816261677829118918dc1087830151dc86d671e` | `fd271710034d8492f215da0480e3a33534616e84bbe85758a396dbf984daed3c` | Deployment proof only; GEN is simulated and live workflow rows below remain unverified |

## Verified Vercel production UI

| Team | Project | Deployment ID | Git commit | Production URL | State | Live checks | Limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tdh-s-projects` | `foodguard-genlayer` | `dpl_ARefQRUQS8SvbnnP3F3yu1xXAmxk` | `1d72e99d9d93f67ccbe46a12c3428fb5efd27ca9` | [`https://foodguard-genlayer.vercel.app`](https://foodguard-genlayer.vercel.app) | `READY`; HTTP `200` | `Bếp Lá` and `Gánh Cuốn` rendered with Noto Serif and normal letter spacing; no horizontal overflow at 375px or 1440px | UI deployment proof only; live three-wallet terminal branches remain unverified |

## Deployment record shown by the proof page

The read-only proof page shows a deployment source hash and deployment transaction lifecycle as **reviewed, unverified metadata** only after a complete public record is configured: a StudioNet chain ID (`61999`), a nonzero StudioNet address, the same nonzero address repeated in the reviewed deployment record, nonzero SHA-256 source hash, nonzero deployment transaction hash, `FINALIZED`, `EXECUTION_SUCCESS`, `READBACK_CONFIRMED`, and an independently checked source-hash-match declaration. Missing, malformed, or mismatched data is displayed as unavailable; it must never be replaced with a placeholder.

Populate those public values only from a reviewed, real `deploy/studionet-manifest.json` after the checks below. The environment values bind a reviewed record to the UI; they do not establish live proof by themselves, and the non-deployable example manifest is never a source for them. The page may show **VERIFIED** only after its StudioNet RPC session independently confirms all of the following for the displayed order: the selected StudioNet chain, a finalized deployment transaction with successful execution, deploy type/address/code binding, current deployed-code byte equality and SHA-256 equality, and an authoritative `get_order(order_id)` readback at `latest-final`. If any runtime check fails or cannot run, the record remains reviewed/unverified with the failure reason.

## Local verification (not live proof)

The deterministic browser fixture also covers authoritative creation-pause readback and an escalated mutual-settlement proposal. The committed batch evidence family independently binds its cure to a complete three-item manifest and ordered six-record target history. These remain local behavior checks, not deployment evidence.

`npm run test:e2e` uses deterministic local wallet and RPC doubles. It covers 375/1440 marketplace layout, bilingual filtering, three-wallet/payable preview, `DEPLOYMENT_REQUIRED`, keyboard focus, finality → execution → full readback, `UNRESOLVED` cure, consensus-failed unchanged state, operation-specific retry, one post-write transport failure reconciled without resend, participant cancellation before packing, and three stale customer claims corrected by one atomic batch. The recovery scenario records exactly one decoded wallet request and later exposes the changed state through `latest-final`; the cancellation scenario reads one conserved full-customer-refund settlement. These checks exercise the real browser application but **must not be counted as StudioNet deployment evidence**.

In the recovery scenario the wallet provider throws `Failed to fetch` after recording the request and returns no transaction hash. A matching authoritative state readback produces `STATE_READBACK_CONFIRMED`, but it does not supply or prove transaction finality or execution and those lifecycle rows remain incomplete. The application never automatically resends the wallet transaction.

| Local-only scenario | Actor | Method | Deterministic lifecycle | Authoritative local readback | Source/test | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| Recorded acceptance → provider transport failure | Synthetic restaurant fixture | `accept_restaurant("fg-1")` once | `RECONCILING` → `STATE_READBACK_CONFIRMED`; finality/execution remain incomplete | A later `latest-final` read returns `PARTIALLY_ACCEPTED` with only the restaurant accepted | `tests/e2e/order-happy-path.spec.ts` | Local deterministic evidence only; no transaction hash, StudioNet finality, execution result, receipt, explorer record, or live wallet |
| Participant cancellation before packing | Synthetic restaurant fixture | `cancel_before_packed("fg-1")` once | Deterministic local finalized/executed/readback lifecycle | `CANCELLED_REFUNDED`; acceptance flags cleared; refund marker set; aggregate customer allocation `130` wei, restaurant/courier `0` | `tests/e2e/order-happy-path.spec.ts` | V2 source behavior exercised with local doubles only; not proof that V2 is deployed or live on StudioNet |
| Three stale customer claims → one atomic cure | Synthetic customer fixture | `submit_cure_evidence("fg-batch-1", envelope_json)` once | `FINALIZED` / `EXECUTION_SUCCESS` / `READBACK_CONFIRMED` from local doubles | One new history index `6`; active `0, 1, 2, 6`; stale `3, 4, 5` absent | `public/evidence/order-fg-batch-demo-*.json`; `tests/web/evidence.test.ts`; `tests/e2e/order-unresolved.spec.ts` | Local deterministic evidence only; no StudioNet address, transaction, explorer receipt, wallet, or live URL |

## Live proof rows

For each live row, record raw values only after checking network, actor, contract, transaction receipt, execution result, authoritative readback, repository commit, and source hash. Add rows rather than overwriting earlier evidence.

| Scenario | Actor wallet | User action | Contract method | Transaction hash | Finality | Execution result | Authoritative readback | Public evidence / test link | Git commit | Contract source SHA-256 | Contract address | Explorer URL | Vercel URL | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Happy path through settlement | Live verification required | Live verification required | `execute_settlement` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Pre-packing participant cancellation (V2) | Live verification required | Live verification required | `cancel_before_packed` | Not recorded | Not recorded | Not recorded | Not recorded | Local deterministic regression only | `8816261677829118918dc1087830151dc86d671e` | `fd271710034d8492f215da0480e3a33534616e84bbe85758a396dbf984daed3c` | `0xA672f8EbAdA651ad1bE6a22c0558Fc94c6422423` | [V2 contract](https://explorer-studio.genlayer.com/address/0xA672f8EbAdA651ad1bE6a22c0558Fc94c6422423) | Pending V2 frontend deployment | Contract is deployed, but the cancellation workflow has not yet been exercised live with participant wallets |
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
