import { createHash } from "node:crypto";

import type { Locator, Page } from "@playwright/test";
import { abi } from "genlayer-js";

export type FoodGuardBrowserScenario =
  | "accept-transport-failure"
  | "batch-cure"
  | "consensus-failed"
  | "create-preview"
  | "escalated"
  | "happy-path"
  | "participant-cancellation"
  | "ready-for-pickup"
  | "unresolved";

const CONTRACT = "0x4444444444444444444444444444444444444444";
const CUSTOMER = "0x1111111111111111111111111111111111111111";
const RESTAURANT = "0x2222222222222222222222222222222222222222";
const COURIER = "0x3333333333333333333333333333333333333333";
const TRANSACTION_HASH = `0x${"9".repeat(64)}`;
const CHAIN_NOW_SECONDS = 2_000_000_000;
const BATCH_CHAIN_NOW_SECONDS = 1_893_456_000;
const BATCH_ORDER_ID = "fg-batch-1";
const BATCH_SOURCE_URL = "https://app.foodguard.vn/evidence/order-fg-batch-1-cure-batch.json";

type Json = boolean | null | number | string | Json[] | { [key: string]: Json };

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value: Json | string): string {
  return `0x${createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex")}`;
}

const manifest = {
  items: [
    {
      conditions: ["served warm"],
      item_id: "item-1",
      name: "Broken rice plate",
      permitted_substitutions: [],
      price_wei: "100",
      quantity: 1,
    },
  ],
} satisfies Json;

const batchManifest = {
  items: [
    ...manifest.items,
    {
      conditions: [],
      item_id: "item-2",
      name: "Kumquat tea",
      permitted_substitutions: [],
      price_wei: "20",
      quantity: 1,
    },
    {
      conditions: [],
      item_id: "item-3",
      name: "Dessert",
      permitted_substitutions: [],
      price_wei: "50",
      quantity: 1,
    },
  ],
} satisfies Json;

const evidencePreimage = {
  action: "DELIVERED",
  actor_wallet: COURIER,
  chain_id: "61999",
  contract_address: CONTRACT,
  delivery_observation: "HANDOFF_CONFIRMED",
  expires_at: "2030-01-02T00:00:00.000Z",
  issuer_id: "foodguard-e2e-local-fixture",
  nonce: "e2e-delivered-1",
  observed_at: "2030-01-01T00:00:00.000Z",
  order_id: "fg-1",
  schema_version: "foodguard-evidence/1",
  source_url: "https://app.foodguard.vn/evidence/order-fg-demo-delivered.json",
  subject: "order:fg-1",
  submitted_at: "2030-01-01T00:00:01.000Z",
} satisfies Json;
const evidenceEnvelope = {
  ...evidencePreimage,
  sha256: sha256(evidencePreimage),
} satisfies Json;
const evidenceRecord = {
  ...evidenceEnvelope,
  effective_action: "DELIVERED",
  envelope_json: canonical(evidenceEnvelope),
  item_id: "",
} satisfies Json;

function batchBaseEvidence(
  action: "PACKED" | "PICKED_UP" | "DELIVERED" | "CUSTOMER_CLAIM",
  actor: string,
  nonce: string,
  facts: Record<string, Json> = {},
) {
  const itemId = typeof facts.item_id === "string" ? facts.item_id : "";
  const preimage = {
    action,
    actor_wallet: actor,
    chain_id: "61999",
    contract_address: CONTRACT,
    expires_at: "2030-01-02T01:00:00.000Z",
    issuer_id: "foodguard-e2e-local-fixture",
    nonce,
    observed_at: "2030-01-01T00:00:00.000Z",
    order_id: BATCH_ORDER_ID,
    schema_version: "foodguard-evidence/1",
    source_url: `https://app.foodguard.vn/evidence/${nonce}.json`,
    subject: itemId ? `order:${BATCH_ORDER_ID}/item:${itemId}` : `order:${BATCH_ORDER_ID}`,
    submitted_at: "2030-01-01T00:00:01.000Z",
    ...facts,
  } satisfies Json;
  const envelope = { ...preimage, sha256: sha256(preimage) } satisfies Json;
  return {
    ...envelope,
    effective_action: action,
    envelope_json: canonical(envelope),
    item_id: itemId,
  } satisfies Json;
}

