// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const genlayerMocks = vi.hoisted(() => ({
  readFoodGuard: vi.fn(),
  trackTransaction: vi.fn(),
  writeFoodGuard: vi.fn(),
}));

vi.mock("../../lib/genlayer/client", () => ({
  readFoodGuard: genlayerMocks.readFoodGuard,
  writeFoodGuard: genlayerMocks.writeFoodGuard,
}));
vi.mock("../../lib/genlayer/transactions", () => ({
  trackTransaction: genlayerMocks.trackTransaction,
}));

import { AppealPanel } from "../../components/order/AppealPanel";
import {
  authoritativeNowMs,
  MAX_CHAIN_SAMPLE_AGE_MS,
} from "../../components/order/authoritativeClock";
import { ConsensusPanel } from "../../components/order/ConsensusPanel";
import { EvidenceDrawer } from "../../components/order/EvidenceDrawer";
import { ItemOutcomeTable, type OrderDetailView } from "../../components/order/ItemOutcomeTable";
import { OrderTimeline } from "../../components/order/OrderTimeline";
import { TransactionLifecycle } from "../../components/order/TransactionLifecycle";
import { LocaleProvider, type Locale } from "../../lib/i18n";
import type { EvidenceDocument } from "../../lib/domain";
import { canonicalizeEvidenceEnvelope, hashEvidence } from "../../lib/evidence";
import {
  OrderDetailWorkspace,
  readAuthoritativeOrder,
  transactAndRead,
  type OrderDetailWorkspaceConfiguration,
} from "../../app/orders/[id]/page";
import { ProofView } from "../../app/orders/[id]/proof/page";

const CUSTOMER = "0x1111111111111111111111111111111111111111";
const RESTAURANT = "0x2222222222222222222222222222222222222222";
const COURIER = "0x3333333333333333333333333333333333333333";

const BASE_ORDER = {
  acceptance_deadline: "1893456000",
  appeal_deadline: "1893463200",
  courier: COURIER,
  courier_accepted: true,
  customer: CUSTOMER,
  delivery_deadline: "1893459600",
  delivery_fee: "50",
  delivery_settled: false,
  items_settled: false,
  refund_emitted: false,
  manifest_json: JSON.stringify({
    items: [
      {
        conditions: ["sealed"],
        item_id: "item-1",
        name: "Pho",
        permitted_substitutions: [],
        price_wei: "400",
        quantity: 2,
      },
      {
        conditions: [],
        item_id: "item-2",
        name: "Tea",
        permitted_substitutions: [],
        price_wei: "100",
        quantity: 1,
      },
    ],
  }),
  order_id: "fg-mixed",
  packing_deadline: "1893457800",
  restaurant: RESTAURANT,
  restaurant_accepted: true,
  review_deadline: "1893461400",
  state: "RESOLVED" as const,
  subtotal: "900",
  total_value: "950",
} satisfies Omit<OrderDetailView, "resolution">;

const MIXED_OUTCOME_ORDER: OrderDetailView = {
  ...BASE_ORDER,
  resolution: {
    delivery_outcome: "DELIVERY_FAILED",
    evidence_hashes: ["0x" + "ab".repeat(32)],
    items: [
      { facts: ["sealed package"], item_id: "item-1", outcome: "MATCHED" },
      { facts: ["not received"], item_id: "item-2", outcome: "MISSING" },
    ],
  },
};

const UNRESOLVED_ORDER: OrderDetailView = {
  ...BASE_ORDER,
  resolution: {
    delivery_outcome: "UNRESOLVED",
    evidence_hashes: [],
    items: [
      { facts: ["insufficient evidence"], item_id: "item-1", outcome: "UNRESOLVED" },
      { facts: [], item_id: "item-2", outcome: "UNRESOLVED" },
    ],
  },
  state: "EVIDENCE_CURE",
};

const EXPIRED_APPEAL_ORDER: OrderDetailView = {
  ...MIXED_OUTCOME_ORDER,
  appeal_deadline: "1700000000",
};

function renderLocalized(node: React.ReactNode, locale: Locale) {
  return render(
    <LocaleProvider hasExplicitLocale initialLocale={locale}>
      {node}
    </LocaleProvider>,
  );
}

function testClock(seconds: bigint) {
  return { sampledAtMonotonicMs: performance.now(), seconds };
}

async function storedPackedEvidence() {
  const preimage = {
    action: "PACKED",
    actor_wallet: RESTAURANT,
    chain_id: "61999",
    contract_address: "0x4444444444444444444444444444444444444444",
    expires_at: "2030-01-02T02:00:00.000Z",
    issuer_id: "foodguard-web",
    item_observations: [
      { item_id: "item-1", observation: "PACKED_AS_ORDERED" },
      { item_id: "item-2", observation: "PACKED_AS_ORDERED" },
    ],
    nonce: "packed-readback",
    observed_at: "2030-01-01T00:00:00.000Z",
    order_id: "fg-mixed",
    schema_version: "foodguard-evidence/1",
    sha256: ("0x" + "00".repeat(32)) as EvidenceDocument["sha256"],
    source_url: "https://evidence.foodguard.vn/packed-readback.json",
    subject: "order:fg-mixed",
    submitted_at: "2030-01-01T00:00:00.000Z",
  } satisfies EvidenceDocument;
  const document = { ...preimage, sha256: await hashEvidence(preimage) } satisfies EvidenceDocument;
  return { ...document, envelope_json: canonicalizeEvidenceEnvelope(document), item_id: "" };
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (window as typeof window & { ethereum?: unknown }).ethereum;
});

