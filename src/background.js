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

/*
Lifecycle documentation:

The purpose of requestMap is to copy tabInfo from wR.onBeforeRequest to
wR.onResponseStarted (where the IP address is available), and to maintain
the highlighted cell when a connection is open.  A map entry lives from
onBeforeRequest until wR.onCompleted or wR.onErrorOccurred.

An entry in tabMap tries to approximate one "page view".  It begins in
wR.onBeforeRequest(main_frame), and goes away either when another page
begins, or when the tab ceases to exist (see TabTracker for details.)

Icon updates begin once TabTracker succeeds AND (
    wR.onResponseStarted reports the first IP address OR
    wN.onCommitted fires).
Note that we'd like to avoid flashing '?' during a page load.

Popup updates begin sooner, in wR.onBeforeRequest(main_frame), because the
user can demand a popup before any IP addresses are available.
*/

"use strict";

if (chrome.runtime.getManifest().background.service_worker) {
  // This only runs on Chrome.
  // Firefox uses manifest.json/background/scripts instead.
  importScripts("iputil.js", "common.js");
}

// Possible states for an instance of TabInfo.
// We begin at BIRTH, and only ever move forward, not backward.
const TAB_BIRTH = 0;    // Waiting for makeAlive() or remove()
const TAB_ALIVE = 1;    // Waiting for remove()
const TAB_DEAD = 2;

// RequestFilter for webRequest events.
const FILTER_ALL_URLS = { urls: ["<all_urls>"] };

const SECONDS = 1000;  // to milliseconds

const NAME_VERSION = (() => {
  const m = chrome.runtime.getManifest();
  return `${m.name} v${m.version}`;
})();

let debug = false;
function debugLog() {
  if (debug) {
    console.log(new Date().toISOString(), ...arguments);
  }
}

// Log errors from async listeners, because otherwise Firefox hides them
// in the global console.
function wrap(f) {
  const tracer = new Error("wrap() stack trace");
  return (...args) => f(...args).catch((err) => {
    console.error("Error in async listener:", err, tracer);
  });
}

function parseUrl(url) {
  let domain = null;
  let ssl = false;
  let ws = false;

  const u = new URL(url);
  if (u.protocol == "file:") {
    domain = "file://";
  } else if (u.protocol == "chrome:") {
    domain = "chrome://";
  } else {
    domain = u.hostname || "";
    switch (u.protocol) {
      case "https:":
        ssl = true;
        break;
      case "wss:":
        ssl = true;
        // fallthrough
      case "ws:":
        ws = true;
        break;
    }
  }
  return { domain: domain, ssl: ssl, ws: ws, origin: u.origin };
}

function updateNAT64(domain, addr) {
  if (!(IPV4_ONLY_DOMAINS.has(domain) && addr)) {
    return;
  }
  const packed = parseIP(addr);
  if (packed.length != 128/4) {
    return;  // not an IPv6 address
  }
  // Heuristic: Don't consider this a NAT64 prefix if the embedded
  // IPv4 address falls under 0.x.x.x/8.  This filters out cases where all
  // traffic is proxied to the same address, assuming that most proxies
  // have a low-numbered suffix like ::1.
  if (packed.substr(96/4, 2) == '00') {
    return;
  }
  // If this is a new prefix, the watchOptions callback will handle it.
  addPackedNAT64(packed.slice(0, 96/4));
}

class SaveableEntry {
  #prefix;
  #id;
  #dirty = false;
  #remove = false;
  #savedJSON = null;

  constructor(prefix, id) {
    if (!prefix) throw "missing prefix";
    if (!id) throw "missing id";
    this.#prefix = prefix;
    this.#id = id;
  }

  id() { return this.#id; }

  load(j) {
    this.#savedJSON = j;
    for (const [k, v] of Object.entries(JSON.parse(j))) {
      if (this.hasOwnProperty(k)) {
        this[k] = v;
      } else {
        console.error("skipping unknown key", k);
      }
    }
    return this;
  }

  // Limit to 1 in-flight chrome.storage operation per key.
  // No need to await.
  async save() {
    if (this.#dirty) {
      return;  // Already saving.
    }
    this.#dirty = true;
    await null;  // Let the caller finish first.
    while (this.#dirty) {
      this.#dirty = false;
      const key = `${this.#prefix}${this.#id}`
      if (this.#remove) {
        await chrome.storage.session.remove(key);
        return;
      }
      const j = JSON.stringify(this);
      if (this.#savedJSON == j) {
        return;
      }
      //console.log("saving", key, j);
      await chrome.storage.session.set({[key]: j});
      this.#savedJSON = j;
    }
  }

  // No need to await.
  async remove() {
    this.#remove = true;
    await this.save();
  }
}

class SaveableMap {
  #factory;
  #prefix;

  constructor(factory, prefix) {
    this.#factory = factory;
    this.#prefix = prefix;
  }

  validateId(id) {
    if (this.#prefix == "ip/") {
      // Don't restrict ipCache domain name keys.
      return id;
    } else {
      const idNumeric = parseInt(id, 10);
      if (idNumeric) {
        return idNumeric;
      }
    }
    throw `malformed id: ${id}`;
  }

