import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { abi } from "genlayer-js";

import { installWalletAndRpcFixture, trackConsoleErrors } from "./support/foodguard-fixture";

const WRONG_TRANSACTION_HASH = `0x${"8".repeat(64)}`;

async function browserRpc(page: Page, method: string, params: unknown[]) {
  return page.evaluate(async ({ rpcMethod, rpcParams }) => {
    const response = await fetch("https://studio.genlayer.com/api", {
      body: JSON.stringify({ id: 991, jsonrpc: "2.0", method: rpcMethod, params: rpcParams }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return response.json() as Promise<{
      error?: { code: number; message: string };
      result?: unknown;
    }>;
  }, { rpcMethod: method, rpcParams: params });
}

function mockedReadData(method: string, args: string[]): string {
  const calldata = abi.calldata.encode(new Map<string, string | string[]>([
    ["method", method],
    ["args", args],
  ]));
  return `0x0000${Buffer.from(calldata).toString("hex")}00`;
}

test("happy path waits for finality, execution, and full readback before success", async ({ page }) => {
  await installWalletAndRpcFixture(page, "happy-path");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1?locale=en");

  await expect(page.getByTestId("raw-detail-state")).toHaveText("RESOLVED");
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: /execute settlement/i }).click();

  await expect(page.getByText("FINALIZED", { exact: true })).toBeVisible();
  await expect(page.getByText("EXECUTION_SUCCESS", { exact: true })).toBeVisible();
  await expect(page.getByText("READBACK_CONFIRMED", { exact: true })).toBeVisible();
  await expect(page.getByTestId("raw-detail-state")).toHaveText("SETTLED");
  await expect(page.getByText(/authoritative readback confirmed/i)).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("a recorded wallet write with a transport failure reconciles later latest-final state without resending", async ({ page }) => {
  const fixture = await installWalletAndRpcFixture(page, "accept-transport-failure");
  const walletWritesFor = (method: string) => fixture.walletWrites.filter((write) => write.method === method);
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1");
  await page.getByRole("button", { name: /kết nối ví/i }).click();

  await page.getByRole("button", { name: "Nhà hàng nhận đơn" }).click();
  await expect(page.getByText(/đang đối chiếu contract/i)).toBeVisible();
  await expect(page.getByTestId("raw-order-state")).toHaveText("PARTIALLY_ACCEPTED");
  await expect(page.getByTestId("raw-detail-state")).toHaveText("PARTIALLY_ACCEPTED");
  await expect(page.getByTestId("transaction-finality")).not.toHaveAttribute("data-complete", "true");
  await expect(page.getByTestId("transaction-execution")).not.toHaveAttribute("data-complete", "true");
  await expect(page.getByTestId("transaction-readback")).toContainText("STATE_READBACK_CONFIRMED");
  await expect(page.getByText(
    "Chỉ trạng thái contract có thẩm quyền được xác nhận; finality và execution của giao dịch vẫn chưa được chứng minh.",
  )).toBeVisible();
  expect(walletWritesFor("accept_restaurant")).toHaveLength(1);
  expect(fixture.walletWrites).toEqual([{ method: "accept_restaurant", args: ["fg-1"] }]);
  expect(consoleErrors).toEqual([]);
});

test("participant cancellation RPC does not finalize for the wrong transaction hash", async ({ page }) => {
  const fixture = await installWalletAndRpcFixture(page, "participant-cancellation");
  await page.goto("/orders/fg-1?locale=en");

  const wrongHash = await browserRpc(page, "eth_getTransactionByHash", [WRONG_TRANSACTION_HASH]);

  expect(wrongHash.result).toBeNull();
  await page.reload();
  await expect(page.getByTestId("raw-detail-state")).toHaveText("PARTIALLY_ACCEPTED");
  expect(fixture.walletWrites).toEqual([]);
});

test("participant cancellation RPC rejects settlement reads before finalization", async ({ page }) => {
  const fixture = await installWalletAndRpcFixture(page, "participant-cancellation");
  await page.goto("/orders/fg-1?locale=en");

  const prematureSettlement = await browserRpc(page, "gen_call", [{
    data: mockedReadData("get_order_settlement", ["fg-1"]),
    transaction_hash_variant: "latest-final",
  }]);

  expect(prematureSettlement.result).toBeUndefined();
  expect(prematureSettlement.error).toEqual({
    code: -32000,
    message: "[EXPECTED] settlement not found",
  });
  expect(fixture.walletWrites).toEqual([]);
});

test("a participant can cancel before packing and receives one item refund allocation", async ({ page }) => {
  const fixture = await installWalletAndRpcFixture(page, "participant-cancellation");
  const walletWritesFor = (method: string) => fixture.walletWrites.filter((write) => write.method === method);
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1?locale=en");
  await page.getByRole("button", { name: /connect wallet/i }).click();
  page.once("dialog", (dialog) => dialog.accept());

  await page.getByRole("button", { name: "Cancel before packing" }).click();

  await expect(page.getByTestId("raw-order-state")).toHaveText("CANCELLED_REFUNDED");
  await expect(page.getByTestId("raw-detail-state")).toHaveText("CANCELLED_REFUNDED");
  await expect(page.getByRole("row", { name: /Broken rice plate.*Customer refund/i })).toHaveCount(1);
  expect(walletWritesFor("cancel_before_packed")).toHaveLength(1);
  expect(fixture.walletWrites).toEqual([{ method: "cancel_before_packed", args: ["fg-1"] }]);
  expect(consoleErrors).toEqual([]);
});
