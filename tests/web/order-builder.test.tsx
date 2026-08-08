// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrderBuilder } from "../../components/food/OrderBuilder";
import {
  OrdersWorkspace,
  RoleConsole,
  type FoodGuardOrderView,
} from "../../components/order/RoleConsole";
import { LocaleProvider } from "../../lib/i18n";
import type { OrderItem } from "../../lib/domain";

const mocks = vi.hoisted(() => ({
  readFoodGuard: vi.fn(),
  trackTransaction: vi.fn(),
  writeFoodGuard: vi.fn(),
}));

vi.mock("../../lib/genlayer/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/genlayer/client")>();
  return {
    ...original,
    readFoodGuard: mocks.readFoodGuard,
    writeFoodGuard: mocks.writeFoodGuard,
  };
});

vi.mock("../../lib/genlayer/transactions", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/genlayer/transactions")>();
  return { ...original, trackTransaction: mocks.trackTransaction };
});

const CUSTOMER = "0x1111111111111111111111111111111111111111";
const RESTAURANT = "0x2222222222222222222222222222222222222222";
const COURIER = "0x3333333333333333333333333333333333333333";
const OUTSIDER = "0x4444444444444444444444444444444444444444";
const CONTRACT = "0x5555555555555555555555555555555555555555";
const HASH = `0x${"a".repeat(64)}`;

const ITEM: OrderItem = {
  item_id: "pho-1",
  name: "Phở bò",
  quantity: 3,
  permitted_substitutions: ["bún gạo"],
  price_wei: "400",
  conditions: ["nước dùng đóng riêng"],
};

const READY_CONFIGURATION = {
  status: "READY" as const,
  address: CONTRACT,
  writesEnabled: true as const,
};

const READY_FOR_PICKUP_ORDER: FoodGuardOrderView = {
  order_id: "fg-9",
  customer: CUSTOMER,
  restaurant: RESTAURANT,
  courier: COURIER,
  state: "READY_FOR_PICKUP",
  restaurant_accepted: true,
  courier_accepted: true,
};

type EthereumMock = {
  request: ReturnType<typeof vi.fn>;
};

function installWallet(chainId = "0xf22f"): EthereumMock {
  let currentChain = chainId;
  const provider: EthereumMock = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [CUSTOMER];
      if (method === "eth_chainId") return currentChain;
      if (method === "wallet_switchEthereumChain") {
        currentChain = "0xf22f";
        return null;
      }
      throw new Error(`Unexpected wallet method: ${method}`);
    }),
  };
  Object.defineProperty(window, "ethereum", { configurable: true, value: provider });
  return provider;
}

function renderBuilder(
  props: Partial<React.ComponentProps<typeof OrderBuilder>> = {},
) {
  return render(
    <LocaleProvider>
      <OrderBuilder
        configuration={READY_CONFIGURATION}
        initialActors={[CUSTOMER, RESTAURANT, COURIER]}
        item={ITEM}
        orderId="fg-9"
        {...props}
      />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  installWallet();
  mocks.writeFoodGuard.mockResolvedValue(HASH);
  mocks.readFoodGuard.mockResolvedValue(READY_FOR_PICKUP_ORDER);
  mocks.trackTransaction.mockResolvedValue({
    ...READY_FOR_PICKUP_ORDER,
    state: "FUNDED",
    restaurant_accepted: false,
    courier_accepted: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "ethereum");
});

describe("FoodGuard order builder", () => {
  it("blocks creation until three valid, nonzero, distinct wallets are present", () => {
    renderBuilder({ initialActors: [CUSTOMER, RESTAURANT, RESTAURANT] });

    expect(screen.getByRole("button", { name: /tạo và ký quỹ/i })).toBeDisabled();
    expect(screen.getByText(/ba địa chỉ ví phải khác nhau/i)).toBeVisible();
  });

  it("shows the canonical order manifest and Task 1 digest before wallet confirmation", async () => {
    renderBuilder();

    expect(screen.getByTestId("canonical-manifest")).toHaveTextContent(
      '{"items":[{"conditions":["nước dùng đóng riêng"],"item_id":"pho-1","name":"Phở bò","permitted_substitutions":["bún gạo"],"price_wei":"400","quantity":3}]}',
    );
    await waitFor(() =>
      expect(screen.getByTestId("manifest-digest")).toHaveTextContent(/^0x[0-9a-f]{64}$/),
    );
    expect(mocks.writeFoodGuard).not.toHaveBeenCalled();
  });

  it("keeps the raw manifest digest unchanged when only the URL locale changes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    window.history.replaceState({}, "", "/create");
    renderBuilder();
    await waitFor(() =>
      expect(screen.getByTestId("manifest-digest")).toHaveTextContent(/^0x[0-9a-f]{64}$/),
    );
    const vietnameseDigest = screen.getByTestId("manifest-digest").textContent;
    cleanup();

    window.history.replaceState({}, "", "/create?locale=en");
    render(
      <LocaleProvider initialLocale="en">
        <OrderBuilder
          configuration={READY_CONFIGURATION}
          initialActors={[CUSTOMER, RESTAURANT, COURIER]}
          item={ITEM}
          orderId="fg-9"
        />
      </LocaleProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("manifest-digest")).toHaveTextContent(/^0x[0-9a-f]{64}$/),
    );

    expect(screen.getByTestId("manifest-digest")).toHaveTextContent(vietnameseDigest!);
    clock.mockRestore();
  });

  it("funds create_order with the exact bigint subtotal plus delivery fee and waits for readback", async () => {
    renderBuilder({ deliveryFeeWei: "50" });

    fireEvent.click(screen.getByRole("button", { name: /kết nối ví/i }));
    await screen.findByText(CUSTOMER);
    const createButton = screen.getByRole("button", { name: /tạo và ký quỹ/i });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);

    await waitFor(() => expect(mocks.writeFoodGuard).toHaveBeenCalledTimes(1));
    const [method, args, value] = mocks.writeFoodGuard.mock.calls[0];
    expect(method).toBe("create_order");
    expect(args[0]).toBe("fg-9");
    expect(args[1]).toBe(RESTAURANT);
    expect(args[2]).toBe(COURIER);
    expect(args[3]).toBe(
      '{"items":[{"conditions":["nước dùng đóng riêng"],"item_id":"pho-1","name":"Phở bò","permitted_substitutions":["bún gạo"],"price_wei":"400","quantity":3}]}',
    );
    expect(args[4]).toBe(50n);
    expect(value).toBe(1250n);
    expect(mocks.trackTransaction).toHaveBeenCalledWith(HASH, expect.any(Function));
    expect(await screen.findByText("FUNDED")).toBeVisible();
  });

  it("shows actionable StudioNet switching guidance and cannot write on the wrong chain", async () => {
    const provider = installWallet("0x1");
    renderBuilder();

    fireEvent.click(screen.getByRole("button", { name: /kết nối ví/i }));
    expect(await screen.findByText(/chuyển ví sang StudioNet.*61999/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /tạo và ký quỹ/i })).toBeDisabled();
    expect(mocks.writeFoodGuard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /chuyển sang StudioNet/i }));
    await waitFor(() =>
      expect(provider.request).toHaveBeenCalledWith({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xf22f" }],
      }),
    );
  });

  it("keeps preview available but disables writes when deployment is required", async () => {
    renderBuilder({
      configuration: {
        status: "DEPLOYMENT_REQUIRED",
        address: null,
        writesEnabled: false,
        message: "FoodGuard deployment required",
      },
    });

    expect(await screen.findByTestId("manifest-digest")).toBeVisible();
    expect(screen.getByText("DEPLOYMENT_REQUIRED")).toBeVisible();
    expect(screen.getByRole("button", { name: /tạo và ký quỹ/i })).toBeDisabled();
    expect(screen.queryByText("0x0000000000000000000000000000000000000000")).not.toBeInTheDocument();
  });
});

