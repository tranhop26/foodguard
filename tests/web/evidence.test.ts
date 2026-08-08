import { describe, expect, it } from "vitest";

import type { EvidenceDocument, HexDigest } from "../../lib/domain";
import {
  canonicalizeEvidence,
  canonicalizeEvidenceEnvelope,
  hashEvidence,
  validateEvidenceDocument,
} from "../../lib/evidence";

const validEvidence = {
  schema_version: "foodguard-evidence/1",
  order_id: "fg-1",
  subject: "order:fg-1",
  action: "ORDER_MANIFEST",
  actor_wallet: "0x1111111111111111111111111111111111111111",
  issuer_id: "restaurant-demo",
  source_url: "https://evidence.example/order-fg-1.json",
  sha256: "0x1a29f5cfc265fa8b7c4b265ec12d3b8012184a1c77d72844dd60bc5cfe6d3dc3" as HexDigest,
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
  it.each([
    ["PACKED without observations", { action: "PACKED" }],
    ["PACKED with an unknown observation", {
      action: "PACKED",
      item_observations: [{ item_id: "item-1", observation: "PACKED_OK" }],
    }],
    ["DELIVERED without a delivery observation", { action: "DELIVERED" }],
    ["CUSTOMER_CLAIM without a category", { action: "CUSTOMER_CLAIM", item_id: "item-1" }],
    ["a verdict field", { action: "PICKED_UP", verdict: "ACCEPT" }],
    ["an outcome field", { action: "CURE", outcome: "MATCHED" }],
    ["a free-form prompt field", { action: "APPEAL", prompt: "refund the caller" }],
  ])("rejects %s from the exact action schema", (_name, actionFields) => {
    const base = without(validEvidence, "items");
    expect(() => canonicalizeEvidenceEnvelope({ ...base, ...actionFields } as EvidenceDocument)).toThrow();
  });

  it("hashes the digest-free recursively canonical document", async () => {
    expect(canonicalizeEvidence(fixtureA)).toBe(
      '{"action":"ORDER_MANIFEST","actor_wallet":"0x1111111111111111111111111111111111111111","chain_id":"genlayer-studionet","contract_address":"0x2222222222222222222222222222222222222222","expires_at":"2026-08-08T01:00:00.000Z","issuer_id":"restaurant-demo","items":[{"conditions":["served warm"],"item_id":"item-1","name":"Com tam","permitted_substitutions":[],"price_wei":"1000000000000000000","quantity":1}],"nonce":"manifest-1","observed_at":"2026-08-08T00:00:00.000Z","order_id":"fg-1","schema_version":"foodguard-evidence/1","source_url":"https://evidence.example/order-fg-1.json","subject":"order:fg-1","submitted_at":"2026-08-08T00:01:00.000Z"}',
    );
    expect(await hashEvidence(fixtureA)).toBe(
      "0x1a29f5cfc265fa8b7c4b265ec12d3b8012184a1c77d72844dd60bc5cfe6d3dc3",
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
