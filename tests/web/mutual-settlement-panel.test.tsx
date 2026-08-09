// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MutualSettlementPanel, type MutualSettlementProposalView } from "../../components/order/MutualSettlementPanel";
import type { OrderDetailView } from "../../components/order/ItemOutcomeTable";
import { LocaleProvider } from "../../lib/i18n";

const CUSTOMER = "0x1111111111111111111111111111111111111111";
const RESTAURANT = "0x2222222222222222222222222222222222222222";
const COURIER = "0x3333333333333333333333333333333333333333";
const CONTRACT = "0x4444444444444444444444444444444444444444";

const ORDER: OrderDetailView = {
  courier: COURIER,
  courier_accepted: true,
  customer: CUSTOMER,
  delivery_fee: "50",
  manifest_json: JSON.stringify({
    items: [
      {
        conditions: [],
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
  order_id: "fg-mutual",
  restaurant: RESTAURANT,
  restaurant_accepted: true,
  state: "ESCALATED",
  subtotal: "900",
  total_value: "950",
};

const CONFIGURATION = {
  chainId: "61999",
  contractAddress: CONTRACT,
  writesEnabled: true,
};

function renderPanel(node: React.ReactNode) {
  return render(
    <LocaleProvider hasExplicitLocale initialLocale="en">
      {node}
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("mutual settlement panel", () => {
  it("submits only canonical caller allocations and derives every complementary allocation", async () => {
    const onPropose = vi.fn().mockResolvedValue(undefined);
    renderPanel(
      <MutualSettlementPanel
        address={CUSTOMER}
        configuration={CONFIGURATION}
        nowSeconds={1_700_000_001n}
        onPropose={onPropose}
        order={{ ...ORDER, appeal_deadline: "1700000000" }}
        proposals={[]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Customer refund for Pho (wei)"), {
      target: { value: "250" },
    });
    fireEvent.change(screen.getByLabelText("Customer refund for delivery fee (wei)"), {
      target: { value: "20" },
    });
    fireEvent.click(screen.getByRole("button", { name: /propose mutual settlement/i }));

    await waitFor(() => expect(onPropose).toHaveBeenCalledOnce());
    const [payload] = onPropose.mock.calls[0] as [string];
    expect(JSON.parse(payload)).toEqual({
      delivery_allocation: { courier_wei: "30", customer_wei: "20" },
      item_allocations: [
        { customer_wei: "250", item_id: "item-1", restaurant_wei: "550" },
        { customer_wei: "0", item_id: "item-2", restaurant_wei: "100" },
      ],
      proposal_nonce: expect.any(String),
    });
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual([
      "delivery_allocation",
      "item_allocations",
      "proposal_nonce",
    ]);
    expect(payload).toBe(JSON.stringify(JSON.parse(payload)));
  });

  it("shows digest-keyed offers and lets an unsigned participant sign a selected offer", async () => {
    const onSign = vi.fn().mockResolvedValue(undefined);
    const proposal: MutualSettlementProposalView = {
      active_evidence_digest: "0x" + "ab".repeat(32),
      courier_signed: true,
      courier_wei: "50",
      customer_signed: false,
      customer_wei: "0",
      digest: "0x" + "cd".repeat(32),
      is_current: true,
      proposal_json: JSON.stringify({
        active_evidence_digest: "0x" + "ab".repeat(32),
        chain_id: "61999",
        contract_address: CONTRACT,
        delivery_allocation: { courier_wei: "50", customer_wei: "0" },
        item_allocations: [
          { customer_wei: "0", item_id: "item-1", restaurant_wei: "800" },
          { customer_wei: "0", item_id: "item-2", restaurant_wei: "100" },
        ],
        order_id: "fg-mutual",
        proposal_nonce: "offer-1",
        proposal_version: "1",
        resolution_round: "2",
      }),
      proposal_nonce: "offer-1",
      proposal_version: "1",
      resolution_round: "2",
      restaurant_signed: true,
      restaurant_wei: "900",
    };
    renderPanel(
      <MutualSettlementPanel
        address={CUSTOMER}
        configuration={CONFIGURATION}
        nowSeconds={1_700_000_001n}
        onSign={onSign}
        order={{ ...ORDER, appeal_deadline: "1700000000" }}
        proposals={[proposal]}
      />,
    );

    expect(screen.getByText(proposal.digest)).toBeVisible();
    expect(screen.getByText(/restaurant: signed/i)).toBeVisible();
    expect(screen.getByText(/courier: signed/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /sign this offer/i }));

    await waitFor(() => expect(onSign).toHaveBeenCalledWith(proposal.digest));
  });

  it("keeps settlement controls unavailable before the authoritative appeal deadline", () => {
    renderPanel(
      <MutualSettlementPanel
        address={CUSTOMER}
        configuration={CONFIGURATION}
        nowSeconds={1_699_999_999n}
        onPropose={vi.fn()}
        onSign={vi.fn()}
        order={{ ...ORDER, appeal_deadline: "1700000000" }}
        proposals={[]}
      />,
    );

    expect(screen.queryByRole("button", { name: /propose mutual settlement/i })).not.toBeInTheDocument();
    expect(screen.getByText(/after the appeal deadline/i)).toBeVisible();
  });

  it("keeps a stale round-bound offer visible but prevents a signature", () => {
    const staleProposal = {
      active_evidence_digest: "0x" + "ab".repeat(32),
      courier_signed: true,
      courier_wei: "50",
      customer_signed: false,
      customer_wei: "0",
      digest: "0x" + "ef".repeat(32),
      is_current: false,
      proposal_json: "{}",
      proposal_nonce: "stale",
      proposal_version: "1",
      resolution_round: "1",
      restaurant_signed: true,
      restaurant_wei: "900",
    } as MutualSettlementProposalView & { is_current: boolean };
    renderPanel(
      <MutualSettlementPanel
        address={CUSTOMER}
        configuration={CONFIGURATION}
        nowSeconds={1_700_000_001n}
        onSign={vi.fn()}
        order={{ ...ORDER, appeal_deadline: "1700000000" }}
        proposals={[staleProposal]}
      />,
    );

    expect(screen.getByText(staleProposal.digest)).toBeVisible();
    expect(screen.queryByRole("button", { name: /sign this offer/i })).not.toBeInTheDocument();
  });
});
