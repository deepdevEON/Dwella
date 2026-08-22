#!/usr/bin/env node

/**
 * Dwella self-hosted TradingView browser service.
 *
 * This service runs open-source Chromium through Playwright. It is intentionally
 * independent of Browserbase and has no metered browser-session provider. The
 * mobile app receives a protected remote view backed by screenshots and input
 * events; credentials are entered into the remote TradingView page and are not
 * stored or logged by this service.
 *
 * Endpoints (all accept GET and POST; the browser-facing app and remote view
 * use GET because the outer preview proxy forwards GET but blocks POST):
 *   GET/POST /browser/view       — static mobile remote-view shell
 *   GET/POST /browser/start      — launch or reuse the persistent Chromium profile
 *   GET/POST /browser/status     — inspect session and TradingView login state
 *   GET/POST /browser/screenshot — current screenshot (authenticated)
 *   GET/POST /browser/input      — forward click, keyboard, and scroll input
 *   GET/POST /browser/navigate   — navigate to an allowed TradingView URL
 *   GET/POST /browser/stop       — close the current Chromium session
 *   GET      /market/bars         — real OHLCV bars from the TradingView chart stream
 *   GET      /health             — public process health check
 */

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// The managed preview can run as a different user than the one that installed
// the Playwright browsers (e.g. HOME=/root while the browsers were installed
// under /home/daytona/.cache/ms-playwright). Playwright resolves its browser
// cache from $HOME unless PLAYWRIGHT_BROWSERS_PATH is pinned. Do not require
// browsers.json here: the preview installer can produce a valid browser cache
// with only the Chromium executable and installation markers.
function hasChromiumExecutable(cachePath) {
  try {
    return fs.readdirSync(cachePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+/.test(entry.name))
      .some((entry) => {
        const root = path.join(cachePath, entry.name);
        return [
          'chrome-linux/chrome',
          'chrome-linux64/chrome',
          'chrome-win/chrome.exe',
          'chrome-win64/chrome.exe',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ].some((relativePath) => fs.existsSync(path.join(root, relativePath)));
      });
  } catch {
    return false;
  }
}

const browserCacheCandidates = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  '/home/daytona/.cache/ms-playwright',
  '/root/.cache/ms-playwright',
  '/home/codespace/.cache/ms-playwright',
  '/workspaces/.cache/ms-playwright',
].filter(Boolean);
for (const candidate of browserCacheCandidates) {
  if (hasChromiumExecutable(candidate)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = candidate;
    break;
  }
}

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

// ── Configuration ────────────────────────────────────────────────────────────
const PORT = Number.parseInt(process.env.PORT || '8646', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SERVICE_TOKEN = process.env.PLAYWRIGHT_TRADER_TOKEN
  || process.env.BROWSERBASE_TRADER_TOKEN
  || process.env.VITE_PLAYWRIGHT_TRADER_TOKEN
  || process.env.VITE_BROWSERBASE_TRADER_TOKEN
  || '';
const DWELLA_ORIGIN = process.env.DWELLA_ORIGIN || '*';
// Land on the TradingView sign-in page first so the in-app session opens
// with the login form ready (verified: /accounts/signin/ returns 200 and
// shows the Authentication form; /accounts/sign-in/ is a 404). Once the
// persistent profile holds a session, TradingView redirects signed-in users
// straight to the chart automatically.
const TRADINGVIEW_LOGIN_URL = 'https://www.tradingview.com/accounts/signin/';
const configuredTradingViewUrl = process.env.TRADINGVIEW_URL || '';
// Only an explicitly configured sign-in URL may override the default. A stale
// chart URL must never bypass the login surface the mobile app promises.
const TRADINGVIEW_URL = /\/accounts\/signin(?:[/?]|$)/i.test(configuredTradingViewUrl)
  ? configuredTradingViewUrl
  : TRADINGVIEW_LOGIN_URL;
const PUBLIC_URL = (process.env.PLAYWRIGHT_TRADER_PUBLIC_URL || '').replace(/\/$/, '');
const USER_DATA_DIR = path.resolve(
  process.env.PLAYWRIGHT_USER_DATA_DIR || path.join(__dirname, '.playwright-tradingview'),
);
const SESSION_TIMEOUT = Math.min(
  21600,
  Math.max(60, Number.parseInt(process.env.PLAYWRIGHT_SESSION_TIMEOUT || '21600', 10)),
);
const MOBILE_VIEWPORT = {
  width: Number.parseInt(process.env.PLAYWRIGHT_VIEWPORT_WIDTH || '390', 10),
  height: Number.parseInt(process.env.PLAYWRIGHT_VIEWPORT_HEIGHT || '844', 10),
};
const DESKTOP_VIEWPORT = {
  width: Number.parseInt(process.env.PLAYWRIGHT_DESKTOP_VIEWPORT_WIDTH || '1440', 10),
  height: Number.parseInt(process.env.PLAYWRIGHT_DESKTOP_VIEWPORT_HEIGHT || '900', 10),
};
let activeViewport = MOBILE_VIEWPORT;
let activeIsMobile = true;
const ALLOW_UNAUTHENTICATED_LOCAL = process.env.ALLOW_UNAUTHENTICATED_LOCAL === 'true';
const tradingViewHosts = new Set(['tradingview.com', 'www.tradingview.com']);

function isTradingViewUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && (tradingViewHosts.has(parsed.hostname) || parsed.hostname.endsWith('.tradingview.com'));
  } catch {
    return false;
  }
}

