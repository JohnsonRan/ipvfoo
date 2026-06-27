# IPvFoo Popup Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the popup to slim single-line rows (meta on hover) with a modern-minimal visual treatment, without changing any data or background behavior.

**Architecture:** Pure popup change. `src/popup.html` CSS is reworked for modern-minimal; `src/popup.js` `makeRow` is restructured to 3 visible cells + a single reusable custom hover tooltip carrying request count and timing. The same tuple from background.js drives everything; `pushAll`/`pushOne`/`minimalCopy` semantics are preserved by keeping a deterministic child-node structure per row.

**Tech Stack:** Vanilla ES (no build step, no npm), loaded directly by the browser. `"use strict";` at top of every script. Chrome MV3 service worker + Firefox background scripts; popup is plain HTML/CSS/JS.

## Global Constraints

- No build step, no transpilation, no npm — vanilla JS loaded directly by the browser.
- `"use strict";` at top of every script.
- Use `newMap()` (null-prototype object) instead of `{}` for string-keyed maps.
- Popup-only: do NOT modify `background.js`, `common.js`, `iputil.js`, `options.*`, icon PNGs, or manifests.
- `makeRow(isFirst, tuple)` must keep returning a `<tr>` whose child cells have a deterministic order/count so `minimalCopy` node-diffing does not stomp user text selection.
- Tuple shape is fixed: `[domain, addr, version, flags, firstMs, completedMs, requestCount, errorStatus]`.
- Preserve: dark mode (`prefers-color-scheme`), v4/v6 color coding (v4 orange, v6 green), incognito color hook (`setColorIsDarkMode`/`pushPattern`), auto-resize (`resizePopupToContent`), footer options link, spill-count row, beg button, shake animation, long-domain/long-addr snip + unsnip, copy-paste yielding "domain<sep>ip".
- No CLI test runner for the popup. Verification = load `src/` unpacked OR open `src/popup.html` directly; the popup with no `#tabId` renders the built-in `TEST_TUPLES` test table. Visual checks per task.

---

### Task 1: Modern-minimal CSS shell (no row-structure change yet)

Restyle the existing table/card/body so the current 7-column row already looks modern-minimal. This isolates the pure-CSS visual work from the JS row restructure in Task 2, so a reviewer can approve the look independently.

**Files:**
- Modify: `src/popup.html` (the `<style>` block, lines ~21-336)

**Interfaces:**
- Consumes: existing class names emitted by `makeRow` (`.mainRow`, `.domainTd`, `.addrTd`, `.geoTd`, `.countTd`, `.statusTd`, `.timingTd`, `.cacheTd`, `.sslImg`, `.ip4`, `.ip6`, `.highlight`).
- Produces: a modern-minimal stylesheet that Task 2 extends with `.metaTooltip` and a `.geoStateTd` merge. Class names above remain valid until Task 2 removes them.

- [ ] **Step 1: Remove the fake "zeroth column" gradient line and heavy grid**

In `src/popup.html`, change the `table` rule. Replace:

```css
table {
  --cache-min-width: 0px;
  background-image: linear-gradient(to right, transparent 0 27px, #d0d7de 27px 28px, transparent 28px);
  border: 1px solid #d0d7de;
  border-radius: 8px;
  border-spacing: 0;
  box-shadow: 0 8px 24px rgba(140, 149, 159, 0.18);
  overflow: hidden;
}
```

with:

```css
table {
  --cache-min-width: 0px;
  border: 1px solid #e1e4e8;
  border-radius: 8px;
  border-spacing: 0;
  box-shadow: 0 2px 8px rgba(140, 149, 159, 0.12);
  overflow: hidden;
}
```

- [ ] **Step 2: Replace full cell grid lines with a single subtle row divider**

Replace:

```css
td, tr {
  border-width: 0;
  border-collapse: separate;
  border-color: #d0d7de;
  border-style: solid;
  padding: 4px 8px;
  white-space: nowrap;
  user-select: none;
}
tr {
  height: 28px;
}
tr + tr td {
  border-top-width: 1px;
}
tr:hover {
  background-color: #eef6ff;
}
```

with:

