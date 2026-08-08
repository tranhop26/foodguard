import { createHash } from "node:crypto";

import type { Locator, Page } from "@playwright/test";
import { abi } from "genlayer-js";

export type FoodGuardBrowserScenario =
  | "consensus-failed"
  | "create-preview"
  | "happy-path"
  | "ready-for-pickup"
  | "unresolved";

const CONTRACT = "0x4444444444444444444444444444444444444444";
const CUSTOMER = "0x1111111111111111111111111111111111111111";
const RESTAURANT = "0x2222222222222222222222222222222222222222";
const COURIER = "0x3333333333333333333333333333333333333333";
const TRANSACTION_HASH = `0x${"9".repeat(64)}`;
const CHAIN_NOW_SECONDS = 2_000_000_000;

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
  envelope_json: canonical(evidenceEnvelope),
} satisfies Json;
const matchedResolution = {
  delivery_outcome: "DELIVERED",
  evidence_hashes: [evidenceEnvelope.sha256],
  items: [{ facts: ["Local deterministic E2E fixture"], item_id: "item-1", outcome: "MATCHED" }],
} satisfies Json;
const unresolvedResolution = {
  delivery_outcome: "UNRESOLVED",
  evidence_hashes: [],
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

function baseOrder(state: "EVIDENCE_CURE" | "READY_FOR_PICKUP" | "RESOLVED" | "SETTLED") {
  const settledState = state === "SETTLED";
  return {
    acceptance_deadline: "1999999000",
    appeal_deadline: state === "EVIDENCE_CURE" ? "2000000300" : "1999999800",
    courier: COURIER,
    courier_accepted: true,
    customer: CUSTOMER,
    delivery_deadline: "1999999400",
    delivery_fee: "30",
    delivery_settled: settledState,
    items_settled: settledState,
    manifest_json: canonical(manifest),
    order_id: "fg-1",
    packing_deadline: "1999999200",
    refund_emitted: false,
    restaurant: RESTAURANT,
    restaurant_accepted: true,
    review_deadline: "1999999600",
    state,
    subtotal: "100",
    total_value: "130",
  } satisfies Json;
}

function rpcBlock() {
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
    timestamp: `0x${CHAIN_NOW_SECONDS.toString(16)}`,
    totalDifficulty: "0x0",
    transactions: [],
    transactionsRoot: hash("f"),
    uncles: [],
  };
}

function encodedResult(value: Json): string {
  return Buffer.from(abi.calldata.encode(value)).toString("hex");
}

function contractMethod(data: string): string {
  const decoded = Buffer.from(data.slice(2), "hex").toString("utf8");
  const methods = [
    "get_settlement_proposal",
    "get_order_settlement",
    "get_evidence_count",
    "get_resolution",
    "get_evidence",
    "get_round",
    "get_order",
  ];
  const method = methods.find((candidate) => decoded.includes(candidate));
  if (!method) throw new Error("Unexpected mocked GenLayer contract call");
  return method;
}

function transactionResult(status: "FINALIZED" | "UNDETERMINED") {
  return {
    blockHash: null,
    blockNumber: null,
    from: CUSTOMER,
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
      callData: { args: ["fg-1"], method: status === "FINALIZED" ? "execute_settlement" : "request_resolution" },
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
  await page.addInitScript(({ walletAccount, transactionHash }) => {
    type WalletRequest = { method: string; params?: unknown };
    const provider = {
      async request({ method }: WalletRequest) {
        if (method === "eth_chainId") return "0xf22f";
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [walletAccount];
        if (method === "eth_sendTransaction") return transactionHash;
        throw new Error(`Unexpected local E2E wallet method: ${method}`);
      },
      on() {},
      removeListener() {},
    };
    (window as typeof window & { ethereum?: typeof provider }).ethereum = provider;
  }, { transactionHash: TRANSACTION_HASH, walletAccount: account });

  let settlementExecuted = false;
  await page.route("https://studio.genlayer.com/api", async (route) => {
    const request = route.request();
    const payload = request.postDataJSON() as {
      id: number;
      method: string;
      params: Array<Record<string, unknown> | string>;
    };
    let result: unknown;

    if (payload.method === "eth_getBlockByNumber") result = rpcBlock();
    else if (payload.method === "eth_getTransactionCount") result = "0x0";
    else if (payload.method === "eth_estimateGas") result = "0x30d40";
    else if (payload.method === "eth_gasPrice") result = "0x1";
    else if (payload.method === "eth_getTransactionByHash") {
      const failed = scenario === "consensus-failed";
      settlementExecuted = !failed;
      result = transactionResult(failed ? "UNDETERMINED" : "FINALIZED");
    } else if (payload.method === "gen_call") {
      const first = payload.params[0];
      if (typeof first !== "object" || first === null || typeof first.data !== "string") {
        throw new Error("Malformed local E2E gen_call request");
      }
      const method = contractMethod(first.data);
      const unresolved = scenario === "unresolved" || scenario === "consensus-failed";
      const state = unresolved
        ? "EVIDENCE_CURE"
        : scenario === "ready-for-pickup"
          ? "READY_FOR_PICKUP"
          : settlementExecuted
            ? "SETTLED"
            : "RESOLVED";
      const values: Record<string, Json> = {
        get_evidence: evidenceRecord,
        get_evidence_count: unresolved || scenario === "ready-for-pickup" ? 0 : 1,
        get_order: baseOrder(state),
        get_order_settlement: settlement,
        get_resolution: canonical(unresolved ? unresolvedResolution : matchedResolution),
        get_round: unresolved || state === "RESOLVED" || state === "SETTLED" ? 1 : 0,
        get_settlement_proposal: {},
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
