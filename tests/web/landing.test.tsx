// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import HomePage from "../../app/page";

afterEach(cleanup);

describe("FoodGuard proof marketplace landing", () => {
  it("renders Vietnamese discovery with an explicit simulated-value disclosure", () => {
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { name: /món ngon.*bằng chứng/i, level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("StudioNet · Simulated GEN")).toBeVisible();
    expect(screen.getAllByRole("article")).toHaveLength(6);
  });

  it("provides semantic, image-led restaurant discovery", () => {
    render(<HomePage />);

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
    render(<HomePage />);

    expect(screen.getByRole("link", { name: /khám phá 6 nhà hàng/i })).toHaveAttribute(
      "href",
      "#nha-hang",
    );
    expect(
      screen.getByRole("button", { name: /tạo đơn qua hợp đồng/i }),
    ).toBeDisabled();
    expect(screen.getByText(/chưa triển khai contract trên StudioNet/i)).toBeVisible();
  });

  it("describes hash-bound evidence and escrow as a demo rather than production trust", () => {
    render(<HomePage />);

    expect(screen.getByText(/JSON công khai.*SHA-256/i)).toBeVisible();
    expect(screen.getByText(/không phải tiền thật/i)).toBeVisible();
    expect(screen.getByText(/không tự bảo đảm món ăn đúng/i)).toBeVisible();
  });
});