  load(key, savedJSON) {
    if (!key.startsWith(this.#prefix)) {
      return false;
    }
    const suffix = key.slice(this.#prefix.length);
    let id;
    try {
      id = this.validateId(suffix);
    } catch(err) {
      console.error(err);
      return false;
    }
    this[id] = new this.#factory(this.#prefix, id).load(savedJSON);
    return true;
  }

  lookupOrNew(id) {
    id = this.validateId(id);
    let o = this[id];
    if (!o) {
      o = this[id] = new this.#factory(this.#prefix, id);
    }
    return o;
  }

  remove(id) {
    id = this.validateId(id);
    const o = this[id];
    if (o) {
      delete this[id];
      o.remove();
    }
    return o;
  }
}

// -- TabInfo --

class TabInfo extends SaveableEntry {
  born = Date.now();     // For TabTracker timeout.
  mainRequestId = null;  // Request that constructed this tab, if any.
  mainDomain = "";       // Bare domain from the main_frame request.
  mainOrigin = "";       // Origin from the main_frame request.
  committed = false;     // True if onCommitted has fired.
  domains = newMap();    // Updated whenever we get some IPs.
  spillCount = 0;        // How many requests didn't fit in domains.
  lastPattern = "";      // To avoid redundant icon redraws.
  lastTooltip = "";      // To avoid redundant tooltip updates.
  color = REGULAR_COLOR  // or INCOGNITO_COLOR

  // Private, to avoid writing to storage.
  #state = TAB_BIRTH;

  constructor(prefix, tabId) {
    super(prefix, tabId);

    if (!options.ready) throw "must await optionsReady!";

    if (tabMap[tabId]) throw "Duplicate entry in tabMap";
    if (tabTracker.exists(tabId)) {
      this.makeAlive();
    }
  }

  afterLoad() {
    for (const [domain, json] of Object.entries(this.domains)) {
      this.domains[domain] = DomainInfo.fromJSON(this, domain, json);
    }
    updateOriginMap(this.id(), null, this.mainOrigin);
  }

  tooYoungToDie() {
    // Spare new tabs from garbage collection for a minute or so.
    return (this.#state == TAB_BIRTH &&
            this.born >= Date.now() - 60*SECONDS);
  }

  makeAlive() {
    if (this.#state != TAB_BIRTH) {
      return;
    }
    this.#state = TAB_ALIVE;
    this.updateIcon();
  }

  remove() {
    super.remove();  // no await
    this.#state = TAB_DEAD;
    this.domains = newMap();
    updateOriginMap(this.id(), this.mainOrigin, null);
  }

  setInitialDomain(requestId, domain, origin) {
    if (this.mainRequestId == null) {
      this.mainRequestId = requestId;
    } else if (this.mainRequestId != requestId) {
      console.error("mainRequestId changed!");
    }
    this.mainDomain = domain;
    updateOriginMap(this.id(), this.mainOrigin, origin);
    this.mainOrigin = origin;

    // If anyone's watching, show some preliminary state.
    this.pushAll();
    this.save();
  }

  setCommitted(domain, origin) {
    let changed = false;

    if (this.mainDomain != domain) {
      this.mainDomain = domain;
      changed = true;
    }
    this.committed = true;

    // This is usually redundant, but lastPattern takes care of it.
    this.updateIcon();

    // If the table contents changed, then redraw it.
    if (changed) {
      this.pushAll();
    }

    this.save();
  }

  // If the pageAction is supposed to be visible now, then draw it again.
  refreshPageAction() {
    this.lastTooltip = "";
    this.lastPattern = "";
    this.updateIcon();
    this.save();
  }

  addDomain(domain, dflags, addr, aflags, firstMs = null, statusCode = null, countRequest = true) {
    let d = this.domains[domain];
    if (!d) {
      // Limit the number of domains per page, to avoid wasting RAM.
      if (Object.keys(this.domains).length >= 256) {
        popups.pushSpillCount(this.id(), ++this.spillCount);
        return;
      }
      d = this.domains[domain] =
          new DomainInfo(this, domain, addr || "(lost)", dflags | aflags);
      d.recordFirstTiming(firstMs);
      d.recordRequest(statusCode, countRequest);
      d.countUp();
    } else {
      const oldAddr = d.addr;
      const oldFlags = d.flags;
      const oldFirstMs = d.firstMs;
      const oldRequestCount = d.requestCount;
      const oldErrorStatus = d.errorStatus;
      d.recordFirstTiming(firstMs);
      d.recordRequest(statusCode, countRequest);

      // Domain flags just accumulate.
      d.flags |= dflags;

      // The numerical value of aflags determines which address to keep
      // (uncached replaces cached, etc.)
      if (addr && aflags <= (d.flags & AFLAG_MASK)) {
        d.addr = addr;
        d.flags = (d.flags & DFLAG_MASK) | aflags;
      }
      d.countUp();
      // Don't update if nothing has changed.
      if (d.addr == oldAddr && d.flags == oldFlags && d.firstMs == oldFirstMs &&
          d.requestCount == oldRequestCount && d.errorStatus == oldErrorStatus) {
        return;
      }
    }

    this.updateIcon();
    this.pushOne(domain);
    this.save();
  }

  updateIcon() {
    if (!(this.#state == TAB_ALIVE)) {
      return;
    }
    let pattern = "?";
    let has4 = false;
    let has6 = false;
    let tooltip = "";
    for (const [domain, d] of Object.entries(this.domains)) {
      if (domain == this.mainDomain) {
        pattern = d.addrVersion();
        tooltip = `${d.addr}\n${NAME_VERSION}`;
      } else {
        switch (d.addrVersion()) {
          case "4": has4 = true; break;
          case "6": has6 = true; break;
        }
      }
    }
    if (has4) pattern += "4";
    if (has6) pattern += "6";

    // Firefox might drop support for pageAction someday, but until then
    // let's keep the icon in the address bar.
    const action = chrome.pageAction || chrome.action;

    // Don't waste time rewriting the same tooltip.
    if (this.lastTooltip != tooltip) {
      action.setTitle({
        "tabId": this.id(),
        "title": tooltip,
      });
      this.lastTooltip = tooltip;
      this.save();
    }

    // Don't waste time redrawing the same icon.
    if (this.lastPattern != pattern) {
      // Briefly defaults to "" on first boot.
      const color = options[this.color] || "darkfg";
      action.setIcon({
        "tabId": this.id(),
        "path": {
          "16": iconPath(pattern, 16, color),
          "32": iconPath(pattern, 32, color),
        },
      });
      // Send icon to the popup window.
      popups.pushPattern(this.id(), pattern, this.color);
      action.setPopup({
        "tabId": this.id(),
        "popup": `popup.html#${this.id()}`,
      });
      if (action.show) {
        action.show(this.id());  // Firefox only
      }
      this.lastPattern = pattern;
      this.save();
    }
  }

  pushAll() {
    popups.pushAll(this.id(), this.getTuples(), this.lastPattern, this.color, this.spillCount);
  }

  pushOne(domain) {
    popups.pushOne(this.id(), this.getTuple(domain));
  }

  // Build some [domain, addr, version, flags, firstMs, completedMs, requestCount, errorStatus] tuples, for a popup.
  getTuples() {
    const mainDomain = this.mainDomain || "(no domain)";
    const domains = Object.keys(this.domains).sort();
    const mainTuple = [mainDomain, "(no address)", "?", 0, null, null, 0, null];
    const tuples = [mainTuple];
    for (const domain of domains) {
      const d = this.domains[domain];
      if (domain == mainTuple[0]) {
        mainTuple[1] = d.addr;
        mainTuple[2] = d.addrVersion();
        mainTuple[3] = d.flags;
        mainTuple[4] = d.firstMs;
        mainTuple[5] = d.completedMs;
        mainTuple[6] = d.requestCount;
        mainTuple[7] = d.errorStatus;
      } else {
        tuples.push(this.getTuple(domain));
      }
    }
    return tuples;
  }

  // Build [domain, addr, version, flags, firstMs, completedMs, requestCount, errorStatus] tuple, for a popup.
  getTuple(domain) {
    const d = this.domains[domain];
    if (!d) {
      // Perhaps this.domains was cleared during the request's lifetime.
      return null;
    }
    return [domain, d.addr, d.addrVersion(), d.flags, d.firstMs, d.completedMs, d.requestCount, d.errorStatus];
  }
}

const ERROR_CLEAR_SUCCESS_THRESHOLD = 5;

class DomainInfo {
  tabInfo;
  domain;
  addr;
  flags;

  count = 0;  // count of active requests
  inhibitZero = false;
  firstMs = null;
  completedMs = null;
  requestCount = 0;
  errorStatus = null;
  successSinceError = 0;

  constructor(tabInfo, domain, addr, flags) {
    this.tabInfo = tabInfo;
    this.domain = domain;
    this.addr = addr;
    this.flags = flags;
  }

  // count and DFLAG_CONNECTED will be computed from requestMap.
  toJSON() {
    return [
      this.addr,
      this.flags & ~DFLAG_CONNECTED,
      this.firstMs,
      this.completedMs,
      this.requestCount,
      this.errorStatus,
      this.successSinceError,
    ];
  }

  static fromJSON(tabInfo, domain, json) {
    const [addr, flags, firstMs, completedMs, requestCount, errorStatus, successSinceError] = json;
    const d = new DomainInfo(tabInfo, domain, addr, flags);
    d.firstMs = Number.isFinite(firstMs) ? firstMs : null;
    d.completedMs = Number.isFinite(completedMs) ? completedMs : null;
    d.requestCount = Number.isFinite(requestCount) ? requestCount : 0;
    d.errorStatus = Number.isFinite(errorStatus) ? errorStatus : null;
    d.successSinceError = Number.isFinite(successSinceError) ? successSinceError : 0;
    return d;
  }

  addrVersion() {
    if (this.addr) {
      // NAT64 addresses use the prefix::a.b.c.d format.
      if (this.addr.indexOf(".") >= 0) return "4";
      if (this.addr.indexOf(":") >= 0) return "6";
    }
    return "?";
  }

  async countUp() {
    this.flags |= DFLAG_CONNECTED;
    if (++this.count == 1 && !this.inhibitZero) {
      // Keep the address highlighted for at least 500ms.
      this.inhibitZero = true;
      await sleep(500);
      this.inhibitZero = false;
      this.#checkZero();
    }
  }

  recordFirstTiming(ms) {
    if (!Number.isFinite(ms)) {
      return false;
    }
    ms = Math.max(0, Math.round(ms));
    if (this.firstMs == null || ms < this.firstMs) {
      this.firstMs = ms;
      return true;
    }
    return false;
  }

  recordCompletedTiming(ms) {
    if (!Number.isFinite(ms)) {
      return false;
    }
    ms = Math.max(0, Math.round(ms));
    if (this.completedMs == null || ms > this.completedMs) {
      this.completedMs = ms;
      this.tabInfo.pushOne(this.domain);
      this.tabInfo.save();
      return true;
    }
    return false;
  }

  recordRequest(statusCode, countRequest) {
    if (countRequest) {
      this.requestCount++;
    }
    this.recordStatus(statusCode);
  }

  recordStatus(statusCode) {
    if (!Number.isFinite(statusCode)) {
      return;
    }
    if (statusCode >= 400) {
      this.errorStatus = Math.round(statusCode);
      this.successSinceError = 0;
      return;
    }
    if (this.errorStatus != null) {
      this.successSinceError++;
      if (this.successSinceError >= ERROR_CLEAR_SUCCESS_THRESHOLD) {
        this.errorStatus = null;
        this.successSinceError = 0;
      }
    }
  }

  countDown() {
    if (!(this.count > 0)) throw "Count went negative!";
    --this.count;
    this.#checkZero();
  }

  #checkZero() {
    if (this.count == 0 && !this.inhibitZero) {
      this.flags &= ~DFLAG_CONNECTED;
      this.tabInfo.pushOne(this.domain);
    }
  }
}

class RequestInfo extends SaveableEntry {
  // Typically this contains one {tabId: tabBorn} entry,
  // but for Service Worker requests there may be multiple tabs.
  tabIdToBorn = newMap();
  domain = null;
  prefetch = false;
  started = 0;

  afterLoad() {
    for (const [tabId, tabBorn] of Object.entries(this.tabIdToBorn)) {
      const tabInfo = tabMap[tabId];
      if (tabInfo?.born != tabBorn) {
        delete this.tabIdToBorn[tabId];
        continue;
      }
      if (!this.domain) {
        continue;  // still waiting for onResponseStarted
      }
      tabInfo.addDomain(this.domain, 0, null, 0, null, null, false);
    }
    if (Object.keys(this.tabIdToBorn).length == 0) {
      requestMap.remove(this.id());
      console.log("garbage-collected RequestInfo", this.id());
      return;
    }
  }
}

class IPCacheEntry extends SaveableEntry {
  time = 0;
  addr = "";
}

// tabId -> TabInfo
const tabMap = new SaveableMap(TabInfo, "tab/")

// requestId -> RequestInfo
const requestMap = new SaveableMap(RequestInfo, "req/");

// Firefox-only domain->ip cache, to help work around
// https://bugzilla.mozilla.org/show_bug.cgi?id=1395020
const IP_CACHE_LIMIT = 1024;
const ipCache = (typeof browser == "undefined") ? null : new SaveableMap(IPCacheEntry, "ip/");
let ipCacheSize = 0;

function ipCacheGrew() {
  ++ipCacheSize;
  //console.log("ipCache", ipCacheSize, Object.keys(ipCache).length);
  if (ipCacheSize <= IP_CACHE_LIMIT) {
    return;
  }
  // Garbage collect half the entries.
  const flat = Object.values(ipCache);
  flat.sort((a, b) => a.time - b.time);
  ipCacheSize = flat.length;  // redundant
  for (const cachedAddr of flat) {
    ipCache.remove(cachedAddr.id());
    if (--ipCacheSize <= IP_CACHE_LIMIT/2) {
      break;
    }
  }
}

// mainOrigin -> Set of tabIds, for tabless service workers.
const originMap = newMap();

function updateOriginMap(tabId, oldOrigin, newOrigin) {
  if (oldOrigin && oldOrigin != newOrigin) {
    const tabs = originMap[oldOrigin];
    if (tabs) {
      tabs.delete(tabId);
      if (!tabs.size) {
        delete originMap[oldOrigin];
      }
    }
  }
  if (newOrigin) {
    let tabs = originMap[newOrigin];
    if (!tabs) {
      tabs = originMap[newOrigin] = new Set();
    }
    tabs.add(tabId);
  }
}

function lookupOriginMap(origin) {
  // returns a Set of tabId values.
  return originMap[origin] || new Set();
}

// Dark mode detection. This can eventually be replaced by
// https://github.com/w3c/webextensions/issues/229
(async () => {
  // Only do dark mode detection on first boot.
  // We will still get updates from the popup windows when visible.
  await optionsReady;
  if (options[REGULAR_COLOR]) {
    return;
  }

  if (typeof window !== 'undefined' && window.matchMedia) {
    // Firefox can detect dark mode from the background page.
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setColorIsDarkMode(REGULAR_COLOR, query.matches);
  } else {
    // Chrome needs an offscreen document to detect dark mode.
    // See the onMessage handler below.
    try {
      await chrome.offscreen.createDocument({
        url: "detectdarkmode.html",
        reasons: ['MATCH_MEDIA'],
        justification: 'detect light/dark mode for icon colors',
      });
    } catch {
      console.log("detectdarkmode failed!");
    }
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // ignore
    }
  }
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.hasOwnProperty("darkModeOffscreen")) {
    setColorIsDarkMode(REGULAR_COLOR, message.darkModeOffscreen);
  }
  if (message.hasOwnProperty("setStorageSyncDebounce")) {
    storageSyncDebouncer.set(message.setStorageSyncDebounce);
  }
  if (message.cmd === "fetchGeoInfo") {
    handleFetchGeoInfo(message.ip).then(sendResponse, () => sendResponse(GEO_EMPTY_INFO));
    return true;
  }
  if (message.cmd === "refreshGeoInfo") {
    handleFetchGeoInfo(message.ip, true).then(sendResponse, () => sendResponse(GEO_EMPTY_INFO));
    return true;
  }
  if (message.cmd === "clearGeoCache") {
    clearGeoCache().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
});

// Geo info cache in storage.local (7-day TTL).
const GEO_EMPTY_INFO = { asn: "", country_code: "", region_code: "", organization: "" };
const GEO_CACHE_MAX_ENTRIES = 2048;
const GEO_CACHE_CLEANUP_INTERVAL = 60 * 60 * 1000;
const GEO_FETCH_TIMEOUT = 8000;
const GEO_FALLBACK_DELAY = 700;
const GEO_API_IPSB = "https://api.ip.sb/geoip/";
const GEO_API_IPWHOIS = "https://ipwho.is/";
const geoFetchInFlight = new Map();
let geoCacheCleanupPromise = null;
let geoCacheLastCleanup = 0;

function withGeoCacheMeta(info, geoCacheKey, meta = {}) {
  return {
    ...normalizeGeoInfo(info),
    _cacheKey: geoCacheKey,
    _cacheHit: !!meta.cacheHit,
    _cacheAgeMs: Number.isFinite(meta.cacheAgeMs) ? meta.cacheAgeMs : null,
    _cachedAt: Number.isFinite(meta.cachedAt) ? meta.cachedAt : null,
  };
}

async function getGeoCacheIndex() {
  const items = await chrome.storage.local.get(GEO_CACHE_INDEX_KEY);
  const index = items[GEO_CACHE_INDEX_KEY];
  return Array.isArray(index) ? index.filter(key => typeof key == "string") : [];
}

async function setGeoCacheEntry(cacheKey, data) {
  await chrome.storage.local.set({ [cacheKey]: { data, timestamp: Date.now() } });
  const index = await getGeoCacheIndex();
  if (!index.includes(cacheKey)) {
    index.push(cacheKey);
    await chrome.storage.local.set({ [GEO_CACHE_INDEX_KEY]: index });
  }
}

function maybeCleanupGeoCache() {
  const now = Date.now();
  if (geoCacheCleanupPromise || now - geoCacheLastCleanup < GEO_CACHE_CLEANUP_INTERVAL) {
    return;
  }
  geoCacheCleanupPromise = (async () => {
    try {
      const index = await getGeoCacheIndex();
      const items = await chrome.storage.local.get(index);
      const valid = [];
      const toRemove = [];
      for (const key of index) {
        if (!key.startsWith(GEO_CACHE_PREFIX)) {
          continue;
        }
        const value = items[key];
        const timestamp = value?.timestamp;
        if (!(Number.isFinite(timestamp) && timestamp > 0)) {
          toRemove.push(key);
          continue;
        }
        const ttl = hasGeoInfo(value?.data) ? GEO_CACHE_TTL : GEO_NEGATIVE_CACHE_TTL;
        if (now - timestamp >= ttl) {
          toRemove.push(key);
          continue;
        }
        valid.push([key, timestamp]);
      }
      // Keep the newest entries when over capacity.
      valid.sort((a, b) => b[1] - a[1]);
      for (let i = GEO_CACHE_MAX_ENTRIES; i < valid.length; i++) {
        toRemove.push(valid[i][0]);
      }
      if (toRemove.length) {
        await chrome.storage.local.remove(toRemove);
      }
      await chrome.storage.local.set({
        [GEO_CACHE_INDEX_KEY]: valid.slice(0, GEO_CACHE_MAX_ENTRIES).map(([key]) => key),
      });
    } catch {
      // ignore
    } finally {
      geoCacheLastCleanup = Date.now();
      geoCacheCleanupPromise = null;
    }
  })();
}

async function handleFetchGeoInfo(ip, forceRefresh = false) {
  await optionsReady;
  if (!options[GEO_INFO_ENABLED]) {
    return withGeoCacheMeta(GEO_EMPTY_INFO, "", {});
  }
  const geoCacheKey = geoCacheKeyForIP(ip);
  if (!geoCacheKey) {
    return withGeoCacheMeta(GEO_EMPTY_INFO, "", {});
  }
  maybeCleanupGeoCache();
  const cacheKey = GEO_CACHE_PREFIX + geoCacheKey;

  if (!forceRefresh) {
    // Fast path from cache.
    try {
      const cached = await chrome.storage.local.get(cacheKey);
      const entry = cached[cacheKey];
      const ttl = hasGeoInfo(entry?.data) ? GEO_CACHE_TTL : GEO_NEGATIVE_CACHE_TTL;
      const ageMs = entry?.timestamp ? Date.now() - entry.timestamp : null;
      if (entry?.data && entry.timestamp && ageMs < ttl) {
        return withGeoCacheMeta(entry.data, geoCacheKey, {
          cacheHit: true,
          cacheAgeMs: ageMs,
          cachedAt: entry.timestamp,
        });
      }
      if (entry) {
        chrome.storage.local.remove(cacheKey).catch(() => {});
      }
    } catch {}
  }

  const inFlight = geoFetchInFlight.get(cacheKey);
  if (inFlight && !forceRefresh) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    const data = await fetchGeoInfoUncached(ip);
    if (!data) {
      try {
        await setGeoCacheEntry(cacheKey, GEO_EMPTY_INFO);
      } catch {
        // ignore
      }
      return withGeoCacheMeta(GEO_EMPTY_INFO, geoCacheKey, { cacheHit: false });
    }
    try {
      await setGeoCacheEntry(cacheKey, data);
    } catch {
      // ignore
    }
    return withGeoCacheMeta(data, geoCacheKey, { cacheHit: false, cachedAt: Date.now() });
  })();
  geoFetchInFlight.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    geoFetchInFlight.delete(cacheKey);
  }
}

