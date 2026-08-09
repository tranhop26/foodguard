# FoodGuard

FoodGuard is a bilingual proof-marketplace demonstration for evidence-bound food orders on GenLayer StudioNet.

> **StudioNet · Simulated GEN.** This repository is not production payments software. No deployed FoodGuard address is committed in this source tree. Contract reads and writes remain locked as `DEPLOYMENT_REQUIRED` until a separately verified address is configured.

## English

### What the system trusts

FoodGuard separates a food commitment from evidence about it and from the contract consequence. SHA-256 detects a changed canonical document; it does **not** prove that a meal was packed or delivered. Validator consensus derives bounded outcomes from valid evidence, and only authoritative contract readback is presented as state.

| Actor | Decision | Consequence | Evidence | State | Custody |
| --- | --- | --- | --- | --- | --- |
| Customer wallet | Creates the order; may claim, cure, appeal, or sign a mutual settlement when eligible | Funds exact item subtotal plus delivery fee; receives refunds assigned by the terminal decision | `ORDER_MANIFEST`, `CUSTOMER_CLAIM`, `CURE`, `APPEAL` | Contract enums and deadlines determine available actions | The browser wallet keeps the key; FoodGuard never stores it |
| Restaurant wallet | Accepts and records bounded packing facts | Receives only item value allocated by resolution or a fully signed mutual settlement | `PACKED`, `CURE`, `APPEAL` | Wallet + contract state gate each action | A separate, nonzero wallet is required |
| Courier wallet | Accepts and records pickup/delivery facts | Receives only the delivery-fee allocation | `PICKED_UP`, `DELIVERED`, `CURE`, `APPEAL` | Wallet + contract state gate each action | A third separate, nonzero wallet is required |
| GenLayer validators | Resolve typed evidence to item and delivery enums | No value moves at resolution; settlement later applies the stored decision | Canonical public envelopes and their committed digests | Consensus failure leaves the prior state and reserves unchanged | Validators do not hold participant wallet keys |
| FoodGuard V1 contract | Enforces transitions, append-only evidence, conservation, deadlines, and one-time settlement | `MATCHED` pays the restaurant; other resolved item outcomes refund the customer; delivered fee pays courier; `UNRESOLVED` remains locked | `foodguard-evidence/1` metadata plus action-specific typed facts | Contract readback is authoritative | Contract escrow holds only Simulated GEN reserved for orders |

The three participant addresses must be valid, nonzero, and pairwise distinct. A connected wallet is checked again at action time. Payable creation previews the exact integer-wei subtotal, delivery fee, total, manifest, deadlines, digest, customer account, and contract/network before wallet confirmation.

### Decision and consequence model

- Item outcomes are `MATCHED`, `MISSING`, `MISMATCHED`, `DELIVERY_FAILED`, or `UNRESOLVED`.
- Delivery outcomes are `DELIVERED`, `DELIVERY_FAILED`, or `UNRESOLVED`.
- `MATCHED` allocates that item value to the restaurant. The resolved non-matching outcomes allocate that item value back to the customer.
- `DELIVERED` allocates the delivery fee to the courier; `DELIVERY_FAILED` allocates it back to the customer.
- Any `UNRESOLVED` item or delivery outcome stays locked in escrow. The first unresolved round enters `EVIDENCE_CURE`; a later unresolved round enters `ESCALATED`. No payout or refund is inferred from UI state.
- `CONSENSUS_FAILED` is a transaction result, not a new order state. The prior contract state and reserved balances remain unchanged, and the same operation may be retried by whoever its contract authorization permits.
- Success requires `FINALIZED` → `EXECUTION_SUCCESS` → `READBACK_CONFIRMED`. Finality alone is not success.

### State machine

```text
FUNDED → PARTIALLY_ACCEPTED → ACCEPTED → READY_FOR_PICKUP → IN_TRANSIT
      → REVIEW_WINDOW → RESOLVING → RESOLVED → APPEALED → SETTLED
                              └→ EVIDENCE_CURE → RESOLVING
                                                └→ ESCALATED
FUNDED / PARTIALLY_ACCEPTED → CANCELLED_REFUNDED when strict cancellation rules allow
ACCEPTED / READY_FOR_PICKUP / IN_TRANSIT → FULFILLMENT_TIMEOUT_REFUNDED at the exact stalled-workflow deadline (full customer refund)
```

The contract validates the exact transition; the diagram is explanatory, not an authorization substitute.