function serviceConfigured() {
  return Boolean(SERVICE_TOKEN || ALLOW_UNAUTHENTICATED_LOCAL);
}

function configurationError() {
  return serviceConfigured()
    ? ''
    : 'Set PLAYWRIGHT_TRADER_TOKEN, or explicitly enable ALLOW_UNAUTHENTICATED_LOCAL for a private local-only preview.';
}

function startupErrorMessage(error) {
  const message = String(error?.message || error || 'Unknown browser startup error').replace(/\s+/g, ' ').trim();
  if (/Executable doesn't exist|browserType\.launch|executable/i.test(message)) {
    return 'Playwright Chromium is unavailable to the TradingView service. Run the preview install command, then reopen Trade.';
  }
  return `Could not start local Chromium: ${message.slice(0, 260)}`;
}

// ── In-memory browser state ──────────────────────────────────────────────────
let context = null;
let browser = null;
let page = null;
let primaryPage = null;
let sessionStartTime = null;
let sessionTimer = null;
let ensureSessionPromise = null;
let shuttingDown = false;
let marketPage = null;
let marketQueue = Promise.resolve();
const marketCache = new Map();
const marketInflight = new Map();

const TRADINGVIEW_MARKET_SYMBOLS = Object.freeze({
  NQ: 'CME_MINI:NQ1!',
  MNQ: 'CME_MINI:MNQ1!',
  ES: 'CME_MINI:ES1!',
  MES: 'CME_MINI:MES1!',
  GC: 'COMEX:GC1!',
  MGC: 'COMEX:MGC1!',
  YM: 'CBOT:YM1!',
  RTY: 'CME_MINI:RTY1!',
  CL: 'NYMEX:CL1!',
  SI: 'COMEX:SI1!',
});
const TRADINGVIEW_INTERVALS = Object.freeze({
  M1: '1',
  M5: '5',
  M15: '15',
  M30: '30',
  H1: '60',
  H4: '240',
  D1: '1D',
});

function browserIsConnected() {
  if (!context) return false;
  try {
    return !browser || browser.isConnected();
  } catch {
    return false;
  }
}

function selectViewport(req) {
  if (context || !req) return;
  const requestedDevice = String(req.query?.device || '').toLowerCase();
  const userAgent = String(req.get?.('user-agent') || '');
  const mobile = requestedDevice === 'mobile'
    || (requestedDevice !== 'desktop' && /android|iphone|ipad|ipod|mobile/i.test(userAgent));
  activeIsMobile = mobile;
  activeViewport = mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
}

function viewUrl() {
  // Relative URLs work through the Vite same-origin proxy and when the
  // service is exposed directly. PUBLIC_URL is available for a separate host.
  return PUBLIC_URL ? `${PUBLIC_URL}/browser/view` : '/browser/view';
}

function constantTimeTokenMatch(received) {
  if (!SERVICE_TOKEN || !received) return false;
  const expected = Buffer.from(SERVICE_TOKEN);
  const actual = Buffer.from(received);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireServiceToken(req, res, next) {
  if (ALLOW_UNAUTHENTICATED_LOCAL && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1')) {
    return next();
  }
  const authorization = req.get('authorization') || '';
  const received = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!constantTimeTokenMatch(received)) {
    return res.status(401).json({ ok: false, error: 'Playwright TradingView service authorization required.' });
  }
  return next();
}