const batchInitialEvidence = [
  batchBaseEvidence("PACKED", RESTAURANT, "e2e-batch-packed", {
    item_observations: batchManifest.items.map((item) => ({
      condition_statuses: item.conditions.map((_condition, conditionIndex) => ({
        condition_index: conditionIndex,
        status: "MET",
      })),
      item_id: item.item_id,
      item_status: "AS_ORDERED",
      quantity_status: "EXACT",
      substitution_index: -1,
    })),
  }),
  batchBaseEvidence("PICKED_UP", COURIER, "e2e-batch-pickup", {
    pickup_observation: "PICKUP_CONFIRMED",
  }),
  batchBaseEvidence("DELIVERED", COURIER, "e2e-batch-delivered", {
    delivery_observation: "HANDOFF_CONFIRMED",
  }),
  ...batchManifest.items.map((item, index) => batchBaseEvidence(
    "CUSTOMER_CLAIM",
    CUSTOMER,
    `e2e-batch-claim-${index + 1}`,
    {
      claim_category: index === 0 ? "ABSENT_AT_RECEIPT" : index === 1 ? "NOT_AS_ORDERED" : "HANDOFF_NOT_RECEIVED",
      criterion_index: index === 2 ? -1 : 0,
      criterion_kind: index === 0 ? "ITEM" : index === 1 ? "QUANTITY" : "DELIVERY",
      item_id: item.item_id,
    },
  )),
] satisfies Json[];

const expectedBatchPublicDocument = canonical({
  action: "CURE",
  actor_wallet: CUSTOMER,
  chain_id: "61999",
  contract_address: CONTRACT,
  expires_at: "2030-01-02T00:13:20.000Z",
  issuer_id: "foodguard-web",
  nonce: "000102030405060708090a0b0c0d0e0f",
  observed_at: "2030-01-01T00:00:00.000Z",
  order_id: BATCH_ORDER_ID,
  schema_version: "foodguard-evidence/1",
  source_url: BATCH_SOURCE_URL,
  statements: [
    { claim_category: "ABSENT_AT_RECEIPT", criterion_index: 0, criterion_kind: "ITEM", effective_action: "CUSTOMER_CLAIM", item_id: "item-1" },
    { claim_category: "NOT_AS_ORDERED", criterion_index: 0, criterion_kind: "QUANTITY", effective_action: "CUSTOMER_CLAIM", item_id: "item-2" },
    { claim_category: "HANDOFF_NOT_RECEIVED", criterion_index: -1, criterion_kind: "DELIVERY", effective_action: "CUSTOMER_CLAIM", item_id: "item-3" },
  ],
  subject: `order:${BATCH_ORDER_ID}`,
  submitted_at: "2030-01-01T00:00:00.000Z",
  supersedes_evidence_indices: [3, 4, 5],
});
const expectedBatchEnvelope = {
  ...(JSON.parse(expectedBatchPublicDocument) as Record<string, Json>),
  sha256: sha256(expectedBatchPublicDocument),
} satisfies Json;
const expectedBatchEnvelopeJson = canonical(expectedBatchEnvelope);
const batchEvidenceRecord = {
  ...expectedBatchEnvelope,
  effective_action: "BATCH_CORRECTION",
  envelope_json: expectedBatchEnvelopeJson,
  item_id: "",
} satisfies Json;
const matchedResolution = {
  delivery_outcome: "DELIVERED",
  evidence_hashes: [evidenceEnvelope.sha256],
  evidence_indices: [0],
  items: [{ facts: ["Local deterministic E2E fixture"], item_id: "item-1", outcome: "MATCHED" }],
} satisfies Json;
const unresolvedResolution = {
  delivery_outcome: "UNRESOLVED",
  evidence_hashes: [],
  evidence_indices: [],
  items: [{ facts: ["Fixture validators require more evidence"], item_id: "item-1", outcome: "UNRESOLVED" }],
} satisfies Json;
const settlementWithoutId = {
  courier_wei: "30",
  customer_wei: "0",
  restaurant_wei: "100",
} satisfies Json;
const settlement = {
  ...settlementWithoutId,
  settlement_id: sha256({
    basis: `resolution:${sha256(matchedResolution)}`,
    chain_id: "61999",
    contract_address: CONTRACT,
    ...settlementWithoutId,
    order_id: "fg-1",
    schema_version: "foodguard-settlement-v1",
  }),
} satisfies Json;
const cancellationSettlementWithoutId = {
  courier_wei: "0",
  customer_wei: "130",
  restaurant_wei: "0",
} satisfies Json;
const cancellationSettlement = {
  ...cancellationSettlementWithoutId,
  settlement_id: sha256({
    basis: "participant-cancellation-before-packed",
    chain_id: "61999",
    contract_address: CONTRACT,
    ...cancellationSettlementWithoutId,
    order_id: "fg-1",
    schema_version: "foodguard-settlement-v1",
  }),
} satisfies Json;