async function clearGeoCache() {
  const index = await getGeoCacheIndex();
  const allItems = await chrome.storage.local.get(null);
  const legacyKeys = Object.keys(allItems).filter(key => key.startsWith(GEO_CACHE_PREFIX));
  const keys = [...new Set([...index, ...legacyKeys, GEO_CACHE_INDEX_KEY])];
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }
}

function normalizeGeoInfo(json) {
  return {
    asn: normalizeAsn(json?.asn || json?.as || json?.autonomous_system_number || ""),
    country_code: json?.country_code || "",
    region_code: normalizeRegionCode(json?.region_code || ""),
    organization: json?.organization || "",
  };
}

function hasGeoInfo(info) {
  return !!(info?.asn || info?.country_code || info?.region_code || info?.organization);
}

function normalizeAsn(asn) {
  if (asn == null || asn === "") {
    return "";
  }
  const text = String(asn).trim();
  if (!text) {
    return "";
  }
  return /^AS/i.test(text) ? text.toUpperCase() : `AS${text}`;
}

function normalizeRegionCode(regionCode) {
  const text = String(regionCode || "").trim();
  return /^\d+$/.test(text) ? "" : text;
}

function startGeoProvider(fetcher, ip) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEO_FETCH_TIMEOUT);
  const promise = (async () => {
    try {
      const info = await fetcher(ip, controller.signal);
      if (hasGeoInfo(info)) {
        return info;
      }
      throw new Error("empty geo info");
    } finally {
      clearTimeout(timeout);
    }
  })();
  return {
    promise,
    abort() {
      controller.abort();
    },
  };
}

