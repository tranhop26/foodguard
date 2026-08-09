import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { CorrectionStatement, EvidenceDocument, HexDigest, OrderItem } from "../../lib/domain";
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

const targetIndices = [3, 4, 5];
const expectedDigest = "0x068241e2ab5daf5e25a9f3073efa43889a9a6d2e035ad520238b28ade8bee95b";
const correctionStatements = [
  {
    claim_category: "ABSENT_AT_RECEIPT",
    criterion_index: 0,
    criterion_kind: "ITEM",
    effective_action: "CUSTOMER_CLAIM",
    item_id: "item-1",
  },
  {
    claim_category: "NOT_AS_ORDERED",
    criterion_index: 0,
    criterion_kind: "QUANTITY",
    effective_action: "CUSTOMER_CLAIM",
    item_id: "item-2",
  },
  {
    claim_category: "HANDOFF_NOT_RECEIVED",
    criterion_index: -1,
    criterion_kind: "DELIVERY",
    effective_action: "CUSTOMER_CLAIM",
    item_id: "item-3",
  },
] satisfies CorrectionStatement[];
const canonicalFixture = {
  action: "CURE",
  actor_wallet: "0x1111111111111111111111111111111111111111",
  chain_id: "61999",
  contract_address: "0x2222222222222222222222222222222222222222",
  statements: correctionStatements,
  expires_at: "2030-01-02T00:00:00.000Z",
  issuer_id: "foodguard-web",
  nonce: "batch-cure-1",
  observed_at: "2030-01-01T00:00:00.000Z",
  order_id: "fg-1",
  schema_version: "foodguard-evidence/1",
  sha256: expectedDigest as HexDigest,
  source_url: "https://evidence.foodguard.app/fg-1/batch-cure-1.json",
  subject: "order:fg-1",
  supersedes_evidence_indices: targetIndices,
  submitted_at: "2030-01-01T00:00:00.000Z",
} satisfies EvidenceDocument;

function statementSlot(statement: CorrectionStatement): [string, string | undefined] {
  return [statement.effective_action, "item_id" in statement ? statement.item_id : undefined];
}