describe("authoritative order outcome presentation", () => {
  it("marks the raw authoritative state and displays every well-formed deadline", () => {
    renderLocalized(<OrderTimeline order={UNRESOLVED_ORDER} />, "en");

    expect(screen.getByText("EVIDENCE_CURE")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("1893456000")).toBeVisible();
    expect(screen.getByText("1893457800")).toBeVisible();
    expect(screen.getByText("1893459600")).toBeVisible();
    expect(screen.getByText("1893461400")).toBeVisible();
    expect(screen.getByText("1893463200")).toBeVisible();
  });

  it("renders every item outcome and a separate delivery-fee outcome", () => {
    renderLocalized(<ItemOutcomeTable order={MIXED_OUTCOME_ORDER} />, "en");

    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Delivery fee")).toBeVisible();
    expect(screen.getByText("MATCHED")).toBeVisible();
    expect(screen.getByText("DELIVERY_FAILED")).toBeVisible();
    expect(screen.getByText("Restaurant allocation")).toBeVisible();
    expect(screen.getAllByText("Customer refund")).toHaveLength(2);
  });

  it("shows UNRESOLVED as locked funds with a cure action", () => {
    renderLocalized(<AppealPanel address={RESTAURANT} order={UNRESOLVED_ORDER} />, "vi");

    expect(screen.getByText(/vẫn được khóa trong escrow/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /bổ sung bằng chứng/i })).toBeEnabled();
  });

  it("shows finality, execution, and readback as separate stages", () => {
    renderLocalized(<TransactionLifecycle stage="EXECUTION_SUCCESS" />, "en");

    expect(screen.getByText("FINALIZED")).toBeVisible();
    expect(screen.getByText("Execution success")).toBeVisible();
    expect(screen.getByText("Readback pending")).toBeVisible();
  });

  it("does not equate FINALIZED with execution or readback success", () => {
    renderLocalized(<TransactionLifecycle stage="FINALIZED" />, "en");

    expect(screen.getByText("WALLET_CONFIRMATION")).toBeVisible();
    expect(screen.getByText("FINALIZED")).toBeVisible();
    expect(screen.getByText("EXECUTION_PENDING")).toBeVisible();
    expect(screen.queryByText("Execution success")).not.toBeInTheDocument();
    expect(screen.getByText("Readback pending")).toBeVisible();
  });

  it("records all predecessor stages before an execution error", () => {
    renderLocalized(<TransactionLifecycle stage="EXECUTION_ERROR" />, "en");

    expect(screen.getByText("SUBMITTED").closest("li")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText("CONSENSUS_PENDING").closest("li")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText("FINALIZED").closest("li")).toHaveAttribute("data-complete", "true");
    expect(screen.getByText("READBACK_PENDING")).toBeVisible();
  });

  it("uses a bounded monotonic elapsed time for authoritative chain samples", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const clock = { sampledAtMonotonicMs: 500, seconds: 1_000n };

    expect(authoritativeNowMs(clock, () => 1_500)).toBe(1_001_000n);
    vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    expect(authoritativeNowMs(clock, () => 1_500)).toBe(1_001_000n);
    expect(authoritativeNowMs(clock, () => 500 + MAX_CHAIN_SAMPLE_AGE_MS + 1)).toBeNull();
  });

  it("names the eligible actor for an actor-bound consensus retry", () => {
    renderLocalized(
      <TransactionLifecycle
        actorAddress={RESTAURANT}
        operation="submit_packed_evidence"
        stage="CONSENSUS_FAILED"
      />,
      "en",
    );

    expect(screen.getByText(RESTAURANT)).toBeVisible();
    expect(screen.getByText("submit_packed_evidence")).toBeVisible();
    expect(screen.queryByText(/anyone may retry/i)).not.toBeInTheDocument();
  });

  it("keeps request_resolution consensus retry explicitly permissionless", () => {
    renderLocalized(
      <TransactionLifecycle operation="request_resolution" stage="CONSENSUS_FAILED" />,
      "en",
    );

    expect(screen.getByText(/anyone may retry safely/i)).toBeVisible();
  });

  it("hides appeal after its strict deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));

    renderLocalized(
      <AppealPanel address={CUSTOMER} clock={testClock(1_700_000_001n)} order={EXPIRED_APPEAL_ORDER} />,
      "en",
    );

    expect(screen.queryByRole("button", { name: /appeal/i })).not.toBeInTheDocument();
  });

  it("counts down to the appeal boundary and removes the action exactly there", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    renderLocalized(
      <AppealPanel
        address={CUSTOMER}
        clock={testClock(1_893_456_000n)}
        order={{ ...MIXED_OUTCOME_ORDER, appeal_deadline: "1893456005", state: "RESOLVED" }}
      />,
      "en",
    );

    expect(screen.getByText("5 seconds remaining")).toBeVisible();
    expect(screen.getByRole("button", { name: /appeal/i })).toBeEnabled();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByRole("button", { name: /appeal/i })).not.toBeInTheDocument();
  });

  it("hides an actor's already-used cure action from append-only evidence", () => {
    renderLocalized(
      <AppealPanel
        address={RESTAURANT}
        order={{
          ...UNRESOLVED_ORDER,
          evidence: [{
            action: "CURE",
            actor_wallet: RESTAURANT,
            chain_id: "61999",
            contract_address: "0x4444444444444444444444444444444444444444",
            expires_at: "2030-01-02T02:00:00.000Z",
            issuer_id: "foodguard-web",
            nonce: "cure-used",
            observed_at: "2030-01-01T00:00:00.000Z",
            order_id: "fg-mixed",
            schema_version: "foodguard-evidence/1",
            sha256: "0x" + "ab".repeat(32),
            source_url: "https://evidence.foodguard.vn/cure.json",
            subject: "order:fg-mixed",
            submitted_at: "2030-01-01T00:00:00.000Z",
          }],
        }}
      />,
      "en",
    );

    expect(screen.queryByRole("button", { name: /add cure evidence/i })).not.toBeInTheDocument();
  });
});

