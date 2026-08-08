import { describe, expect, it } from "vitest";

import type { EvidenceDocument, HexDigest } from "../../lib/domain";
import {
  hashEvidence,
  validateEvidenceDocument,
} from "../../lib/evidence";

const validEvidence = {
  schema_version: "foodguard-evidence/1",
  order_id: "fg-1",
  item_id: "item-1",
  action: "ORDER_MANIFEST",
  actor_wallet: "0x1111111111111111111111111111111111111111",
  issuer_id: "restaurant-demo",
  source_url: "https://evidence.example/order-fg-1.json",
  sha256: `0x${"a".repeat(64)}` as HexDigest,
  observed_at: "2026-08-08T00:00:00.000Z",
  submitted_at: "2026-08-08T00:01:00.000Z",
  expires_at: "2026-08-08T01:00:00.000Z",
  chain_id: "genlayer-studionet",
  contract_address: "0x2222222222222222222222222222222222222222",
  nonce: "manifest-1",
  items: [
    {
      item_id: "item-1",
      name: "Com tam",
      quantity: 1,
      permitted_substitutions: [],
      price_wei: "1000000000000000000",
      conditions: ["served warm"],
    },
  ],
} satisfies EvidenceDocument;

const fixtureA = validEvidence;
const fixtureB = {
  nonce: validEvidence.nonce,
  contract_address: validEvidence.contract_address,
  chain_id: validEvidence.chain_id,
  expires_at: validEvidence.expires_at,
  submitted_at: validEvidence.submitted_at,
  observed_at: validEvidence.observed_at,
  sha256: validEvidence.sha256,
  source_url: validEvidence.source_url,
  issuer_id: validEvidence.issuer_id,
  actor_wallet: validEvidence.actor_wallet,
  action: validEvidence.action,
  item_id: validEvidence.item_id,
  order_id: validEvidence.order_id,
  schema_version: validEvidence.schema_version,
  items: validEvidence.items,
} satisfies EvidenceDocument;

function without(value: Record<string, unknown>, key: string) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("FoodGuard evidence", () => {
  it("produces one digest for differently ordered object keys", async () => {
    expect(await hashEvidence(fixtureA)).toBe(await hashEvidence(fixtureB));
  });

  it.each(["order_id", "actor_wallet", "source_url", "sha256", "nonce"])(
    "rejects a missing %s binding",
    (key) =>
      expect(() => validateEvidenceDocument(without(validEvidence, key))).toThrow(),
  );
});
