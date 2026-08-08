import { expect, test } from "@playwright/test";

import { installWalletAndRpcFixture, trackConsoleErrors } from "./support/foodguard-fixture";

test("happy path waits for finality, execution, and full readback before success", async ({ page }) => {
  await installWalletAndRpcFixture(page, "happy-path");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1?locale=en");

  await expect(page.getByTestId("raw-detail-state")).toHaveText("RESOLVED");
  await page.getByRole("button", { name: /execute settlement/i }).click();

  await expect(page.getByText("FINALIZED", { exact: true })).toBeVisible();
  await expect(page.getByText("EXECUTION_SUCCESS", { exact: true })).toBeVisible();
  await expect(page.getByText("READBACK_CONFIRMED", { exact: true })).toBeVisible();
  await expect(page.getByTestId("raw-detail-state")).toHaveText("SETTLED");
  await expect(page.getByText(/authoritative readback confirmed/i)).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