function baseOrder(
  state: "EVIDENCE_CURE" | "ESCALATED" | "READY_FOR_PICKUP" | "RESOLVED" | "SETTLED",
  settlementWindowExpired = false,
  batch = false,
) {
  const settledState = state === "SETTLED";
  const deadlines = batch
    ? {
        acceptance: "1893455000",
        appeal: "1893456800",
        delivery: "1893455400",
        packing: "1893455200",
        review: "1893456600",
      }
    : settlementWindowExpired
    ? {
        acceptance: "1999999000",
        appeal: "1999999800",
        delivery: "1999999400",
        packing: "1999999200",
        review: "1999999600",
      }
    : {
        acceptance: "2000000100",
        appeal: "2000000800",
        delivery: "2000000400",
        packing: "2000000200",
        review: "2000000600",
      };
  return {
    acceptance_deadline: deadlines.acceptance,
    appeal_deadline: deadlines.appeal,
    courier: COURIER,
    courier_accepted: true,
    customer: CUSTOMER,
    delivery_deadline: deadlines.delivery,
    delivery_fee: "30",
    delivery_settled: settledState,
    items_settled: settledState,
    manifest_json: canonical(batch ? batchManifest : manifest),
    order_id: batch ? BATCH_ORDER_ID : "fg-1",
    packing_deadline: deadlines.packing,
    refund_emitted: false,
    restaurant: RESTAURANT,
    restaurant_accepted: true,
    review_deadline: deadlines.review,
    state,
    subtotal: batch ? "170" : "100",
    total_value: batch ? "200" : "130",
  } satisfies Json;
}

function rpcBlock(timestamp = CHAIN_NOW_SECONDS) {
  const zeroBloom = `0x${"0".repeat(512)}`;
  const hash = (character: string) => `0x${character.repeat(64)}`;
  return {
    baseFeePerGas: "0x1",
    difficulty: "0x0",
    extraData: "0x",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    hash: hash("a"),
    logsBloom: zeroBloom,
    miner: `0x${"0".repeat(40)}`,
    mixHash: hash("0"),
    nonce: "0x0000000000000000",
    number: "0x1",
    parentHash: hash("b"),
    receiptsRoot: hash("c"),
    sha3Uncles: hash("d"),
    size: "0x1",
    stateRoot: hash("e"),
    timestamp: `0x${timestamp.toString(16)}`,
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: hash("f"),
    uncles: [],
  };
}

function encodedResult(value: Json): string {
  return Buffer.from(abi.calldata.encode(value)).toString("hex");
}