```css
td, tr {
  border-width: 0;
  border-collapse: separate;
  border-color: #eaecef;
  border-style: solid;
  padding: 6px 10px;
  white-space: nowrap;
  user-select: none;
}
tr {
  height: 30px;
}
tr + tr td {
  border-top-width: 1px;
}
tr:hover {
  background-color: #f3f6fb;
}
```

- [ ] **Step 3: Soften the dark-mode equivalents**

Replace the dark-mode `table`, `td, tr`, and `tr:hover` rules inside `@media (prefers-color-scheme: dark)`:

```css
  table {
    background-image: linear-gradient(to right, transparent 0 27px, #30363d 27px 28px, transparent 28px);
    border-color: #30363d;
    box-shadow: 0 8px 24px rgba(1, 4, 9, 0.35);
  }
  td, tr {
    border-color: #30363d;
  }
  tr:hover {
    background-color: #161b22;
  }
```

with:

```css
  table {
    border-color: #2a2f37;
    box-shadow: 0 2px 8px rgba(1, 4, 9, 0.4);
  }
  td, tr {
    border-color: #21262d;
  }
  tr:hover {
    background-color: #161b22;
  }
```

- [ ] **Step 4: Verify in browser**

Open `src/popup.html` directly in a browser (no `#tabId` → renders `TEST_TUPLES`).
Expected: card has a thinner border + softer shadow; rows separated by a single light divider, no vertical grid lines, no left "zeroth-column" line; rows are slightly taller with more padding. Toggle OS dark mode → dark card softened, no gradient line. v4 row IP orange, v6 rows IP green.

- [ ] **Step 5: Commit**

```bash
git add src/popup.html
git commit -m "style(popup): modern-minimal card and dividers"
```

---

### Task 2: Slim 3-cell row + custom hover tooltip

Restructure `makeRow` so each row shows only Domain, Address, and a merged Geo+State cell; move request count and timing into a single reusable custom tooltip shown on row hover/focus; keep the error-status badge visible.

**Files:**
- Modify: `src/popup.js` (`makeRow` ~481-640; add tooltip helpers)
- Modify: `src/popup.html` (add `.metaTooltip` + `.statusBadge` CSS; add tooltip element to body)

**Interfaces:**
- Consumes: tuple `[domain, addr, version, flags, firstMs, completedMs, requestCount, errorStatus]`; existing helpers `makeSslImg`, `formatDuration`, `makeImg`, `isGeoLookupCandidate`, `geoInfoQueue`, `makeSnippedText`, `handleClick`, `handleContextMenu`, `resizePopupToContent`; flags `DFLAG_*`/`AFLAG_*`.
- Produces:
  - `makeRow(isFirst, tuple)` → `<tr>` with exactly 3 `<td>` children in fixed order: `domainTd` (`.domainTd`), `addrTd` (`.addrTd …`), `geoStateTd` (`.geoStateTd …`). Row carries `tr._domain` (unchanged) and `tr._meta = {requestCount, errorStatus, firstMs, completedMs}` for the tooltip.
  - `showMetaTooltip(tr)` / `hideMetaTooltip()` — manage the single `#meta_tooltip` element.
  - `formatRowMeta(meta)` → string lines for the tooltip.

- [ ] **Step 1: Add the tooltip element and CSS**