async function fetchGeoFromIpSb(ip, signal) {
  const r = await fetch(`${GEO_API_IPSB}${encodeURIComponent(ip)}`, { signal });
  if (!r.ok) {
    throw new Error("ip.sb request failed");
  }
  return normalizeGeoInfo(await r.json());
}

async function fetchGeoFromIpWhoIs(ip, signal) {
  const r = await fetch(`${GEO_API_IPWHOIS}${encodeURIComponent(ip)}`, { signal });
  if (!r.ok) {
    throw new Error("ipwho.is request failed");
  }
  const json = await r.json();
  if (json?.success === false) {
    throw new Error("ipwho.is returned error");
  }
  return normalizeGeoInfo({
    asn: json?.connection?.asn || "",
    country_code: json?.country_code || json?.country || "",
    region_code: json?.region_code || json?.region || "",
    organization: json?.connection?.org || json?.organization || json?.isp || "",
  });
}

async function fetchGeoInfoUncached(ip) {
  const primary = startGeoProvider(fetchGeoFromIpSb, ip);
  let secondary = null;
  const startSecondary = () => {
    if (!secondary) {
      secondary = startGeoProvider(fetchGeoFromIpWhoIs, ip);
    }
    return secondary;
  };
  try {
    // Try the primary provider first for a short window.
    const fastResult = await Promise.race([
      primary.promise.then(info => ({ ok: true, info })).catch(() => ({ ok: false })),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), GEO_FALLBACK_DELAY)),
    ]);
    if (fastResult.ok) {
      return fastResult.info;
    }

    // If primary is slow/failed, hedge with the fallback provider.
    const fallback = startSecondary();
    return await Promise.any([primary.promise, fallback.promise]);
  } catch {
    return null;
  } finally {
    primary.abort();
    secondary?.abort();
  }
}

