# FoodGuard Vietnamese Serif Rendering Fix

## Problem

Restaurant names containing precomposed Vietnamese glyphs render with artificial gaps on some Windows browsers. The visible failures include `Bếp Lá` and `Gánh Cuốn`.

The catalog strings are valid NFC Unicode. Production currently renders card headings with the local-font stack `"Iowan Old Style", Georgia, serif` and negative letter spacing. This makes the result depend on platform font metrics and Vietnamese glyph support.

## Approved direction

Preserve the existing serif visual identity, but replace the platform-dependent display stack with a Vietnamese-capable serif webfont bundled by the application.

Use Noto Serif Variable with the Vietnamese character set. Load it through Next.js as a local application font so visitors do not depend on an installed operating-system font or a runtime request to Google Fonts.

## Scope

- Apply the bundled serif font to the existing display-heading font variable or shared heading selectors.
- Cover restaurant-card names and every other heading that currently uses the Iowan/Georgia display stack.
- Keep the current body sans-serif stack unchanged.
- Preserve existing type scale, weights, colors, and responsive layout.
- Remove the negative letter spacing from restaurant names; use normal spacing unless visual verification proves a small non-negative adjustment is necessary.
- Keep catalog text unchanged because its Unicode encoding is already correct.
- Do not change the Intelligent Contract, StudioNet configuration, wallet flow, evidence rules, or settlement workflow.

## Alternatives considered

1. Use only Georgia or another system serif. Rejected because rendering would still vary by operating system.
2. Convert headings to the existing sans-serif body font. Rejected because it changes the approved visual identity.
3. Normalize or rewrite the restaurant strings. Rejected because the strings are already NFC and the defect is typographic, not textual.

## Verification

- Add a failing regression test before implementation that locks the shared display-font integration and prevents the old Iowan stack or negative restaurant-name spacing from returning.
- Run the focused landing tests, full web tests, lint, TypeScript, and production build.
- Inspect the rendered production-equivalent page at mobile and desktop widths, including `Bếp Lá` and `Gánh Cuốn`.
- Confirm no horizontal overflow or unexpected heading reflow.

## Deployment boundary

The local fix and commit do not authorize a GitHub push or Vercel production deployment. Those external actions require separate action-time confirmation.