function requireConfiguration(req, res, next) {
  if (!serviceConfigured()) return res.status(503).json({ ok: false, error: configurationError() });
  return next();
}

async function inspectTradingView() {
  if (!page || !browserIsConnected()) {
    return {
      sessionState: 'offline',
      authenticated: false,
      needsLogin: false,
      accountName: '',
      onTradingView: false,
    };
  }

  let title = '';
  let currentUrl = '';
  try {
    title = await page.title();
    currentUrl = page.url();
    const signals = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const normalized = body.toLowerCase();
      const userButton = document.querySelector(
        '[data-name="header-user-menu-button"], [data-name="header-user-menu"], [data-name="header-user-menu-button-mobile"], [data-name="header-user-menu"], [aria-label*="user menu" i], [class*="userMenu" i]',
      );
      const signInLink = document.querySelector(
        'a[href*="/accounts/signin" i], a[href*="/accounts/login" i], button[data-name*="sign-in" i], [data-name*="sign-in" i]',
      );
      const accountText = userButton?.getAttribute('aria-label')
        || userButton?.getAttribute('title')
        || userButton?.textContent
        || '';
      return {
        hasUserMenu: Boolean(userButton),
        accountText: accountText.trim().slice(0, 120),
        hasSignInCopy: /(^|\s)(sign in|log in|login)(\s|$)/i.test(normalized),
        hasSignInLink: Boolean(signInLink),
        hasSignedOutCopy: /(^|\s)(sign out|log out)(\s|$)/i.test(normalized),
      };
    });
    const cookies = await context.cookies(['https://www.tradingview.com']);
    // Never return cookie values. This is only a boolean signal used to
    // recognize the persistent TradingView session after a redirect.
    const authCookie = cookies.some((cookie) => /^(sessionid|sessionid_sign|sessionid_ssr|auth_token|tv_ecuid)$/i.test(cookie.name));
    const onTradingView = isTradingViewUrl(currentUrl);
    const authPath = /\/accounts\/(signin|sign-in|login|signup|recover|reset)(?:[/?]|$)/i.test(currentUrl);
    const signedIn = onTradingView && (
      signals.hasUserMenu
      || signals.hasSignedOutCopy
      || (authCookie && !authPath)
    );
    const needsLogin = onTradingView && !signedIn && (
      authPath || signals.hasSignInCopy || signals.hasSignInLink
    );
    return {
      sessionState: signedIn ? 'signed-in' : needsLogin ? 'needs-login' : 'unknown',
      authenticated: signedIn,
      needsLogin,
      accountName: signedIn ? signals.accountText : '',
      onTradingView,
      title,
      currentUrl,
    };
  } catch (error) {
    return {
      sessionState: 'unknown',
      authenticated: false,
      needsLogin: false,
      accountName: '',
      onTradingView: isTradingViewUrl(currentUrl),
      title,
      currentUrl,
      inspectionError: error.message,
    };
  }
}

async function snapshot(req) {
  const tradingView = await inspectTradingView();
  return {
    ok: true,
    mode: 'playwright-local',
    sessionActive: Boolean(context),
    browserConnected: browserIsConnected(),
    persistentProfile: true,
    sessionState: tradingView.sessionState,
    authenticated: Boolean(tradingView.authenticated),
    needsLogin: Boolean(tradingView.needsLogin),
    tradingView,
    currentUrl: tradingView.currentUrl || page?.url() || '',
    title: tradingView.title || '',
    uptime: sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0,
    viewUrl: context ? viewUrl(req) : '',
    debugUrl: context ? viewUrl(req) : '',
    liveViewUrl: context ? viewUrl(req) : '',
    viewport: activeViewport,
  };
}

async function finishCurrentSession() {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = null;
  if (marketPage) {
    try { await marketPage.close(); } catch { /* already closed */ }
  }
  marketPage = null;
  if (context) {
    try { await context.close(); } catch { /* already closed */ }
  }
  page = null;
  primaryPage = null;
  browser = null;
  context = null;
  sessionStartTime = null;
  marketCache.clear();
  marketInflight.clear();
}