### Fixed evidence examples

Files in `public/evidence/` are deterministic **offline fixtures**, not live evidence and not proof of freshness. Their fixed `2030-01-01` observation/submission times and `2030-01-02` expiry are fixture values only. `contract_address` is the explicit non-deployable string `OFFLINE_FIXTURE_NOT_DEPLOYED`, and the reserved `.example` source host makes them unsuitable for submission. Tests recompute each canonical SHA-256, validate the exact action schema/enums, bind each `source_url` path to its committed filename, and cross-check packed/claim item references against the manifest.

Each `foodguard-evidence/1` envelope contains common order, actor, issuer, source, digest, time, chain, contract, and nonce bindings. Action facts are exact:

- `ORDER_MANIFEST`: canonical `items`.
- `PACKED`: one ordered `item_observations` entry per manifest item.
- `PICKED_UP`: no extra action fact.
- `DELIVERED`: `delivery_observation`.
- `CUSTOMER_CLAIM`: `item_id` and `claim_category`.
- `CURE` / `APPEAL`: optional `item_id` only.

### Local commands

Requirements are Node.js/npm and Python 3.12. Install the locked JavaScript dependencies with `npm ci` and the Python project with your normal isolated environment.

```powershell
python -m pytest tests/contract -v
npm test
npm run test:e2e
npm run lint
npx tsc --noEmit
npm run build
npm run verify:no-secrets
```

`npm run test:e2e` starts two local servers: a configured test instance and a `DEPLOYMENT_REQUIRED` instance. Wallet and RPC behavior is mocked deterministically at the browser boundary. These tests never contact a deployment and **do not count as live StudioNet proof**.

The secret scan reads tracked worktree content, staged index content, and untracked public-source files. A separate bounded filesystem presence check also catches ordinary ignored `.env.local` files at the root and relevant source subtrees without reading their contents; it skips `.git`, `node_modules`, and symlinks. The gate rejects private-key, mnemonic/seed-phrase, and Vercel-token patterns plus unsafe tracked paths such as generated output, dependency/cache directories, `.superpowers`, `work`, `research`, and task artifacts. Findings report only the path and rule ID; matched values are redacted. Blank `.env.example` keys and documentation variable names are allowed.

### Deployment and action-time confirmation gates

1. Before any StudioNet deployment, show the exact deployer wallet, network, source SHA-256, Git commit, contract classification token `INTENTIONALLY_FROZEN`, and command. Execute only after explicit confirmation of that wallet and action.
2. Populate a real `deploy/studionet-manifest.json` only from the confirmed receipt and authoritative readback. The committed `.example.json` is deliberately non-deployable.
3. Before any Vercel link/create/deploy, show the authenticated identity/team, project, production action, and public configuration. Accept credentials only through a secure environment mechanism; never print or persist them. Execute only after a separate confirmation.
4. Before any GitHub push, show author/account, repository owner, remote, branch, commits, staged files, and untracked files. Push only after a separate confirmation.
5. Wallet confirmation is still required for every on-chain write. Recheck the connected account, StudioNet chain ID `61999`, exact method/arguments, and payable value immediately before submission.

### Frozen V1 classification and known limits

FoodGuard V1's exact contract classification is `INTENTIONALLY_FROZEN`: it is a frozen, non-upgradeable contract design. The deployer can pause **new order creation only**; the UI reads `get_creation_paused()` and fails closed for new funding if that authoritative read is unavailable. There is no upgrade proxy, arbitrary admin rewrite, custody sweep, or automatic migration of active orders. A defect therefore requires pausing creation, auditing every active V1 order, exporting public evidence, deploying reviewed V2 source after confirmation, routing only new orders to V2, and preserving V1 readback/action access until its orders are terminal. See `docs/recovery-runbook.md`.

Known limits: StudioNet and Simulated GEN are non-production; evidence availability and truth remain external assumptions; a digest proves integrity, not physical correctness; browser tests use local doubles; no live contract address, transaction, explorer record, or production URL is asserted by this repository; and unresolved/escalated funds may require cure or a fully signed mutual settlement.

## Tiếng Việt

### Mô hình tin cậy

FoodGuard tách ba phần: cam kết món ăn, bằng chứng về cam kết, và hệ quả do contract thực thi. SHA-256 chỉ phát hiện tài liệu chuẩn hóa bị thay đổi; hash không chứng minh món đã được đóng gói hay giao thật. Kết quả chỉ có thẩm quyền sau đồng thuận validator và đọc lại contract.

