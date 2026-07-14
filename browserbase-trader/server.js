#!/usr/bin/env node

/**
 * Browserbase Trader — cloud browser service for Dwella
 * 
 * Runs a persistent Browserbase browser session that Buffy (Freebuff AI)
 * can control via REST API to manually execute trades on Tradovate/MT5 Web.
 *
 * Endpoints:
 *   POST /browser/start      — Create/get persistent browser session
 *   POST /browser/navigate   — Navigate to URL
 *   POST /browser/click      — Click element by CSS selector
 *   POST /browser/type       — Type text into element
 *   POST /browser/evaluate   — Run JavaScript in page
 *   POST /browser/screenshot — Take screenshot (returns base64)
 *   POST /browser/stop       — End the browser session
 *   GET  /browser/status     — Session + page status
 *   GET  /health             — Health check
 */

require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const Browserbase = require("@browserbasehq/sdk");
const { chromium } = require("playwright-core");

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8646", 10);
const API_KEY = process.env.BROWSERBASE_API_KEY;
const CONTEXT_ID = process.env.BROWSER_CONTEXT_ID || ""; // Set to persist login across sessions
const DEFAULT_URL = process.env.DEFAULT_URL || "https://trader.tradovate.com";

if (!API_KEY) {
  console.error("❌ BROWSERBASE_API_KEY not set");
  process.exit(1);
}

// ── State ────────────────────────────────────────────────────────────────────
let bbClient = null;
let session = null;       // current Browserbase session object
let browser = null;       // Playwright browser (CDP connection)
let page = null;          // active page
let sessionStartTime = null;
let shuttingDown = false;

// ── Graceful Shutdown ────────────────────────────────────────────────────────
async function cleanup(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[browserbase] Shutting down (${reason})...`);
  if (page) { try { await page.close(); } catch {} }
  if (browser) { try { await browser.close(); } catch {} }
  if (session) {
    try {
      const client = getClient();
      await client.sessions.update(session.id, { status: "COMPLETED" });
      console.log(`[browserbase] Session ${session.id} completed`);
    } catch {}
  }
  page = null; browser = null; session = null; sessionStartTime = null;
  console.log("[browserbase] Clean exit");
  process.exit(0);
}

process.on("SIGINT", () => cleanup("SIGINT"));
process.on("SIGTERM", () => cleanup("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("[browserbase] Uncaught exception:", err.message);
  cleanup("uncaught exception");
});
process.on("unhandledRejection", (reason) => {
  // Don't crash on unhandled rejections — log and move on
  console.error("[browserbase] Unhandled rejection:", reason);
});

// ── Browserbase SDK ──────────────────────────────────────────────────────────
function getClient() {
  if (!bbClient) {
    bbClient = new Browserbase({ apiKey: API_KEY });
  }
  return bbClient;
}

// ── Start / Get Persistent Session ───────────────────────────────────────────
async function ensureSession() {
  // If we already have a live page, return it
  if (page && browser && browser.isConnected()) {
    try {
      await page.evaluate(() => 1); // quick check
      return { session, browser, page };
    } catch { /* stale — reconnect below */ }
  }

  const client = getClient();

  // Create (or rehydrate) a persistent session
  // Contexts save cookies/auth — setting persist:true + a fixed context ID
  // means the browser stays logged into Tradovate across runs.
  // Clear any stale session state before creating a new one
  if (browser) { try { await browser.close(); } catch {} }
  browser = null;
  page = null;
  if (session) {
    try { await client.sessions.update(session.id, { status: "COMPLETED" }); } catch {}
    session = null;
  }

  console.log("[browserbase] Creating session with persistent context...");
  // Build browser settings: use persistent context if one is configured
  const browserSettings = {
    viewport: { width: 1280, height: 900 },
  };
  if (CONTEXT_ID) {
    browserSettings.context = { id: CONTEXT_ID, persist: true };
    console.log(`[browserbase] Using persistent context: ${CONTEXT_ID}`);
  }

  session = await client.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID || undefined,
    keepAlive: true,
    browserSettings,
  });

  sessionStartTime = Date.now();
  console.log(`[browserbase] Session created: ${session.id}`);
  console.log(`[browserbase] Live View: https://www.browserbase.com/sessions/${session.id}`);
  console.log(`[browserbase] Connect URL: ${session.connectUrl}`);

  // Connect Playwright over CDP
  console.log("[browserbase] Connecting Playwright...");
  browser = await chromium.connectOverCDP(session.connectUrl);

  // Use the default context and its first page
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  page = pages.length > 0 ? pages[0] : await ctx.newPage();

  // Navigate to the trading platform
  console.log(`[browserbase] Navigating to ${DEFAULT_URL}...`);
  await page.goto(DEFAULT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("[browserbase] Session ready!");
  return { session, browser, page };
}

// ── Helper: Get or start (lazy) ─────────────────────────────────────────────
async function getPage() {
  const result = await ensureSession();
  return result.page;
}

// ── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "browserbase-trader",
    port: PORT,
    sessionActive: !!session,
    browserConnected: browser?.isConnected() ?? false,
    contextId: CONTEXT_ID,
    uptime: sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0,
  });
});