function parseTradingViewPayload(payload) {
  const messages = [];
  let cursor = 0;
  while (typeof payload === 'string' && payload.startsWith('~m~', cursor)) {
    const lengthEnd = payload.indexOf('~m~', cursor + 3);
    if (lengthEnd < 0) break;
    const length = Number(payload.slice(cursor + 3, lengthEnd));
    const start = lengthEnd + 3;
    if (!Number.isFinite(length) || length < 0) break;
    const raw = payload.slice(start, start + length);
    try { messages.push(JSON.parse(raw)); } catch { /* ignore non-JSON frames */ }
    cursor = start + length;
  }
  return messages;
}

function extractTradingViewBars(messages) {
  const bars = new Map();
  for (const message of messages) {
    if (message?.m !== 'timescale_update') continue;
    const seriesMap = message.p?.[1];
    if (!seriesMap || typeof seriesMap !== 'object') continue;
    for (const series of Object.values(seriesMap)) {
      for (const point of series?.s || []) {
        const values = point?.v;
        if (!Array.isArray(values) || values.length < 5) continue;
        const [time, open, high, low, close, volume = 0] = values.map(Number);
        if (![time, open, high, low, close].every(Number.isFinite) || [open, high, low, close].every(value => value === 0)) continue;
        bars.set(time, {
          t: Math.floor(time * 1000),
          o: open,
          h: high,
          l: low,
          c: close,
          v: Number.isFinite(volume) ? volume : 0,
        });
      }
    }
  }
  return [...bars.values()].sort((a, b) => a.t - b.t);
}

function queueMarketRequest(work) {
  const result = marketQueue.then(work, work);
  marketQueue = result.catch(() => undefined);
  return result;
}