describe("evidence envelope preview", () => {
  it("binds the append-only envelope without any verdict or prompt path", async () => {
    const submit = vi.fn<(envelopeJson: string) => Promise<void>>().mockResolvedValue();
    renderLocalized(
      <EvidenceDrawer
        action="PACKED"
        address={RESTAURANT}
        chainId="61999"
        clock={testClock(1_893_456_000n)}
        contractAddress="0x4444444444444444444444444444444444444444"
        nonce="nonce-packed-1"
        now={new Date("2030-01-01T00:00:00.000Z")}
        onSubmit={submit}
        order={BASE_ORDER}
        sourceUrl="https://evidence.foodguard.vn/packed.json"
      />,
      "en",
    );

    expect(screen.queryByTestId("evidence-envelope-json")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit packed evidence/i })).toBeDisabled();
    const observations = screen.getAllByRole("combobox", { name: /packed observation/i });
    expect(observations).toHaveLength(2);
    observations.forEach((select) => {
      fireEvent.change(select, { target: { value: "PACKED_AS_ORDERED" } });
    });

    const preview = await screen.findByTestId("evidence-envelope-json");
    const envelope = JSON.parse(preview.textContent ?? "") as Record<string, unknown>;
    expect(envelope).toMatchObject({
      action: "PACKED",
      actor_wallet: RESTAURANT,
      chain_id: "61999",
      contract_address: "0x4444444444444444444444444444444444444444",
      expires_at: "2030-01-02T02:00:00.000Z",
      issuer_id: "foodguard-web",
      nonce: "nonce-packed-1",
      observed_at: "2030-01-01T00:00:00.000Z",
      order_id: "fg-mixed",
      schema_version: "foodguard-evidence/1",
      source_url: "https://evidence.foodguard.vn/packed.json",
      subject: "order:fg-mixed",
      submitted_at: "2030-01-01T00:00:00.000Z",
    });
    expect(envelope.item_observations).toEqual([
      { item_id: "item-1", observation: "PACKED_AS_ORDERED" },
      { item_id: "item-2", observation: "PACKED_AS_ORDERED" },
    ]);
    expect(envelope.sha256).toBe("0x7130ad5882363da0920865264aaba599eb0e66ec35ba7e94192980e9077539da");
    expect(preview.textContent).toMatch(/^\{"action":"PACKED","actor_wallet":/);
    expect(envelope).not.toHaveProperty("outcome");
    expect(envelope).not.toHaveProperty("verdict");
    expect(envelope).not.toHaveProperty("prompt");
    expect(screen.queryByRole("textbox", { name: /prompt|verdict|outcome/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("evidence-validation")).toHaveTextContent("Local canonical hash verified");
    expect(screen.getByText("foodguard-evidence/1", { selector: "dd" })).toBeVisible();
    expect(screen.getByText("2030-01-02T02:00:00.000Z", { selector: "dd" })).toBeVisible();

    expect(screen.getByRole("button", { name: /submit packed evidence/i })).toBeDisabled();
    const fetchSource = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("{}") })
      .mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(screen.getByTestId("evidence-public-json").textContent),
      });
    vi.stubGlobal("fetch", fetchSource);
    fireEvent.click(screen.getByRole("button", { name: /verify public source/i }));
    expect(await screen.findByText(/does not exactly match/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /submit packed evidence/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /verify public source/i }));
    expect(await screen.findByText("Public source matches the canonical document")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /submit packed evidence/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(preview.textContent));
  });

  it("rejects a non-public evidence URL and disables submission", async () => {
    renderLocalized(
      <EvidenceDrawer
        action="DELIVERED"
        address={COURIER}
        chainId="61999"
        clock={testClock(1_893_456_000n)}
        contractAddress="0x4444444444444444444444444444444444444444"
        nonce="nonce-delivered-1"
        now={new Date("2030-01-01T00:00:00.000Z")}
        onSubmit={vi.fn()}
        order={BASE_ORDER}
        sourceUrl="https://localhost/delivered.json"
      />,
      "en",
    );

    expect(await screen.findByText(/public HTTPS URL/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /submit delivered evidence/i })).toBeDisabled();
  });

  it("fails closed when a previewed envelope reaches its expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const view = renderLocalized(
      <EvidenceDrawer
        action="DELIVERED"
        address={COURIER}
        chainId="61999"
        clock={testClock(1_893_456_000n)}
        contractAddress="0x4444444444444444444444444444444444444444"
        nonce="nonce-delivered-expiry"
        now={new Date("2030-01-01T00:00:00.000Z")}
        onSubmit={vi.fn()}
        order={BASE_ORDER}
        sourceUrl="https://evidence.foodguard.vn/delivered-expiry.json"
      />,
      "en",
    );

    fireEvent.change(screen.getByRole("combobox", { name: /delivery observation/i }), {
      target: { value: "HANDOFF_CONFIRMED" },
    });
    await act(async () => {
      await crypto.subtle.digest("SHA-256", new Uint8Array());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("evidence-envelope-json")).toBeVisible();
    expect(screen.getByRole("button", { name: /submit delivered evidence/i })).toBeDisabled();

    act(() => { vi.advanceTimersByTime(26 * 60 * 60 * 1_000); });
    view.rerender(
      <LocaleProvider hasExplicitLocale initialLocale="en">
        <EvidenceDrawer
          action="DELIVERED"
          address={COURIER}
          chainId="61999"
          clock={testClock(1_893_549_600n)}
          contractAddress="0x4444444444444444444444444444444444444444"
          nonce="nonce-delivered-expiry"
          now={new Date("2030-01-01T00:00:00.000Z")}
          onSubmit={vi.fn()}
          order={BASE_ORDER}
          sourceUrl="https://evidence.foodguard.vn/delivered-expiry.json"
        />
      </LocaleProvider>,
    );

    expect(screen.getByText(/envelope has expired/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /submit delivered evidence/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /build a fresh envelope/i }));
    await act(async () => {
      await crypto.subtle.digest("SHA-256", new Uint8Array());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("button", { name: /submit delivered evidence/i })).toBeDisabled();
  });
});