// This class prevents writing to storage.sync more than once per second,
// so the user can type in a text field without spamming the network.
// It runs in background.js to avoid data loss if the user closes the
// options window within 1 second of typing.
class StorageSyncDebouncer {
  latest = {};
  pending = {};
  writePromise = null;
  set(items) {
    for (let [key, value] of Object.entries(items)) {
      if (this.latest[key] !== value) {
        this.latest[key] = value;
        this.pending[key] = value;
      }
    }
    if (!this.writePromise && Object.keys(this.pending).length > 0) {
      this.writePromise = this._writeWithDelay();
    }
  }
  async _writeWithDelay() {
    while (Object.keys(this.pending).length > 0) {
      const toWrite = this.pending;
      this.pending = {};
      //console.log("writing", toWrite);
      await Promise.all([
        chrome.storage.sync.set(toWrite),
        new Promise(resolve => setTimeout(resolve, 1000))
      ]);
    }
    this.writePromise = null;
  }
}
const storageSyncDebouncer = new StorageSyncDebouncer();

// Must "await storageReady;" before reading maps.
// You can force initStorage() from the console for debugging purposes.
const initStorage = async () => {
  await optionsReady;

  // These are be no-ops unless initStorage() is called manually.
  clearMap(tabMap);
  clearMap(requestMap);
  if (ipCache) clearMap(ipCache);

  const items = await chrome.storage.session.get();
  const unparseable = [];
  for (const [k, v] of Object.entries(items)) {
    if (!(tabMap.load(k, v) || requestMap.load(k, v) || ipCache?.load(k, v))) {
      unparseable.push(k);
    }
  }
  if (unparseable.length) {
    console.error("skipped unparseable keys:", unparseable);
  }
  // Reconsitute the DomainInfo objects and connection counts.
  for (const tabInfo of Object.values(tabMap)) {
    tabInfo.afterLoad();
  }
  for (const requestInfo of Object.values(requestMap)) {
    requestInfo.afterLoad();
  }
  if (ipCache) {
    ipCacheSize = Object.keys(ipCache).length;
  }
};
const storageReady = initStorage();