async function fetchTradingViewBars(symbol, timeframe, count) {
  await ensureSession();
  if (!context || !browserIsConnected()) throw new Error('TradingView browser session is offline.');
  if (!marketPage || marketPage.isClosed()) {
    marketPage = await context.newPage();
    // The market collector uses a second TradingView tab. Keep the primary
    // interactive page selected for screenshots, login input, and auth checks.
    if (page === marketPage || !page || page.isClosed()) page = primaryPage;
  }

  const tvSymbol = TRADINGVIEW_MARKET_SYMBOLS[symbol.toUpperCase()] || symbol;
  if (!isTradingViewUrl(`https://www.tradingview.com/chart/?symbol=${tvSymbol}`)) {
    throw new Error('Only TradingView symbols are supported for live backtest data.');
  }
  const interval = TRADINGVIEW_INTERVALS[timeframe.toUpperCase()] || timeframe;
  const target = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}&interval=${encodeURIComponent(interval)}`;
  const messages = [];
  const socketListeners = [];
  const onSocket = socket => {
    const onFrame = frame => messages.push(...parseTradingViewPayload(frame?.payload || ''));
    socket.on('framereceived', onFrame);
    socketListeners.push({ socket, onFrame });
  };
  marketPage.on('websocket', onSocket);

  try {
    try {
      await marketPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      // TradingView can abort the document navigation when its SPA chart shell
      // takes over. The page and its WebSocket remain usable in that case; only
      // propagate genuine navigation failures.
      if (!/ERR_ABORTED/i.test(error?.message || '')) throw error;
    }
    const deadline = Date.now() + 30000;
    let bars = [];
    while (Date.now() < deadline) {
      bars = extractTradingViewBars(messages);
      if (bars.length >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (bars.length < 2) throw new Error(`TradingView returned no ${timeframe} bars for ${symbol}.`);
    return {
      ok: true,
      source: 'tradingview-web',
      symbol,
      timeframe,
      requested: count,
      delayed: true,
      bars: bars.slice(-Math.max(2, Math.min(count, bars.length))),
    };
  } finally {
    for (const { socket, onFrame } of socketListeners) {
      try { socket.off('framereceived', onFrame); } catch { /* socket already closed */ }
    }
    marketPage.off('websocket', onSocket);
  }
}

async function getTradingViewBars(symbol, timeframe, count) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedTimeframe = String(timeframe || 'M15').trim().toUpperCase();
  const normalizedCount = Math.max(2, Math.min(Number(count) || 300, 4000));
  const key = `${normalizedSymbol}:${normalizedTimeframe}:${normalizedCount}`;
  const cached = marketCache.get(key);
  if (cached && Date.now() - cached.at < 5000) return cached.value;
  if (marketInflight.has(key)) return marketInflight.get(key);

  const request = queueMarketRequest(async () => {
    const value = await fetchTradingViewBars(normalizedSymbol, normalizedTimeframe, normalizedCount);
    marketCache.set(key, { at: Date.now(), value });
    return value;
  });
  marketInflight.set(key, request);
  try {
    return await request;
  } finally {
    marketInflight.delete(key);
  }
}

async function ensureSession() {
  if (context && browserIsConnected() && page) {
    try {
      await page.evaluate(() => 1);
      return page;
    } catch {
      await finishCurrentSession();
    }
  }

  // Opening Trade can fire /browser/start, the embedded remote view's
  // screenshot poll, and a market-bars request in the same instant. Serialize
  // the first launch so they share one persistent Chromium profile instead of
  // racing launchPersistentContext on the same user-data directory.
  if (ensureSessionPromise) return ensureSessionPromise;
  ensureSessionPromise = (async () => {
    try {
      const initialUrl = isTradingViewUrl(TRADINGVIEW_URL) ? TRADINGVIEW_URL : 'https://www.tradingview.com/chart/';
      context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: true,
        viewport: activeViewport,
        isMobile: activeIsMobile,
        hasTouch: activeIsMobile,
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        acceptDownloads: false,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      browser = context.browser();
      page = context.pages()[0] || await context.newPage();
      primaryPage = page;
      // TradingView's Google/Apple buttons may open an OAuth popup. Follow the
      // newest page for the screenshot/input bridge, then return to the main
      // login page when the popup closes.
      context.on('page', (candidate) => {
        if (candidate === primaryPage || candidate === marketPage) return;
        page = candidate;
        candidate.once('close', () => {
          if (page === candidate && !primaryPage.isClosed()) page = primaryPage;
        });
      });
      sessionStartTime = Date.now();
      sessionTimer = setTimeout(() => {
        void finishCurrentSession();
      }, SESSION_TIMEOUT * 1000);

      // A persistent context can restore the last TradingView chart page. Always
      // visit the configured landing URL for a fresh browser session so the
      // embedded view reliably presents TradingView's sign-in form first. If the
      // profile is already authenticated, TradingView will redirect back to its
      // chart automatically.
      try {
        await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (error) {
        // TradingView sometimes aborts the initial document navigation when its
        // SPA shell takes over. Keep the page alive in that case; the remote
        // screenshot and subsequent input events still work.
        if (!/ERR_ABORTED/i.test(error?.message || '')) throw error;
      }
      // TradingView renders the sign-in form after the document event. Let that
      // client-side shell settle before the first remote screenshot is requested.
      // A short DOM-ready wait alone can capture TradingView's dark shell before
      // its authentication UI paints, which looks like an empty remote canvas.
      await page.waitForSelector('body', { state: 'visible', timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1800);
      return page;
    } catch (error) {
      await finishCurrentSession();
      throw error;
    }
  })();
  try {
    return await ensureSessionPromise;
  } finally {
    ensureSessionPromise = null;
  }
}

// ── Embedded remote view ─────────────────────────────────────────────────────
// This is a small noVNC-free view: Playwright captures the headless page and
// forwards touch/keyboard events. It keeps the free mode usable on a phone
// without exposing a raw CDP endpoint or requiring a paid Live View provider.
const REMOTE_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<title>Dwella TradingView Remote View</title>
<style>
  :root { color-scheme: dark; font-family: Inter,system-ui,sans-serif; }
  * { box-sizing: border-box; }
  html,body { width:100%; min-height:100%; margin:0; background:#101712; color:#edf4df; }
  body { display:grid; place-items:center; padding:10px; }
  main { width:min(100%,960px); display:grid; gap:8px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:2px 4px; font-size:11px; }
  header span { color:#9eae91; }
  #status { color:#c6e47d; }
  #viewport { position:relative; width:100%; overflow:hidden; border:1px solid #43563e; border-radius:14px; background:#0b0f0c; box-shadow:0 18px 50px #0008; touch-action:none; }
  #screen { display:block; width:100%; height:auto; min-height:220px; object-fit:contain; background:#0b0f0c; user-select:none; -webkit-user-drag:none; }
  #loading { display:grid; min-height:360px; place-items:center; padding:24px; color:#c6e47d; font-size:13px; text-align:center; }
  #loading[hidden] { display:none; }
  #hint { padding:8px 4px; color:#94a48a; font-size:10px; line-height:1.45; }
  #keyboard { position:fixed; left:2px; bottom:2px; width:2px; height:2px; opacity:.02; border:0; padding:0; color:transparent; background:transparent; pointer-events:none; }
  button { border:1px solid #52684b; border-radius:8px; padding:6px 9px; color:#edf4df; background:#253624; font:inherit; font-size:10px; }
  button:focus-visible { outline:2px solid #c6e47d; outline-offset:2px; }
</style>
</head>
<body>
<main tabindex="0" aria-label="Remote TradingView browser">
  <input id="keyboard" type="text" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Type into TradingView" />
  <header><strong>TradingView · Playwright local</strong><span id="status">Waiting for Dwella…</span><button id="keyboard-toggle" type="button">Type</button><button id="refresh" type="button">Refresh</button></header>
  <div id="viewport"><div id="loading">Opening TradingView sign-in…</div><img id="screen" alt="Remote TradingView session" /></div>
  <div id="hint">This is TradingView's real sign-in page rendered from the private Playwright browser. Tap the page, then type normally. Credentials are forwarded to TradingView and are not saved by this view.</div>
</main>
<script>
(() => {
  const screen = document.getElementById('screen');
  const loading = document.getElementById('loading');
  const viewport = document.getElementById('viewport');
  const status = document.getElementById('status');
  const keyboard = document.getElementById('keyboard');
  const root = document.querySelector('main');
  const serviceOrigin = window.location.origin;
  let dimensions = { width: 390, height: 844 };
  let focused = false;
  let pointer = null;
  let refreshInFlight = false;

  function headers() {
    // When the view page is served through the Vite proxy (same origin),
    // Vite injects the real Authorization header on every /browser/* request.
    // Sending our own header would risk a conflict with the proxy.
    return { 'Content-Type': 'application/json' };
  }
  async function request(path, options = {}) {
    const response = await fetch(serviceOrigin + path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Remote browser request failed');
    return data;
  }
  let firstFrame = true;
  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const data = await request('/browser/screenshot');
      if (data.image) {
        screen.src = data.image;
        loading.hidden = true;
        if (firstFrame) {
          firstFrame = false;
          try { window.parent.postMessage({ type: 'dwella-view-ready' }, '*'); } catch { /* cross-origin — parent handles its own overlay */ }
        }
      }
      if (data.width && data.height) dimensions = { width: data.width, height: data.height };
      status.textContent = 'Connected';
      status.style.color = '#c6e47d';
    } catch (error) {
      status.textContent = error.message;
      status.style.color = '#e6a58d';
    } finally {
      refreshInFlight = false;
    }
  }
  function coordinates(event) {
    const rect = screen.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(dimensions.width, (event.clientX - rect.left) * dimensions.width / rect.width)),
      y: Math.max(0, Math.min(dimensions.height, (event.clientY - rect.top) * dimensions.height / rect.height)),
    };
  }
  async function send(payload, refreshAfter = true) {
    try {
      // Text and key events can contain a password or MFA code. Keep those
      // values in a protected POST body instead of putting them in a URL.
      if (payload.kind === 'text' || payload.kind === 'key') {
        await request('/browser/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(payload)) {
          if (value !== undefined && value !== null) params.set(key, value);
        }
        await request('/browser/input?' + params.toString());
      }
      if (refreshAfter) await refresh();
    } catch (error) { status.textContent = error.message; }
  }
  window.addEventListener('message', (event) => {
    // Auth is handled by the Vite proxy — no tokens needed here.
  });
  // Start polling immediately — the same-origin Vite proxy injects the real
  // Authorization header on every /browser/* request, so the view page does
  // not need to wait for a postMessage bearer token from the parent.
  void refresh();
  function focusKeyboard() {
    // A live DOM input does not exist in this screenshot surface. Keeping a
    // tiny real input focused lets iOS/Android show their keyboard, while its
    // input events are forwarded to the actual Playwright page.
    try { keyboard.focus({ preventScroll: true }); } catch { keyboard.focus(); }
  }
  screen.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    focused = true;
    root.focus();
    focusKeyboard();
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    try { screen.setPointerCapture(event.pointerId); } catch { /* unsupported */ }
  });
  screen.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.moved && Math.hypot(dx, dy) < 6) return;
    pointer.moved = true;
    event.preventDefault();
    const point = coordinates(event);
    const scaleY = dimensions.height / Math.max(1, screen.getBoundingClientRect().height);
    const scaleX = dimensions.width / Math.max(1, screen.getBoundingClientRect().width);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    // A finger moving up should scroll the real TradingView page down.
    void send({ kind: 'wheel', ...point, deltaX: -dx * scaleX, deltaY: -dy * scaleY }, false);
  }, { passive: false });
  screen.addEventListener('pointerup', (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const wasTap = !pointer.moved;
    pointer = null;
    try { screen.releasePointerCapture(event.pointerId); } catch { /* unsupported */ }
    if (wasTap) {
      const point = coordinates(event);
      void send({ kind: 'click', ...point });
    }
  });
  screen.addEventListener('pointercancel', () => { pointer = null; });
  screen.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = coordinates(event);
    void send({ kind: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  }, { passive: false });
  keyboard.addEventListener('input', (event) => {
    const value = event.target.value;
    event.target.value = '';
    if (value) void send({ kind: 'text', value });
  });
  keyboard.addEventListener('keydown', (event) => {
    if (event.key.length === 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    void send({ kind: 'key', value: event.key });
  });
  root.addEventListener('keydown', (event) => {
    if (!focused || event.target === keyboard || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (event.key.length === 1) void send({ kind: 'text', value: event.key });
    else void send({ kind: 'key', value: event.key });
  });
  document.getElementById('keyboard-toggle').addEventListener('click', focusKeyboard);
  document.getElementById('refresh').addEventListener('click', () => void refresh());
  // Poll fast enough to feel live on a phone, slow enough to keep the free
  // local Chromium and the preview proxy happy.
  window.setInterval(() => void refresh(), 1400);
})();
</script>
</body>
</html>`;

