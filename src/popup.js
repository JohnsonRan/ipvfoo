/*
Copyright (C) 2011  Paul Marks  http://www.pmarks.net/

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

"use strict";

// Requires <script src="common.js">

// Geo info fetch queue: up to 5 concurrent requests per 3-second batch.
const geoInfoQueue = (() => {
  const EMPTY = { asn: "", country_code: "", region_code: "", organization: "", _cacheKey: "" };
  const queue = [];
  const pendingByKey = new Map();  // CIDR cache key -> {callback, onPending}[]
  const cacheByKey = new Map();    // CIDR cache key -> geo info
  let running = 0;
  let lastBatchTime = 0;
  let batchTimer = null;
  const MAX_CONCURRENT = 5;
  const INTERVAL_MS = 3000;

  async function fetchGeo(ip, forceRefresh = false) {
    try {
      const cmd = forceRefresh ? "refreshGeoInfo" : "fetchGeoInfo";
      return await chrome.runtime.sendMessage({ cmd, ip }) || EMPTY;
    } catch {
      return EMPTY;
    }
  }

  function hasGeoInfo(info) {
    return !!(info?.asn || info?.country_code || info?.region_code || info?.organization);
  }

  async function readCachedGeo(key) {
    try {
      const storageKey = GEO_CACHE_PREFIX + key;
      const cached = await chrome.storage.local.get(storageKey);
      const entry = cached[storageKey];
      const ttl = hasGeoInfo(entry?.data) ? GEO_CACHE_TTL : GEO_NEGATIVE_CACHE_TTL;
      if (entry?.data && entry.timestamp && Date.now() - entry.timestamp < ttl) {
        return {
          ...(entry.data || EMPTY),
          _cacheKey: key,
          _cacheHit: true,
          _cacheAgeMs: Date.now() - entry.timestamp,
          _cachedAt: entry.timestamp,
        };
      }
    } catch {
      // ignore
    }
    return null;
  }

  function deliver(key, info) {
    const callbacks = pendingByKey.get(key) || [];
    pendingByKey.delete(key);
    cacheByKey.set(key, info || EMPTY);
    for (const { callback } of callbacks) {
      try {
        callback(info);
      } catch (err) {
        console.error("Geo callback failed", err);
      }
    }
  }

  async function runOne(entry) {
    let info = EMPTY;
    try {
      info = await fetchGeo(entry.ip, entry.forceRefresh);
    } catch {
      info = EMPTY;
    }
    deliver(entry.key, info || EMPTY);
  }

  function process() {
    if (!queue.length || running > 0) {
      return;
    }

    const elapsed = Date.now() - lastBatchTime;
    if (lastBatchTime && elapsed < INTERVAL_MS) {
      if (!batchTimer) {
        batchTimer = setTimeout(() => {
          batchTimer = null;
          process();
        }, INTERVAL_MS - elapsed);
      }
      return;
    }

    lastBatchTime = Date.now();
    const batch = queue.splice(0, MAX_CONCURRENT);
    for (const entry of batch) {
      running++;
      runOne(entry).finally(() => {
        running--;
        if (running == 0) {
          process();
        }
      });
    }
  }

  function add(ip, callback, onPending, forceRefresh = false) {
    const key = geoCacheKeyForIP(ip);
    if (!key) {
      callback(EMPTY);
      return;
    }
    if (!forceRefresh && cacheByKey.has(key)) {
      callback(cacheByKey.get(key));
      return;
    }
    if (forceRefresh) {
      cacheByKey.delete(key);
    }
    const pending = pendingByKey.get(key);
    if (pending) {
      pending.push({ callback, onPending });
      return;
    }
    pendingByKey.set(key, [{ callback, onPending }]);
    if (forceRefresh) {
      const pending = pendingByKey.get(key);
      for (const item of pending) {
        item.onPending?.();
      }
      queue.unshift({ key, ip, forceRefresh: true });
      process();
      return;
    }
    readCachedGeo(key).then((info) => {
      if (info) {
        deliver(key, info);
        return;
      }
      const pending = pendingByKey.get(key);
      if (pending) {
        for (const item of pending) {
          item.onPending?.();
        }
        queue.push({ key, ip });
        process();
      }
    });
  }

  function refresh(ip, callback, onPending) {
    add(ip, callback, onPending, true);
  }

  return { add, refresh };
})();

function formatGeoAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "";
  }
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

function formatGeoCacheTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function geoTitle(info) {
  const lines = [];
  if (info.asn) lines.push(`ASN: ${info.asn}`);
  if (info.country_code) lines.push(`Country: ${info.country_code}`);
  if (info.region_code) lines.push(`Region: ${info.region_code}`);
  if (info.organization) lines.push(`Organization: ${info.organization}`);
  if (info._cacheKey) lines.push(`CIDR cache key: ${info._cacheKey}`);
  if (info._cacheHit) {
    const age = formatGeoAge(info._cacheAgeMs);
    const cachedAt = formatGeoCacheTime(info._cachedAt);
    lines.push(`Cache: hit${age ? ` (${age} old)` : ""}`);
    if (cachedAt) lines.push(`Cached at: ${cachedAt}`);
  } else if (info._cacheKey) {
    lines.push("Cache: refreshed");
  }
  if (info._cacheKey) lines.push("Click to refresh Geo cache");
  return lines.join("\n");
}

function isGeoLookupCandidate(addr) {
  if (!options[GEO_INFO_ENABLED]) {
    return false;
  }
  if (!addr || addr == "(no address)" || addr == "(lost)") {
    return false;
  }
  return isPublicIPForGeo(addr);
}

const ALL_URLS = "<all_urls>";

// Snip long labels, to avoid horizontal scrolling.
const LONG_DOMAIN = 34;
const LONG_ADDR = 27;

const tabId = window.location.hash.substr(1);

let table = null;

const POPUP_MAX_WIDTH = 780;
const POPUP_MAX_HEIGHT = 580;

window.onload = async function() {
  table = document.getElementById("addr_table");
  table.onmousedown = handleMouseDown;

  const optionsLink = document.getElementById("options_link");
  optionsLink?.addEventListener("click", (e) => {
    e.preventDefault();
    if (chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
      window.close();
    }
  });

  if (/^[0-9]+$/.test(tabId)) {
    await beg();
    connectToExtension();
  } else if (tabId) {
    throw new Error(`Bad tabId: ${tabId}`);
  } else {
    console.log("No tabId, using test table")
    const TEST_TUPLES = [
      ["ipv6.example.com", "2001:db8::f00", "6", DFLAG_SSL, 82, 410],
      ["ipv4.example.com", "192.0.2.9", "4", DFLAG_NOSSL, 126, 1390],
      ["cached.example.com", "2001:db8::f00", "6", DFLAG_SSL | DFLAG_NOSSL | AFLAG_CACHE, 9, 9],
    ];
    pushAll(TEST_TUPLES, "646", REGULAR_COLOR, 0);
  }
};

function resizePopupToContent() {
  requestAnimationFrame(() => {
    const border = document.querySelector(".border");
    if (!border) {
      return;
    }

    document.body.style.width = "";
    document.body.style.height = "";
    document.body.style.overflow = "";
    border.style.maxWidth = "";
    border.style.maxHeight = "";
    border.style.overflow = "";

    const bodyStyle = getComputedStyle(document.body);
    const horizontalPadding = parseFloat(bodyStyle.paddingLeft) + parseFloat(bodyStyle.paddingRight);
    const verticalPadding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
    const width = Math.min(Math.ceil(border.scrollWidth + horizontalPadding), POPUP_MAX_WIDTH);
    const height = Math.min(Math.ceil(border.scrollHeight + verticalPadding), POPUP_MAX_HEIGHT);

    document.body.style.width = `${width}px`;
    document.body.style.height = `${height}px`;
    document.body.style.overflow = "hidden";
    border.style.maxWidth = `${Math.max(0, width - horizontalPadding)}px`;
    border.style.maxHeight = `${Math.max(0, height - verticalPadding)}px`;
    border.style.overflow = "auto";
  });
}

// Monitor for dark mode updates.
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
let darkMode = darkModeQuery.matches;
darkModeQuery.addEventListener("change", async (event) => {
  darkMode = event.matches;
  await optionsReady;
  if (lastColor) {
    setColorIsDarkMode(lastColor, darkMode);
  }
});

async function beg() {
  const p = await chrome.permissions.getAll();
  for (const origin of p.origins) {
    if (origin == ALL_URLS) {
      return;  // We already have permission.
    }
  }
  const button = document.getElementById("beg");
  button.style.display = "block";  // visible
  resizePopupToContent();
  button.addEventListener("click", async () => {
    // We need to close the popup before awaiting, otherwise
    // Firefox (at least version 116 on Windows) renders the
    // permission dialog underneath the popup.
    const promise = chrome.permissions.request({origins: [ALL_URLS]});
    window.close();
    await promise;
  });
}

function connectToExtension() {
  const port = chrome.runtime.connect(null, {name: tabId});
  port.onMessage.addListener((msg) => {
    document.bgColor = "";
    //console.log("onMessage", msg.cmd, msg);
    switch (msg.cmd) {
      case "pushAll":
        return pushAll(msg.tuples, msg.pattern, msg.color, msg.spillCount);
      case "pushOne":
        return pushOne(msg.tuple);
      case "pushPattern":
        return pushPattern(msg.pattern, msg.color);
      case "pushSpillCount":
        return pushSpillCount(msg.spillCount);
      case "shake":
        return shake();
    }
  });

  port.onDisconnect.addListener(() => {
    document.bgColor = "lightpink";
    setTimeout(connectToExtension, 1);
  });
}

// Clear the table, and fill it with new data.
function pushAll(tuples, pattern, color, spillCount) {
  hideMetaTooltip();
  removeChildren(table);
  for (let i = 0; i < tuples.length; i++) {
    table.appendChild(makeRow(i == 0, tuples[i]));
  }
  pushPattern(pattern, color);
  pushSpillCount(spillCount);
  resizePopupToContent();
}

// Insert or update a single table row.
function pushOne(tuple) {
  const domain = tuple[0];
  let insertHere = null;
  let isFirst = true;
  for (let tr = table.firstChild; tr; tr = tr.nextSibling) {
    if (tr._domain == domain) {
      // Found an exact match.  Update the row.
      hideMetaTooltip();
      minimalCopy(makeRow(isFirst, tuple), tr);
      return;
    }
    if (isFirst) {
      isFirst = false;
    } else if (tr._domain > domain) {
      insertHere = tr;
      break;
    }
  }
  // No exact match.  Insert the row in alphabetical order.
  table.insertBefore(makeRow(false, tuple), insertHere);
  scrollbarHack();
  resizePopupToContent();
}

let lastColor = "";  // regular/incognito color scheme
function pushPattern(pattern, color) {
  if (lastColor != color) {
    lastColor = color;
    setColorIsDarkMode(lastColor, darkMode);
  }
}

// Count must be a number.
function pushSpillCount(count) {
  document.getElementById("spill_count_container").style.display =
      count == 0 ? "none" : "block";
  removeChildren(document.getElementById("spill_count")).appendChild(
      document.createTextNode(count));
  scrollbarHack();
  resizePopupToContent();
}

// Shake the content (for 500ms) to signal an error.
function shake() {
  document.body.className = "shake";
  setTimeout(function() {
    document.body.className = "";
  }, 600);
}

// Workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1395025
let redrawn = false;
function scrollbarHack() {
  if (typeof browser == "undefined") {
    return;  // nothing to do on Chrome.
  }
  setTimeout(() => {
    const e = document.documentElement;
    if (e.scrollHeight <= e.clientHeight && !redrawn) {
      document.body.classList.toggle('force-redraw');
      redrawn = true;
    }
  }, 200);
}

// Copy the contents of src into dst, making minimal changes.
function minimalCopy(src, dst) {
  dst.className = src.className;
  dst._meta = src._meta;
  for (let s = src.firstChild, d = dst.firstChild, sNext, dNext;
       s && d;
       s = sNext, d = dNext) {
    sNext = s.nextSibling;
    dNext = d.nextSibling;
    // First, sync up the class names.
    d.className = s.className = s.className;
    // Only replace the whole node if something changes.
    // That way, we avoid stomping on the user's selected text.
    if (!d.isEqualNode(s)) {
      dst.replaceChild(s, d);
    }
  }
}

function makeImg(src, title) {
  const img = document.createElement("img");
  img.src = src;
  img.title = title;
  // Empty title => decorative (e.g. the "..." snip image); hide from AT.
  img.alt = title;
  return img;
}

function makeSslImg(flags) {
  switch (flags & (DFLAG_SSL | DFLAG_NOSSL)) {
    case DFLAG_SSL | DFLAG_NOSSL:
      return makeImg(
          "gray_schrodingers_lock.png",
          "Mixture of HTTPS and non-HTTPS connections.");
    case DFLAG_SSL:
      return makeImg(
          "gray_lock.png",
          "Connection uses HTTPS.\n" +
          "Warning: IPvFoo does not verify the integrity of encryption.");
    default:
      return makeImg(
          "gray_unlock.png",
          "Connection does not use HTTPS.");
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 10000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms / 1000)}s`;
}

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

// Compact one-line "<count> · <first>/<completed>" for inline display.
function formatRowMetaSummary(requestCount, firstMs, completedMs) {
  const parts = [];
  if (requestCount > 0) {
    parts.push(String(requestCount));
  }
  const firstText = formatDuration(firstMs);
  const completedText = formatDuration(completedMs);
  if (firstText || completedText) {
    parts.push(`${firstText || "-"}/${completedText || "..."}`);
  }
  return parts.join(" · ");
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

function makeRow(isFirst, tuple) {
  const domain = tuple[0];
  const addr = tuple[1];
  const version = tuple[2];
  const flags = tuple[3];
  const firstMs = tuple[4];
  const completedMs = tuple[5];
  const requestCount = tuple[6] || 0;
  const errorStatus = tuple[7];

  const tr = document.createElement("tr");
  if (isFirst) {
    tr.className = "mainRow";
  }

  // Build the SSL icon for the "zeroth" pseudo-column.
  const sslImg = makeSslImg(flags);
  sslImg.className = "sslImg";

  // Build the "Domain" column.
  const domainTd = document.createElement("td");
  domainTd.appendChild(sslImg);

  const selectMe = document.createElement("span");
  domainTd.appendChild(selectMe);
  selectMe.className = "selectMe";

  if (domain.length > LONG_DOMAIN) {
    selectMe.appendChild(makeSnippedText(domain, Math.floor(LONG_DOMAIN / 2)));
  } else {
    selectMe.appendChild(document.createTextNode(domain));
  }
  domainTd.className = "domainTd";
  domainTd.title = domain;
  domainTd.onclick = handleClick;
  domainTd.oncontextmenu = handleContextMenu;

  // Build the "Address" column.
  const addrTd = document.createElement("td");
  let addrClass = "";
  switch (version) {
    case "4": addrClass = " ip4"; break;
    case "6": addrClass = " ip6"; break;
  }
  const connectedClass = (flags & DFLAG_CONNECTED) ? " highlight" : "";
  addrTd.className = `addrTd${addrClass}${connectedClass}`;
  addrTd.title = addr;
  if (addr.length > LONG_ADDR) {
    const selectMe = document.createElement("span");
    selectMe.className = "selectMe";
    selectMe.appendChild(makeSnippedText(addr, Math.floor(LONG_ADDR / 2)));
    addrTd.appendChild(selectMe);
  } else {
    addrTd.appendChild(document.createTextNode(addr));
  }
  addrTd.onclick = handleClick;
  addrTd.oncontextmenu = handleContextMenu;

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

  // Visible request-count + timing, compact and dim (sibling of the clipped
  // geo text, so it never gets ellipsized away).
  const metaSummary = formatRowMetaSummary(requestCount, firstMs, completedMs);
  if (metaSummary) {
    const metaSpan = document.createElement("span");
    metaSpan.className = "rowMeta";
    metaSpan.textContent = metaSummary;
    geoStateTd.appendChild(metaSpan);
  }

  // Row-level meta drives the custom hover tooltip (count + timing).
  tr._meta = { requestCount, errorStatus, firstMs, completedMs };
  const metaTitle = formatRowMeta(tr._meta);
  if (metaTitle) {
    geoStateTd.title = metaTitle;
  }
  tr.onmouseenter = () => showMetaTooltip(tr);
  tr.onmouseleave = hideMetaTooltip;
  tr.onfocusin = () => showMetaTooltip(tr);
  tr.onfocusout = hideMetaTooltip;

  tr._domain = domain;
  tr.appendChild(domainTd);
  tr.appendChild(addrTd);
  tr.appendChild(geoStateTd);
  return tr;
}

// Given a long domain name, generate "prefix...suffix".  When the user
// clicks "...", all domains are expanded.  The CSS is tricky because
// we want the original domain to remain intact for clipboard purposes.
function makeSnippedText(domain, keep) {
  const prefix = domain.substr(0, keep);
  const snipped = domain.substr(keep, domain.length - 2 * keep);
  const suffix = domain.substr(domain.length - keep);
  const f = document.createDocumentFragment();

  // Add prefix text.
  f.appendChild(document.createTextNode(prefix));

  // Add snipped text, invisible but copyable.
  let snippedText = document.createElement("span");
  snippedText.className = "snippedTextInvisible";
  snippedText.textContent = snipped;
  f.appendChild(snippedText);

  // Add clickable "..." image.
  const snipImg = makeImg("snip.png", "");
  snipImg.className = "snipImg";
  const snipLink = document.createElement("a");
  snipLink.className = "snipLinkInvisible snipLinkVisible";
  snipLink.href = "#";
  snipLink.addEventListener("click", unsnipAll);
  snipLink.appendChild(snipImg);
  f.appendChild(snipLink);

  // Add suffix text.
  f.appendChild(document.createTextNode(suffix));
  return f;
}

function unsnipAll(event) {
  event.preventDefault();
  removeStyles(".snippedTextInvisible", ".snipLinkVisible");
}

function removeStyles(...selectors) {
  const stylesheet = document.styleSheets[0];
  for (const selector of selectors) {
    for (let i = stylesheet.cssRules.length - 1; i >= 0; i--) {
      const rule = stylesheet.cssRules[i];
      if (rule.selectorText === selector) {
        stylesheet.deleteRule(i);
      }
    }
  }
}

// Mac OS has an annoying feature where right-click selects the current
// "word" (i.e. a useless fragment of the address) before showing a
// context menu.  Detect this by watching for the selection to change
// between consecutive onmousedown and oncontextmenu events.
let oldTimeStamp = 0;
let oldRanges = [];
function handleMouseDown(e) {
  oldTimeStamp = e.timeStamp;
  oldRanges = [];
  const sel = window.getSelection();
  for (let i = 0; i < sel.rangeCount; i++) {
    oldRanges.push(sel.getRangeAt(i));
  }
}

function sameRange(r1, r2) {
  return (r1.compareBoundaryPoints(Range.START_TO_START, r2) == 0 &&
          r1.compareBoundaryPoints(Range.END_TO_END, r2) == 0);
}

function isSpuriousSelection(sel, newTimeStamp) {
  if (newTimeStamp - oldTimeStamp > 10) {
    return false;
  }
  if (sel.rangeCount != oldRanges.length) {
    return true;
  }
  for (let i = 0; i < sel.rangeCount; i++) {
    if (!sameRange(sel.getRangeAt(i), oldRanges[i])) {
      return true;
    }
  }
  return false;
}

function handleContextMenu(e) {
  const sel = window.getSelection();
  if (isSpuriousSelection(sel, e.timeStamp)) {
    sel.removeAllRanges();
  }
  selectWholeAddress(this, sel);
  return sel;
}

// Let the "selectMe" class define a more specific selection range.
function nodeToRange(node) {
  const range = document.createRange();
  range.selectNodeContents(node.querySelector('.selectMe') || node);
  return range;
}

function handleClick(e) {
  const sel = window.getSelection();

  // If the user clicked an already-selected address, deselect it.
  // Don't check timeStamp because it depends how long they held the button.
  if (e.detail == 1 && oldRanges.length == 1) {
    if (sameRange(nodeToRange(this), oldRanges[0])) {
      sel.removeAllRanges();
      return;
    }
  }

  selectWholeAddress(this, sel);
}

// If the user hasn't manually selected part of the address, then select
// the whole thing, to make copying easier.
function selectWholeAddress(node, sel) {
  if (sel.isCollapsed || !sel.containsNode(node, true)) {
    sel.removeAllRanges();
    sel.addRange(nodeToRange(node));
  }
}
