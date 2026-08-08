import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { EvidenceDocument, HexDigest } from "../../lib/domain";
import {
  canonicalizeEvidence,
  canonicalizeEvidenceEnvelope,
  hashEvidence,
  validateEvidenceDocument,
} from "../../lib/evidence";
import claimFixture from "../../public/evidence/order-fg-demo-claim-missing-item.json";
import deliveredFixture from "../../public/evidence/order-fg-demo-delivered.json";
import manifestFixture from "../../public/evidence/order-fg-demo-manifest.json";
import packedFixture from "../../public/evidence/order-fg-demo-packed.json";
import pickupFixture from "../../public/evidence/order-fg-demo-pickup.json";

const FIXTURE_DIGESTS = Object.freeze({
  "order-fg-demo-claim-missing-item.json": "0xc6b1996f8fb0350c217679fdd40b425c5b0385f32d7db608713087e3f6d989c3",
  "order-fg-demo-delivered.json": "0x1f75f32767e97a2dfe7bdec507fe3b963d7ff151e3a13cb5a169a1570bfccd0f",
  "order-fg-demo-manifest.json": "0xc8b3c3caf0d9c51e79a636095a5c8b1a603b61a39bc80027e7ae9ab91ac76ac5",
  "order-fg-demo-packed.json": "0x81aeb38f325af53321789f67ca05cd2423f5cb4d5c4511eaf9ebd0a896ef8d48",
  "order-fg-demo-pickup.json": "0x1619d7c15f830b0c6279f2cee4ee2687b800aba22590c7fba5d2114ca7035344",
} as const satisfies Record<string, HexDigest>);

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

describe("committed demo evidence fixtures", () => {
  const fixtures = [
    ["order-fg-demo-manifest.json", manifestFixture, FIXTURE_DIGESTS["order-fg-demo-manifest.json"]],
    ["order-fg-demo-packed.json", packedFixture, FIXTURE_DIGESTS["order-fg-demo-packed.json"]],
    ["order-fg-demo-pickup.json", pickupFixture, FIXTURE_DIGESTS["order-fg-demo-pickup.json"]],
    ["order-fg-demo-delivered.json", deliveredFixture, FIXTURE_DIGESTS["order-fg-demo-delivered.json"]],
    ["order-fg-demo-claim-missing-item.json", claimFixture, FIXTURE_DIGESTS["order-fg-demo-claim-missing-item.json"]],
  ] as const;

  it.each(fixtures)("pins the canonical envelope and digest for %s", async (name, rawFixture, expectedDigest) => {
    const fixture = rawFixture as unknown as EvidenceDocument;
    const canonicalEnvelope = canonicalizeEvidenceEnvelope(fixture);
    const committedBytes = readFileSync(resolve("public/evidence", name));

    expect(fixture.sha256).toBe(expectedDigest);
    expect(await hashEvidence(fixture)).toBe(expectedDigest);
    expect(validateEvidenceDocument(fixture, new Date("2030-01-01T00:00:00.000Z"))).toEqual(fixture);
    expect(committedBytes.equals(Buffer.from(`${canonicalEnvelope}\n`, "utf8"))).toBe(true);
  });

  it.each(fixtures)("binds %s to its committed public fixture path", (name, rawFixture) => {
    const fixture = rawFixture as unknown as EvidenceDocument;
    const source = new URL(fixture.source_url);

    expect(source.pathname).toBe(`/evidence/${name}`);
    expect(fixture.order_id).toBe("fg-demo");
    expect(fixture.issuer_id).toBe("foodguard-offline-fixture");
  });

  it("cross-checks action actors and item references against the order manifest", () => {
    const manifestItemIds = manifestFixture.items.map((item) => item.item_id);
    const customer = "0x1111111111111111111111111111111111111111";
    const restaurant = "0x2222222222222222222222222222222222222222";
    const courier = "0x3333333333333333333333333333333333333333";

    expect(packedFixture.item_observations.map((item) => item.item_id)).toEqual(manifestItemIds);
    expect(manifestItemIds).toContain(claimFixture.item_id);
    expect(claimFixture.subject).toBe(`order:fg-demo/item:${claimFixture.item_id}`);
    expect(manifestFixture.actor_wallet).toBe(customer);
    expect(packedFixture.actor_wallet).toBe(restaurant);
    expect(pickupFixture.actor_wallet).toBe(courier);
    expect(deliveredFixture.actor_wallet).toBe(courier);
    expect(claimFixture.actor_wallet).toBe(customer);
    expect(new Set([customer, restaurant, courier]).size).toBe(3);
  });
});