// ── Express API ───────────────────────────────────────────────────────────────
const app = express();
const allowedOrigins = DWELLA_ORIGIN === '*'
  ? '*'
  : DWELLA_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins === '*' || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by the Playwright TradingView service.'));
  },
}));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'playwright-trader',
    mode: 'playwright-local',
    tradingViewOnly: true,
    sessionActive: Boolean(context),
    browserConnected: browserIsConnected(),
    configured: serviceConfigured(),
    missingConfiguration: configurationError() || null,
  });
});

// The shell contains no session data. It receives the bearer token from the
// parent Dwella page through postMessage after the iframe has loaded.
app.get('/browser/view', (req, res) => {
  // Embed the service token directly so the view page's JavaScript can
  // authenticate its fetch calls immediately. No postMessage + proxy race.
  const html = REMOTE_VIEW_HTML.replace(
    '<script>',
    `<script>window.__dwellaToken = ${JSON.stringify(SERVICE_TOKEN)};</script><script>`,
  );
  res.type('html').send(html);
});

app.get('/market/bars', requireServiceToken, requireConfiguration, async (req, res) => {
  try {
    // Market cards can be the first request after boot. Select the device
    // profile before that request creates the shared persistent context.
    selectViewport(req);
    const result = await getTradingViewBars(req.query.symbol, req.query.timeframe || req.query.tf || 'M15', req.query.count);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ ok: false, source: 'tradingview-web', error: error.message || 'TradingView live data is unavailable.' });
  }
});