// -- Popups --

// This class keeps track of the visible popup windows,
// and streams changes to them as they occur.
class Popups {
  ports = newMap();  // tabId -> Port

  // Attach a new popup window, and start sending it updates.
  attachPort(port) {
    const tabId = port.name;
    this.ports[tabId] = port;
    tabMap[tabId]?.pushAll();
  };

  detachPort(port) {
    const tabId = port.name;
    delete this.ports[tabId];
  };

  pushAll(tabId, tuples, pattern, color, spillCount) {
    this.ports[tabId]?.postMessage({
      cmd: "pushAll",
      tuples: tuples,
      pattern: pattern,
      color: color,
      spillCount: spillCount,
    });
  };

  pushOne(tabId, tuple) {
    if (!tuple) {
      return;
    }
    this.ports[tabId]?.postMessage({
      cmd: "pushOne",
      tuple: tuple,
    });
  };

  pushPattern(tabId, pattern, color) {
    this.ports[tabId]?.postMessage({
      cmd: "pushPattern",
      pattern: pattern,
      color: color,
    });
  };

  pushSpillCount(tabId, count) {
    this.ports[tabId]?.postMessage({
      cmd: "pushSpillCount",
      spillCount: count,
    });
  };

  shake(tabId) {
    this.ports[tabId]?.postMessage({
      cmd: "shake",
    });
  }
}

const popups = new Popups();

chrome.runtime.onConnect.addListener(wrap(async (port) => {
  await storageReady;
  popups.attachPort(port);
  port.onDisconnect.addListener(() => {
    popups.detachPort(port);
  });
}));

// Refresh icons after chrome.runtime.reload()
chrome.runtime.onInstalled.addListener(wrap(async () => {
  await storageReady;
  for (const tabInfo of Object.values(tabMap)) {
    tabInfo.refreshPageAction();
  }
}));

// -- TabTracker --

// This class keeps track of every usable tabId, sending notifications when a
// tab appears or disappears.
//
// Rationale:
//
// Sometimes a webRequest event belongs to a hidden tab (e.g. for a pre-rendered
// page), and we can't set a pageAction on it until it becomes visible.
// However, hidden tabs may vanish without a trace, so the best we can really
// do is set a timer, and abandon hope if it doesn't appear.
//
// Once a tab has become visible, then hopefully we can rely on the onRemoved
// event to fire sometime in the future, when the user closes it.
class TabTracker {
  tabSet = newMap();  // Set of all known tabIds

  constructor() {
    chrome.tabs.onCreated.addListener(wrap(async (tab) => {
      await storageReady;
      this.#addTab(tab.id, "onCreated");
    }));
    chrome.tabs.onRemoved.addListener(wrap(async (tabId) => {
      await storageReady;
      this.#removeTab(tabId, "onRemoved");
    }));
    chrome.tabs.onReplaced.addListener(wrap(async (addId, removeId) => {
      await storageReady;
      this.#removeTab(removeId, "onReplaced");
      this.#addTab(addId, "onReplaced");
    }));
    this.#pollAllTabs();
  }