describe("FoodGuard role console", () => {
  it("derives available actions from wallet plus authoritative contract state", () => {
    render(
      <LocaleProvider>
        <RoleConsole address={COURIER} order={READY_FOR_PICKUP_ORDER} />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: /xác nhận nhận hàng/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /đóng gói/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("raw-order-state")).toHaveTextContent("READY_FOR_PICKUP");
  });

  it("makes outsider read-only status explicit", () => {
    render(
      <LocaleProvider>
        <RoleConsole address={OUTSIDER} order={READY_FOR_PICKUP_ORDER} />
      </LocaleProvider>,
    );

    expect(screen.getByText(/chỉ đọc/i)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("updates actions only from the authoritative order returned after a write", async () => {
    let resolveReadback: ((order: FoodGuardOrderView) => void) | undefined;
    const onAction = vi.fn(
      () =>
        new Promise<FoodGuardOrderView>((resolve) => {
          resolveReadback = resolve;
        }),
    );
    render(
      <LocaleProvider>
        <RoleConsole
          address={COURIER}
          onAction={onAction}
          order={READY_FOR_PICKUP_ORDER}
        />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /xác nhận nhận hàng/i }));
    expect(screen.getByTestId("raw-order-state")).toHaveTextContent("READY_FOR_PICKUP");
    resolveReadback?.({ ...READY_FOR_PICKUP_ORDER, state: "IN_TRANSIT" });

    expect(await screen.findByTestId("raw-order-state")).toHaveTextContent("IN_TRANSIT");
    expect(screen.getByRole("button", { name: /xác nhận giao hàng/i })).toBeEnabled();
  });
});

describe("wallet-scoped order lookup", () => {
  it("loads an order from authoritative contract state without persisting the wallet", async () => {
    render(
      <LocaleProvider>
        <OrdersWorkspace configuration={READY_CONFIGURATION} />
      </LocaleProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: /mã đơn/i }), {
      target: { value: "fg-9" },
    });
    fireEvent.click(screen.getByRole("button", { name: /đọc đơn từ contract/i }));

    expect(await screen.findByTestId("raw-order-state")).toHaveTextContent("READY_FOR_PICKUP");
    expect(mocks.readFoodGuard).toHaveBeenCalledWith("get_order", ["fg-9"]);
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps order lookup visible but locked without a deployment", () => {
    render(
      <LocaleProvider>
        <OrdersWorkspace
          configuration={{
            status: "DEPLOYMENT_REQUIRED",
            address: null,
            writesEnabled: false,
            message: "FoodGuard deployment required",
          }}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole("textbox", { name: /mã đơn/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /đọc đơn từ contract/i })).toBeDisabled();
    expect(screen.getByText("DEPLOYMENT_REQUIRED")).toBeVisible();
  });
});
