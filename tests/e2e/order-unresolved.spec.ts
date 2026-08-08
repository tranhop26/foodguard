import { expect, test } from "@playwright/test";

import { installWalletAndRpcFixture, trackConsoleErrors } from "./support/foodguard-fixture";

test("UNRESOLVED locks value and exposes one cure for the connected participant", async ({ page }) => {
  await installWalletAndRpcFixture(page, "unresolved");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1");
  await page.getByRole("button", { name: /kết nối ví/i }).click();

  await expect(page.getByTestId("raw-detail-state")).toHaveText("EVIDENCE_CURE");
  await expect(page.getByText(/tiền vẫn được khóa trong escrow/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /bổ sung bằng chứng/i })).toBeEnabled();
  expect(consoleErrors).toEqual([]);
});

test("consensus failure preserves prior state and exposes operation-specific retry", async ({ page }) => {
  await installWalletAndRpcFixture(page, "consensus-failed");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1");
  await expect(page.getByTestId("raw-detail-state")).toHaveText("EVIDENCE_CURE");

  await page.getByRole("button", { name: /yêu cầu phân xử/i }).click();

  await expect(page.getByText("CONSENSUS_FAILED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/trạng thái contract không đổi/i).first()).toBeVisible();
  await expect(page.getByTestId("raw-detail-state")).toHaveText("EVIDENCE_CURE");
  await expect(page.getByRole("button", { name: /thử phân xử lại/i })).toBeEnabled();
  expect(consoleErrors).toEqual([]);
});