  exists(tabId) {
    return !!this.tabSet[tabId];
  }

  // Every 5 minutes (or after a service_worker restart),
  // poke any tabs that have become out of sync.
  async #pollAllTabs() {
    await storageReady;  // load 'born' timestamps first.
    while (true) {
      const result = await chrome.tabs.query({});
      this.tabSet = newMap();
      for (const tab of result) {
        this.#addTab(tab.id, "pollAlltabs")
      }
      for (const tabId of Object.keys(tabMap)) {
        if (!this.tabSet[tabId]) {
          this.#removeTab(tabId, "pollAllTabs");
        }
      }
      await sleep(300*SECONDS);
    }
  }

  #addTab(tabId, logText) {
    debugLog("addTab", tabId, logText);
    this.tabSet[tabId] = true;
    tabMap[tabId]?.makeAlive();
  }

  #removeTab(tabId, logText) {
    debugLog("removeTab", tabId, logText);
    delete this.tabSet[tabId];
    if (tabMap[tabId]?.tooYoungToDie()) {
      return;
    }
    tabMap.remove(tabId);
  }
}

const tabTracker = new TabTracker();

// -- webNavigation --

// Typically, onBeforeNavigate fires between the main_frame
// onBeforeRequest and onResponseStarted events, and we don't have to do
// anything here.
//
// However, when the site is using a service worker, the main_frame request
// never happens, so we need to initialize the tab here instead.
//
// Conveniently, this also ensures that the previous page data is cleared
// when navigating to a file://, chrome://, or Chrome Web Store URL.
chrome.webNavigation.onBeforeNavigate.addListener(wrap(async (details) => {
  if (!(details.frameId == 0 && details.tabId > 0)) {
    return;
  }
  await storageReady;
  let tabInfo = tabMap[details.tabId];
  const requestInfo = requestMap[tabInfo?.mainRequestId];
  if (requestInfo && requestInfo.domain == null) {
    return;  // Typical no-op case.
  }
  debugLog(`tabId=${details.tabId} is a service worker or special URL`);
  const parsed = parseUrl(details.url);
  tabMap.remove(details.tabId);
  tabInfo = tabMap.lookupOrNew(details.tabId);
  tabInfo.setInitialDomain(-1, parsed.domain, parsed.origin);
}));

chrome.webNavigation.onCommitted.addListener(wrap(async (details) => {
  debugLog("wN.oC", details?.tabId, details?.url, details);
  await storageReady;
  if (details.frameId != 0) {
    return;
  }
  const parsed = parseUrl(details.url);
  const tabInfo = tabMap.lookupOrNew(details.tabId);
  tabInfo.setCommitted(parsed.domain, parsed.origin);
}));

// -- tabs --

// Whenever anything tab-related happens, try to refresh the pageAction.  This
// is hacky and inefficient, but the back-stabbing browser leaves me no choice.
// This seems to fix http://crbug.com/124970 and some problems on Google+.
chrome.tabs.onUpdated.addListener(wrap(async (tabId, changeInfo, tab) => {
  debugLog("tabs.oU", tabId);
  await storageReady;
  const tabInfo = tabMap[tabId];
  if (tabInfo) {
    tabInfo.color = tab.incognito ? INCOGNITO_COLOR : REGULAR_COLOR;
    tabInfo.refreshPageAction();
  }
}));

// -- webRequest --

// Experimentally, a main_frame request with a documentId refers to a prefetch
// (possibly using https://developer.chrome.com/blog/private-prefetch-proxy)
// rather than a top-level navigation to a new URL.
function isProperMainFrame(details) {
  return (details.type == "main_frame" || details.type == "outermost_frame") &&
      !details.documentId;
}

chrome.webRequest.onBeforeRequest.addListener(wrap(async (details) => {
  debugLog("wR.oBR", details?.tabId, details?.url, details);
  await storageReady;
  const tabId = details.tabId;
  const tabInfos = [];
  let prefetch = false;
  if (tabId > 0) {
    if (isProperMainFrame(details)) {
      const parsed = parseUrl(details.url);
      tabMap.remove(tabId);
      const tabInfo = tabMap.lookupOrNew(tabId);
      tabInfo.setInitialDomain(details.requestId, parsed.domain, parsed.origin);
      tabInfos.push(tabInfo);
    } else {
      prefetch = (details.type == "main_frame" || details.type == "outermost_frame");
      const tabInfo = tabMap[tabId];
      if (tabInfo) {
        tabInfos.push(tabInfo);
      }
    }
  } else if (tabId == -1 && (details.initiator || details.documentUrl)) {
    // Chrome uses initiator, Firefox uses documentUrl.
    const initiator = details.initiator || parseUrl(details.documentUrl).origin;
    // Request is from a tabless Service Worker.
    // Find all tabs matching the initiator's origin.
    for (const tabId of lookupOriginMap(initiator)) {
      const tabInfo = tabMap[tabId];
      if (tabInfo) {
        tabInfos.push(tabInfo);
      }
    }
  }
  if (!tabInfos.length) {
    return;
  }
  const requestInfo = requestMap.lookupOrNew(details.requestId);
  if (requestInfo.tabIdToBorn.size || requestInfo.domain) {
    // Can this actually happen?
    console.error("duplicate request; connection count leak");
  }
  for (const tabInfo of tabInfos) {
    requestInfo.tabIdToBorn[tabInfo.id()] = tabInfo.born;
  }
  requestInfo.started = details.timeStamp || Date.now();
  requestInfo.domain = null;
  requestInfo.prefetch = prefetch;
  requestInfo.save();
}), FILTER_ALL_URLS);