In `src/popup.html`, add inside `<body>` just after the `.border` opening (before `<button id="beg">` is fine; element is position-fixed so location doesn't matter):

```html
<div id="meta_tooltip" class="metaTooltip" role="tooltip" aria-hidden="true"></div>
```

Add to the `<style>` block (light mode, before the dark-mode `@media`):

```css
.metaTooltip {
  position: fixed;
  z-index: 10;
  display: none;
  max-width: 240px;
  padding: 6px 9px;
  border: 1px solid #e1e4e8;
  border-radius: 6px;
  background: #ffffff;
  color: #1f2328;
  box-shadow: 0 4px 14px rgba(140, 149, 159, 0.28);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  pointer-events: none;
}
.metaTooltip.visible {
  display: block;
}
.statusBadge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 999px;
  background: #ffebe9;
  color: #cf222e;
  font-size: 11px;
  font-weight: 600;
  vertical-align: 1px;
}
.geoStateTd {
  font-size: 12px;
  color: #57606a;
  padding-left: 6pt;
  border-left-width: 0;
  border-right-width: 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.geoStateTd .stateImg {
  opacity: 0.6;
  margin-left: 6px;
}
```

Add to the dark-mode `@media (prefers-color-scheme: dark)` block:

```css
  .metaTooltip {
    border-color: #30363d;
    background: #161b22;
    color: #e6edf3;
    box-shadow: 0 4px 14px rgba(1, 4, 9, 0.5);
  }
  .statusBadge {
    background: #3a1d1d;
    color: #ff7b72;
  }
  .geoStateTd {
    color: #8b949e;
  }
```

- [ ] **Step 2: Add tooltip + meta-format helpers in popup.js**

Add near the other top-level helpers in `src/popup.js` (e.g. after `formatDuration`, ~line 479):

```js
function formatRowMeta(meta) {
  const lines = [];
  if (meta.requestCount > 0) {
    lines.push(`Requests: ${meta.requestCount}`);
  }
  const firstText = formatDuration(meta.firstMs);
  const completedText = formatDuration(meta.completedMs);
  if (firstText || completedText) {
    lines.push(`Fastest first response: ${firstText || "unknown"}`);
    lines.push(`Longest completed request: ${completedText || "pending"}`);
  }
  if (Number.isFinite(meta.errorStatus) && meta.errorStatus >= 400) {
    lines.push(`Last error status: ${meta.errorStatus}`);
  }
  return lines.join("\n");
}

let metaTooltipEl = null;
function showMetaTooltip(tr) {
  const meta = tr._meta;
  if (!meta) return;
  const text = formatRowMeta(meta);
  if (!text) return;
  if (!metaTooltipEl) {
    metaTooltipEl = document.getElementById("meta_tooltip");
  }
  metaTooltipEl.textContent = text;
  metaTooltipEl.classList.add("visible");
  metaTooltipEl.setAttribute("aria-hidden", "false");

  // Position near the row, clamped within the viewport (popup bounds).
  const rect = tr.getBoundingClientRect();
  const tip = metaTooltipEl.getBoundingClientRect();
  const margin = 6;
  let top = rect.bottom + margin;
  if (top + tip.height > window.innerHeight) {
    top = Math.max(margin, rect.top - tip.height - margin);
  }
  let left = rect.left;
  if (left + tip.width > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - tip.width - margin);
  }
  metaTooltipEl.style.top = `${top}px`;
  metaTooltipEl.style.left = `${left}px`;
}

function hideMetaTooltip() {
  if (!metaTooltipEl) return;
  metaTooltipEl.classList.remove("visible");
  metaTooltipEl.setAttribute("aria-hidden", "true");
}
```

- [ ] **Step 3: Restructure `makeRow` to 3 cells**

In `src/popup.js`, replace the body of `makeRow` from the `// Build the "Geo Info" column.` comment through the `return tr;` line (the geo/count/status/timing/cache construction and the `tr.append*` block, ~lines 539-639) with the merged geo+state cell, the row-level meta + tooltip wiring, and the visible error badge. Keep the domain-cell and address-cell construction above it unchanged.

Replace this region:

```js
  // Build the "Geo Info" column.
  const geoTd = document.createElement("td");
  geoTd.className = `geoTd${connectedClass}`;
  geoTd.textContent = "";
  geoTd.title = "";

  if (isGeoLookupCandidate(addr)) {
    const showGeoInfo = (info) => {
      const { asn, country_code, region_code, organization } = info;
      const summary = [asn, country_code, region_code, organization].filter(Boolean).join(" | ");
      geoTd.classList.remove("geoPending");
      geoTd.textContent = summary;
      geoTd.title = geoTitle(info) || summary;
      resizePopupToContent();
    };
    const showGeoPending = () => {
      geoTd.classList.add("geoPending");
      geoTd.title = "Refreshing Geo cache...";
      resizePopupToContent();
    };
    geoTd.classList.add("geoRefreshable");
    geoTd.setAttribute("role", "button");
    geoTd.setAttribute("tabindex", "0");
    geoTd.setAttribute("aria-label", `Refresh Geo info for ${addr}`);
    const doRefresh = () => geoInfoQueue.refresh(addr, showGeoInfo, showGeoPending);
    geoTd.onclick = doRefresh;
    geoTd.onkeydown = (e) => {
      if (e.key == "Enter" || e.key == " ") {
        e.preventDefault();
        doRefresh();
      }
    };
    geoInfoQueue.add(addr, showGeoInfo, showGeoPending);
  }

  // Build the "Request Count" column.
  const countTd = document.createElement("td");
  countTd.className = `countTd${connectedClass}`;
  if (requestCount > 0) {
    countTd.textContent = String(requestCount);
    countTd.title = `Requests: ${requestCount}`;
  }

  // Build the "Error Status" column.
  const statusTd = document.createElement("td");
  statusTd.className = `statusTd${connectedClass}`;
  if (Number.isFinite(errorStatus) && errorStatus >= 400) {
    statusTd.textContent = String(errorStatus);
    statusTd.title = `Last error status: ${errorStatus}`;
    statusTd.classList.add("errorStatus");
  }

  // Build the "Timing" column.
  const timingTd = document.createElement("td");
  timingTd.className = `timingTd${connectedClass}`;
  const firstText = formatDuration(firstMs);
  const completedText = formatDuration(completedMs);
  if (firstText || completedText) {
    timingTd.textContent = `${firstText || "-"} / ${completedText || "..."}`;
    timingTd.title =
        `Fastest first response: ${firstText || "unknown"}\n` +
        `Longest completed request: ${completedText || "pending"}`;
  }

  // Build the (possibly invisible) "WebSocket/Cached" column.
  // We don't need to worry about drawing both, because a cached WebSocket
  // would be nonsensical.
  //
  // Now that we also have a Service Worker icon, I just made it replace
  // the Cached icon because I'm too lazy to align multiple columns properly.
  const cacheTd = document.createElement("td");
  cacheTd.className = `cacheTd${connectedClass}`;
  if (flags & DFLAG_WEBSOCKET) {
    cacheTd.appendChild(
        makeImg("websocket.png", "WebSocket handshake; connection may still be active."));
    cacheTd.style.paddingLeft = '6pt';
  } else if (flags & AFLAG_PREFETCH) {
    cacheTd.appendChild(
        makeImg("prefetch.png", "Prefetched request; may be proxied."));
    cacheTd.style.paddingLeft = '6pt';
  } else if (flags & AFLAG_WORKER) {
    cacheTd.appendChild(
        makeImg("serviceworker.png", "Service Worker request; possibly from a different tab."));
    cacheTd.style.paddingLeft = '6pt';
  } else if (flags & AFLAG_CACHE) {
    cacheTd.appendChild(
        makeImg("cached_arrow.png", "Data from cached requests only."));
    cacheTd.style.paddingLeft = '6pt';
  } else {
    cacheTd.style.paddingLeft = '0';
  }

  tr._domain = domain;
  tr.appendChild(domainTd);
  tr.appendChild(addrTd);
  tr.appendChild(geoTd);
  tr.appendChild(countTd);
  tr.appendChild(statusTd);
  tr.appendChild(timingTd);
  tr.appendChild(cacheTd);
  return tr;
```

with:

```js
  // Build the merged "Geo + State" column.
  const geoStateTd = document.createElement("td");
  geoStateTd.className = `geoStateTd${connectedClass}`;

  const geoText = document.createElement("span");
  geoText.className = "geoText";
  geoStateTd.appendChild(geoText);

  if (isGeoLookupCandidate(addr)) {
    const showGeoInfo = (info) => {
      const { asn, country_code, region_code, organization } = info;
      const summary = [asn, country_code, region_code, organization].filter(Boolean).join(" | ");
      geoText.classList.remove("geoPending");
      geoText.textContent = summary;
      geoText.title = geoTitle(info) || summary;
      resizePopupToContent();
    };
    const showGeoPending = () => {
      geoText.classList.add("geoPending");
      geoText.title = "Refreshing Geo cache...";
      resizePopupToContent();
    };
    geoText.classList.add("geoRefreshable");
    geoText.setAttribute("role", "button");
    geoText.setAttribute("tabindex", "0");
    geoText.setAttribute("aria-label", `Refresh Geo info for ${addr}`);
    const doRefresh = () => geoInfoQueue.refresh(addr, showGeoInfo, showGeoPending);
    geoText.onclick = doRefresh;
    geoText.onkeydown = (e) => {
      if (e.key == "Enter" || e.key == " ") {
        e.preventDefault();
        doRefresh();
      }
    };
    geoInfoQueue.add(addr, showGeoInfo, showGeoPending);
  }

  // State icon (websocket/prefetch/serviceworker/cache), small and dim.
  // A cached WebSocket would be nonsensical, so at most one applies.
  let stateImg = null;
  if (flags & DFLAG_WEBSOCKET) {
    stateImg = makeImg("websocket.png", "WebSocket handshake; connection may still be active.");
  } else if (flags & AFLAG_PREFETCH) {
    stateImg = makeImg("prefetch.png", "Prefetched request; may be proxied.");
  } else if (flags & AFLAG_WORKER) {
    stateImg = makeImg("serviceworker.png", "Service Worker request; possibly from a different tab.");
  } else if (flags & AFLAG_CACHE) {
    stateImg = makeImg("cached_arrow.png", "Data from cached requests only.");
  }
  if (stateImg) {
    stateImg.className = "stateImg";
    geoStateTd.appendChild(stateImg);
  }

  // Visible error-status badge (rare + important).
  if (Number.isFinite(errorStatus) && errorStatus >= 400) {
    const badge = document.createElement("span");
    badge.className = "statusBadge";
    badge.textContent = String(errorStatus);
    badge.title = `Last error status: ${errorStatus}`;
    geoStateTd.appendChild(badge);
  }

  // Row-level meta drives the custom hover tooltip (count + timing).
  tr._meta = { requestCount, errorStatus, firstMs, completedMs };
  tr.onmouseenter = () => showMetaTooltip(tr);
  tr.onmouseleave = hideMetaTooltip;
  tr.onfocusin = () => showMetaTooltip(tr);
  tr.onfocusout = hideMetaTooltip;

  tr._domain = domain;
  tr.appendChild(domainTd);
  tr.appendChild(addrTd);
  tr.appendChild(geoStateTd);
  return tr;
```

- [ ] **Step 4: Hide the tooltip when the table is cleared/rebuilt**

In `pushAll` (~line 348), add `hideMetaTooltip();` as the first line so a stale tooltip can't linger across a full rebuild:

```js
function pushAll(tuples, pattern, color, spillCount) {
  hideMetaTooltip();
  removeChildren(table);
```

- [ ] **Step 5: Verify in browser**

Open `src/popup.html` directly (no `#tabId` → `TEST_TUPLES`).
Expected:
- Each row shows only domain, IP, and geo/state — no inline count/status/timing columns.
- v4 IP orange, v6 IP green; lock icons present; `cached.example.com` row shows the cache state icon, small + dim.
- Hover a row → custom styled tooltip appears near it with "Requests: N" and the two timing lines; moving away hides it. Tooltip styled (rounded, shadow), dark-mode aware when OS is dark.
- Long domain/IP still snip with "…"; clicking "…" unsnips; copying a row yields "domain<tab/space>ip".
- Resize-to-content still fits; spill-count row + options footer still render.

- [ ] **Step 6: Commit**

```bash
git add src/popup.js src/popup.html
git commit -m "feat(popup): slim 3-cell rows with hover meta tooltip"
```

---

### Task 3: Remove now-dead CSS and verify both browsers

Delete CSS rules for the columns that no longer exist, and confirm the popup works under both the Chrome and Firefox manifests via the live extension (not just the static file).

**Files:**
- Modify: `src/popup.html` (remove dead `.geoTd`, `.countTd`, `.statusTd`, `.timingTd`, `.cacheTd` rules + their dark-mode variants; keep `.geoPending`, `.geoRefreshable`, `.highlight`, `.statusBadge`, `.geoStateTd`)

**Interfaces:**
- Consumes: class names still emitted after Task 2 (`.geoStateTd`, `.geoText`, `.geoPending`, `.geoRefreshable`, `.stateImg`, `.statusBadge`, `.highlight`, `.metaTooltip`).
- Produces: final stylesheet with no orphan rules.

- [ ] **Step 1: Delete orphaned light-mode rules**

In `src/popup.html`, delete these rules (no longer referenced after Task 2): `.cacheTd`, `.cacheTd img`, the old `.geoTd` block, and the `.countTd, .statusTd` / `.countTd` / `.statusTd.errorStatus` / `.timingTd` rules. Keep `.geoPending`, `.geoPending::after`, `.geoRefreshable`, and the `.geoRefreshable:focus-visible, #options_link:focus-visible` rule (move the `.geoRefreshable` selector context onto `.geoText` is not needed — the class is applied to `geoText` in Task 2, and these selectors are class-based so they still match).

- [ ] **Step 2: Delete orphaned dark-mode rules**

Inside `@media (prefers-color-scheme: dark)`, delete the now-dead `.geoTd`, `.countTd, .statusTd`, `.statusTd.errorStatus`, and `.timingTd` color rules. Keep `.geoPending::after` dark variant and `.highlight` dark variant.

- [ ] **Step 3: Verify static file still correct**

Open `src/popup.html` directly. Expected: identical to end of Task 2 (no visual regression — only dead rules removed). Check light + dark.

- [ ] **Step 4: Verify live extension, Chrome**

```bash
cp src/manifest/chrome-manifest.json src/manifest.json
```

Load `src/` as an unpacked extension in Chrome (`chrome://extensions`, Developer mode, Load unpacked). Visit an IPv6 and an IPv4 site, open the popup. Expected: real rows render in the new layout; hover tooltip shows count/timing; geo (if enabled in options) appears; clicking geo refreshes; icon + resize behave.

- [ ] **Step 5: Verify live extension, Firefox**

```bash
cp src/manifest/firefox-manifest.json src/manifest.json
```

Load `src/` via `about:debugging` → This Firefox → Load Temporary Add-on → pick `src/manifest.json`. Open the popup on a live site. Expected: same as Chrome; no console errors; tooltip + snip + copy-paste work.

- [ ] **Step 6: Restore tracked manifest and commit**

The repo tracks `src/manifest.json` as a copy of one of the two; restore whichever was checked in (compare with `git diff src/manifest.json` and `git checkout src/manifest.json` if it only differs by the manifest swap).

```bash
git checkout src/manifest.json
git add src/popup.html
git commit -m "style(popup): remove dead column CSS after row restructure"
```

---

## Self-Review

**Spec coverage:**
- Slim 3-cell row → Task 2 Step 3. ✓
- Error status visible badge → Task 2 Step 3 (`.statusBadge`). ✓
- Count + timing on custom hover tooltip → Task 2 Steps 1-3 (`metaTooltip`, `showMetaTooltip`, `formatRowMeta`). ✓
- Geo + state icon merged cell → Task 2 Step 3 (`geoStateTd`, `stateImg`). ✓
- Modern-minimal card/dividers/spacing → Task 1. ✓
- Remove zeroth-column gradient line → Task 1 Step 1. ✓
- Preserve dark mode / v4-v6 colors / snip / copy-paste / resize / footer / spill / beg / shake → untouched code + Task 2/3 verify steps. ✓
- AT fallback for hover meta → tooltip also shown on `focusin`/`focusout` (keyboard focus), Task 2 Step 3. ✓
- Dead CSS cleanup → Task 3. ✓
- Both browsers verified → Task 3 Steps 4-5. ✓

**Placeholder scan:** No TBD/TODO; all code steps show full code. ✓

**Type consistency:** `showMetaTooltip(tr)`/`hideMetaTooltip()`/`formatRowMeta(meta)`/`tr._meta` names consistent across Task 2 Steps 2-4 and `pushAll`. `geoStateTd`/`geoText`/`stateImg`/`statusBadge` class names consistent between Task 2 CSS (Step 1) and JS (Step 3) and Task 3 cleanup. ✓