describe("permissionless consensus", () => {
  it("keeps consensus failure distinct from contract outcomes and offers retry", () => {
    const retry = vi.fn();
    renderLocalized(
      <ConsensusPanel
        clock={testClock(1_700_000_001n)}
        onResolve={retry}
        order={{ ...BASE_ORDER, review_deadline: "1700000000", state: "REVIEW_WINDOW" }}
        stage="CONSENSUS_FAILED"
      />,
      "en",
    );

    expect(screen.getByText("CONSENSUS_FAILED")).toBeVisible();
    expect(screen.getByText(/no contract state changed/i)).toBeVisible();
    expect(screen.queryByText("UNRESOLVED", { selector: "code" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry resolution/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("fails closed before a resolution deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T00:00:00.000Z"));
    renderLocalized(
      <ConsensusPanel
        clock={testClock(1_893_456_000n)}
        onResolve={vi.fn()}
        order={{ ...BASE_ORDER, review_deadline: "1893461400", state: "REVIEW_WINDOW" }}
        stage={null}
      />,
      "en",
    );

    expect(screen.queryByRole("button", { name: /request resolution/i })).not.toBeInTheDocument();
  });

  it("reveals permissionless resolution exactly when the deadline passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    renderLocalized(
      <ConsensusPanel
        clock={testClock(1_893_456_000n)}
        onResolve={vi.fn()}
        order={{ ...BASE_ORDER, review_deadline: "1893456005", state: "REVIEW_WINDOW" }}
        stage={null}
      />,
      "en",
    );

    expect(screen.queryByRole("button", { name: /request resolution/i })).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByRole("button", { name: /request resolution/i })).toBeEnabled();
  });

  it("offers permissionless settlement only after the strict appeal deadline", () => {
    const settle = vi.fn();
    renderLocalized(
      <ConsensusPanel
        clock={testClock(1_700_000_001n)}
        onSettle={settle}
        order={{ ...MIXED_OUTCOME_ORDER, appeal_deadline: "1700000000", state: "RESOLVED" }}
        stage={null}
      />,
      "en",
    );

    fireEvent.click(screen.getByRole("button", { name: /execute settlement/i }));
    expect(settle).toHaveBeenCalledOnce();
  });
});

