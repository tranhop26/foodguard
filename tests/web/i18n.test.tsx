// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LOCALE_STORAGE_KEY,
  LocaleProvider,
  LocaleSwitcher,
  WorkflowShell,
  useLocale,
} from "../../lib/i18n";
import type { ItemOutcome } from "../../lib/domain";

function LocaleHarness({ outcome }: { outcome: ItemOutcome }) {
  const { copy } = useLocale();

  return (
    <>
      <LocaleSwitcher />
      <span>{copy.outcomes[outcome]}</span>
      <code data-testid="raw-outcome">{outcome}</code>
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/orders?order=fg-9");
});

afterEach(cleanup);

describe("FoodGuard locale", () => {
  it("defaults to Vietnamese and changes labels without translating raw enums", () => {
    render(
      <LocaleProvider>
        <LocaleHarness outcome="UNRESOLVED" />
      </LocaleProvider>,
    );

    expect(screen.getByText("Cần bổ sung bằng chứng")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByText("More evidence required")).toBeVisible();
    expect(screen.getByTestId("raw-outcome")).toHaveTextContent("UNRESOLVED");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect([...Array(window.localStorage.length)].map((_, index) => window.localStorage.key(index))).toEqual([
      LOCALE_STORAGE_KEY,
    ]);
  });

  it("preserves the real bilingual URL and active query when switching language", () => {
    render(
      <LocaleProvider>
        <LocaleSwitcher />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    const englishUrl = new URL(window.location.href);
    expect(englishUrl.pathname).toBe("/orders");
    expect(englishUrl.searchParams.get("order")).toBe("fg-9");
    expect(englishUrl.searchParams.get("locale")).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "Tiếng Việt" }));
    const vietnameseUrl = new URL(window.location.href);
    expect(vietnameseUrl.searchParams.get("order")).toBe("fg-9");
    expect(vietnameseUrl.searchParams.has("locale")).toBe(false);
  });

  it("updates workflow navigation and headings with the selected URL locale", () => {
    render(
      <LocaleProvider>
        <WorkflowShell page="orders"><span>Order content</span></WorkflowShell>
      </LocaleProvider>,
    );

    expect(screen.getByRole("heading", { name: "Đơn hàng theo ví" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByRole("heading", { name: "Wallet-scoped orders" })).toBeVisible();
    expect(screen.getByRole("link", { name: "FoodGuard" })).toHaveAttribute("href", "/?locale=en");
    expect(screen.getByRole("link", { name: /back to marketplace/i })).toHaveAttribute(
      "href",
      "/?locale=en",
    );
  });
});