| Tác nhân | Quyết định | Hệ quả | Bằng chứng | Trạng thái | Quyền giữ tài sản/khóa |
| --- | --- | --- | --- | --- | --- |
| Ví khách hàng | Tạo đơn; khi đủ điều kiện có thể khiếu nại, bổ sung, kháng nghị hoặc ký thỏa thuận | Ký quỹ đúng tổng món + phí giao; nhận phần hoàn theo kết quả cuối | `ORDER_MANIFEST`, `CUSTOMER_CLAIM`, `CURE`, `APPEAL` | Enum và deadline contract quyết định hành động | Khóa riêng luôn ở ví trình duyệt, không lưu trong FoodGuard |
| Ví nhà hàng | Nhận đơn và ghi sự kiện đóng gói giới hạn | Chỉ nhận giá trị món được phân bổ | `PACKED`, `CURE`, `APPEAL` | Ví + trạng thái contract khóa/mở hành động | Phải là ví hợp lệ, khác hai ví còn lại |
| Ví courier | Nhận đơn, ghi nhận lấy/giao hàng | Chỉ nhận phần phí giao được phân bổ | `PICKED_UP`, `DELIVERED`, `CURE`, `APPEAL` | Ví + trạng thái contract khóa/mở hành động | Là ví hợp lệ thứ ba, khác hai ví còn lại |
| Validator GenLayer | Phân xử dữ kiện đã giới hạn thành enum món và giao hàng | Phân xử chưa di chuyển tiền; quyết toán sau đó mới áp dụng kết quả lưu | Envelope chuẩn hóa và digest đã cam kết | Lỗi đồng thuận giữ nguyên trạng thái và tiền dự trữ | Validator không giữ khóa ví người tham gia |
| Contract FoodGuard V1 | Ép state machine, deadline, bằng chứng ghi nối thêm và bảo toàn giá trị | `UNRESOLVED` khóa tiền; các enum cuối xác định thanh toán/hoàn tiền | `foodguard-evidence/1` | Dữ liệu đọc lại từ contract là nguồn có thẩm quyền | Escrow chỉ giữ Simulated GEN của đơn |

Ba ví phải hợp lệ, khác địa chỉ zero và khác nhau từng đôi một. Trước khi xác nhận ví, giao diện hiển thị chính xác subtotal, phí giao, tổng wei phải trả, manifest, deadline, digest, tài khoản khách hàng, chain và contract. Thành công bắt buộc đi qua `FINALIZED` → `EXECUTION_SUCCESS` → `READBACK_CONFIRMED`; chỉ finality là chưa đủ.

Các JSON trong `public/evidence/` là **fixture offline cố định**, không phải bằng chứng live và không thể dùng để tuyên bố còn mới. Thời gian năm 2030 chỉ là dữ liệu fixture. Test trình duyệt cũng dùng ví/RPC giả lập cục bộ có giới hạn và không được tính là bằng chứng StudioNet live.

### Chạy kiểm tra và giới hạn triển khai

Dùng các lệnh trong phần English để chạy contract test, web test, browser E2E, lint, typecheck, build và quét secret. Khi chưa có địa chỉ đã triển khai/xác minh, ứng dụng phải hiển thị `DEPLOYMENT_REQUIRED` và khóa mọi write.

Phân loại contract chính xác của V1 là `INTENTIONALLY_FROZEN`: contract đóng băng, không upgrade. Deployer chỉ có thể dừng tạo **đơn mới**; không thể sửa tùy ý, quét escrow hoặc tự động chuyển đơn đang chạy. Khi có lỗi: dừng tạo đơn sau xác nhận, kiểm kê đơn V1, xuất bằng chứng, review/deploy V2 sau xác nhận, chuyển đơn mới sang V2, và tiếp tục giữ giao diện V1 cho đến khi mọi đơn cũ kết thúc. Xác nhận deployment phải hiển thị chính token `INTENTIONALLY_FROZEN`. Mọi deployment StudioNet, deployment Vercel và push GitHub đều có cổng xác nhận riêng ngay tại thời điểm hành động.

## Repository references

- Recovery: `docs/recovery-runbook.md`
- Non-deployable manifest schema: `deploy/studionet-manifest.example.json`
- Live-proof template: `docs/verification/proof-matrix.md`
- Contract: `contracts/food_guard.py`