describe("order detail readback orchestration", () => {
  it("confirms readback only after the complete authoritative enrichment succeeds", async () => {
    const stages: string[] = [];
    genlayerMocks.writeFoodGuard.mockResolvedValue("0x" + "cd".repeat(32));
    genlayerMocks.trackTransaction.mockImplementation(async (_hash, onStage) => {
      onStage("FINALIZED");
      onStage("EXECUTION_SUCCESS");
      onStage("READBACK_CONFIRMED");
      return BASE_ORDER;
    });
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(BASE_ORDER);
      if (method === "get_evidence_count") return Promise.reject(new Error("evidence read failed"));
      throw new Error(`unexpected method ${method}`);
    });

    await expect(transactAndRead(
      "fg-mixed",
      "request_resolution",
      ["fg-mixed"],
      undefined,
      (stage) => stages.push(stage),
    )).rejects.toThrow("evidence read failed");

    expect(stages).toEqual(["FINALIZED", "EXECUTION_SUCCESS"]);
  });

  it("enriches the order only from contract evidence, resolution, and round reads", async () => {
    const evidencePreimage = {
      action: "DELIVERED",
      actor_wallet: COURIER,
      chain_id: "61999",
      contract_address: "0x4444444444444444444444444444444444444444",
      expires_at: "2030-01-01T01:00:00.000Z",
      issuer_id: "foodguard-web",
      nonce: "delivered-1",
      observed_at: "2030-01-01T00:00:00.000Z",
      order_id: "fg-mixed",
      schema_version: "foodguard-evidence/1",
      sha256: ("0x" + "00".repeat(32)) as EvidenceDocument["sha256"],
      source_url: "https://evidence.foodguard.vn/delivered.json",
      subject: "order:fg-mixed",
      submitted_at: "2030-01-01T00:00:00.000Z",
      delivery_observation: "HANDOFF_CONFIRMED",
    } satisfies EvidenceDocument;
    const evidenceDocument = { ...evidencePreimage, sha256: await hashEvidence(evidencePreimage) } satisfies EvidenceDocument;
    const evidence = { ...evidenceDocument, envelope_json: canonicalizeEvidenceEnvelope(evidenceDocument) };
    const resolvedOrder = {
      ...MIXED_OUTCOME_ORDER,
      resolution: { ...MIXED_OUTCOME_ORDER.resolution!, evidence_hashes: [evidence.sha256] },
    };
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(resolvedOrder);
      if (method === "get_evidence_count") return Promise.resolve("1");
      if (method === "get_evidence") return Promise.resolve(evidence);
      if (method === "get_resolution") return Promise.resolve(JSON.stringify(resolvedOrder.resolution));
      if (method === "get_round") return Promise.resolve("2");
      throw new Error(`unexpected method ${method}`);
    });

    const result = await readAuthoritativeOrder("fg-mixed");

    expect(result.resolution?.items[0].outcome).toBe("MATCHED");
    expect(result.evidence).toEqual([evidence]);
    expect(result.resolution_round).toBe("2");
  });

  it("rejects a resolution digest that is absent from append-only evidence", async () => {
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(MIXED_OUTCOME_ORDER);
      if (method === "get_evidence_count") return Promise.resolve("0");
      if (method === "get_resolution") return Promise.resolve(JSON.stringify(MIXED_OUTCOME_ORDER.resolution));
      if (method === "get_round") return Promise.resolve("1");
      throw new Error(`unexpected method ${method}`);
    });

    await expect(readAuthoritativeOrder("fg-mixed")).rejects.toThrow(/resolution evidence/i);
  });

  it("rejects an empty digest list for a non-fail-closed resolution", async () => {
    const resolvedWithoutDigests = {
      ...MIXED_OUTCOME_ORDER,
      resolution: { ...MIXED_OUTCOME_ORDER.resolution!, evidence_hashes: [] },
    };
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(resolvedWithoutDigests);
      if (method === "get_evidence_count") return Promise.resolve("0");
      if (method === "get_resolution") return Promise.resolve(JSON.stringify(resolvedWithoutDigests.resolution));
      if (method === "get_round") return Promise.resolve("1");
      throw new Error(`unexpected method ${method}`);
    });

    await expect(readAuthoritativeOrder("fg-mixed")).rejects.toThrow(/resolution evidence/i);
  });

  it("accepts a fully fail-closed UNRESOLVED result with no cited digests", async () => {
    const evidence = await storedPackedEvidence();
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(UNRESOLVED_ORDER);
      if (method === "get_evidence_count") return Promise.resolve("1");
      if (method === "get_evidence") return Promise.resolve(evidence);
      if (method === "get_resolution") return Promise.resolve(JSON.stringify(UNRESOLVED_ORDER.resolution));
      if (method === "get_round") return Promise.resolve("1");
      throw new Error(`unexpected method ${method}`);
    });

    await expect(readAuthoritativeOrder("fg-mixed")).resolves.toMatchObject({
      state: "EVIDENCE_CURE",
      resolution: { delivery_outcome: "UNRESOLVED", evidence_hashes: [] },
    });
  });

  it("reads a unanimously signed mutual settlement for unresolved outcomes", async () => {
    const evidence = await storedPackedEvidence();
    const mixedUnresolvedResolution: NonNullable<OrderDetailView["resolution"]> = {
      delivery_outcome: "UNRESOLVED",
      evidence_hashes: [evidence.sha256],
      items: [
        { facts: ["matched"], item_id: "item-1", outcome: "MATCHED" },
        { facts: ["insufficient evidence"], item_id: "item-2", outcome: "UNRESOLVED" },
      ],
    };
    const proposalDocument = {
      chain_id: "61999",
      contract_address: "0x4444444444444444444444444444444444444444",
      delivery_allocation: { courier_wei: "30", customer_wei: "20" },
      item_allocations: [
        { customer_wei: "100", item_id: "item-1", restaurant_wei: "700" },
        { customer_wei: "50", item_id: "item-2", restaurant_wei: "50" },
      ],
      order_id: "fg-mixed",
      proposal_nonce: "mutual-readback",
    };
    const proposalJson = JSON.stringify(proposalDocument);
    const digest = await sha256Text(proposalJson);
    const settlementId = await sha256Text(JSON.stringify({
      basis: `mutual:${digest}`,
      chain_id: "61999",
      contract_address: "0x4444444444444444444444444444444444444444",
      courier_wei: "30",
      customer_wei: "170",
      order_id: "fg-mixed",
      restaurant_wei: "750",
      schema_version: "foodguard-settlement-v1",
    }));
    const settledUnresolved = {
      ...UNRESOLVED_ORDER,
      delivery_settled: true,
      items_settled: true,
      resolution: mixedUnresolvedResolution,
      state: "SETTLED",
    };
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(settledUnresolved);
      if (method === "get_evidence_count") return Promise.resolve("1");
      if (method === "get_evidence") return Promise.resolve(evidence);
      if (method === "get_resolution") return Promise.resolve(JSON.stringify(mixedUnresolvedResolution));
      if (method === "get_round") return Promise.resolve("2");
      if (method === "get_order_settlement") return Promise.resolve({
        courier_wei: "30",
        customer_wei: "170",
        restaurant_wei: "750",
        settlement_id: settlementId,
      });
      if (method === "get_settlement_proposal") return Promise.resolve({
        courier_signed: true,
        courier_wei: 30,
        customer_signed: true,
        customer_wei: 170,
        digest,
        proposal_json: proposalJson,
        proposal_nonce: "mutual-readback",
        restaurant_signed: true,
        restaurant_wei: 750,
      });
      throw new Error(`unexpected method ${method}`);
    });

    const result = await readAuthoritativeOrder("fg-mixed");
    expect(result.mutual_settlement?.item_allocations[0]).toEqual({
      customer_wei: "100",
      item_id: "item-1",
      restaurant_wei: "700",
    });
    renderLocalized(<ItemOutcomeTable order={result} />, "en");
    expect(screen.getByText("Customer: 100 wei / Restaurant: 700 wei")).toBeVisible();
    expect(screen.getByText("Customer: 20 wei / Courier: 30 wei")).toBeVisible();
    expect(screen.queryByText("Locked in escrow")).not.toBeInTheDocument();
  });

  it("normalizes a configured contract address when verifying a cancellation settlement ID", async () => {
    const mixedCaseContract = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
    vi.stubEnv("NEXT_PUBLIC_FOODGUARD_ADDRESS", mixedCaseContract);
    const settlementId = await sha256Text(JSON.stringify({
      basis: "unaccepted-cancellation",
      chain_id: "61999",
      contract_address: mixedCaseContract.toLowerCase(),
      courier_wei: "0",
      customer_wei: "950",
      order_id: "fg-mixed",
      restaurant_wei: "0",
      schema_version: "foodguard-settlement-v1",
    }));
    const cancelledOrder = {
      ...BASE_ORDER,
      delivery_settled: true,
      items_settled: true,
      refund_emitted: true,
      state: "CANCELLED_REFUNDED",
    };
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(cancelledOrder);
      if (method === "get_evidence_count") return Promise.resolve("0");
      if (method === "get_round") return Promise.resolve("0");
      if (method === "get_order_settlement") return Promise.resolve({
        courier_wei: 0,
        customer_wei: 950,
        restaurant_wei: 0,
        settlement_id: settlementId,
      });
      throw new Error(`unexpected method ${method}`);
    });

    await expect(readAuthoritativeOrder("fg-mixed")).resolves.toMatchObject({
      settlement: { settlement_id: settlementId },
      state: "CANCELLED_REFUNDED",
    });
  });

  it("fails closed instead of rendering malformed mutual allocations", () => {
    renderLocalized(
      <ItemOutcomeTable
        order={{
          ...UNRESOLVED_ORDER,
          mutual_settlement: {
            courier_signed: true,
            courier_wei: "30",
            customer_signed: true,
            customer_wei: "170",
            delivery_allocation: { courier_wei: "30", customer_wei: "20" },
            digest: "0x" + "ab".repeat(32),
            item_allocations: [],
            proposal_json: "{}",
            proposal_nonce: "broken",
            restaurant_signed: true,
            restaurant_wei: "750",
          },
          state: "SETTLED",
        }}
      />,
      "en",
    );

    expect(screen.getByText(/no well-formed authoritative resolution/i)).toBeVisible();
  });

  it("rejects a stored evidence record without its exact canonical envelope", async () => {
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve({ ...BASE_ORDER, state: "ACCEPTED" });
      if (method === "get_evidence_count") return Promise.resolve("1");
      if (method === "get_evidence") return Promise.resolve({
        action: "PACKED",
        actor_wallet: RESTAURANT,
        chain_id: "61999",
        contract_address: "0x4444444444444444444444444444444444444444",
        envelope_json: "{}",
        expires_at: "2030-01-02T02:00:00.000Z",
        issuer_id: "foodguard-web",
        item_id: "",
        nonce: "broken-envelope",
        observed_at: "2030-01-01T00:00:00.000Z",
        order_id: "fg-mixed",
        schema_version: "foodguard-evidence/1",
        sha256: "0x" + "ab".repeat(32),
        source_url: "https://evidence.foodguard.vn/broken.json",
        subject: "order:fg-mixed",
        submitted_at: "2030-01-01T00:00:00.000Z",
      });
      if (method === "get_round") return Promise.resolve("0");
      throw new Error(`unexpected method ${method}`);
    });

    await expect(readAuthoritativeOrder("fg-mixed")).rejects.toThrow(/envelope readback/i);
  });

  it("rejects non-conserving settlement readback", async () => {
    const evidence = await storedPackedEvidence();
    const settledOrder = {
      ...MIXED_OUTCOME_ORDER,
      delivery_settled: true,
      items_settled: true,
      resolution: { ...MIXED_OUTCOME_ORDER.resolution!, evidence_hashes: [evidence.sha256] },
      state: "SETTLED",
    };
    genlayerMocks.readFoodGuard.mockImplementation((method: string) => {
      if (method === "get_order") return Promise.resolve(settledOrder);
      if (method === "get_evidence_count") return Promise.resolve("1");
      if (method === "get_evidence") return Promise.resolve(evidence);
      if (method === "get_resolution") return Promise.resolve(JSON.stringify(settledOrder.resolution));
      if (method === "get_round") return Promise.resolve("1");
      if (method === "get_order_settlement") return Promise.resolve({
        courier_wei: "0",
        customer_wei: "150",
        restaurant_wei: "799",
        settlement_id: "0x" + "ef".repeat(32),
      });
      throw new Error(`unexpected method ${method}`);
    });

    await expect(readAuthoritativeOrder("fg-mixed")).rejects.toThrow(/conserve/i);
  });

  it("does not change authoritative state until tracked execution returns readback", async () => {
    let completeWrite: ((order: OrderDetailView) => void) | undefined;
    const readOrder = vi.fn().mockResolvedValue({
      ...BASE_ORDER,
      resolution: null,
      review_deadline: "1700000000",
      state: "REVIEW_WINDOW",
    });
    const transact = vi.fn((_method, _args, _address, onStage) => {
      onStage("SUBMITTED");
      onStage("CONSENSUS_PENDING");
      return new Promise<{ order: OrderDetailView; transactionHash?: string }>((resolve) => {
        completeWrite = (order) => resolve({ order, transactionHash: "0x" + "cd".repeat(32) });
      });
    });
    const configuration: OrderDetailWorkspaceConfiguration = {
      contractAddress: "0x4444444444444444444444444444444444444444",
      chainId: "61999",
      message: null,
      readsEnabled: true,
      status: "READY",
      writesEnabled: true,
    };

    renderLocalized(
      <OrderDetailWorkspace
        configuration={configuration}
        orderId="fg-mixed"
        readChainTime={vi.fn().mockResolvedValue(1893461400n)}
        readOrder={readOrder}
        transact={transact}
      />,
      "en",
    );

    expect(await screen.findByText("REVIEW_WINDOW", { selector: "[data-testid='raw-detail-state']" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /request resolution/i }));
    expect(screen.getByText("REVIEW_WINDOW", { selector: "[data-testid='raw-detail-state']" })).toBeVisible();
    expect(screen.getAllByText("CONSENSUS_PENDING")).toHaveLength(2);

    completeWrite?.({ ...UNRESOLVED_ORDER, order_id: "fg-mixed" });
    expect(await screen.findByText("EVIDENCE_CURE", { selector: "[data-testid='raw-detail-state']" })).toBeVisible();
  });

  it("renders deployment-required state without reads or writes", () => {
    const readOrder = vi.fn();
    const configuration: OrderDetailWorkspaceConfiguration = {
      contractAddress: null,
      chainId: "61999",
      message: "verified deployment required",
      readsEnabled: false,
      status: "DEPLOYMENT_REQUIRED",
      writesEnabled: false,
    };
    renderLocalized(
      <OrderDetailWorkspace configuration={configuration} orderId="fg-mixed" readOrder={readOrder} />,
      "en",
    );

    expect(screen.getByText("DEPLOYMENT_REQUIRED")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(readOrder).not.toHaveBeenCalled();
  });

  it("keeps permissionless resolution available when only public evidence hosting is gated", async () => {
    const transact = vi.fn().mockResolvedValue({
      order: { ...UNRESOLVED_ORDER, order_id: "fg-mixed" },
      transactionHash: "0x" + "cd".repeat(32),
    });
    const configuration: OrderDetailWorkspaceConfiguration = {
      contractAddress: "0x4444444444444444444444444444444444444444",
      chainId: "61999",
      message: "public origin required for evidence",
      readsEnabled: true,
      status: "PUBLIC_APP_ORIGIN_REQUIRED",
      writesEnabled: true,
    };
    renderLocalized(
      <OrderDetailWorkspace
        configuration={configuration}
        orderId="fg-mixed"
        readChainTime={vi.fn().mockResolvedValue(1893456000n)}
        readOrder={vi.fn().mockResolvedValue({ ...BASE_ORDER, review_deadline: "1700000000", state: "REVIEW_WINDOW" })}
        transact={transact}
      />,
      "en",
    );

    fireEvent.click(await screen.findByRole("button", { name: /request resolution/i }));
    await waitFor(() => expect(transact).toHaveBeenCalledWith(
      "request_resolution",
      ["fg-mixed"],
      undefined,
      expect.any(Function),
    ));
  });

  it("fails closed on deadline actions when authoritative chain time is unavailable", async () => {
    const configuration: OrderDetailWorkspaceConfiguration = {
      contractAddress: "0x4444444444444444444444444444444444444444",
      chainId: "61999",
      message: null,
      readsEnabled: true,
      status: "READY",
      writesEnabled: true,
    };
    renderLocalized(
      <OrderDetailWorkspace
        configuration={configuration}
        orderId="fg-mixed"
        readChainTime={vi.fn().mockRejectedValue(new Error("clock unavailable"))}
        readOrder={vi.fn().mockResolvedValue({ ...BASE_ORDER, review_deadline: "1700000000", state: "REVIEW_WINDOW" })}
      />,
      "en",
    );

    expect(await screen.findByText(/authoritative chain time is unavailable/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /request resolution/i })).not.toBeInTheDocument();
  });

  it("does not relabel an evidence consensus failure as a resolution retry", async () => {
    (window as typeof window & { ethereum?: unknown }).ethereum = {
      request: vi.fn(({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return Promise.resolve([RESTAURANT]);
        if (method === "eth_chainId") return Promise.resolve("0xf22f");
        throw new Error(`unexpected wallet method ${method}`);
      }),
    };
    const configuration: OrderDetailWorkspaceConfiguration = {
      contractAddress: "0x4444444444444444444444444444444444444444",
      chainId: "61999",
      message: null,
      readsEnabled: true,
      status: "READY",
      writesEnabled: true,
    };
    const transact = vi.fn((_method, _args, _address, onStage) => {
      onStage("CONSENSUS_FAILED");
      return Promise.reject(new Error("cure consensus failed"));
    });
    renderLocalized(
      <OrderDetailWorkspace
        configuration={configuration}
        orderId="fg-mixed"
        readChainTime={vi.fn().mockResolvedValue(1893456000n)}
        readOrder={vi.fn().mockResolvedValue(UNRESOLVED_ORDER)}
        transact={transact}
      />,
      "en",
    );

    fireEvent.click(await screen.findByRole("button", { name: /connect wallet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /add cure evidence/i }));
    fireEvent.change(await screen.findByRole("textbox", { name: /public HTTPS source URL/i }), {
      target: { value: "https://evidence.foodguard.vn/cure-retry.json" },
    });
    const publicDocument = await screen.findByTestId("evidence-public-json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(publicDocument.textContent),
    }));
    fireEvent.click(screen.getByRole("button", { name: /verify public source/i }));
    await screen.findByText("Public source matches the canonical document");
    fireEvent.click(screen.getByRole("button", { name: /submit cure evidence/i }));

    await screen.findAllByText("cure consensus failed");
    expect(screen.queryByRole("button", { name: /retry resolution/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request resolution/i })).toBeEnabled();
  });

  it("keeps the evidence drawer open when the tracked write fails", async () => {
    (window as typeof window & { ethereum?: unknown }).ethereum = {
      request: vi.fn(({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return Promise.resolve([RESTAURANT]);
        if (method === "eth_chainId") return Promise.resolve("0xf22f");
        throw new Error(`unexpected wallet method ${method}`);
      }),
    };
    const configuration: OrderDetailWorkspaceConfiguration = {
      contractAddress: "0x4444444444444444444444444444444444444444",
      chainId: "61999",
      message: null,
      readsEnabled: true,
      status: "READY",
      writesEnabled: true,
    };
    const transact = vi.fn().mockRejectedValue(new Error("tracked evidence write failed"));
    renderLocalized(
      <OrderDetailWorkspace
        configuration={configuration}
        orderId="fg-mixed"
        readChainTime={vi.fn().mockResolvedValue(1893456000n)}
        readOrder={vi.fn().mockResolvedValue({ ...BASE_ORDER, state: "ACCEPTED" })}
        transact={transact}
      />,
      "en",
    );

    await screen.findByText("ACCEPTED", { selector: "[data-testid='raw-detail-state']" });
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm packed/i }));
    const source = await screen.findByRole("textbox", { name: /public HTTPS source URL/i });
    fireEvent.change(source, { target: { value: "https://evidence.foodguard.vn/packed-retry.json" } });
    screen.getAllByRole("combobox", { name: /packed observation/i }).forEach((select) => {
      fireEvent.change(select, { target: { value: "PACKED_AS_ORDERED" } });
    });
    const publicDocument = await screen.findByTestId("evidence-public-json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(publicDocument.textContent),
    }));
    fireEvent.click(screen.getByRole("button", { name: /verify public source/i }));
    await screen.findByText("Public source matches the canonical document");
    fireEvent.click(await screen.findByRole("button", { name: /submit packed evidence/i }));

    expect(await screen.findAllByText("tracked evidence write failed")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /public evidence envelope/i })).toBeVisible();
  });
});

