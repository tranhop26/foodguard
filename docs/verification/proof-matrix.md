# FoodGuard verification proof matrix

This file is a template for evidence gathered **after separately confirmed live actions**. It currently asserts no deployed address, transaction hash, explorer record, Vercel URL, or live StudioNet result. Never populate a cell from an expectation, local mock, wallet popup, or submitted hash.

## Local verification (not live proof)

`npm run test:e2e` uses deterministic local wallet and RPC doubles. It covers 375/1440 marketplace layout, bilingual filtering, three-wallet/payable preview, `DEPLOYMENT_REQUIRED`, keyboard focus, finality → execution → full readback, `UNRESOLVED` cure, consensus-failed unchanged state, and operation-specific retry. These checks exercise the real browser application but **must not be counted as StudioNet deployment evidence**.

## Live proof rows

For each live row, record raw values only after checking network, actor, contract, transaction receipt, execution result, authoritative readback, repository commit, and source hash. Add rows rather than overwriting earlier evidence.

| Scenario | Actor wallet | User action | Contract method | Transaction hash | Finality | Execution result | Authoritative readback | Public evidence / test link | Git commit | Contract source SHA-256 | Contract address | Explorer URL | Vercel URL | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Happy path through settlement | Live verification required | Live verification required | `execute_settlement` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Unaccepted cancellation/refund | Live verification required | Live verification required | `cancel_unaccepted` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| UNRESOLVED → cure → re-resolution | Live verification required | Live verification required | `request_resolution` / `submit_cure_evidence` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Appeal and later resolution | Live verification required | Live verification required | `appeal` / `request_resolution` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Outsider permissionless resolution/settlement | Live verification required | Live verification required | `request_resolution` / `execute_settlement` | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded |
| Consensus failure and same-operation retry | Live verification required | Live verification required | Record exact failed/retried method | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | Not recorded | State/reserves must be compared before and after failure |

## Population rules

1. Capture the transaction hash only after submission, but do not mark success yet.
2. Record finality and `txExecutionResultName` separately.
3. Re-read the exact order and accounting views after successful execution.
4. Cross-check the deployment address/source hash against `deploy/studionet-manifest.json`; never use the non-deployable example.
5. Link public evidence only when the fetched canonical bytes match the committed digest.
6. Record the exact Git commit tested and deployed.
7. Record limitations and failures without deleting them.
8. Do not place credentials, private keys, mnemonics, seed phrases, or deployment tokens in this file.
