# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

IPvFoo is a Chrome/Firefox (MV3) browser extension. It adds an address-bar icon showing whether the current page was fetched over IPv4 or IPv6; clicking it opens a popup listing the IP address (and optional geo/ASN info) for every domain that served a page element. All data comes from the `webRequest` API — the extension makes no extra network requests except the optional geo lookups.

## Commands

- `make` — build both `build/ipvfoo-<ver>.xpi` (Firefox) and `build/ipvfoo-<ver>.zip` (Chrome). Requires `zip` and GNU `make`.
- `make firefox` / `make chrome` — build one target. Each copies the browser-specific manifest over `src/manifest.json` before zipping.
- `make clean` — remove `build/`.
- Regenerate icons: `python3 sprites/generate_icons.py` (needs Pillow). Composites `sprites/sprites{16,32}.png` into `src/generated_icons/*.png`. Run this after changing sprites; the generated PNGs are committed.

### Tests

Tests are zero-dependency in-browser (`tests/tinytest.js`). Open `tests/iputil_test.html` in a browser: green background = pass, red = fail, details in the JS console. There is no CLI test runner; covers `src/iputil.js` only (IP parse/format, NAT64, geo-key, public-IP classification).

### Running unpacked

`src/manifest.json` is a tracked copy that the build overwrites (the Makefile aborts if it isn't a copy of one of the two `src/manifest/*.json`). Before loading unpacked, copy the right one:
`cp src/manifest/chrome-manifest.json src/manifest.json` (or `firefox-manifest.json`). Loading the wrong manifest fails: Firefox needs `background.scripts`, Chrome needs `background.service_worker`. Load `src/` as the unpacked extension directory.

## Architecture

The extension has two halves that communicate over a `chrome.runtime` Port: the **background** service worker (capture + state) and the **popup** (display). `common.js` and `iputil.js` are shared by both.

### Script loading differs per browser
- Chrome: `background.js` runs as a service worker and `importScripts("iputil.js", "common.js")` at the top.
- Firefox: the manifest lists `background.scripts: [iputil.js, common.js, background.js]`, so the `importScripts` call is skipped (guarded by checking `getManifest().background.service_worker`).
Keep this in mind — `background.js` must work both as a service worker and as a persistent-ish background script.

### background.js — the core
Listens to `webRequest` (onBeforeRequest → onResponseStarted → onCompleted/onErrorOccurred) and `webNavigation` to build per-tab state. Key models:
- **TabInfo** (`tabMap`, keyed by tabId) ≈ one page view. Holds `mainDomain`/`mainOrigin` and a map of `DomainInfo`. Drives the icon (`updateIcon`) and pushes table updates to the popup.
- **DomainInfo** — per-domain state: address, flags, request count, timing, error status, live connection count.
- **RequestInfo** (`requestMap`, keyed by requestId) — bridges onBeforeRequest (where the tab is known) to onResponseStarted (where the IP is known). One request may map to multiple tabs (tabless service workers, matched via `originMap`).
- Lifecycle is documented in detail in the comment block at the top of `background.js` — read it before touching the event handlers.

State must survive service-worker restarts, so `tabMap`/`requestMap`/`ipCache` are persisted to `chrome.storage.session` via the `SaveableEntry`/`SaveableMap` base classes (`toJSON`/`load`/`afterLoad`). `await storageReady` before reading any of these maps inside a listener. Wrap async listeners in `wrap()` so Firefox doesn't swallow errors.

`TabTracker` reconciles real tabs with `tabMap` (tabs can vanish silently); it polls every 5 min and on restart.

### common.js — shared constants, options, flags
- **Flags**: `DFLAG_*` (domain flags, OR-accumulated — SSL/WebSocket/connected) and `AFLAG_*` (address flags — lowest numeric value wins when choosing which address to display, e.g. uncached beats cached). `iconPath()` maps a pattern + color to a `generated_icons/*.png` filename and validates the format.
- **Options** live in `chrome.storage.local` (color scheme, geo-enabled) and `chrome.storage.sync` (lookup provider, custom provider URLs, NAT64 prefixes). Access via the `options` object after `await optionsReady`; subscribe to changes via `watchOptions()`. Writes to sync are rate-limited through `StorageSyncDebouncer` in background.js.
- **NAT64**: prefixes are stored as sync keys `nat64/<24 hex>`. `reformatForNAT64()` rewrites IPv6 addresses to dotted form when they match a known prefix; `updateNAT64` auto-detects prefixes from `IPV4_ONLY_DOMAINS`.
- **Lookup providers**: right-click menu in the popup opens a domain/IP lookup (`LOOKUP_PROVIDERS` or a custom URL with `$` placeholder).

### iputil.js — pure IP helpers
`parseIP` (Guava-derived, returns packed hex), `formatIPv6`/`formatIPv6WithDots`, `isPublicIPForGeo`, `geoCacheKeyForIP`. No browser APIs — this is what the tests exercise.

### Geo/ASN lookups
Optional, gated by the `geoInfoEnabled` option. The popup requests geo info via `chrome.runtime.sendMessage` (`fetchGeoInfo`/`refreshGeoInfo`/`clearGeoCache`); background.js fetches from ip.sb with an ipwho.is hedge/fallback, caches in `chrome.storage.local` (`geo_` prefix, 7-day TTL, 10-min negative TTL, index at `geo:index`), keyed by CIDR (`geoCacheKeyForIP`) so nearby IPs share a cache entry. The popup throttles outgoing requests through `geoInfoQueue` (5 concurrent / 3 s batch). Only public IPs are looked up.

### Dark mode
Icon foreground color follows the OS theme. Firefox reads it from the background page; Chrome needs an offscreen document (`detectdarkmode.html/.js`, `offscreen` permission) that reports back via `darkModeOffscreen` message. Incognito tabs use a separate color scheme.

## Conventions
- `"use strict";` at the top of every script; plain ES classes/modules, no build step or transpilation, no npm — vanilla JS loaded directly by the browser.
- `newMap()` (a null-prototype object) is used instead of `{}` for string-keyed maps throughout.
- When adding a `webRequest`/`webNavigation` listener: `await storageReady`, wrap in `wrap()`, and remember requestId→tabId may be many-to-one.
