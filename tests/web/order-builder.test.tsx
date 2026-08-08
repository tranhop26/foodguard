// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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
const PUBLIC_APP_ORIGIN_ENV = "NEXT_PUBLIC_FOODGUARD_APP_ORIGIN";
const VALID_PUBLIC_APP_ORIGIN = "https://app.foodguard.vn";

function testClock(seconds: bigint) {
  return { sampledAtMonotonicMs: performance.now(), seconds };
}
const originalPublicAppOrigin = process.env.NEXT_PUBLIC_FOODGUARD_APP_ORIGIN;

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
  emit(event: "accountsChanged" | "chainChanged", value: unknown): void;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
};

function installWallet(chainId = "0xf22f"): EthereumMock {
  let currentChain = chainId;
  let currentAccounts = [CUSTOMER];
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const provider: EthereumMock = {
    emit(event, value) {
      if (event === "accountsChanged" && Array.isArray(value)) currentAccounts = value as string[];
      if (event === "chainChanged" && typeof value === "string") currentChain = value;
      for (const listener of listeners.get(event) ?? []) listener(value);
    },
    on: vi.fn((event: string, listener: (value: unknown) => void) => {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    removeListener: vi.fn((event: string, listener: (value: unknown) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return currentAccounts;
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
  vi.stubEnv(PUBLIC_APP_ORIGIN_ENV, VALID_PUBLIC_APP_ORIGIN);
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalPublicAppOrigin === undefined) {
    Reflect.deleteProperty(process.env, PUBLIC_APP_ORIGIN_ENV);
  } else {
    process.env.NEXT_PUBLIC_FOODGUARD_APP_ORIGIN = originalPublicAppOrigin;
  }
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

  it("keeps visible contract deadlines fresh while the preview is idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    renderBuilder();
    const first = JSON.parse(screen.getByTestId("canonical-deadlines").textContent!);

    expect(first).toEqual({
      acceptance_deadline: 1_893_457_800,
      appeal_deadline: 1_893_484_800,
      delivery_deadline: 1_893_470_400,
      packing_deadline: 1_893_463_200,
      review_deadline: 1_893_477_600,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const refreshed = JSON.parse(screen.getByTestId("canonical-deadlines").textContent!);

    expect(refreshed.acceptance_deadline).toBeGreaterThan(first.acceptance_deadline);
    expect(refreshed.acceptance_deadline).toBe(1_893_457_860);
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

  it("uses a stable configured public source URL instead of browser location", async () => {
    window.history.replaceState({}, "", "/create?locale=en#draft");
    renderBuilder();

    await waitFor(() =>
      expect(screen.getByTestId("canonical-evidence")).toHaveTextContent(
        '"source_url":"https://app.foodguard.vn/create"',
      ),
    );
  });

  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["reserved example TLD", "https://foodguard.example"],
    ["reserved example domain", "https://example.com"],
    ["non-HTTPS", "http://app.foodguard.vn"],
    ["credentials", "https://user:secret@app.foodguard.vn"],
    ["path", "https://app.foodguard.vn/subpath"],
    ["query", "https://app.foodguard.vn?preview=1"],
    ["fragment", "https://app.foodguard.vn#preview"],
    ["malformed", "not-a-url"],
  ])("keeps preview read-only when public app origin is %s", async (_case, rawOrigin) => {
    vi.unstubAllEnvs();
    if (rawOrigin === undefined) {
      Reflect.deleteProperty(process.env, PUBLIC_APP_ORIGIN_ENV);
    } else {
      vi.stubEnv(PUBLIC_APP_ORIGIN_ENV, rawOrigin);
    }
    renderBuilder();

    await waitFor(() =>
      expect(screen.getByTestId("manifest-digest")).toHaveTextContent(/^0x[0-9a-f]{64}$/),
    );
    expect(screen.getByText("PUBLIC_APP_ORIGIN_REQUIRED")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button")[0]);
    await screen.findByText(CUSTOMER);

    const createButton = screen.getAllByRole("button").at(-1)!;
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(mocks.writeFoodGuard).not.toHaveBeenCalled();
  });

  it("canonicalizes a valid public origin and enables its exact source commitment", async () => {
    vi.stubEnv(PUBLIC_APP_ORIGIN_ENV, "  https://App.FoodGuard.VN/  ");
    renderBuilder();

    await waitFor(() =>
      expect(screen.getByTestId("canonical-evidence")).toHaveTextContent(
        '"source_url":"https://app.foodguard.vn/create"',
      ),
    );
    fireEvent.click(screen.getAllByRole("button")[0]);
    await screen.findByText(CUSTOMER);
    await waitFor(() => expect(screen.getAllByRole("button").at(-1)).toBeEnabled());
    expect(screen.queryByText("PUBLIC_APP_ORIGIN_REQUIRED")).not.toBeInTheDocument();
  });

  it("server-renders and hydrates the initial commitment without clock or URL drift", async () => {
    const element = (
      <LocaleProvider>
        <OrderBuilder
          configuration={READY_CONFIGURATION}
          initialActors={[CUSTOMER, RESTAURANT, COURIER]}
          item={ITEM}
          orderId="fg-9"
        />
      </LocaleProvider>
    );
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_893_456_000_000);
    let firstServerHtml = "";
    let secondServerHtml = "";

    Reflect.deleteProperty(globalThis, "window");
    try {
      firstServerHtml = renderToString(element);
      clock.mockReturnValue(2_208_988_800_000);
      secondServerHtml = renderToString(element);
    } finally {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      }
    }

    expect(secondServerHtml).toBe(firstServerHtml);
    const container = document.createElement("div");
    container.innerHTML = firstServerHtml;
    document.body.append(container);
    const hydrationErrors: unknown[] = [];
    let root: Root | undefined;

    clock.mockReturnValue(2_524_608_000_000);
    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => hydrationErrors.push(error),
      });
      await Promise.resolve();
    });

    expect(hydrationErrors).toEqual([]);
    await act(async () => root?.unmount());
    container.remove();
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
    expect(screen.getByRole("button", { name: /tạo và ký quỹ/i })).toBeDisabled();
  });

  it("freezes every submitted commitment while wallet confirmation and readback are pending", async () => {
    mocks.writeFoodGuard.mockImplementation(() => new Promise(() => undefined));
    renderBuilder({ deliveryFeeWei: "50" });
    fireEvent.click(screen.getByRole("button", { name: /kết nối ví/i }));
    const createButton = screen.getByRole("button", { name: /tạo và ký quỹ/i });
    await waitFor(() => expect(createButton).toBeEnabled());

    fireEvent.click(createButton);

    expect(screen.getByRole("textbox", { name: /ví khách hàng/i })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /ví nhà hàng/i })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /ví người giao hàng/i })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /mã đơn/i })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /phí giao hàng/i })).toBeDisabled();
  });

  it("keeps the submitted preview immutable across wallet events and parent updates", async () => {
    const provider = installWallet();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_893_456_000_000);
    mocks.writeFoodGuard.mockImplementation(() => new Promise(() => undefined));
    const view = renderBuilder({
      deliveryFeeWei: "50",
    });
    fireEvent.click(screen.getAllByRole("button")[0]);
    const createButton = screen.getAllByRole("button").at(-1)!;
    await waitFor(() => expect(createButton).toBeEnabled());

    const preview = {
      deadlines: screen.getByTestId("canonical-deadlines").textContent,
      digest: screen.getByTestId("manifest-digest").textContent,
      evidence: screen.getByTestId("canonical-evidence").textContent,
      manifest: screen.getByTestId("canonical-manifest").textContent,
    };
    fireEvent.click(createButton);
    await waitFor(() => expect(mocks.writeFoodGuard).toHaveBeenCalledTimes(1));
    const submittedCall = mocks.writeFoodGuard.mock.calls[0];

    clock.mockReturnValue(1_893_459_600_000);
    view.rerender(
      <LocaleProvider>
        <OrderBuilder
          configuration={READY_CONFIGURATION}
          deliveryFeeWei="999"
          initialActors={[CUSTOMER, RESTAURANT, COURIER]}
          item={{ ...ITEM, item_id: "changed-item", price_wei: "999" }}
          orderId="changed-order"
          publicAppConfiguration={{
            status: "READY",
            origin: "https://changed.foodguard.vn",
            createOrderSourceUrl: "https://changed.foodguard.vn/create",
            writesEnabled: true,
          }}
        />
      </LocaleProvider>,
    );
    await act(async () => {
      provider.emit("accountsChanged", [COURIER]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("COURIER")).toBeVisible();
    expect(screen.getByTestId("canonical-deadlines")).toHaveTextContent(preview.deadlines!);
    expect(screen.getByTestId("manifest-digest")).toHaveTextContent(preview.digest!);
    expect(screen.getByTestId("canonical-evidence")).toHaveTextContent(preview.evidence!);
    expect(screen.getByTestId("canonical-manifest")).toHaveTextContent(preview.manifest!);
    expect(mocks.writeFoodGuard.mock.calls[0]).toEqual(submittedCall);
    expect(submittedCall[1]).toEqual([
      "fg-9",
      RESTAURANT,
      COURIER,
      preview.manifest,
      50n,
      preview.deadlines,
    ]);
    expect(submittedCall[2]).toBe(1_250n);
    expect(submittedCall[4]).toBe(CUSTOMER);
    clock.mockRestore();
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

  it("reacts to wallet account and chain changes after connection", async () => {
    const provider = installWallet();
    const view = renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /kết nối ví/i }));
    await screen.findByText(CUSTOMER);

    act(() => provider.emit("accountsChanged", [COURIER]));
    expect(await screen.findByText("COURIER")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /tạo và ký quỹ/i })).toBeDisabled(),
    );

    act(() => provider.emit("chainChanged", "0x1"));
    expect(await screen.findByText(/chuyển ví sang StudioNet.*61999/i)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /tạo và ký quỹ/i })).toBeDisabled(),
    );

    view.unmount();
    expect(provider.removeListener).toHaveBeenCalledWith("accountsChanged", expect.any(Function));
    expect(provider.removeListener).toHaveBeenCalledWith("chainChanged", expect.any(Function));
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

  it("hides provider acceptance after the authoritative acceptance deadline", () => {
    render(
      <LocaleProvider>
        <RoleConsole
          address={RESTAURANT}
          clock={testClock(BigInt(Math.floor(Date.now() / 1_000)))}
          order={{
            ...READY_FOR_PICKUP_ORDER,
            acceptance_deadline: BigInt(Math.floor(Date.now() / 1_000)) - 1n,
            courier_accepted: false,
            restaurant_accepted: false,
            state: "FUNDED",
          }}
        />
      </LocaleProvider>,
    );

    expect(screen.queryByRole("button", { name: /nhà hàng nhận đơn/i })).not.toBeInTheDocument();
  });

  it("offers customer cancellation before the deadline only when neither provider accepted", () => {
    render(
      <LocaleProvider>
        <RoleConsole
          address={CUSTOMER}
          clock={testClock(BigInt(Math.floor(Date.now() / 1_000)))}
          order={{
            ...READY_FOR_PICKUP_ORDER,
            acceptance_deadline: BigInt(Math.floor(Date.now() / 1_000)) + 60n,
            courier_accepted: false,
            restaurant_accepted: false,
            state: "FUNDED",
          }}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: /hoàn tiền đơn chưa được nhận/i })).toBeEnabled();
  });

  it("hides customer claims after the review deadline", () => {
    render(
      <LocaleProvider>
        <RoleConsole
          address={CUSTOMER}
          clock={testClock(BigInt(Math.floor(Date.now() / 1_000)))}
          order={{
            ...READY_FOR_PICKUP_ORDER,
            review_deadline: BigInt(Math.floor(Date.now() / 1_000)) - 1n,
            state: "REVIEW_WINDOW",
          }}
        />
      </LocaleProvider>,
    );

    expect(screen.queryByRole("button", { name: /khiếu nại/i })).not.toBeInTheDocument();
  });

  it("removes provider acceptance at the exact Unix-second deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    render(
      <LocaleProvider>
        <RoleConsole
          address={RESTAURANT}
          clock={testClock(1_893_456_000n)}
          order={{
            ...READY_FOR_PICKUP_ORDER,
            acceptance_deadline: 1_893_456_001n,
            courier_accepted: false,
            restaurant_accepted: false,
            state: "FUNDED",
          }}
        />
      </LocaleProvider>,
    );

    const acceptanceLabel = screen.getByRole("button").textContent;
    expect(acceptanceLabel).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(screen.getByRole("button")).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("button")).not.toHaveTextContent(acceptanceLabel!);
  });

  it("makes unaccepted cancellation permissionless at the exact deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    render(
      <LocaleProvider>
        <RoleConsole
          address={OUTSIDER}
          clock={testClock(1_893_456_000n)}
          order={{
            ...READY_FOR_PICKUP_ORDER,
            acceptance_deadline: 1_893_456_001n,
            courier_accepted: false,
            restaurant_accepted: true,
            state: "PARTIALLY_ACCEPTED",
          }}
        />
      </LocaleProvider>,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it.each([undefined, "not-a-deadline"])(
    "fails closed when the acceptance deadline is missing or invalid (%s)",
    (acceptanceDeadline) => {
      render(
        <LocaleProvider>
          <RoleConsole
            address={CUSTOMER}
            order={{
              ...READY_FOR_PICKUP_ORDER,
              acceptance_deadline: acceptanceDeadline,
              courier_accepted: false,
              restaurant_accepted: false,
              state: "FUNDED",
            }}
          />
        </LocaleProvider>,
      );

      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it("removes customer claims at the exact Unix-second review deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    render(
      <LocaleProvider>
        <RoleConsole
          address={CUSTOMER}
          clock={testClock(1_893_456_000n)}
          order={{
            ...READY_FOR_PICKUP_ORDER,
            review_deadline: 1_893_456_001n,
            state: "REVIEW_WINDOW",
          }}
        />
      </LocaleProvider>,
    );

    expect(screen.getByRole("button")).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
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
