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
  subject: "order:fg-1/item:item-1",
  action: "ORDER_MANIFEST",
  actor_wallet: "0x1111111111111111111111111111111111111111",
  issuer_id: "restaurant-demo",
  source_url: "https://evidence.example/order-fg-1.json",
  sha256: "0x1f5f60f3d5fa220fcc251a5c25787d2cd2981da16f63957e2cc72d818c066015" as HexDigest,
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
  subject: validEvidence.subject,
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

const nestedReorderedFixture = {
  ...fixtureB,
  items: [
    {
      conditions: ["served warm"],
      price_wei: "1000000000000000000",
      permitted_substitutions: [],
      quantity: 1,
      name: "Com tam",
      item_id: "item-1",
    },
  ],
} satisfies EvidenceDocument;

function without(value: Record<string, unknown>, key: string) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("FoodGuard evidence", () => {
  it("hashes the digest-free recursively canonical document", async () => {
    expect(await hashEvidence(fixtureA)).toBe(
      "0x1f5f60f3d5fa220fcc251a5c25787d2cd2981da16f63957e2cc72d818c066015",
    );
    expect(await hashEvidence(fixtureA)).toBe(await hashEvidence(nestedReorderedFixture));
    expect(validateEvidenceDocument(fixtureA, new Date("2026-08-08T00:01:00.000Z"))).toEqual(fixtureA);
  });

  it.each(["order_id", "actor_wallet", "source_url", "sha256", "nonce", "subject"])(
    "rejects a missing %s binding",
    (key) =>
      expect(() => validateEvidenceDocument(without(validEvidence, key))).toThrow(),
  );

  it("rejects a digest that does not bind the canonical evidence", () => {
    expect(() =>
      validateEvidenceDocument({ ...validEvidence, sha256: `0x${"b".repeat(64)}` }),
    ).toThrow();
  });

  it.each([
    ["a Date", new Date("2026-08-08T00:00:00.000Z")],
    ["a Map", new Map([["item", "value"]])],
    ["a Set", new Set(["item"])],
    ["a sparse array", new Array(1)],
  ])("rejects %s from a canonical evidence document", (_name, payload) => {
    expect(() => validateEvidenceDocument({ ...validEvidence, payload } as unknown)).toThrow();
  });

  it.each([
    ["malformed", { observed_at: "not-a-time" }],
    ["expired", { expires_at: "2026-08-07T23:59:59.999Z" }],
    ["out of order", { observed_at: "2026-08-08T00:02:00.000Z" }],
  ])("rejects %s timestamps", (_name, timestamps) => {
    expect(() =>
      validateEvidenceDocument(
        { ...validEvidence, ...timestamps },
        new Date("2026-08-08T00:01:00.000Z"),
      ),
    ).toThrow();
  });
});
