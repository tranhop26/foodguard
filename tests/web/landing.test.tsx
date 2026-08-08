// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LandingPage } from "../../app/page";
import { getFoodGuardConfiguration } from "../../lib/genlayer/config";

const UNDEPLOYED = getFoodGuardConfiguration("");
const READY = getFoodGuardConfiguration("0x2222222222222222222222222222222222222222");

function renderLanding(
  options: { categorySlug?: string; locale?: "vi" | "en"; searchQuery?: string } = {},
) {
  return render(<LandingPage configuration={UNDEPLOYED} {...options} />);
}

afterEach(cleanup);

describe("FoodGuard proof marketplace landing", () => {
  it("renders Vietnamese discovery with an explicit simulated-value disclosure", () => {
    renderLanding();

    expect(
      screen.getByRole("heading", { name: /món ngon.*bằng chứng/i, level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("StudioNet · Simulated GEN")).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(6);
  });

  it("provides semantic, image-led restaurant discovery", () => {
    renderLanding();

    expect(screen.getByRole("banner")).toBeVisible();
    expect(screen.getByRole("main")).toBeVisible();
    expect(screen.getByRole("search")).toBeVisible();
    expect(
      screen.getByRole("searchbox", { name: /tìm món ăn hoặc nhà hàng/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: /danh mục món ăn/i }),
    ).toBeVisible();
    expect(screen.getByRole("contentinfo")).toBeVisible();
    expect(
      screen.getByRole("img", { name: /bàn món Việt với phở, bánh xèo và cuốn tươi/i }),
    ).toBeVisible();

    for (const card of screen.getAllByRole("article")) {
      expect(within(card).getByRole("img")).toHaveAccessibleName();
      expect(within(card).getByText(/Simulated GEN$/i)).toBeVisible();
    }
  });

  it("keeps marketplace discovery available while contract actions are unavailable", () => {
    renderLanding();

    expect(screen.getByRole("link", { name: /khám phá 6 nhà hàng/i })).toHaveAttribute(
      "href",
      "#nha-hang",
    );
    expect(
      screen.getByRole("button", { name: /tạo đơn qua hợp đồng/i }),
    ).toBeDisabled();
    expect(screen.getByText("DEPLOYMENT_REQUIRED")).toBeVisible();
    expect(screen.getByText(/chưa triển khai contract trên StudioNet/i)).toBeVisible();
  });

  it("describes hash-bound evidence and escrow as a demo rather than production trust", () => {
    renderLanding();

    expect(screen.getByText(/JSON công khai.*SHA-256/i)).toBeVisible();
    expect(screen.getByText(/không phải tiền thật/i)).toBeVisible();
    expect(screen.getByText(/không tự bảo đảm món ăn đúng/i)).toBeVisible();
  });

  it("filters restaurant discovery with a diacritic-insensitive search", () => {
    renderLanding({ searchQuery: "pho" });

    expect(screen.getByRole("searchbox", { name: /tìm món ăn hoặc nhà hàng/i })).toHaveValue(
      "pho",
    );
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Phở Sớm" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Trạm Nước Lèo" })).toBeVisible();
    expect(screen.getByText(/2 nhà hàng phù hợp/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /khám phá 2 nhà hàng/i })).toBeVisible();
    expect(
      within(screen.getAllByRole("article")[0]).getByRole("img"),
    ).not.toHaveAttribute("loading", "lazy");
  });

  it("filters by category and marks only the selected chip current", () => {
    renderLanding({ categorySlug: "mon-chay" });

    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Bếp Lá" })).toBeVisible();
    expect(screen.getByRole("link", { name: /khám phá 1 nhà hàng/i })).toBeVisible();
    expect(screen.getByRole("link", { name: "Món chay" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Tất cả" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows the contract route without the deployment warning when configuration is ready", () => {
    render(<LandingPage configuration={READY} />);

    expect(screen.getByRole("link", { name: /tạo đơn qua hợp đồng/i })).toHaveAttribute(
      "href",
      "/create",
    );
    expect(
      screen.queryByRole("button", { name: /tạo đơn qua hợp đồng/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/chưa triển khai contract trên StudioNet/i)).not.toBeInTheDocument();
    expect(screen.queryByText("DEPLOYMENT_REQUIRED")).not.toBeInTheDocument();
  });

  it("provides a real English content path while preserving active discovery filters", () => {
    renderLanding({ categorySlug: "mon-nuoc", locale: "en", searchQuery: "pho" });

    expect(
      screen.getByRole("heading", { name: /good food.*evidence/i, level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("StudioNet · Simulated GEN")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: /search dishes or restaurants/i })).toHaveValue(
      "pho",
    );
    expect(screen.getByRole("link", { name: /explore 2 restaurants/i })).toBeVisible();
    expect(screen.getByText(/2 restaurants match the current filters/i)).toBeVisible();
    expect(screen.getByText(/public JSON.*SHA-256/i)).toBeVisible();
    expect(screen.getByText(/not real money/i)).toBeVisible();

    const languageNavigation = screen.getByRole("navigation", { name: /language/i });
    expect(within(languageNavigation).getByRole("link", { name: "English" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const vietnameseHref = within(languageNavigation)
      .getByRole("link", { name: "Tiếng Việt" })
      .getAttribute("href");
    expect(vietnameseHref).toContain("q=pho");
    expect(vietnameseHref).toContain("category=mon-nuoc");
    expect(vietnameseHref).not.toContain("locale=");
  });

  it.each([
    { category: "mon-nuoc", categoryName: "Noodle soups", count: 2, query: "pho" },
    { category: "com-viet", categoryName: "Vietnamese rice", count: 2, query: "rice" },
    { category: "mon-chay", categoryName: "Vegetarian", count: 1, query: "vegetarian food" },
  ])(
    "returns truthful English results for advertised '$query' search",
    ({ category, categoryName, count, query }) => {
      renderLanding({ categorySlug: category, locale: "en", searchQuery: query });

      expect(screen.getByRole("searchbox", { name: /search dishes or restaurants/i })).toHaveValue(
        query,
      );
      expect(screen.getAllByRole("article")).toHaveLength(count);
      expect(screen.getByText(new RegExp(`^${count} restaurant`))).toBeVisible();

      const currentCategory = screen.getByRole("link", { name: categoryName });
      expect(currentCategory).toHaveAttribute("aria-current", "page");
      const currentParams = new URL(currentCategory.getAttribute("href")!, "https://foodguard.test")
        .searchParams;
      expect(currentParams.get("q")).toBe(query);
      expect(currentParams.get("category")).toBe(category);
      expect(currentParams.get("locale")).toBe("en");

      const vietnameseHref = screen.getByRole("link", { name: "Tiếng Việt" }).getAttribute("href");
      const vietnameseParams = new URL(vietnameseHref!, "https://foodguard.test").searchParams;
      expect(vietnameseParams.get("q")).toBe(query);
      expect(vietnameseParams.get("category")).toBe(category);
    },
  );
});