function contractCall(data: string): { args: Json[]; contract?: string; method: string } {
  const raw = data.slice(2);
  let calldata: string;
  let contract: string | undefined;
  if (raw.startsWith("27241a99")) {
    const argumentsHex = raw.slice(8);
    contract = `0x${argumentsHex.slice(64 + 24, 2 * 64)}`;
    const offset = Number.parseInt(argumentsHex.slice(4 * 64, 5 * 64), 16) * 2;
    const length = Number.parseInt(argumentsHex.slice(offset, offset + 64), 16) * 2;
    const framed = argumentsHex.slice(offset + 64, offset + 64 + length);
    const mapStart = framed.indexOf("160461726773");
    if (mapStart < 0 || !framed.endsWith("00")) throw new Error("Malformed local E2E wallet calldata");
    calldata = framed.slice(mapStart, -2);
  } else {
    if (!raw.endsWith("00")) throw new Error("Malformed local E2E read calldata");
    calldata = raw.slice(4, -2);
  }
  const decoded = abi.calldata.decode(Uint8Array.from(Buffer.from(calldata, "hex")));
  const methodValue = decoded instanceof Map ? decoded.get("method") : undefined;
  const argsValue = decoded instanceof Map ? decoded.get("args") : undefined;
  const methods = [
    "accept_restaurant",
    "cancel_before_packed",
    "submit_cure_evidence",
    "get_settlement_proposal_count",
    "get_settlement_proposal_digest",
    "get_settlement_proposal",
    "get_order_settlement",
    "get_creation_paused",
    "get_evidence_count",
    "get_resolution",
    "get_evidence",
    "get_round",
    "get_order",
  ];
  const method = methods.find((candidate) => methodValue === candidate);
  if (!method) throw new Error("Unexpected mocked GenLayer contract call");
  if (argsValue !== undefined && !Array.isArray(argsValue)) throw new Error("Malformed mocked GenLayer contract call args");
  return { args: (argsValue ?? []) as Json[], contract, method };
}

function transactionResult(
  status: "FINALIZED" | "UNDETERMINED",
  method = "execute_settlement",
  args: Json[] = ["fg-1"],
  from = CUSTOMER,
) {
  return {
    blockHash: null,
    blockNumber: null,
    from,
    gas: "0x30d40",
    gasPrice: "0x1",
    hash: TRANSACTION_HASH,
    input: "0x",
    nonce: "0x0",
    r: `0x${"1".repeat(64)}`,
    s: `0x${"2".repeat(64)}`,
    status,
    to: CONTRACT,
    transactionIndex: null,
    txDataDecoded: {
      callData: { args, method: status === "FINALIZED" ? method : "request_resolution" },
      leaderOnly: false,
      type: "call",
    },
    txExecutionResultName: status === "FINALIZED" ? "FINISHED_WITH_RETURN" : "NOT_VOTED",
    type: "0x0",
    v: "0x1",
    value: "0x0",
  };
}

function scenarioAccount(scenario: FoodGuardBrowserScenario): string {
  if (scenario === "accept-transport-failure" || scenario === "participant-cancellation") return RESTAURANT;
  if (scenario === "ready-for-pickup") return COURIER;
  if (scenario === "unresolved") return RESTAURANT;
  return CUSTOMER;
}

/**
 * Installs deterministic local wallet and RPC doubles at the external boundary.
 * This verifies the real browser application, but is never live StudioNet proof.
 */
