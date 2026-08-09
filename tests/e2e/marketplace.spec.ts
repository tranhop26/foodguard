import { expect, test } from "@playwright/test";

import { installWalletAndRpcFixture, trackConsoleErrors } from "./support/foodguard-fixture";

test("marketplace is usable at 375px and 1440px", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /món ngon.*bằng chứng/i })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(consoleErrors).toEqual([]);
});

test("language and marketplace filters remain usable", async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/");
  await page.getByRole("link", { name: "English" }).click();
  await expect(page).toHaveURL(/locale=en/);
  await expect(page.getByRole("heading", { name: /evidence alongside/i })).toBeVisible();

  await page.getByRole("searchbox", { name: /search dishes/i }).fill("vegetarian");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(/restaurants? match the current filters/i)).toBeVisible();
  await page.getByRole("link", { name: "Vegetarian" }).click();
  await expect(page.getByRole("link", { name: "Vegetarian" })).toHaveAttribute("aria-current", "page");
  expect(consoleErrors).toEqual([]);
});

test("three-wallet validation and exact payable preview are explicit", async ({ page }) => {
  await installWalletAndRpcFixture(page, "create-preview");
  const consoleErrors = trackConsoleErrors(page);
  await page.goto("/create?locale=en");

  const customer = "0x1111111111111111111111111111111111111111";
  const restaurant = "0x2222222222222222222222222222222222222222";
  const courier = "0x3333333333333333333333333333333333333333";
  await page.getByRole("textbox", { name: "Customer wallet" }).fill(customer);
  await page.getByRole("textbox", { name: "Restaurant wallet" }).fill(restaurant);
  await page.getByRole("textbox", { name: "Courier wallet" }).fill(restaurant);
  await expect(page.getByText(/three wallet addresses must be different/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /create and fund/i })).toBeDisabled();

  await page.getByRole("textbox", { name: "Courier wallet" }).fill(courier);
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await expect(page.getByText(/StudioNet network ready/i)).toBeVisible();

  const amounts = await page.locator(".amount-summary dd code").allTextContents();
  expect(amounts).toEqual([
    "420000000000000000",
    "50000000000000000",
    "470000000000000000",
  ]);
  await expect(page.getByRole("button", { name: /create and fund/i })).toBeEnabled();
  expect(consoleErrors).toEqual([]);
});
