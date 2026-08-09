import { expect, test } from "@playwright/test";

import { installWalletAndRpcFixture, trackConsoleErrors } from "./support/foodguard-fixture";

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
  await expect(page.getByTestId("transaction-readback")).toContainText("READBACK_CONFIRMED");
  expect(walletWritesFor("accept_restaurant")).toHaveLength(1);
  expect(fixture.walletWrites).toEqual([{ method: "accept_restaurant", args: ["fg-1"] }]);
  expect(consoleErrors).toEqual([]);
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