app.use('/browser', requireServiceToken, requireConfiguration);

// All browser endpoints accept GET and POST. Status/start and pointer events
// may use GET, but text/key events are sent as JSON POST bodies so passwords and
// MFA codes never appear in request URLs. Direct/separate-host callers may use
// POST with JSON bodies for every endpoint.
app.all('/browser/start', async (req, res) => {
  try {
    selectViewport(req);
    await ensureSession();
    return res.json(await snapshot(req));
  } catch (error) {
    const message = startupErrorMessage(error);
    console.error('[playwright] start failed:', message);
    return res.status(500).json({ ok: false, error: message });
  }
});

app.get('/browser/status', async (req, res) => {
  if (!context || !page || !browserIsConnected()) {
    return res.json({
      ok: true,
      mode: 'playwright-local',
      sessionActive: false,
      browserConnected: false,
      sessionState: 'offline',
      authenticated: false,
      needsLogin: false,
      tradingView: {
        sessionState: 'offline',
        authenticated: false,
        needsLogin: false,
        accountName: '',
        onTradingView: false,
        currentUrl: '',
        title: '',
      },
      debugUrl: '',
      liveViewUrl: '',
      currentUrl: '',
      title: '',
    });
  }
  try {
    return res.json(await snapshot(req));
  } catch (error) {
    return res.json({ ok: false, mode: 'playwright-local', sessionActive: Boolean(context), browserConnected: browserIsConnected(), sessionState: 'unknown', authenticated: false, needsLogin: false, error: 'Local TradingView status is temporarily unavailable.' });
  }
});