describe("immutable settlement proof", () => {
  const SETTLED_ORDER: OrderDetailView = {
    ...MIXED_OUTCOME_ORDER,
    evidence: [{
      action: "DELIVERED",
      actor_wallet: COURIER,
      chain_id: "61999",
      contract_address: "0x4444444444444444444444444444444444444444",
      expires_at: "2030-01-01T01:00:00.000Z",
      issuer_id: "foodguard-web",
      nonce: "delivered-1",
      observed_at: "2030-01-01T00:00:00.000Z",
      order_id: "fg-mixed",
      schema_version: "foodguard-evidence/1",
      sha256: "0x" + "ab".repeat(32),
      source_url: "https://evidence.foodguard.vn/delivered.json",
      subject: "order:fg-mixed",
      submitted_at: "2030-01-01T00:00:00.000Z",
    }],
    settlement: {
      courier_wei: "0",
      customer_wei: "150",
      restaurant_wei: "800",
      settlement_id: "0x" + "ef".repeat(32),
    },
    state: "SETTLED",
  };

  it("renders only real chain, settlement, evidence, outcomes, and readback fields", () => {
    renderLocalized(
      <ProofView
        chainId="61999"
        contractAddress="0x4444444444444444444444444444444444444444"
        order={SETTLED_ORDER}
      />,
      "en",
    );

    expect(screen.getByText("61999")).toBeVisible();
    expect(screen.getByText("0x" + "ef".repeat(32))).toBeVisible();
    expect(screen.getAllByText("0x" + "ab".repeat(32)).length).toBeGreaterThan(0);
    expect(screen.getByText("SETTLED")).toBeVisible();
    expect(screen.queryByText(/contract source hash/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/transaction hash/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("omits unavailable transaction and settlement identifiers without placeholders", () => {
    renderLocalized(
      <ProofView
        chainId="61999"
        contractAddress="0x4444444444444444444444444444444444444444"
        order={{ ...MIXED_OUTCOME_ORDER, settlement: null }}
      />,
      "en",
    );

    expect(screen.queryByText("Transaction hash")).not.toBeInTheDocument();
    expect(screen.queryByText("Settlement ID")).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown|placeholder|0x000000/i)).not.toBeInTheDocument();
  });
});