// POST /browser/start — Create/get the persistent session
app.post("/browser/start", async (req, res) => {
  try {
    const result = await ensureSession();
    res.json({
      ok: true,
      sessionId: result.session.id,
      liveViewUrl: `https://www.browserbase.com/sessions/${result.session.id}`,
      currentUrl: result.page.url(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /browser/navigate — Go to a URL
app.post("/browser/navigate", async (req, res) => {
  const { url, waitUntil = "domcontentloaded", timeout = 30000 } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url is required" });
  try {
    const p = await getPage();
    await p.goto(url, { waitUntil, timeout });
    res.json({ ok: true, url: p.url(), title: await p.title() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /browser/click — Click an element
app.post("/browser/click", async (req, res) => {
  const { selector, timeout = 10000 } = req.body || {};
  if (!selector) return res.status(400).json({ ok: false, error: "selector is required" });
  try {
    const p = await getPage();
    await p.waitForSelector(selector, { timeout });
    await p.click(selector);
    res.json({ ok: true, selector });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /browser/type — Type text into an element
app.post("/browser/type", async (req, res) => {
  const { selector, text, timeout = 10000, delay = 30 } = req.body || {};
  if (!selector || text === undefined) return res.status(400).json({ ok: false, error: "selector and text are required" });
  try {
    const p = await getPage();
    await p.waitForSelector(selector, { timeout });
    await p.fill(selector, "");
    await p.type(selector, String(text), { delay });
    res.json({ ok: true, selector, length: String(text).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /browser/evaluate — Run JS in the page
app.post("/browser/evaluate", async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ ok: false, error: "code is required" });
  try {
    const p = await getPage();
    const result = await p.evaluate(code);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /browser/screenshot — Take a screenshot
app.post("/browser/screenshot", async (req, res) => {
  const { fullPage = false } = req.body || {};
  try {
    const p = await getPage();
    const buffer = await p.screenshot({ fullPage, type: "jpeg", quality: 80 });
    res.json({
      ok: true,
      screenshot: buffer.toString("base64"),
      mimeType: "image/jpeg",
      size: buffer.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /browser/stop — End the browser session
app.post("/browser/stop", async (req, res) => {
  try {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    if (session) {
      try {
        await getClient().sessions.update(session.id, { status: "COMPLETED" });
      } catch {}
    }
    page = null;
    browser = null;
    session = null;
    sessionStartTime = null;
    res.json({ ok: true, message: "Session ended" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /browser/status — Current session status
app.get("/browser/status", async (req, res) => {
  try {
    const p = await getPage();
    const title = await p.title();
    const url = p.url();
    res.json({
      ok: true,
      sessionActive: !!session,
      browserConnected: browser?.isConnected() ?? false,
      sessionId: session?.id || null,
      liveViewUrl: session ? `https://www.browserbase.com/sessions/${session.id}` : null,
      currentUrl: url,
      title,
      contextId: CONTEXT_ID,
      uptime: sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0,
    });
  } catch (err) {
    res.json({
      ok: false,
      sessionActive: false,
      browserConnected: false,
      error: err.message,
    });
  }
});

// ── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, "127.0.0.1", () => {
  console.log(`╔═══════════════════════════════════════════╗`);
  console.log(`║   Browserbase Trader — Port ${PORT}       ║`);
  console.log(`╚═══════════════════════════════════════════╝`);
  console.log(`Context ID: ${CONTEXT_ID}`);
  console.log(`Default URL: ${DEFAULT_URL}`);
  console.log(`Dashboard: https://www.browserbase.com/sessions`);
  console.log(``);
  console.log(`Endpoints:`);
  console.log(`  POST /browser/start     — Create persistent session`);
  console.log(`  POST /browser/navigate   — Go to URL`);
  console.log(`  POST /browser/click      — Click element`);
  console.log(`  POST /browser/type       — Type text`);
  console.log(`  POST /browser/evaluate   — Run JS`);
  console.log(`  POST /browser/screenshot — Take screenshot`);
  console.log(`  POST /browser/stop       — End session`);
  console.log(`  GET  /browser/status     — Session status`);
  console.log(`  GET  /health             — Health check`);
  console.log(``);
  console.log(`Waiting for commands…`);
});
