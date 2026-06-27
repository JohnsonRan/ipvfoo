# IPvFoo Popup Redesign

Date: 2026-06-27
Status: Approved (design phase)

## Goal

Refresh the popup UI. Two user pains: (1) looks dated/plain, (2) cluttered/dense.
Solution: slimmer rows with hover-revealed meta, plus a modern-minimal visual
treatment. No behavior/data changes.

## Scope

In scope:
- `src/popup.html` — CSS rewrite (modern-minimal).
- `src/popup.js` — `makeRow` restructure; custom hover tooltip.

Out of scope:
- `background.js`, geo fetch logic, icon PNGs, `options.html/.js`, `common.js`,
  `iputil.js`, manifests.
- No new data fields. Same tuple shape from background.

## Row layout

Today each row shows 7+ things on one line: lock icon, domain, IP, geo, request
count, error status, timing, cache/ws/worker/prefetch icon. Too dense.

New row = 3 visible cells, left to right:

1. **Domain cell** — lock icon (SSL state) + domain text. Selectable. Long-domain
   snip behavior unchanged.
2. **Address cell** — IP, monospace, v4 = orange / v6 = green. Selectable. Long-addr
   snip behavior unchanged.
3. **Geo/state cell** — geo summary (ASN | country | region | org, same string as
   today) + the state icon (cache / websocket / serviceworker / prefetch) rendered
   small and dim. The "connected" highlight stays.

Always-visible exceptions:
- **Error status** (HTTP >= 400): small red badge in the row, kept visible because
  it is rare and important.

Moved to hover (custom tooltip, see below):
- **Request count**
- **Timing** (fastest-first / longest-completed)

Copy-paste: column/cell order keeps domain in column 1 and IP in column 2 so
selecting + copying a row still yields "domain<sep>ip". The current fake "zeroth
column" vertical gradient line is removed; copy-paste is preserved by cell order
and the existing `.selectMe` ranges, not the visual line.

## Custom hover tooltip

A single reusable tooltip element (not one per row). On row `mouseenter`, populate
it with that row's count + timing (and any extra meta) and position it near the
cursor/row; hide on `mouseleave`. Styled to match the modern-minimal palette
(rounded, soft shadow, dark-mode aware). Pure vanilla JS + CSS, no build step,
consistent with existing code conventions (`"use strict";`, `newMap()` etc.).

The existing geo detail tooltip (click-to-refresh geo, geo `title` text) stays as
is — only the per-row count/timing meta moves into the new tooltip.

Accessibility: row meta also exposed via `aria-label`/`title` fallback so it is not
purely hover-gated for AT users. Keyboard focus on a row shows the tooltip.

## Modern-minimal visual treatment

- Replace full grid lines with a single subtle `border-bottom` row divider; lighter
  border color than today.
- Remove the `linear-gradient` "zeroth column" line on the table.
- More vertical breathing room: row height ~30px, looser cell padding.
- Softer container: thinner border, smaller/softer box-shadow, keep 8px radius.
- Tighten typography: mono for IPs (already), cleaner domain weight; main row keeps
  emphasis but less heavy.
- Keep: dark mode (`prefers-color-scheme`), v4/v6 color coding, incognito color
  scheme hook (`setColorIsDarkMode`), auto-resize (`resizePopupToContent`), footer
  options link, spill-count row, "grant permission" beg button, shake animation.

## Data flow / behavior

Unchanged. `makeRow(isFirst, tuple)` consumes the same tuple
`[domain, addr, version, flags, firstMs, completedMs, requestCount, errorStatus]`.
`pushAll` / `pushOne` / `minimalCopy` semantics unchanged — `makeRow` still returns
a `<tr>` with stable child order so `minimalCopy`'s node-diffing keeps working and
does not stomp user text selection.

## Testing

No automated popup tests exist (tinytest covers `iputil.js` only). Manual
verification, both Chrome and Firefox manifests:
- Test table renders (open popup with no tabId → built-in `TEST_TUPLES`).
- Rows: domain/IP/geo visible; v4 orange, v6 green; lock states; state icons.
- Hover a row → custom tooltip shows count + timing; leaves cleanly.
- Error status badge shows for >= 400.
- Long domain/IP snip + unsnip still works; copy a row → "domain ip".
- Dark mode toggle; incognito color; resize to content; spill count; beg button.

## Risks

- Count/timing invisible until hover. Accepted (declutter goal); error status stays
  visible; AT fallback provided.
- Custom tooltip positioning inside a small auto-resized popup can clip. Mitigate:
  clamp within popup bounds, prefer above/below row by available space.
- `minimalCopy` relies on stable child node structure; restructure must keep child
  count/order deterministic per row state.