app.get('/browser/screenshot', async (req, res) => {
  try {
    selectViewport(req);
    const currentPage = await ensureSession();
    await currentPage.bringToFront().catch(() => {});
    // OAuth/MFA providers can temporarily own the active popup page. Do not
    // force that page back to TradingView while the user is completing login;
    // only repair an untouched about:blank page.
    const currentUrl = currentPage.url();
    if (!currentUrl || currentUrl === 'about:blank') {
      await currentPage.goto(TRADINGVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((error) => {
        if (!/ERR_ABORTED/i.test(error?.message || '')) throw error;
      });
    }
    await currentPage.waitForSelector('body', { state: 'visible', timeout: 8000 }).catch(() => {});
    await currentPage.waitForTimeout(350);
    const buffer = await currentPage.screenshot({ type: 'jpeg', quality: 74, animations: 'disabled' });
    return res.json({ ok: true, image: `data:image/jpeg;base64,${buffer.toString('base64')}`, width: activeViewport.width, height: activeViewport.height, url: currentPage.url() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not capture the local TradingView page.' });
  }
});

app.all('/browser/input', async (req, res) => {
  const input = { ...(req.body || {}) };
  const q = req.query || {};
  if (input.kind === undefined && q.kind) {
    input.kind = q.kind;
    input.x = Number(q.x);
    input.y = Number(q.y);
    input.deltaX = Number(q.deltaX);
    input.deltaY = Number(q.deltaY);
    input.value = q.value;
  }
  try {
    const currentPage = await ensureSession();
    const x = Number(input.x);
    const y = Number(input.y);
    if (input.kind === 'click' && Number.isFinite(x) && Number.isFinite(y)) {
      await currentPage.mouse.click(x, y);
    } else if (input.kind === 'wheel' && Number.isFinite(x) && Number.isFinite(y)) {
      await currentPage.mouse.move(x, y);
      await currentPage.mouse.wheel(Number(input.deltaX) || 0, Number(input.deltaY) || 0);
    } else if (input.kind === 'text' && typeof input.value === 'string' && input.value.length <= 256) {
      await currentPage.keyboard.insertText(input.value);
    } else if (input.kind === 'key' && typeof input.value === 'string' && input.value.length <= 24) {
      await currentPage.keyboard.press(input.value);
    } else {
      return res.status(400).json({ ok: false, error: 'Unsupported remote input.' });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not forward input to the local TradingView page.' });
  }
});

app.all('/browser/navigate', async (req, res) => {
  const target = String(req.body?.url || req.query?.url || '');
  if (!isTradingViewUrl(target)) return res.status(400).json({ ok: false, error: 'Navigation is limited to TradingView pages.' });
  try {
    const currentPage = await ensureSession();
    await currentPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return res.json(await snapshot(req));
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not navigate the local TradingView page.' });
  }
});

app.all('/browser/stop', async (req, res) => {
  try {
    await finishCurrentSession();
    return res.json({ ok: true, message: 'Local TradingView session ended.' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not end the local TradingView session.' });
  }
});

app.use((error, req, res, next) => {
  if (error?.message === 'Origin is not allowed by the Playwright TradingView service.') {
    return res.status(403).json({ ok: false, error: error.message });
  }
  console.error('[playwright] request error:', error?.message || error);
  return res.status(500).json({ ok: false, error: 'Local TradingView service error.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Playwright TradingView service listening on ${HOST}:${PORT}`);
  console.log(`TradingView URL: ${TRADINGVIEW_URL}`);
  console.log(`Persistent profile enabled at ${USER_DATA_DIR}`);
});
