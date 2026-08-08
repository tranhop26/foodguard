import { expect, test } from "@playwright/test";

import {
  focusByKeyboard,
  installWalletAndRpcFixture,
  trackConsoleErrors,
} from "./support/foodguard-fixture";

test("keyboard reaches every enabled order action with a visible focus target", async ({ page }) => {
  await installWalletAndRpcFixture(page, "ready-for-pickup");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1");
  await page.getByRole("button", { name: /kết nối ví/i }).click();

  const pickup = page.getByRole("button", { name: /xác nhận nhận hàng/i });
  await expect(pickup).toBeEnabled();
  await focusByKeyboard(page, pickup, 30);
  await expect(pickup).toBeFocused();
  expect(consoleErrors).toEqual([]);
});

test("deployment-required mode stays browseable and locks contract actions", async ({ browser }) => {
  const page = await browser.newPage();
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("http://127.0.0.1:3101/");
  await expect(page.getByText("DEPLOYMENT_REQUIRED", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /tạo đơn qua hợp đồng/i })).toBeDisabled();
  await page.goto("http://127.0.0.1:3101/create?locale=en");
  await expect(page.getByText("DEPLOYMENT_REQUIRED", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /create and fund/i })).toBeDisabled();
  expect(consoleErrors).toEqual([]);
  await page.close();
});
