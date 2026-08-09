# FoodGuard Vietnamese Serif Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render all FoodGuard display headings, including `Bếp Lá` and `Gánh Cuốn`, with a deterministic Vietnamese-capable serif font and normal restaurant-name spacing.

**Architecture:** Load Noto Serif through Next.js font optimization with the Vietnamese subset and expose it as the `--font-display` CSS variable on the document body. Route every existing serif display selector through that variable and remove the negative tracking on restaurant-card names.

**Tech Stack:** Next.js 16.3, React 19, `next/font/google`, CSS, Vitest

## Global Constraints

- Preserve the current serif visual identity.
- Keep the body sans-serif stack unchanged.
- Keep catalog text unchanged; it is valid NFC Unicode.
- Do not change the Intelligent Contract, StudioNet configuration, wallet flow, evidence rules, or settlement workflow.
- Do not push GitHub or deploy Vercel without separate action-time confirmation.

---

### Task 1: Deterministic Vietnamese display typography

**Files:**
- Create: `tests/web/typography.test.ts`
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: Next.js `Noto_Serif` font loader.
- Produces: the `--font-display` CSS variable applied to the root body and consumed by every display-heading selector.

- [ ] **Step 1: Write the failing regression test**

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/web/typography.test.ts`

Expected: both tests fail because Noto Serif is not configured, the Iowan stack remains, and restaurant-card headings still use `letter-spacing: -0.025em`.

- [ ] **Step 3: Implement the minimal font integration**

In `app/layout.tsx`, add:

```tsx
import { Noto_Serif } from "next/font/google";

const displaySerif = Noto_Serif({
  display: "swap",
  subsets: ["latin", "vietnamese"],
  variable: "--font-display",
});
```

Apply `displaySerif.variable` to `<body>`. In `app/globals.css`, replace each Iowan-based display stack with `var(--font-display), Georgia, serif` and change the `.restaurant-card h3` declaration to `letter-spacing: normal`.

- [ ] **Step 4: Run focused and full automated verification**

Run:

```text
npm test -- --run tests/web/typography.test.ts tests/web/landing.test.tsx
npm test -- --run tests/web
npm run lint
npx tsc --noEmit
npm run build
```

Expected: all commands exit zero. The build must show successful compilation and static page generation.

- [ ] **Step 5: Perform visual verification**

Serve the production build locally and inspect `/` at 375px and 1440px widths. Confirm `Bếp Lá` and `Gánh Cuốn` render without artificial gaps, all display headings retain the serif identity, and there is no horizontal overflow or unexpected card wrapping.

- [ ] **Step 6: Commit the implementation**

```text
git add app/layout.tsx app/globals.css tests/web/typography.test.ts
git commit -m "fix(web): stabilize Vietnamese serif rendering"
```