export async function installWalletAndRpcFixture(page: Page, scenario: FoodGuardBrowserScenario) {
  const account = scenarioAccount(scenario);
  const walletWrites: Array<{ args: Json[]; method: string }> = [];
  let batchWritten = false;
  let participantCancellationWriteValid = false;
  await page.exposeFunction("__foodGuardRecordWrite", (params: unknown) => {
    if (!Array.isArray(params) || typeof params[0] !== "object" || params[0] === null) {
      throw new Error("Malformed local E2E wallet write");
    }
    const transaction = params[0] as { data?: unknown; from?: unknown; to?: unknown };
    const data = transaction.data;
    if (typeof data !== "string") throw new Error("Local E2E wallet write calldata is missing");
    const call = contractCall(data);
    walletWrites.push({ args: call.args, method: call.method });
    if (call.method === "submit_cure_evidence") batchWritten = true;
    if (call.method === "cancel_before_packed") {
      participantCancellationWriteValid = (
        call.args.length === 1 &&
        call.args[0] === "fg-1" &&
        typeof transaction.from === "string" &&
        transaction.from.toLowerCase() === RESTAURANT.toLowerCase() &&
        call.contract?.toLowerCase() === CONTRACT.toLowerCase()
      );
    }
  });
  const recordsWalletWrites = (
    scenario === "accept-transport-failure" ||
    scenario === "batch-cure" ||
    scenario === "participant-cancellation"
  );
  await page.addInitScript(({ deterministicBatch, failAfterRecordedWrite, recordWalletWrites, walletAccount, transactionHash }) => {
    type WalletRequest = { method: string; params?: unknown };
    const provider = {
      async request({ method, params }: WalletRequest) {
        if (method === "eth_chainId") return "0xf22f";
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [walletAccount];
        if (method === "eth_sendTransaction") {
          if (recordWalletWrites) {
            await (window as typeof window & { __foodGuardRecordWrite(params: unknown): Promise<void> }).__foodGuardRecordWrite(params);
          }
          if (failAfterRecordedWrite) throw new TypeError("Failed to fetch");
          return transactionHash;
        }
        throw new Error(`Unexpected local E2E wallet method: ${method}`);
      },
      on() {},
      removeListener() {},
    };
    if (deterministicBatch) {
      Object.defineProperty(window.performance, "now", { configurable: true, value: () => 1_000 });
      Object.defineProperty(window.crypto, "getRandomValues", {
        configurable: true,
        value: (values: Uint8Array) => {
          values.forEach((_value, index) => { values[index] = index; });
          return values;
        },
      });
    }
    (window as typeof window & { ethereum?: typeof provider }).ethereum = provider;
  }, {
    deterministicBatch: scenario === "batch-cure",
    failAfterRecordedWrite: scenario === "accept-transport-failure",
    recordWalletWrites: recordsWalletWrites,
    transactionHash: TRANSACTION_HASH,
    walletAccount: account,
  });

  if (scenario === "batch-cure") {
    await page.route(BATCH_SOURCE_URL, async (route) => {
      await route.fulfill({ body: expectedBatchPublicDocument, contentType: "application/json", status: 200 });
    });
  }

  let settlementExecuted = false;
  let participantCancellationFinalized = false;
  let acceptanceReadbackCount = 0;
  await page.route("https://studio.genlayer.com/api", async (route) => {
    const request = route.request();
    const payload = request.postDataJSON() as {
      id: number;
      method: string;
      params: Array<Record<string, unknown> | string>;
    };
    let result: unknown;

    if (payload.method === "eth_getBlockByNumber") result = rpcBlock(scenario === "batch-cure" ? BATCH_CHAIN_NOW_SECONDS : CHAIN_NOW_SECONDS);
    else if (payload.method === "eth_getTransactionCount") result = "0x0";
    else if (payload.method === "eth_estimateGas") result = "0x30d40";
    else if (payload.method === "eth_gasPrice") result = "0x1";
    else if (payload.method === "eth_getTransactionByHash") {
      const failed = scenario === "consensus-failed";
      const exactCancellationWrite = (
        participantCancellationWriteValid &&
        walletWrites.length === 1 &&
        walletWrites.some((write) => (
          write.method === "cancel_before_packed" &&
          write.args.length === 1 &&
          write.args[0] === "fg-1"
        ))
      );
      if (scenario === "participant-cancellation") {
        if (payload.params[0] === TRANSACTION_HASH && exactCancellationWrite) {
          participantCancellationFinalized = true;
          result = transactionResult("FINALIZED", "cancel_before_packed", ["fg-1"], RESTAURANT);
        } else {
          result = null;
        }
      } else {
        settlementExecuted = !failed;
        result = scenario === "batch-cure"
          ? transactionResult("FINALIZED", "submit_cure_evidence", [BATCH_ORDER_ID, expectedBatchEnvelopeJson])
          : transactionResult(failed ? "UNDETERMINED" : "FINALIZED");
      }
    } else if (payload.method === "gen_call") {
      const first = payload.params[0];
      if (typeof first !== "object" || first === null || typeof first.data !== "string") {
        throw new Error("Malformed local E2E gen_call request");
      }
      if (
        (scenario === "accept-transport-failure" || scenario === "participant-cancellation") &&
        first.transaction_hash_variant !== "latest-final"
      ) {
        throw new Error("Deterministic recovery readback must use latest-final");
      }
      const { args, method } = contractCall(first.data);
      if (
        scenario === "participant-cancellation" &&
        method === "get_order_settlement" &&
        !participantCancellationFinalized
      ) {
        await route.fulfill({
          body: JSON.stringify({
            error: { code: -32000, message: "[EXPECTED] settlement not found" },
            id: payload.id,
            jsonrpc: "2.0",
          }),
          contentType: "application/json",
          status: 200,
        });
        return;
      }
      const unresolved = scenario === "batch-cure" || scenario === "unresolved" || scenario === "consensus-failed" || scenario === "escalated";
      const preResolution = scenario === "accept-transport-failure" || scenario === "participant-cancellation";
      const recordedAcceptance = walletWrites.some((write) => (
        write.method === "accept_restaurant" &&
        write.args.length === 1 &&
        write.args[0] === "fg-1"
      ));
      if (scenario === "accept-transport-failure" && method === "get_order" && recordedAcceptance) {
        acceptanceReadbackCount += 1;
      }
      const acceptanceVisible = recordedAcceptance && acceptanceReadbackCount >= 2;
      const fundedOrder = {
        ...baseOrder("RESOLVED"),
        courier_accepted: false,
        restaurant_accepted: false,
        state: "FUNDED",
      } satisfies Json;
      const partiallyAcceptedOrder = {
        ...fundedOrder,
        restaurant_accepted: true,
        state: "PARTIALLY_ACCEPTED",
      } satisfies Json;
      const cancelledOrder = {
        ...partiallyAcceptedOrder,
        courier_accepted: false,
        delivery_settled: true,
        items_settled: true,
        refund_emitted: true,
        restaurant_accepted: false,
        state: "CANCELLED_REFUNDED",
      } satisfies Json;
      const state = unresolved
        ? scenario === "escalated" ? "ESCALATED" : "EVIDENCE_CURE"
        : scenario === "ready-for-pickup"
          ? "READY_FOR_PICKUP"
          : settlementExecuted
            ? "SETTLED"
            : "RESOLVED";
      const order = scenario === "accept-transport-failure"
        ? acceptanceVisible ? partiallyAcceptedOrder : fundedOrder
        : scenario === "participant-cancellation"
          ? participantCancellationFinalized ? cancelledOrder : partiallyAcceptedOrder
          : baseOrder(state, scenario === "happy-path" || scenario === "escalated", scenario === "batch-cure");
      const values: Record<string, Json> = {
        get_evidence: scenario === "batch-cure"
          ? (batchWritten && Number(args[1]) === 6 ? batchEvidenceRecord : batchInitialEvidence[Number(args[1])])
          : evidenceRecord,
        get_evidence_count: scenario === "batch-cure" ? (batchWritten ? 7 : 6) : unresolved || scenario === "ready-for-pickup" || preResolution ? 0 : 1,
        get_creation_paused: false,
        get_order: order,
        get_order_settlement: scenario === "participant-cancellation" ? cancellationSettlement : settlement,
        get_resolution: canonical(scenario === "batch-cure" ? {
          delivery_outcome: "UNRESOLVED",
          evidence_hashes: batchInitialEvidence.map((record) => record.sha256),
          evidence_indices: [0, 1, 2, 3, 4, 5],
          items: batchManifest.items.map((item) => ({ facts: ["Local deterministic stale claim"], item_id: item.item_id, outcome: "UNRESOLVED" })),
        } : unresolved ? unresolvedResolution : matchedResolution),
        get_round: scenario === "escalated" ? 2 : preResolution ? 0 : unresolved || state === "RESOLVED" || state === "SETTLED" ? 1 : 0,
        get_settlement_proposal: {},
        get_settlement_proposal_count: 0,
        get_settlement_proposal_digest: "",
      };
      result = encodedResult(values[method]);
    } else {
      throw new Error(`Unexpected local E2E RPC method: ${payload.method}`);
    }

    await route.fulfill({
      body: JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }),
      contentType: "application/json",
      status: 200,
    });
  });

  return {
    expectedEnvelopeJson: expectedBatchEnvelopeJson,
    expectedPublicDocument: expectedBatchPublicDocument,
    sourceUrl: BATCH_SOURCE_URL,
    walletWrites,
  };
}

export function trackConsoleErrors(page: Page, allowed: RegExp[] = []): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!allowed.some((pattern) => pattern.test(text))) errors.push(text);
  });
  page.on("pageerror", (error) => {
    if (!allowed.some((pattern) => pattern.test(error.message))) errors.push(error.message);
  });
  return errors;
}

export async function focusByKeyboard(page: Page, target: Locator, maximumTabs: number): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus did not reach the target within ${maximumTabs} Tab presses`);
}
