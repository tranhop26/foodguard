# FoodGuard Getter Readback Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authoritative order readback accept the real GenLayer `Evidence` getter shape by deriving typed base evidence facts exclusively from the validated canonical `envelope_json`.

**Architecture:** Keep the contract ABI and evidence schema unchanged. Normalize every getter record after canonical envelope validation: provenance/storage fields remain bound to the getter, while typed PACKED/PICKED_UP/DELIVERED/CUSTOMER_CLAIM fields are copied from the validated envelope into `EvidenceRecordView`. The active-history reducer then receives the same manifest-bound typed representation for real RPC, injected readers, and post-write confirmation.

**Tech Stack:** Next.js 16.3, React 19.2, TypeScript 5.9, `genlayer-js` 1.1.8, Vitest 4.1, Playwright 1.62.

## Global Constraints

- Contract source, ABI, custody, settlement, evidence hashes, fixtures, and public documents do not change.
- The real getter shape has storage/provenance fields plus `envelope_json`; action-specific typed facts are not top-level getter fields.
- Typed facts must come only from the canonical, digest-checked, manifest-validated `envelope_json`, never from untrusted duplicate top-level RPC properties.
- Getter/envelope disagreement in provenance, action, item, hash, actor, domain, or timestamps fails closed.
- PACKED/PICKED_UP/DELIVERED/CUSTOMER_CLAIM remain exact contract schemas with manifest-bound claim and PACKED limits.
- The same normalized view feeds authoritative readback, active-history derivation, editor eligibility, and post-write confirmation.
- No deployment, wallet, token, StudioNet, GitHub push, Vercel action, or live-proof claim.

---

### Task 1: Normalize real getter evidence and prove end-to-end readback

**Files:**
- Modify: `app/orders/[id]/page.tsx`
- Modify: `tests/web/order-detail.test.tsx`
- Modify only if required by a failing test: `components/order/ItemOutcomeTable.tsx`, `lib/evidence.ts`, `tests/e2e/support/foodguard-fixture.ts`

**Interfaces:**
- Consumes: real `get_evidence(order_id, index)` storage shape and canonical `envelope_json` validator.
- Produces: `evidenceRecord(value, manifestItems)` returning an `EvidenceRecordView` whose typed action fields are copied from the validated envelope, with no reliance on top-level typed RPC fields.

- [ ] **Step 1: Write genuine real-getter RED tests**

Create literal getter records containing only the fields returned by the contract dataclass and `envelope_json`. Do not spread the parsed envelope into the getter object. Cover exact PACKED, PICKED_UP, DELIVERED, and CUSTOMER_CLAIM records plus a batch record.

Assert `readAuthoritativeOrder` accepts all valid records, derives the correct active set, and exposes the typed fields required by `deriveActiveEvidenceRecords`. Expected pre-fix result: all base-action cases fail because typed fields are absent at getter top level.

- [ ] **Step 2: Add fail-closed disagreement tests**

Use literal cases where an RPC top-level duplicate typed field is forged, while the canonical envelope remains valid. Assert normalization ignores the duplicate and uses the envelope value. Add provenance/action/item/hash disagreements between getter fields and envelope and assert enriched readback rejects the entire order.

- [ ] **Step 3: Implement minimal normalization**

After `validateEvidenceDocument(JSON.parse(envelope_json), now, manifestItems)` and canonical-envelope equality succeed, construct the view from validated getter provenance plus exact action fields selected from the validated envelope:

```typescript
const typedFacts = action === "PACKED"
  ? { item_observations: envelope.item_observations }
  : action === "PICKED_UP"
    ? { pickup_observation: envelope.pickup_observation }
    : action === "DELIVERED"
      ? { delivery_observation: envelope.delivery_observation }
      : action === "CUSTOMER_CLAIM"
        ? {
            claim_category: envelope.claim_category,
            criterion_kind: envelope.criterion_kind,
            criterion_index: envelope.criterion_index,
          }
        : {};
```

Never merge arbitrary envelope keys or top-level RPC typed fields. Preserve batch `statements` and `supersedes_evidence_indices` only from the validated batch envelope.

- [ ] **Step 4: Run focused and full GREEN verification**

```powershell
npm test -- --run tests/web/order-detail.test.tsx tests/web/evidence.test.ts
npm test -- --run tests/web
npm run test:e2e
npm run lint
npx tsc --noEmit
npm run build
npm run verify:no-secrets
python -m pytest -v
git diff --check
```

Expected: all commands exit 0; real-getter cases pass without enriched mocks; contract remains unchanged.

- [ ] **Step 5: Self-review, report, and commit**

Mutation-check missing typed normalization, forged top-level duplicates, getter/envelope mismatch, malformed manifest-bound claims, and post-write confirmation. Write the ignored task report with RED/GREEN output and commit:

```powershell
git add 'app/orders/[id]/page.tsx' tests/web/order-detail.test.tsx components/order/ItemOutcomeTable.tsx lib/evidence.ts tests/e2e/support/foodguard-fixture.ts
git commit -m "fix(web): normalize authoritative evidence getter"
```

After the task-scoped review is clean, run one whole-plan review over this micro-plan and fresh verification before returning to deployment confirmation.