// In the event of a redirect, the mainOrigin may change
// (from http: to https:) between the onBeforeRequest and onCommitted events,
// triggering an "access denied" error.  Patch this from onBeforeRedirect.
//
// As of 2022, this can be tested by visiting http://maps.google.com/
chrome.webRequest.onBeforeRedirect.addListener(wrap(async (details) => {
  await storageReady;
  if (!isProperMainFrame(details)) {
    return;
  }
  const requestInfo = requestMap[details.requestId];
  if (!requestInfo) {
    return;
  }
  for (const [tabId, tabBorn] of Object.entries(requestInfo.tabIdToBorn)) {
    const tabInfo = tabMap[tabId];
    if (tabInfo?.born != tabBorn) {
      continue;
    }
    if (tabInfo.committed) {
      console.error("onCommitted before onBeforeRedirect!");
      continue;
    }
    const parsed = parseUrl(details.redirectUrl);
    tabInfo.setInitialDomain(requestInfo.id(), parsed.domain, parsed.origin);
  }

}), FILTER_ALL_URLS);

chrome.webRequest.onResponseStarted.addListener(wrap(async (details) => {
  //debugLog("wR.oRS", details?.tabId, details?.url, details);
  await storageReady;
  const requestInfo = requestMap[details.requestId];
  if (!requestInfo) {
    return;
  }
  const tabInfos = [];
  for (const [tabId, tabBorn] of Object.entries(requestInfo.tabIdToBorn)) {
    const tabInfo = tabMap[tabId];
    if (tabInfo?.born != tabBorn) {
      continue;
    }
    tabInfos.push(tabInfo);
  }
  if (!tabInfos.length) {
    return;
  }
  const parsed = parseUrl(details.url);
  if (!parsed.domain) {
    return;
  }

  let addr = details.ip;
  let fromCache = details.fromCache;

  if (!fromCache) {
    updateNAT64(parsed.domain, addr);
  }

  if (ipCache) {
    // This runs on Firefox only.
    if (addr) {
      const cachedAddr = ipCache.lookupOrNew(parsed.domain);
      const grew = !cachedAddr.addr;
      cachedAddr.time = Date.now();
      cachedAddr.addr = addr;
      cachedAddr.save();
      if (grew) {
        ipCacheGrew();
      }
    } else {
      const cachedAddr = ipCache[parsed.domain];
      if (cachedAddr) {
        fromCache = true;
        addr = cachedAddr.addr;
      }
    }
  }
  addr = reformatForNAT64(addr) || "(no address)";

  // Domain flags
  const dflags =
      (parsed.ssl ? DFLAG_SSL : DFLAG_NOSSL) |
      (parsed.ws ? DFLAG_WEBSOCKET : 0);

  // Address flags
  const aflags =
      (requestInfo.prefetch ? AFLAG_PREFETCH : 0) |
      (details.tabId <= 0 ? AFLAG_WORKER : 0) |
      (fromCache ? AFLAG_CACHE : 0);

  if (requestInfo.domain) throw `Duplicate onResponseStarted: ${parsed.domain}`;
  requestInfo.domain = parsed.domain;
  requestInfo.save();
  const firstMs = requestInfo.started ? details.timeStamp - requestInfo.started : null;
  for (const tabInfo of tabInfos) {
    tabInfo.addDomain(parsed.domain, dflags, addr, aflags, firstMs, details.statusCode);
  }
}), FILTER_ALL_URLS);

const forgetRequest = wrap(async (details) => {
  await storageReady;
  const requestInfo = requestMap.remove(details.requestId);
  if (!requestInfo?.domain) {
    return;
  }
  const completedMs = requestInfo.started ? details.timeStamp - requestInfo.started : null;
  for (const [tabId, tabBorn] of Object.entries(requestInfo.tabIdToBorn)) {
    const tabInfo = tabMap[tabId];
    if (tabInfo?.born == tabBorn) {
      const domainInfo = tabInfo.domains[requestInfo.domain];
      if (domainInfo) {
        domainInfo.recordCompletedTiming(completedMs);
        domainInfo.countDown();
      }
    }
  }
});
chrome.webRequest.onCompleted.addListener(forgetRequest, FILTER_ALL_URLS);
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, FILTER_ALL_URLS);

// -- contextMenus --

// When the user right-clicks a domain or IP address in the popup window,
// add a menu item that opens the requested lookup provider.
const MENU_ID = "ipvfoo-lookup";

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId != MENU_ID) return;
  const text = info.selectionText;
  const url = selectionToLookupUrl(text)?.href;
  if (url) {
    chrome.tabs.create({url});
  } else {
    // Malformed selection; shake the popup content.
    const tabId = /#(\d+)$/.exec(info.pageUrl);
    if (tabId) {
      popups.shake(Number(tabId[1]));
    }
  }
});

watchOptions(async (optionsChanged) => {
  await storageReady;
  optionsChanged = new Set(optionsChanged);
  for (const tabInfo of Object.values(tabMap)) {
    let refreshPageAction = optionsChanged.has(tabInfo.color);
    if (optionsChanged.has(NAT64_KEY)) {
      for (const [domain, di] of Object.entries(tabInfo.domains)) {
        const newAddr = reformatForNAT64(di.addr);
        if (di.addr != newAddr) {
          di.addr = newAddr;
          tabInfo.pushOne(domain);
          refreshPageAction = true;
        }
      }
    }
    if (refreshPageAction) {
      tabInfo.refreshPageAction();
    }
  }

  if (optionsChanged.has(LOOKUP_PROVIDER) ||
      optionsChanged.has(CUSTOM_PROVIDER_DOMAIN) ||
      optionsChanged.has(CUSTOM_PROVIDER_IP)) {
    chrome.contextMenus?.removeAll(() => {
      // Show something sensible, even when domain/ip use different providers.
      const title = lookupMenuTitle("example.com", "0.0.0.0");
      if (title) {
        chrome.contextMenus.create({
          title: title,
          id: MENU_ID,
          // Scope the menu to text selection in our popup windows.
          contexts: ["selection"],
          documentUrlPatterns: [chrome.runtime.getURL("popup.html")],
        });
      }
    });
  }
});
