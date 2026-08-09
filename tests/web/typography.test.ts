// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync("app/layout.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

describe("Vietnamese display typography", () => {
  it("loads and applies Noto Serif with the Vietnamese subset", () => {
    expect(layout).toContain('import { Noto_Serif } from "next/font/google"');
    expect(layout).toContain('subsets: ["latin", "vietnamese"]');
    expect(layout).toContain('variable: "--font-display"');
    expect(layout).toContain("<body className={displaySerif.variable}>");
  });

  it("uses the shared display font without the broken local stack or card tracking", () => {
    expect(css).not.toContain('"Iowan Old Style"');
    expect(css).toContain("font-family: var(--font-display), Georgia, serif;");
    expect(css).toMatch(/\.restaurant-card h3\s*\{[\s\S]*?letter-spacing:\s*normal;/);
  });
});
