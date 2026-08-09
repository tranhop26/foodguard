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

test("an escalated participant can build and submit a mutual settlement proposal", async ({ page }) => {
  await installWalletAndRpcFixture(page, "escalated");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-1?locale=en");
  await expect(page.getByTestId("raw-detail-state")).toHaveText("ESCALATED");
  await page.getByRole("button", { name: /connect wallet/i }).click();

  await expect(page.getByRole("heading", { name: /mutual settlement/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /propose mutual settlement/i })).toBeEnabled();
  await page.getByRole("button", { name: /propose mutual settlement/i }).click();
  await expect(page.getByText(/proposal submitted\. wait for authoritative readback/i)).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("three stale customer claims recover through one atomic batch cure", async ({ page }) => {
  const fixture = await installWalletAndRpcFixture(page, "batch-cure");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/orders/fg-batch-1?locale=en");
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: /add cure evidence/i }).click();

  for (const index of [3, 4, 5]) {
    await page.getByRole("checkbox", { name: `Select evidence #${index}` }).check();
  }
  await expect(page.getByText("3 records selected")).toBeVisible();

  const categories = page.getByRole("combobox", { name: /claim category/i });
  const kinds = page.getByRole("combobox", { name: /criterion kind/i });
  const indices = page.getByRole("spinbutton", { name: /criterion index/i });
  await expect(categories).toHaveCount(3);
  await expect(categories.nth(0)).toHaveValue("");
  await expect(categories.nth(1)).toHaveValue("");
  await expect(categories.nth(2)).toHaveValue("");
  for (const [index, category] of ["ABSENT_AT_RECEIPT", "NOT_AS_ORDERED", "HANDOFF_NOT_RECEIVED"].entries()) {
    await categories.nth(index).selectOption(category);
  }
  for (const [index, kind] of ["ITEM", "QUANTITY", "DELIVERY"].entries()) {
    await kinds.nth(index).selectOption(kind);
    await indices.nth(index).fill(index === 2 ? "-1" : "0");
  }
  await page.getByRole("textbox", { name: /public HTTPS source URL/i }).fill(fixture.sourceUrl);
  await expect(page.getByTestId("evidence-public-json")).toHaveText(fixture.expectedPublicDocument);
  await page.getByRole("button", { name: /verify public source/i }).click();
  await expect(page.getByText(/public source matches the canonical document/i)).toBeVisible();
  await page.getByRole("button", { name: /submit cure evidence/i }).click();

  await expect(page.getByText("3 evidence selected")).toBeVisible();
  await expect(page.getByTestId("transaction-finality")).toContainText("FINALIZED");
  await expect(page.getByTestId("transaction-execution")).toContainText("SUCCESS");
  await expect(page.getByTestId("transaction-readback")).toContainText("CONFIRMED");
  await expect(page.getByTestId("active-evidence-indices")).toHaveText("0, 1, 2, 6");
  expect(fixture.walletWrites).toEqual([
    { method: "submit_cure_evidence", args: ["fg-batch-1", fixture.expectedEnvelopeJson] },
  ]);
  expect(consoleErrors).toEqual([]);
});