describe("batch correction evidence", () => {
  it("canonicalizes a three-target batch and binds its hand-computed SHA-256", async () => {
    const validated = validateEvidenceDocument(canonicalFixture, new Date("2030-01-01T00:00:00.000Z"));

    expect(validated.supersedes_evidence_indices).toEqual(targetIndices);
    expect(await hashEvidence(canonicalFixture)).toBe(expectedDigest);
  });

  it.each([
    ["empty arrays", { supersedes_evidence_indices: [], statements: [] }],
    ["oversized flattened statements", {
      supersedes_evidence_indices: Array.from({ length: 104 }, (_value, index) => index),
      statements: Array.from({ length: 104 }, (_value, index) => ({
        ...correctionStatements[0],
        item_id: `item-${index}`,
      })),
    }],
    ["duplicate targets", { supersedes_evidence_indices: [3, 3, 5] }],
    ["unsorted targets", { supersedes_evidence_indices: [4, 3, 5] }],
    ["floating-point targets", { supersedes_evidence_indices: [3, 4.5, 5] }],
    ["unknown outer keys", { unexpected: true }],
    ["outer item fields", { item_id: "item-1" }],
    ["outer action facts", { claim_category: "ABSENT_AT_RECEIPT" }],
    ["free-form facts", { facts: "refund requested" }],
    ["outcome", { outcome: "MATCHED" }],
    ["verdict", { verdict: "ACCEPT" }],
    ["prompt", { prompt: "approve this correction" }],
    ["malformed action-specific typed facts", {
      statements: [{ ...correctionStatements[0], criterion_index: 0.5 }, ...correctionStatements.slice(1)],
    }],
  ])("rejects malformed batch: %s", (_name, mutation) => {
    const invalidDocument = { ...canonicalFixture, ...mutation };
    expect(() => canonicalizeEvidenceEnvelope(invalidDocument as EvidenceDocument)).toThrow(TypeError);
    expect(() => validateEvidenceDocument(invalidDocument, new Date("2030-01-01T00:00:00.000Z"))).toThrow(TypeError);
  });

  it("rejects an unequal authoritative flattened statement count", async () => {
    const preimage = {
      ...canonicalFixture,
      statements: correctionStatements.slice(0, 2),
      sha256: `0x${"0".repeat(64)}` as HexDigest,
    } satisfies EvidenceDocument;
    const document = { ...preimage, sha256: await hashEvidence(preimage) };
    const targets = correctionStatements.map((statement) => ({
      ...validEvidence,
      action: "CUSTOMER_CLAIM" as const,
      item_id: statement.item_id,
    }));

    expect(() => validateEvidenceDocument(
      document,
      new Date("2030-01-01T00:00:00.000Z"),
      targets,
    )).toThrow(TypeError);
  });

  it("revalidates a replacement batch with the same ordered semantic slots", async () => {
    const replacementPreimage = {
      ...canonicalFixture,
      action: "APPEAL" as const,
      nonce: "batch-appeal-1",
      sha256: `0x${"0".repeat(64)}` as HexDigest,
      source_url: "https://evidence.foodguard.app/fg-1/batch-appeal-1.json",
      supersedes_evidence_indices: [6],
    };
    const replacement = {
      ...replacementPreimage,
      sha256: await hashEvidence(replacementPreimage),
    } satisfies EvidenceDocument;
    const validated = validateEvidenceDocument(
      replacement,
      new Date("2030-01-01T00:00:00.000Z"),
      [canonicalFixture],
    );

    expect(validated.statements.map(statementSlot)).toEqual([
      ["CUSTOMER_CLAIM", "item-1"],
      ["CUSTOMER_CLAIM", "item-2"],
      ["CUSTOMER_CLAIM", "item-3"],
    ]);
  });

  const packedManifest = [
    {
      conditions: ["sealed", "warm"],
      item_id: "item-1",
      name: "Pho",
      permitted_substitutions: ["Bun bo"],
      price_wei: "400",
      quantity: 1,
    },
    {
      conditions: [],
      item_id: "item-2",
      name: "Tea",
      permitted_substitutions: [],
      price_wei: "100",
      quantity: 1,
    },
  ] satisfies OrderItem[];
  const packedStatement = {
    effective_action: "PACKED",
    item_observations: [
      {
        condition_statuses: [
          { condition_index: 0, status: "MET" },
          { condition_index: 1, status: "UNKNOWN" },
        ],
        item_id: "item-1",
        item_status: "PERMITTED_SUBSTITUTION",
        quantity_status: "EXACT",
        substitution_index: 0,
      },
      {
        condition_statuses: [],
        item_id: "item-2",
        item_status: "UNKNOWN",
        quantity_status: "UNKNOWN",
        substitution_index: -1,
      },
    ],
  } satisfies CorrectionStatement;
  const packedTarget = { ...validEvidence, action: "PACKED" as const };

  async function packedBatch(statement: CorrectionStatement): Promise<EvidenceDocument> {
    const preimage = {
      ...canonicalFixture,
      statements: [statement],
      supersedes_evidence_indices: [3],
      sha256: `0x${"0".repeat(64)}` as HexDigest,
    } satisfies EvidenceDocument;
    return { ...preimage, sha256: await hashEvidence(preimage) };
  }

  it("binds PACKED correction observations to the real manifest order and bounds", async () => {
    const document = await packedBatch(packedStatement);
    expect(validateEvidenceDocument(
      document,
      new Date("2030-01-01T00:00:00.000Z"),
      [packedTarget],
      packedManifest,
    )).toEqual(document);
  });

  it.each([
    ["reordered manifest observations", {
      ...packedStatement,
      item_observations: [...packedStatement.item_observations].reverse(),
    }],
    ["missing manifest observation", {
      ...packedStatement,
      item_observations: packedStatement.item_observations.slice(0, 1),
    }],
    ["substitution index beyond the permitted set", {
      ...packedStatement,
      item_observations: [
        { ...packedStatement.item_observations[0], substitution_index: 1 },
        packedStatement.item_observations[1],
      ],
    }],
    ["wrong condition count", {
      ...packedStatement,
      item_observations: [
        { ...packedStatement.item_observations[0], condition_statuses: packedStatement.item_observations[0].condition_statuses.slice(0, 1) },
        packedStatement.item_observations[1],
      ],
    }],
  ])("rejects PACKED correction facts with %s", async (_name, statement) => {
    const document = await packedBatch(statement as CorrectionStatement);
    expect(() => validateEvidenceDocument(
      document,
      new Date("2030-01-01T00:00:00.000Z"),
      [packedTarget],
      packedManifest,
    )).toThrow(TypeError);
  });

  it("rejects a non-positional PACKED condition index before hashing", async () => {
    await expect(packedBatch({
      ...packedStatement,
      item_observations: [
        {
          ...packedStatement.item_observations[0],
          condition_statuses: [
            packedStatement.item_observations[0].condition_statuses[0],
            { condition_index: 2, status: "UNKNOWN" as const },
          ],
        },
        packedStatement.item_observations[1],
      ],
    })).rejects.toThrow(TypeError);
  });
});

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

  it("rejects evidence at the exact expiry boundary", () => {
    expect(() => validateEvidenceDocument(
      validEvidence,
      new Date(validEvidence.expires_at),
    )).toThrow(TypeError);
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
    const indexedBytes = execFileSync("git", ["show", `:public/evidence/${name}`]);
    const expectedFileBytes = Buffer.from(`${canonicalEnvelope}\n`, "utf8");

    expect(fixture.sha256).toBe(expectedDigest);
    expect(await hashEvidence(fixture)).toBe(expectedDigest);
    expect(validateEvidenceDocument(fixture, new Date("2030-01-01T00:00:00.000Z"))).toEqual(fixture);
    expect(indexedBytes.equals(expectedFileBytes)).toBe(true);
    expect(committedBytes.equals(expectedFileBytes)).toBe(true);
  });

  it("forces LF checkout bytes for every evidence fixture", () => {
    const paths = fixtures.map(([name]) => `public/evidence/${name}`);
    const values = execFileSync("git", ["check-attr", "-z", "text", "eol", "--", ...paths], {
      encoding: "utf8",
    }).split("\0").filter(Boolean);
    const attributes = new Map<string, Record<string, string>>();

    for (let index = 0; index < values.length; index += 3) {
      const [path, attribute, value] = values.slice(index, index + 3);
      attributes.set(path, { ...attributes.get(path), [attribute]: value });
    }

    for (const path of paths) {
      expect(attributes.get(path)).toEqual({ eol: "lf", text: "set" });
    }
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
