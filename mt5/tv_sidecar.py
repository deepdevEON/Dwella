#!/usr/bin/env python3
"""
tv_sidecar.py — Dwella TradingView sidecar.

Uses the TradingView MCP CLI (tv command) to read live candles, quotes,
and manage alerts from TradingView Desktop via CDP on port 9222.

Endpoints (JSON):
    GET  /status                -> { connected, symbols, last_update, ticks, candle_counts, account, positions }
    GET  /tick?symbol=NQ        -> { symbol, tick: { bid, ask, last, time } }
    GET  /candles?symbol=NQ&timeframe=3  -> { symbol, timeframe, candles: [...] }
    GET  /account               -> { account: {...} }
    GET  /positions             -> { positions: [...] }
    GET  /alerts                -> { alerts: [...] }
    POST /alerts                -> create alert
    DELETE /alerts?id=X         -> delete alert
    GET  /health                -> { tv: connected, ... }

Run:  python3 tv_sidecar.py           (default: http 127.0.0.1:18814)
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

# Import only Dwella's playlist strategy. If it cannot load, keep the
# sidecar unavailable rather than silently trading a different strategy.
try:
    from scanner_pullback import (
        ScannerState, start_scanner, stop_scanner, arm_scanner,
        reset_daily_pnl, reset_daily_positions, scan_pullback,
        TV_UI_LOCK, DAILY_POSITION_LIMIT,
    )
    SCANNER_AVAILABLE = True
    print("[sidecar] Investing Mastery 777 scanner loaded", flush=True)
except ImportError as exc:
    SCANNER_AVAILABLE = False
    ScannerState = None  # type: ignore[assignment]
    DAILY_POSITION_LIMIT = 0
    print(f"[sidecar] Investing Mastery 777 scanner unavailable: {exc}", flush=True)

# ── Auto-switch configuration ─────────────────────────────────────────
# Account changes are always explicit. Never rotate to another account in the background.
AUTO_SWITCH_ENABLED = False

# ── Symbol mapping: Dwella short name → TradingView symbol ────────────
# Nasdaq = E-mini (NQ1!) — the micro (MNQ1!/ENQ) is intentionally NOT
# traded; the user wants E-mini NQ for the strategy.
SYMBOL_MAP = {
    "NQ": "CME_MINI:NQ1!",
    "MES": "CME_MINI:MES1!",
    "GCE": "COMEX:GC1!",
    "YM": "CBOT:YM1!",
    "ES": "CME_MINI:ES1!",
    "RTY": "CME_MINI:RTY1!",
    "CL": "NYMEX:CL1!",
    "SI": "COMEX:SI1!",
}
POLL_SECONDS = 3.0
# Auto-disarm hysteresis: the scanner must only disarm after a
# SUSTAINED string of failed account observations (TradingView
# reloading, CDP blip, DOM race), never on a single transient
# failure that would leave the AutoTrader off while TradingView
# is actually connected.
ACCOUNT_OBSERVE_TOLERANCE = 4      # consecutive failed observations before auto-disarm
ACCOUNT_LASTGOOD_GRACE = 300.0     # seconds the scanner may survive a CDP blip
ACCOUNT_SNAPSHOT_GRACE = 20.0      # seconds a live balance may survive a scrape gap
# The active strategy needs enough confirmed trigger history to warm its
# wick levels and multi-timeframe structure. Request a long window; the data
# source may cap this, so status exposes the actual count.
CANDLE_COUNT = 1400

# Path to the TradingView MCP CLI
# Detect bundled paths when running from .app or PyInstaller binary
def _bundled_base():
    """Return the Resources dir of the .app bundle, or None."""
    # A frozen sidecar runs from a temporary PyInstaller directory, while the
    # signed app's MCP files live beside the executable in Contents/Resources.
    exe_dir = pathlib.Path(sys.executable).resolve().parent
    for p in [exe_dir, exe_dir.parent, exe_dir.parent.parent]:
        if (p / 'tradingview-mcp').is_dir():
            return str(p)
    # PyInstaller: sys._MEIPASS points to the temp extract dir
    if getattr(sys, '_MEIPASS', None):
        # The binary is in Contents/Resources/ inside the .app
        mei = pathlib.Path(sys._MEIPASS)
        # Walk up to find Contents/Resources
        for p in [mei, mei.parent, mei.parent.parent]:
            if (p / 'tradingview-mcp').is_dir():
                return str(p)
            if (p / 'Resources' / 'tradingview-mcp').is_dir():
                return str(p / 'Resources')
    # Running from .app bundle directly
    me = pathlib.Path(__file__).resolve()
    for ancestor in [me] + list(me.parents):
        if ancestor.name == 'Resources' and ancestor.parent.name == 'Contents':
            return str(ancestor)
        if (ancestor / 'Resources' / 'tradingview-mcp').is_dir():
            return str(ancestor / 'Resources')
    return None

_bundled = _bundled_base()
_COMPONENTS_DIR = os.environ.get("DWELLA_COMPONENTS_DIR") or os.path.join(
    os.path.expanduser("~"), "Documents", "Dwella", "trading", "components"
)
_BUNDLED_MCP_DIR = os.environ.get("DWELLA_BUNDLED_MCP_DIR") or (
    os.path.join(_bundled, "tradingview-mcp") if _bundled else
    os.path.join(os.path.expanduser("~"), "tradingview-mcp")
)
_BUNDLED_NODE = os.environ.get("DWELLA_BUNDLED_NODE") or (
    os.path.join(_bundled, "runtime", "node") if _bundled else ""
)
# Pinned TradingView Desktop (the exact build Dwella's CDP automation was
# tested against) is BUILT INTO Dwella's own bundle at
# Contents/Resources/TradingView.app — the app is inside the app, not a
# separate install. Its auto-updater is blocked (dead update feed + read-only
# cache) so the pinned version can never be replaced by a newer, breaking
# build. A per-user copy in the components dir is kept as a fallback for
# source-tree dev runs, where no embedded bundle exists.
_EMBEDDED_TV_APP = os.environ.get("DWELLA_EMBEDDED_TV_APP") or (
    os.path.join(_bundled, "TradingView.app") if _bundled else ""
)
_USER_TV_APP = os.path.join(_COMPONENTS_DIR, "TradingView.app")
_USER_MCP_CLI = os.path.join(_COMPONENTS_DIR, "tradingview-mcp", "src", "cli", "index.js")
_USER_NODE = os.path.join(_COMPONENTS_DIR, "runtime", "node")
_BUNDLED_MCP_CLI = os.path.join(_BUNDLED_MCP_DIR, "src", "cli", "index.js")

# Prefer the writable per-user copies bootstrapped by Electron, then fall
# back to the bundled resources. This lets a fresh friend install repair a
# partial cache without modifying the signed application bundle.
MCP_CLI = os.environ.get("DWELLA_MCP_CLI") or (
    _BUNDLED_MCP_CLI if os.path.isfile(_BUNDLED_MCP_CLI) else
    _USER_MCP_CLI if os.path.isfile(_USER_MCP_CLI) else
    os.path.join(os.path.expanduser('~'), 'tradingview-mcp', 'src', 'cli', 'index.js')
)
NODE_BIN = os.environ.get("DWELLA_NODE") or (
    _USER_NODE if os.path.isfile(_USER_NODE) else
    _BUNDLED_NODE if _BUNDLED_NODE and os.path.isfile(_BUNDLED_NODE) else
    'node'
)

# ── tvdatafeed (WebSocket — fast, no chart switching) ────────────────
try:
    from tvDatafeed import TvDatafeed, Interval as TVInterval
    TVDATAFEED_AVAILABLE = True
except Exception:
    TVDATAFEED_AVAILABLE = False

TVD_FRAME = {
    "1": TVInterval.in_1_minute, "3": TVInterval.in_3_minute,
    "5": TVInterval.in_5_minute, "15": TVInterval.in_15_minute,
    "60": TVInterval.in_1_hour, "240": TVInterval.in_4_hour,
    "D": TVInterval.in_daily,
} if TVDATAFEED_AVAILABLE else {}

TVD_EXCHANGE = {
    "NQ": "CME_MINI", "MES": "CME_MINI", "GCE": "COMEX",
    "YM": "CBOT_MINI", "ES": "CME_MINI", "RTY": "CME_MINI",
    "CL": "NYMEX", "SI": "COMEX",
}
TVD_SYMBOL = {
    "NQ": "CME_MINI:NQ1!", "MES": "CME_MINI:MES1!", "GCE": "COMEX:GC1!",
    "YM": "CBOT_MINI:YM1!", "ES": "CME_MINI:ES1!", "RTY": "CME_MINI:RTY1!",
    "CL": "NYMEX:CL1!", "SI": "COMEX:SI1!",
}

# Every scanner-enabled symbol receives its own candle stream. The scanner
# must never see a pair as "configured" while its /candles endpoint is empty.
# Keep this derived from SYMBOL_MAP so data coverage and routing cannot drift.
CANDLE_SYMBOLS = list(SYMBOL_MAP)
# Retained for compatibility with older status consumers; all configured
# symbols now have candles and can be evaluated by SNIPER.
TICK_ONLY_SYMBOLS = []

# RLock — tvd_candles holds the lock while calling tvd_connect, which
# also acquires it. A plain Lock would deadlock the poll thread on first
# use (client still None), freezing candles at 0. RLock is reentrant.
_tvd_lock = threading.RLock()
_tvd_client = None

# Last-run timestamps for the slow poll_loop scrapes. Each of these spawns
# a node subprocess (~0.5-2s); running all of them every 3s created process
# storms that made /tv/status flap OFFLINE. They now run on staggered,
# longer cadences — candles stay fresh every cycle, everything else is
# throttled to what actually changes.
_POLL_THROTTLE = {}

# Serializes account switching/scraping. TradingView only reveals the
# ACTIVE account's balance, so refresh_accounts() has to switch accounts
# to scrape each one. If the poll loop's tv_account() scrape runs mid-switch
# it reads the wrong panel AND flips state.active_account_id to an account
# TradingView is only momentarily on — which would make the scanner trade
# the wrong account. All account DOM access goes through this lock.
_ACCOUNT_LOCK = threading.Lock()
# Chart-switch fallback is deliberately serialized. It is used only when the
# websocket feed is stale, and prevents concurrent chart requests from fighting
# each other or the order executor.
_CHART_FALLBACK_LOCK = threading.Lock()
# A failed guest websocket must not be retried on every 3s poll. The Desktop
# direct-bars source is authoritative while this cooldown is active.
_TVD_RETRY_AFTER = 0.0


_tvd_last_ok = 0.0  # last time tvdatafeed returned data
# Anonymous tvDatafeed uses a public websocket and can be rate-limited when
# eight futures are requested every scanner cycle. Keep the last verified
# bars per symbol and refresh each stream on a modest cadence instead of
# opening 8 sockets every 3 seconds.
# Cache independently by symbol and timeframe. The 3m stream drives the
# trigger; the higher streams are genuine TradingView bars used for context,
# not relabelled 3m aggregates.
_TVD_SYMBOL_CACHE: dict[str, list[dict]] = {}
_TVD_SYMBOL_NEXT: dict[str, float] = {}
_TVD_SYMBOL_REFRESH_SECONDS = 8.0
CANDLE_TIMEFRAMES = ("1", "3", "5", "15", "60", "240", "D")
# A candle timestamp is the opening time of the bar, so the newest bar can
# legitimately be one interval old while it is still forming. These windows
# allow that normal delay, but detect a feed that has stopped advancing. The
# 3m trigger is intentionally strict enough to prevent the scanner from
# treating an old price as live data.
CANDLE_INTERVAL_SECONDS = {
    "1": 60,
    "3": 3 * 60,
    "5": 5 * 60,
    "15": 15 * 60,
    "60": 60 * 60,
    "240": 4 * 60 * 60,
    "D": 24 * 60 * 60,
}
CANDLE_STALE_AFTER_SECONDS = {
    "1": 3 * 60,
    "3": 4 * 60,
    "5": 10 * 60,
    "15": 30 * 60,
    "60": 2 * 60 * 60,
    "240": 8 * 60 * 60,
    "D": 3 * 24 * 60 * 60,
}


def _normalize_timeframe(timeframe: str | None) -> str:
    value = str(timeframe or "3").upper()
    return "D" if value == "1440" else value


def candle_age_seconds(candles: list[dict], timeframe: str,
                       now: float | None = None) -> float | None:
    """Return the age of the newest candle's opening timestamp."""
    if not candles:
        return None
    try:
        last_time = float(candles[-1].get("time", 0) or 0)
    except (TypeError, ValueError):
        return None
    if last_time <= 0:
        return None
    return max(0.0, (now if now is not None else time.time()) - last_time)


def candles_are_stale(candles: list[dict], timeframe: str,
                      now: float | None = None) -> bool:
    """True when a candle stream is missing or has stopped advancing."""
    tf = _normalize_timeframe(timeframe)
    age = candle_age_seconds(candles, tf, now)
    return age is None or age > CANDLE_STALE_AFTER_SECONDS.get(tf, 10 * 60)


HIGHER_CANDLE_COUNT = 300
# The scanner only needs a few hundred 3m bars after native higher-timeframe
# context is available. Keeping the desktop recovery window bounded makes the
# price stream recover quickly instead of waiting for a 1,400-row CLI scrape.
FALLBACK_TRIGGER_COUNT = 600
# The desktop-bars fallback is deliberately per-symbol and throttled. A dead
# guest websocket must not make eight chart-switching CLI calls every few
# seconds, but a stale trigger stream must be repaired even when another
# symbol's websocket is still returning data.
_DESKTOP_FALLBACK_NEXT: dict[str, float] = {}

def tvd_connect() -> bool:
    """Lazily connect the tvdatafeed websocket client (guest).

    During a known outage, do not construct a new websocket on every poll;
    that reconnect storm was consuming CPU and flooding the sidecar logs.
    """
    global _tvd_client, _TVD_RETRY_AFTER
    if not TVDATAFEED_AVAILABLE or time.time() < _TVD_RETRY_AFTER:
        return False
    with _tvd_lock:
        if _tvd_client is None:
            try:
                _tvd_client = TvDatafeed()
            except Exception:
                return False
        return True


def tvd_healthy() -> bool:
    """True if tvdatafeed returned data recently (< 20s ago)."""
    return time.time() - _tvd_last_ok < 20


def _chart_root(symbol: str) -> str:
    """Normalize a TradingView symbol for safe chart restoration."""
    return str(symbol or "").upper().replace("!", "").split(":")[-1].strip()


# Empty results are tracked per symbol. A transient "no data" response for
# RTY must not drop the shared websocket and starve every other market.
_tvd_empty_by_symbol: dict[str, int] = {}
_tvd_last_drop = 0.0
_tvd_last_err = 0.0


def _tvd_drop_client(reason: str) -> None:
    """Drop the tvdatafeed client so the next call reconnects fresh.

    Cooldown-gated: we never recreate more than once per 10s, so a brief
    TradingView hiccup doesn't turn into a reconnect loop.
    """
    global _tvd_client, _tvd_last_drop, _TVD_RETRY_AFTER
    now = time.time()
    if _tvd_client is None:
        return
    if now - _tvd_last_drop < 10:
        return
    _tvd_last_drop = now
    _tvd_client = None
    _tvd_empty_by_symbol.clear()
    _TVD_RETRY_AFTER = now + 60.0
    if now - _tvd_last_err >= 30:
        _tvd_last_err = now
        import sys as _sys
        print(f"[tvd] reconnecting websocket ({reason})", file=_sys.stderr, flush=True)


def tvd_candles(symbol: str, count: int = CANDLE_COUNT, timeframe: str = "3") -> list[dict]:
    """Fetch OHLCV candles via tvdatafeed websocket (fast, no chart switch).

    If the socket is dead, recreate the client on the next call (the guest
    connection drops periodically — this self-heals).
    """
    global _tvd_last_ok, _tvd_client, _TVD_RETRY_AFTER
    now = time.time()
    tf = _normalize_timeframe(timeframe)
    cache_key = f"{symbol}:{tf}"
    if not TVDATAFEED_AVAILABLE or now < _TVD_RETRY_AFTER:
        return list(_TVD_SYMBOL_CACHE.get(cache_key, []))
    cached = _TVD_SYMBOL_CACHE.get(cache_key)
    if cached and now < _TVD_SYMBOL_NEXT.get(cache_key, 0.0):
        return list(cached)
    try:
        with _tvd_lock:
            if _tvd_client is None and not tvd_connect():
                return []
            # tvDatafeed's guest endpoint is most reliable with the bare
            # continuous-future root plus its exchange. Passing a combined
            # TradingView root (for example COMEX:GC1!) with an empty exchange
            # is what produced repeated "no data" errors for gold and other
            # symbols.
            tv_full = TVD_SYMBOL.get(symbol, symbol)
            tv_bare = tv_full.split(":", 1)[-1]
            exchange = TVD_EXCHANGE.get(symbol, "")
            df = _tvd_client.get_hist(
                symbol=tv_bare,
                exchange=exchange,
                interval=TVD_FRAME.get(tf, TVInterval.in_3_minute),
                n_bars=count,
            )
        if df is None or getattr(df, "empty", True):
            # An individual continuous future can briefly return no data, but
            # a whole watchlist of empty responses means the guest websocket
            # is dead. Drop it once and enter the cooldown instead of asking
            # every symbol to repeat the same failing request every 3 seconds.
            _tvd_empty_by_symbol[cache_key] = _tvd_empty_by_symbol.get(cache_key, 0) + 1
            _TVD_SYMBOL_NEXT[cache_key] = time.time() + 5.0
            empty_symbols = sum(1 for n in _tvd_empty_by_symbol.values() if n >= 1)
            empty_attempts = sum(_tvd_empty_by_symbol.values())
            if empty_symbols >= 6 or empty_attempts >= max(8, len(CANDLE_SYMBOLS)):
                _tvd_drop_client("repeated empty candle responses")
            return list(_TVD_SYMBOL_CACHE.get(cache_key, []))
        _tvd_empty_by_symbol.pop(cache_key, None)
        out = []
        for index, row in df.iterrows():
            # tvDatafeed normally stores the candle time in the dataframe
            # index, not a `datetime` column. Falling back to time.time()
            # for every row collapses the entire history into one timestamp,
            # leaving the UI with only a handful of giant candles. Preserve
            # each bar's real timestamp so charts and scanner setup keys stay
            # pair- and candle-specific.
            ts = row.get("datetime")
            if ts is None:
                ts = index
            if hasattr(ts, "to_pydatetime"):
                ts = ts.to_pydatetime()
            if hasattr(ts, "timestamp"):
                ts = int(ts.timestamp())
            else:
                try:
                    ts = int(ts)
                except (TypeError, ValueError):
                    ts = int(time.time())
            out.append({
                "time": ts,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row.get("volume", 0)),
            })
        _TVD_SYMBOL_CACHE[cache_key] = out
        _TVD_SYMBOL_NEXT[cache_key] = time.time() + _TVD_SYMBOL_REFRESH_SECONDS
        # A non-empty dataframe is not automatically a live feed: the guest
        # websocket can keep serving the same old bar after it has stalled.
        # Only a fresh trigger stream keeps the websocket health flag alive;
        # this lets the Desktop fallback take over instead of freezing price.
        if tf == "3" and not candles_are_stale(out, tf):
            _tvd_last_ok = time.time()
        return list(out)
    except Exception:
        # Socket dead or transient error — drop the client so the next call
        # reconnects. Log a single line (rate-limited) instead of a full
        # traceback per symbol per cycle.
        _tvd_drop_client("exception")
        _TVD_SYMBOL_NEXT[cache_key] = time.time() + 5.0
        return list(_TVD_SYMBOL_CACHE.get(cache_key, []))


# ── TradingView MCP CLI helper ────────────────────────────────────────
def tv_cli(command: str, args: Optional[dict] = None, timeout: int = 15) -> Optional[dict]:
    """Run a TradingView MCP CLI command and return parsed JSON output."""
    cmd = [NODE_BIN, MCP_CLI, command]
    if args:
        for k, v in args.items():
            cmd.extend([f"--{k}", str(v)])
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        return None
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return None


def tv_account() -> dict:
    """Scrape paper trading account info from TradingView DOM.

    The account name is read from the account-manager header (the account
    TradingView is actually using) instead of being hardcoded — mismatched
    names caused duplicate accounts with wrong balances.
    """
    js = (
        'var acct = {};'
        "var hdr = document.querySelector('.js-account-manager-header, [class*=\"accountManager\"] [class*=\"accountName\"], .header-account-info');"
        'var hdrTxt = hdr ? (hdr.textContent || "") : "";'
        'var hm = hdrTxt.match(/^\\s*([A-Za-z0-9_ .&\'#-]{1,40}?)(?:USD|EUR|GBP|JPY|CAD|AUD|CHF)/);'
        'var hdrName = hm ? hm[1].trim() : "";'
        'var divs = document.querySelectorAll("div");'
        'function signedNumber(value) {'
        '  var raw = String(value || "").trim();'
        '  var negative = /^\\(.*\\)$/.test(raw) || /[−–—-]\\s*\\$?\\s*\\d/.test(raw);'
        '  raw = raw.replace(/[()$,+\\s]/g, "").replace(/[−–—]/g, "-");'
        '  var n = parseFloat(raw);'
        '  return isFinite(n) ? (negative ? -Math.abs(n) : n) : 0;'
        '}'
        'for (var i = 0; i < divs.length; i++) {'
        '  var t = divs[i].textContent || "";'
        '  if (t.length > 300 || t.length < 20) continue;'
        '  if (t.indexOf("Account balance") === -1) continue;'
        '  var m;'
        '  m = t.match(/Account balance\\s*([\\d,.]+)/);'
        '  if (m) acct.balance = parseFloat(m[1].replace(/,/g, ""));'
        '  m = t.match(/Equity\\s*([\\d,.]+)/);'
        '  if (m) acct.equity = parseFloat(m[1].replace(/,/g, ""));'
        '  m = t.match(/Realized PnL\\s*([+−–—-]?[\\d,.]+)/);'
        '  if (m) acct.realized_pnl = signedNumber(m[1]);'
        '  m = t.match(/Unrealized PnL\\s*([+−–—-]?[\\d,.]+)/);'
        '  if (m) acct.unrealized_pnl = signedNumber(m[1]);'
        '  m = t.match(/Account margin([\\d,.]+)/);'
        '  if (m) acct.margin = parseFloat(m[1].replace(/,/g, ""));'
        '  m = t.match(/Available funds([\\d,.]+)/);'
        '  if (m) acct.margin_free = parseFloat(m[1].replace(/,/g, ""));'
        '  break;'
        '}'
        'var orderPanel = document.querySelector(\'[data-name="order-panel"]\');'
        'var orderText = orderPanel ? (orderPanel.textContent || "") : "";'
        'var lm = orderText.match(/Leverage[^0-9]*([0-9.]+)\\s*:\\s*([0-9.]+)/i);'
        'if (lm) acct.leverage = parseFloat(lm[1]) / Math.max(parseFloat(lm[2]), 1);'
        'acct.name = hdrName || "TradingView Paper";'
        'acct.server = "Paper Trading";'
        'acct.currency = "USD";'
        'acct.leverage = acct.leverage || 1;'
        'acct.profit = acct.realized_pnl != null ? acct.realized_pnl : 0;'
        'JSON.stringify(acct);'
    )
    result = tv_ui_eval(js)
    if result and result.get("success"):
        try:
            return json.loads(result["result"])
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def tv_accounts(deep: bool = False) -> list[dict]:
    """Scrape ALL accounts from the TradingView account manager DOM.

    The manager lists every account the user has — paper accounts plus any
    connected broker accounts. The account TradingView is actively trading
    on is authoritative: its name comes from the manager header.

    deep=True opens the manager dropdown to read every account row, then
    closes it (heavier — used by the manual Refresh, not the poll loop).
    """
    def _toggle_manager():
        # Same as tv_switch_account._toggle: the click handler lives on the
        # dropdown <button> child, not the wrapping header div.
        return tv_ui_eval(
            "(function(){"
            "var h=document.querySelector('.js-account-manager-header,[data-name=\"account-manager\"],[class*=\"accountManager\"]');"
            "if(!h)return {ok:false};"
            "var b=null;"
            "var all=h.querySelectorAll('button,[class*=\"dropdownButton\"],[class*=\"button\"]');"
            "for(var i=0;i<all.length;i++){var r=all[i].getBoundingClientRect();"
            "if(r.width>0&&r.height>0){b=all[i];break;}}"
            "if(!b)return {ok:false};"
            "var rc=b.getBoundingClientRect();"
            "var cx=rc.left+rc.width/2,cy=rc.top+rc.height/2;"
            "var o={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0};"
            "b.dispatchEvent(new MouseEvent('mousedown',o));"
            "b.dispatchEvent(new MouseEvent('mouseup',o));"
            "b.dispatchEvent(new MouseEvent('click',o));"
            "return {ok:true};})()"
        )

    if deep:
        _toggle_manager()
        time.sleep(1.1)

    js = """
    (function() {
        function acctNameFromText(t) {
            var m = (t || '').match(/^\s*([A-Za-z0-9_ .&'#-]{1,40}?)(?:USD|EUR|GBP|JPY|CAD|AUD|CHF)/);
            return m ? m[1].trim() : '';
        }
        var accounts = [];
        var seen = {};
        var hdr = document.querySelector('.js-account-manager-header');
        var hdrTxt = hdr ? (hdr.textContent || '').replace(/\s+/g, '') : '';
        var hdrName = acctNameFromText(hdrTxt);
        var nameEls = document.querySelectorAll('[class*="itemAccountName"], [class*="accountName"], [class*="account-name"], [data-qa-id^="account-name-"]');
        for (var i = 0; i < nameEls.length; i++) {
            var el = nameEls[i];
            var name = (el.textContent || '').trim();
            if (!name || seen[name]) continue;
            seen[name] = true;
            var parent = el.closest('button') || el.parentElement || el;
            var full = (parent.textContent || '').replace(/\s+/g, ' ').trim();
            var currency = 'USD';
            var cm = full.match(/(USD|EUR|GBP|JPY|CAD|AUD|CHF)/);
            if (cm) currency = cm[1];
            var isActive = hdrName ? (name.toLowerCase() === hdrName.toLowerCase() || full.indexOf(hdrName) !== -1) : false;
            accounts.push({name: name, broker: 'TradingView', currency: currency, active: !!isActive});
        }
        // Fallback: the active account from the header is always known.
        if (!accounts.length && hdrName) {
            accounts.push({name: hdrName, broker: 'TradingView', currency: 'USD', active: true});
        }
        if (!accounts.length) {
            accounts.push({name: 'TradingView Paper', broker: 'TradingView', currency: 'USD', active: true});
        }
        // Exactly one active account: the header one wins.
        var anyActive = accounts.some(function(a) { return a.active; });
        if (!anyActive) accounts[0].active = true;
        return JSON.stringify(accounts);
    })()
    """
    result = tv_ui_eval(js)

    if deep:
        _toggle_manager()
        time.sleep(0.5)

    if result and result.get("success") and result.get("result"):
        try:
            parsed = json.loads(result["result"])
            return parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            return []
    return []


_TV_HISTORY_CACHE: list[dict] = []
_TV_HISTORY_CACHE_AT = 0.0
_TV_HISTORY_LOCK = threading.Lock()


def _history_number(value: Any) -> Optional[float]:
    text = str(value or "").strip()
    if not text:
        return None
    negative = bool(re.search(r"[−–—-]|\(", text))
    cleaned = re.sub(r"[^0-9.]", "", text)
    if not cleaned:
        return None
    try:
        number = float(cleaned)
    except ValueError:
        return None
    return -abs(number) if negative else number


def _history_date(value: Any) -> str:
    """Return an ISO date for a TradingView history timestamp."""
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if not text:
        return ""
    formats = (
        "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M",
        "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y",
    )
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    if re.fullmatch(r"\d{1,2}:\d{2}(?::\d{2})?", text):
        return datetime.now(timezone.utc).date().isoformat()
    match = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", text)
    if match:
        return f"{int(match.group(1)):04d}-{int(match.group(2)):02d}-{int(match.group(3)):02d}"
    return ""


def _parse_history_rows(raw: Any) -> list[dict]:
    """Normalize TradingView's order/balance/journal tables.

    Empty tables remain empty. We only emit rows that TradingView actually
    rendered, so the Journal never invents trades or dates.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if isinstance(item, dict):
            table = str(item.get("table") or "")
            cells = [str(x or "").strip() for x in item.get("cells", [])]
        elif isinstance(item, list):
            table = "history"
            cells = [str(x or "").strip() for x in item]
        else:
            continue
        cells = [x for x in cells if x]
        if not cells:
            continue
        joined = " ".join(cells)
        low = joined.lower()
        if "there is no trading data" in low or "no trading data here" in low:
            continue
        if cells[0].lower() in {"symbol", "time", "date"}:
            continue
        is_account = "account-history" in table
        is_journal = "trading-journal" in table
        # Order-history columns: symbol, side, type, quantity, limit, stop,
        # fill, take profit, stop loss, instruction, status, placing time...
        side = next((x.upper() for x in cells if x.upper() in {"LONG", "SHORT", "BUY", "SELL"}), "")
        date = ""
        for cell in reversed(cells):
            candidate = _history_date(cell)
            if candidate:
                date = candidate
                break
        pnl = None
        if is_account and len(cells) >= 4:
            pnl = _history_number(cells[3])
        else:
            for cell in cells:
                if re.search(r"(?:p&l|pnl|profit|realized)", cell, re.I):
                    pnl = _history_number(cell)
                    break
        if is_account:
            action = cells[4] if len(cells) > 4 else (cells[-1] if cells else "")
            action_low = action.lower()
            excluded = any(word in action_low for word in ("deposit", "withdraw", "transfer", "commission", "fee"))
            # Account-history P&L can be a balance adjustment rather than a
            # closed trade. Only explicit trade/close/fill labels are eligible.
            trade_event = any(word in action_low for word in ("trade", "close", "fill", "realized", "p&l", "pnl"))
            completed = pnl is not None and trade_event and not excluded
            out.append({"table": table, "symbol": "ACCOUNT", "side": action, "qty": "", "price": "", "pnl": pnl, "time": cells[0], "date": date, "action": action, "completed": completed, "balance_before": _history_number(cells[1]) if len(cells) > 1 else None, "balance_after": _history_number(cells[2]) if len(cells) > 2 else None, "raw": cells})
        elif is_journal:
            action = cells[1] if len(cells) > 1 else ""
            out.append({"table": table, "symbol": "JOURNAL", "side": "", "qty": "", "price": "", "pnl": pnl, "time": cells[0], "date": date, "action": action, "completed": pnl is not None, "raw": cells})
        elif side and len(cells) >= 4:
            status = next((x for x in cells if x.lower() in {"filled", "closed", "partially filled"}), "")
            # Order history is intentionally not a completed-trade source:
            # an entry, exit bracket, and cancellation are separate orders
            # and do not carry realized P&L. Keep rows available internally
            # for diagnostics, but never count or expose them as trades.
            action = status.upper() if status else "ORDER"
            fill = cells[6] if len(cells) > 6 else next((x for x in cells if _history_number(x) is not None), "")
            out.append({"table": table, "symbol": cells[0], "side": side, "qty": cells[3] if len(cells) > 3 else "", "price": fill, "pnl": pnl, "time": cells[-1], "date": date, "action": action, "status": status, "completed": False, "raw": cells})
    return out


def _read_history_table(kind: str, selector: str) -> list[dict]:
    """Read one TradingView history table after its tab is selected."""
    js = (
        "(function(){var table=document.querySelector('" + selector + "');"
        "if(!table)return JSON.stringify([]);"
        "var rows=table.querySelectorAll('tr.ka-row,tr[class*=\\\"ka-row\\\"],tbody tr');"
        "var out=[];for(var i=0;i<rows.length;i++){var cells=rows[i].querySelectorAll('td,[class*=\\\"cell\\\"]');"
        "var vals=[];for(var c=0;c<cells.length;c++)vals.push((cells[c].textContent||'').trim());"
        "if(vals.length)out.push({table:'" + kind + "',cells:vals});}return JSON.stringify(out);})()"
    )
    result = tv_ui_eval(js)
    if not result or not result.get("success") or not result.get("result"):
        return []
    try:
        return _parse_history_rows(json.loads(result["result"]))
    except (json.JSONDecodeError, TypeError):
        return []


def _tv_history_tables() -> list[dict]:
    """Read currently rendered history tables without changing TradingView UI."""
    global _TV_HISTORY_CACHE, _TV_HISTORY_CACHE_AT
    with _TV_HISTORY_LOCK:
        if time.time() - _TV_HISTORY_CACHE_AT < 8:
            return list(_TV_HISTORY_CACHE)
        js = """
        (function() {
            var out = [];
            var selectors = [
              ['order-history','[data-name="Paper.history-table"]'],
              ['account-history','[data-name="Paper.account-history.account-history-table"]'],
              ['trading-journal','[data-name="Paper.trading-journal.trading-journal-table"]']
            ];
            for (var s = 0; s < selectors.length; s++) {
                var table = document.querySelector(selectors[s][1]);
                if (!table) continue;
                var rows = table.querySelectorAll('tr.ka-row, tr[class*="ka-row"], tbody tr');
                for (var i = 0; i < rows.length; i++) {
                    var cells = rows[i].querySelectorAll('td, [class*="cell"]');
                    var values = [];
                    for (var c = 0; c < cells.length; c++) values.push((cells[c].textContent || '').trim());
                    if (values.length) out.push({table: selectors[s][0], cells: values});
                }
            }
            return JSON.stringify(out);
        })()
        """
        result = tv_ui_eval(js)
        parsed: Any = []
        if result and result.get("success") and result.get("result"):
            try:
                parsed = json.loads(result["result"])
            except (json.JSONDecodeError, TypeError):
                parsed = []
        _TV_HISTORY_CACHE = _parse_history_rows(parsed)
        _TV_HISTORY_CACHE_AT = time.time()
        return list(_TV_HISTORY_CACHE)


def tv_history() -> list[dict]:
    """Return only TradingView rows that prove a completed trade and P&L.

    Filled orders are deliberately excluded: they are order events, not
    round-trip trades, and TradingView renders entry/exit brackets as several
    separate rows. A row is history-safe only when the Trading Journal or
    Account History supplies a realized P&L value.
    """
    return [
        row for row in _tv_history_tables()
        if row.get("table") in {"trading-journal", "account-history"}
        and row.get("completed")
        and row.get("pnl") is not None
    ]


def expire_stale_account(state: State) -> None:
    """Remove live account data after the embedded session stops answering.

    Account metadata and the selected target remain available, but balances,
    account identity, and verification are never allowed to survive as live
    data after a TradingView webview/CDP outage. This is what prevents a
    deleted/logged-out TradingView session from looking tradeable.
    """
    with state.lock:
        if not state.account_observed_at:
            return
        if time.time() - state.account_observed_at <= ACCOUNT_SNAPSHOT_GRACE:
            return
        if state.account_stale and not state.account:
            return
        state.account = {}
        state.actual_account_name = ""
        state.actual_account_id = ""
        state.account_stale = True
        for account in state.accounts:
            account["balance"] = 0.0
            account["equity"] = 0.0
            account["pnl"] = 0.0
            account["connected"] = False
            account["verified"] = False
            account["observed"] = False
        state._save_accounts()


def _account_is_verified(state: State, account_id: str) -> bool:
    """True when ``account_id`` is a discovered, connected, verified account."""
    found = next((a for a in state.accounts if a.get("id") == account_id), None)
    return bool(found and found.get("connected") and found.get("verified"))


def account_ready_state(state: State):
    """Decide scanner arm state with auto-disarm hysteresis.

    Returns ``(ready, disarm_now)``:

    - ``ready`` is True while a verified account is visible, or for a short
      grace window after the last verified observation so a single CDP blip
      or TradingView reload cannot leave the AutoTrader off.
    - ``disarm_now`` is True only after a SUSTAINED string of failed
      observations AND the grace window has expired — i.e. TradingView has
      genuinely been unavailable, not just reloading.

    The execution path still re-verifies the live account
    (``ensure_account_target``) before placing orders, so keeping the scanner
    armed during a grace window cannot route an order to the wrong account.
    """
    with state.lock:
        actual = state.actual_account_id
        now = time.time()
        if actual:
            if _account_is_verified(state, actual):
                state.last_good_account_id = actual
                state.last_good_time = now
                state.observe_failures = 0
                if not state.cross_trading:
                    return True, False
                return actual in state.selected_account_ids, False
            # Live observation exists but is not verified yet.
            state.observe_failures += 1
        else:
            # No observation at all this cycle (CDP drop, TV still loading).
            state.observe_failures += 1

        in_grace = bool(
            state.last_good_account_id
            and state.last_good_time
            and (now - state.last_good_time) <= ACCOUNT_LASTGOOD_GRACE
            and _account_is_verified(state, state.last_good_account_id)
        )
        if in_grace:
            # Keep the last verified account trusted while it is being
            # re-observed; only disarm once failures are sustained AND grace
            # has expired (otherwise a transient hiccup flips the trader off).
            if not state.cross_trading:
                return True, False
            return state.last_good_account_id in state.selected_account_ids, False
        sustained = state.observe_failures >= ACCOUNT_OBSERVE_TOLERANCE
        return False, sustained


def account_ready_for_trading(state: State) -> bool:
    """Backward-compatible wrapper: whether the account is verified/ready."""
    ready, _ = account_ready_state(state)
    return ready


def adopt_visible_account(state: State) -> None:
    """Persist the account TradingView is already showing in single-account mode.

    This never clicks the account manager and never switches accounts. It only
    repairs stale state left by older builds (for example selected ``The Leap``
    while TradingView is visibly on ``itsgiddd``), preventing a false account
    gate and ensuring orders use the logged-in account.
    """
    with state.lock:
        if state.cross_trading or not state.actual_account_id:
            return
        actual = state.actual_account_id
        found = next((a for a in state.accounts if a.get("id") == actual), None)
        if not found or not found.get("verified"):
            return
        state.active_account_id = actual
        state.selected_account_ids = [actual]
        for account in state.accounts:
            account["active"] = account.get("id") == actual
        state._save_accounts()


def ensure_saved_account(state: State) -> bool:
    """Return whether a connected account is ready for trading.

    The scanner arms when the visible TradingView account matches a saved
    target. Use POST /accounts/save-current to explicitly save the current
    account.
    """
    return account_ready_for_trading(state)


def sync_tv_accounts(state: State, deep: bool = False) -> None:
    """Merge accounts discovered from TradingView into the state store.

    Rules (fixed):
      - The account TradingView is actually trading on is the ONLY active
        account (orders hit that one).
      - Duplicate paper entries created by the old "TradingView Paper"
        fallback are merged, not re-added.
      - Accounts not seen in the live discovery are marked verified=False so
        the UI never shows fabricated balances.
    The slow MCP DOM scrape happens OUTSIDE the state lock so API requests
    are never blocked by the subprocess round-trip.
    """
    try:
        discovered = tv_accounts(deep=deep)
    except Exception:
        return
    if not discovered:
        return
    with state.lock:
        active_name = next((d.get("name", "") for d in discovered if d.get("active")),
                           discovered[0].get("name", "")) if discovered else ""
        seen = set()
        for d in discovered:
            name = d.get("name", "")
            if not name:
                continue
            existing = None
            for e in state.accounts:
                if e.get("name", "").lower() == name.lower():
                    existing = e
                    break
            # Never merge an observed account into a generic paper row. That
            # old fallback renamed the saved target to whichever account the
            # DOM happened to show and caused balances/account ids to jump.
            if existing is None:
                new_id = name.lower().replace(" ", "_").replace("#", "")
                existing = {
                    "id": new_id,
                    "name": name,
                    "broker": d.get("broker", "TradingView"),
                    "type": "Paper" if "paper" in name.lower() else "Live",
                    "balance": 0,
                    "equity": 0,
                    "pnl": 0,
                    "active": False,
                    "connected": True,
                    "currency": d.get("currency", "USD"),
                    "leverage": 1,
                    "verified": False,
                }
                state.accounts.append(existing)
            existing["name"] = name  # adopt the real TradingView name
            existing["broker"] = d.get("broker", "TradingView")
            existing["currency"] = d.get("currency", "USD")
            existing["connected"] = True
            observed = bool(active_name and name.lower() == active_name.lower())
            existing["observed"] = observed
            if observed:
                state.actual_account_name = name
                state.actual_account_id = existing["id"]
            # `active_account_id` is the user's saved trading target. A
            # discovery poll must never replace it with the account that
            # happened to be visible in TradingView's header.
            existing["active"] = (existing["id"] == state.active_account_id)
            seen.add(existing["id"])
        # Exactly one saved target. The observed TradingView account is
        # reported separately and never silently becomes the target.
        for e in state.accounts:
            e["active"] = (e["id"] == state.active_account_id)
        # Drop stale zero-balance duplicate paper entries (old fallback
        # artifacts). Keep the active account, real/manual accounts
        # (balance > 0 or non-paper) — never drop the account TradingView
        # is actually trading on, even during a flaky scrape.
        state.accounts = [
            a for a in state.accounts
            if a["id"] in seen
            or a["id"] == state.active_account_id
            or float(a.get("balance", 0) or 0) > 0
            or str(a.get("type", "")).lower() != "paper"
        ]
        # Only a DEEP discovery sees the full account list (shallow reads
        # just the header, so it must never clobber balances). On deep:
        #   - accounts not seen at all have unverifiable money;
        #   - any account that has never been live-scraped must NOT keep a
        #     stored balance — the old fallback wrote fabricated numbers
        #     (e.g. "The Leap" $51,250). Zero it so the UI shows "—" until
        #     refresh_accounts() switches to it and scrapes the real amount.
        if deep:
            for a in state.accounts:
                if a["id"] not in seen:
                    a["verified"] = False
            for a in state.accounts:
                if not a.get("verified") and not a.get("active"):
                    a["balance"] = 0.0
                    a["equity"] = 0.0
                    a["pnl"] = 0.0
        state._save_accounts()


def tv_switch_account(name: str) -> bool:
    """Switch the ACTIVE account inside TradingView's account manager.

    Best-effort DOM automation: opens the manager dropdown, clicks the row
    whose name matches, closes the dropdown, then verifies the header now
    shows the target account. Returns True when the switch is confirmed.
    """
    def _toggle():
        # Click the account-selector button (new TradingView DOM uses
        # data-qa-id="account-selector" inside .js-account-manager-header).
        return tv_ui_eval(
            "(function(){"
            "var b=document.querySelector('[data-qa-id=\"account-selector\"]');"
            "if(!b)return {ok:false,error:'no selector'};"
            "var rc=b.getBoundingClientRect();"
            "if(rc.width===0)return {ok:false,error:'hidden'};"
            "var cx=rc.left+rc.width/2,cy=rc.top+rc.height/2;"
            "var o={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0};"
            "b.dispatchEvent(new MouseEvent('mousedown',o));"
            "b.dispatchEvent(new MouseEvent('mouseup',o));"
            "b.dispatchEvent(new MouseEvent('click',o));"
            "return {ok:true};})()"
        )
    def _visible_names():
        # Try multiple selector strategies for TradingView's evolving DOM.
        r = tv_ui_eval(
            "(function(){var out=[];"
            "var sels=['[data-qa-id^=\"account-name-\"]','[class*=\"itemAccountName\"]','[class*=\"accountName\"]','[class*=\"account-name\"]'];"
            "for(var s=0;s<sels.length;s++){"
            "var els=document.querySelectorAll(sels[s]);"
            "for(var i=0;i<els.length;i++){var b=els[i].getBoundingClientRect();"
            "if(b.width>0&&b.height>0){var n=(els[i].textContent||'').trim();if(n&&out.indexOf(n)===-1)out.push(n);}}}"
            "return JSON.stringify(out);})()"
        )
        try:
            v = r.get("result") if r and isinstance(r.get("result"), str) else (r or {}).get("result")
            if isinstance(v, str):
                parsed = json.loads(v)
                return parsed if isinstance(parsed, list) else []
            return v if isinstance(v, list) else []
        except Exception:
            return []
    # Deterministically OPEN the dropdown: click the header, then check the
    # DOM. If the click closed it instead (state desync), click again. This
    # replaces blind toggling which raced with refresh_accounts' deep scrape.
    for _ in range(3):
        names = _visible_names()
        if names:
            break
        _toggle()
        time.sleep(1.0)
    js = (
        "(function() {"
        "  var target = '" + name + "';"
        "  function clickableRow(el) {"
        "    var node = el;"
        "    for (var k = 0; k < 5 && node; k++) {"
        "      var cls = (node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className || '').toString();"
        "      if (cls.indexOf('button') !== -1 || node.getAttribute('role') === 'button' || node.tagName === 'BUTTON') return node;"
        "      node = node.parentElement;"
        "    }"
        "    return el.closest('[class*=\"button\"]') || el;"
        "  }"
        "  // IMPORTANT: only the DROPDOWN row spans. The header's own"
        "  // account-name span ([class*=accountName]) also contains the"
        "  // target text, and walking up from it hits the header BUTTON"
        "  // (dropdownButton-*) — which toggles the dropdown instead of"
        "  // switching accounts, and 'verifies' because the header didn't"
        "  // change. itemAccountName / data-qa-id=account-name-* exist ONLY"
        "  // on the dropdown rows."
        "  var sels=['[data-qa-id^=\"account-name-\"]','[class*=\"itemAccountName\"]','[class*=\"accountName\"]','[class*=\"account-name\"]'];"
        "  var els=[];for(var si=0;si<sels.length;si++){var found=document.querySelectorAll(sels[si]);for(var fi=0;fi<found.length;fi++){els.push(found[fi]);}}"
        "  for (var i = 0; i < els.length; i++) {"
        "    var t = (els[i].textContent || '').trim();"
        "    var r = els[i].getBoundingClientRect();"
        "    if (r.width > 0 && r.height > 0 && t.toLowerCase().indexOf(target.toLowerCase()) !== -1) {"
        "      var row = clickableRow(els[i]);"
        "      var rr = row.getBoundingClientRect();"
        "      var cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;"
        "      var o = {bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0};"
        "      row.dispatchEvent(new MouseEvent('mousedown', o));"
        "      row.dispatchEvent(new MouseEvent('mouseup', o));"
        "      row.dispatchEvent(new MouseEvent('click', o));"
        "      return {ok: true, el: t.slice(0, 40)};"
        "    }"
        "  }"
        "  return {ok: false};"
        "})()"
    )
    # Click the row, then VERIFY via the account-manager header. A click
    # that landed elsewhere is not a switch — retry up to 3 times so a
    # transient DOM race never leaves Dwella claiming a wrong account.
    last_err = ""
    for attempt in range(3):
        try:
            if attempt > 0:
                # Re-open the dropdown for the retry if the rows vanished
                if not _visible_names():
                    _toggle()
                    time.sleep(1.1)
            r = tv_ui_eval(js)
            time.sleep(1.4)
            try:
                res = json.loads(r["result"]) if r and isinstance(r.get("result"), str) else (r or {}).get("result")
                clicked = bool(res and res.get("ok"))
            except Exception:
                clicked = False
            if not clicked:
                last_err = "row not found"
                continue
            live = tv_account()
            header_ok = bool(live and live.get("name", "").lower() == name.lower())
            if header_ok:
                _toggle()  # close the dropdown
                return True
            last_err = "header mismatch: " + str((live or {}).get("name", ""))[:20]
        except Exception as exc:
            last_err = str(exc)[:80]
    _toggle()  # best-effort close
    return False


def switch_active_account(state: State, account_id: str, persist_target: bool = True) -> dict:
    """Switch the active account in BOTH Dwella state and TradingView.

    For accounts that TradingView knows about (verified), the local flag is
    only kept when the real TradingView switch succeeds — otherwise it is
    rolled back so Dwella never claims to trade an account it isn't on.
    After a successful switch the balance is re-scraped so the money shown
    is real, not stale.
    """
    with state.lock:
        acct = next((a for a in state.accounts if a.get("id") == account_id), None)
        name = acct.get("name", "") if acct else ""
        verified = bool(acct and acct.get("verified"))
        prev_id = state.active_account_id
    if not acct:
        return {"ok": False, "error": "unknown account"}
    if not verified:
        return {"ok": False, "tv_switched": False, "error": "account balance has not been verified; press Refresh balances first"}
    if persist_target:
        ok = state.switch_account(account_id)
        if not ok:
            return {"ok": False, "error": "could not update local state"}

    tv_switched = True
    if name and verified:
        try:
            # Serialize with the poll loop's account scrape and refresh_accounts
            # so the switch + balance read is atomic w.r.t. the rest of Dwella.
            with _ACCOUNT_LOCK:
                tv_switched = tv_switch_account(name)
                time.sleep(1.0)
                if tv_switched:
                    try:
                        live = tv_account()
                        if live and live.get("balance"):
                            state.update_account_balance(
                                account_id,
                                float(live.get("balance", 0)),
                                float(live.get("equity") or live.get("balance", 0)),
                                float(live.get("realized_pnl") or 0),
                            )
                            with state.lock:
                                for a in state.accounts:
                                    if a["id"] == account_id:
                                        a["verified"] = True
                                        break
                                state._save_accounts()
                    except Exception:
                        pass
        except Exception:
            tv_switched = False
    if not tv_switched:
        # Roll back — TradingView is still on the previous account.
        if persist_target:
            with state.lock:
                for a in state.accounts:
                    a["active"] = (a["id"] == prev_id)
                if prev_id:
                    state.active_account_id = prev_id
                state._save_accounts()
        return {"ok": False, "tv_switched": False,
                "error": "TradingView could not switch to this account — run Refresh balances first"}
    return {"ok": True, "tv_switched": True}


def refresh_accounts(state: State) -> dict:
    """Deep re-discover accounts from TradingView and refresh balances.

    Every account listed in TradingView's account manager gets its REAL
    balance scraped: we switch to it, read the paper-trading panel, then
    switch back to the original active account. Accounts that TradingView
    cannot switch to are marked unverified so the UI shows "—" instead of
    a fabricated number.

    The WHOLE cycle runs under _ACCOUNT_LOCK so the poll loop's account
    scrape can never interleave (it would read the wrong panel and move
    the active account). The original active account is restored last, in
    BOTH TradingView and Dwella state.
    """
    with _ACCOUNT_LOCK:
        # Capture the PERSISTED active account FIRST. sync_tv_accounts()
        # re-derives the active account from whatever TradingView's header
        # shows at that moment — if a previous run left TradingView on a
        # different account, that would become the new "original" and we'd
        # never restore the account the user actually trades on.
        with state.lock:
            active_id = state.active_account_id
            active_name = next((a.get("name", "") for a in state.accounts if a.get("id") == active_id), "")
            accounts = [dict(a) for a in state.accounts]

        sync_tv_accounts(state, deep=True)

        for a in accounts:
            name = a.get("name", "")
            if not name or name.lower() == (active_name or "").lower():
                continue  # active account is scraped at the end
            try:
                switched = tv_switch_account(name)
                if not switched:
                    continue
                time.sleep(0.9)
                live = tv_account()
                if live and live.get("balance"):
                    state.update_account_balance(
                        a["id"],
                        float(live.get("balance", 0)),
                        float(live.get("equity") or live.get("balance", 0)),
                        float(live.get("realized_pnl") or 0),
                    )
            except Exception:
                continue

        # Switch back to the PERSISTED active account — both in TradingView
        # and in Dwella state — so the scanner keeps trading the account it
        # was on before the refresh. Only scrape the final balance if the
        # restore is CONFIRMED (header shows the original account); otherwise
        # we'd overwrite itsgiddd's balance with The Leap's numbers.
        restored = False
        if active_name:
            try:
                restored = tv_switch_account(active_name)
            except Exception:
                restored = False
            time.sleep(0.8)
        if restored:
            try:
                live = tv_account()
                if live and live.get("balance"):
                    with state.lock:
                        for a in state.accounts:
                            if a["id"] == active_id:
                                a["balance"] = float(live.get("balance", a.get("balance", 0)))
                                a["equity"] = float(live.get("equity") or live.get("balance") or a.get("equity", 0))
                                a["pnl"] = float(live.get("realized_pnl") or 0)
                                a["verified"] = True
                                break
                        state.active_account_id = active_id
                        for a in state.accounts:
                            a["active"] = (a["id"] == active_id)
                        state._save_accounts()
            except Exception:
                pass
        else:
            # Restore failed — the poll loop will re-sync the active account
            # on its next scrape. Keep the persisted active account id so the
            # UI doesn't claim a wrong account is active.
            with state.lock:
                state.active_account_id = active_id
                for a in state.accounts:
                    a["active"] = (a["id"] == active_id)
                state._save_accounts()
            print(f"[accounts] WARNING: restore to '{active_name}' failed — poll loop will re-sync", flush=True)
        with state.lock:
            return {"accounts": state.accounts, "active_id": state.active_account_id}


def tv_positions() -> list[dict]:
    """Scrape open positions from TradingView Paper Trading panel."""
    # NOTE: the MCP UI eval rejects top-level `return` statements, so the
    # whole scraper must be wrapped in an IIFE. The old code had bare
    # `return`s — every call threw SyntaxError and positions were hidden.
    js = """
    (function() {
        var table = document.querySelector('[data-name="Paper.positions-table"]');
        if (!table) return [];
        // TradingView renders position rows as tr.ka-row (no data-name attr),
        // so match on class instead of the old tr[data-name] selector which
        // matched nothing and hid all open positions.
        var rows = table.querySelectorAll('tr.ka-row, tr[class*="ka-row"]');
        function signedPnl(value) {
            var raw = String(value || '').trim();
            var negative = /^\\(.*\\)$/.test(raw) || /[−–—-]\s*\$?\s*\d/.test(raw);
            raw = raw.replace(/[()$,+\\s]/g, '').replace(/[−–—]/g, '-');
            var parsed = parseFloat(raw);
            if (!isFinite(parsed)) return 0;
            return negative ? -Math.abs(parsed) : parsed;
        }
        var positions = [];
        for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].querySelectorAll('td');
            if (cells.length >= 9) {
                var sym = cells[0].textContent.trim();
                var side = cells[1].textContent.trim();
                var qty = parseFloat(cells[2].textContent.trim()) || 0;
                var entry = parseFloat(cells[3].textContent.trim().replace(/,/g, '')) || 0;
                var tp = parseFloat(cells[4].textContent.trim().replace(/,/g, '')) || 0;
                var sl = parseFloat(cells[5].textContent.trim().replace(/,/g, '')) || 0;
                var last = parseFloat(cells[6].textContent.trim().replace(/,/g, '')) || 0;
                /* TradingView renders this as e.g. −275.00USD; preserve the sign. */
                var pnl = signedPnl(cells[7].textContent);
                positions.push({
                    symbol: sym,
                    type: side === 'Long' ? 0 : 1,
                    volume: qty,
                    price_open: entry,
                    tp: tp,
                    sl: sl,
                    price_current: last,
                    profit: pnl
                });
            }
        }
        return positions;
    })()
    """
    result = tv_ui_eval(js)
    if result and result.get("success"):
        val = result.get("result")
        # The MCP CLI may return the result already-parsed (list/dict) or
        # as a JSON string — handle both. (json.loads on a list raises
        # TypeError, which previously silently hid all open positions.)
        if isinstance(val, str):
            try:
                return json.loads(val)
            except (json.JSONDecodeError, TypeError):
                return []
        return val if isinstance(val, list) else []
    return []


def tv_ui_eval(js_code: str, timeout: int = 15) -> Optional[dict]:
    """Run a TradingView MCP UI eval command."""
    cmd = [NODE_BIN, MCP_CLI, "ui", "eval", js_code]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        return None
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return None


def tv_health() -> dict:
    """Check TradingView connection health via MCP CLI."""
    result = tv_cli("status")
    if result and result.get("success"):
        return {
            "connected": True,
            "symbol": result.get("chart_symbol", ""),
            "resolution": result.get("chart_resolution", ""),
            "api_available": result.get("api_available", False),
        }
    return {"connected": False}


def tv_set_symbol(symbol: str) -> bool:
    """Set the active chart symbol and verify TradingView accepted it.

    Prefer the already-connected CDP page: spawning the CLI's symbol command
    can take 10+ seconds while it waits for chart rendering, which used to
    block the sidecar poll loop and leave the account/scanner state empty.
    The CLI remains a fallback for pages where the TradingView object is not
    exposed.
    """
    tv_sym = SYMBOL_MAP.get(symbol, symbol)
    target = str(tv_sym).replace("!", "").upper()
    target_root = target.split(":")[-1]
    try:
        js = (
            "(function(){"
            "var c=window.TradingViewApi&&TradingViewApi._activeChartWidgetWV&&TradingViewApi._activeChartWidgetWV.value();"
            "if(!c||!c.setSymbol)return {ok:false};"
            "try{c.setSymbol('" + tv_sym + "',{});return {ok:true};}catch(e){return {ok:false};}"
            "})()"
        )
        page = tv_ui_eval(js, timeout=8)
        if page and page.get("success"):
            for _ in range(10):
                state = tv_cli("state", timeout=4) or {}
                current = str(state.get("symbol", "")).replace("!", "").upper()
                if current == target or current.endswith(target_root):
                    return True
                time.sleep(0.2)
    except Exception:
        pass

    try:
        result = subprocess.run(
            [NODE_BIN, MCP_CLI, "symbol", tv_sym],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            return False
        payload = json.loads(result.stdout or "{}")
        if not payload.get("success"):
            return False
        for _ in range(8):
            state = tv_cli("state", timeout=8) or {}
            current = str(state.get("symbol", "")).replace("!", "").upper()
            if current == target or current.endswith(target_root):
                return True
            time.sleep(0.25)
    except Exception:
        pass
    return False


def cli_candles(symbol: str, count: int = CANDLE_COUNT,
                timeframe: str = "3") -> list[dict]:
    """Read confirmed Desktop bars at a native TradingView resolution.

    tvDatafeed's guest websocket is unavailable on some fresh installs and
    can also go stale while the desktop CDP session remains healthy. The
    fallback reads one symbol/resolution at a time, then restores the user's
    original chart symbol/timeframe before returning. It is used only by the
    throttled worker below, never by the UI chart request.
    """
    with TV_UI_LOCK:
        with _CHART_FALLBACK_LOCK:
            previous_symbol = ""
            previous_resolution = ""
            try:
                current = tv_cli("state", timeout=6) or {}
                previous_symbol = str(current.get("symbol") or current.get("chart_symbol") or "")
                previous_resolution = str(current.get("resolution") or current.get("chart_resolution") or "")
            except Exception:
                pass
            try:
                if not tv_set_symbol(symbol):
                    return []
                if not tv_set_timeframe(str(timeframe or "3")):
                    return []
                bars = tv_get_candles(count)
                return bars if isinstance(bars, list) else []
            finally:
                if previous_symbol:
                    try:
                        restored = True
                        if _chart_root(previous_symbol) != _chart_root(SYMBOL_MAP.get(symbol, symbol)):
                            restored = tv_set_symbol(previous_symbol)
                        if restored and previous_resolution:
                            tv_set_timeframe(previous_resolution)
                    except Exception:
                        pass


def tv_set_timeframe(timeframe: str) -> bool:
    """Set the chart timeframe via MCP CLI."""
    result = tv_cli("timeframe", {"timeframe": timeframe}, timeout=10)
    return result is not None and result.get("success", False)


def aggregate_candles(rows: list[dict], timeframe: str) -> list[dict]:
    """Aggregate verified 3-minute bars only where that is mathematically valid.

    Native 1m/5m/240m streams are preferred by the sidecar. A 3m cache may be
    aggregated into 15m/1H/4H/D chart context, but it must never be relabelled
    as 1m or 5m data when the native stream is unavailable.
    """
    requested = str(timeframe or "3").upper()
    if requested in {"1", "5"}:
        return []
    if requested == "3":
        return list(rows)
    target_minutes = {"15": 15, "60": 60, "240": 240, "D": 1440}.get(requested)
    if not target_minutes or not rows:
        return []
    bucket_seconds = target_minutes * 60
    groups: dict[int, list[dict]] = {}
    for row in rows:
        try:
            ts = int(row.get("time", 0))
        except (TypeError, ValueError):
            continue
        if ts <= 0:
            continue
        groups.setdefault((ts // bucket_seconds) * bucket_seconds, []).append(row)
    out: list[dict] = []
    for bucket, bars in sorted(groups.items()):
        valid = [b for b in bars if all(float(b.get(k, 0)) > 0 for k in ("open", "high", "low", "close"))]
        if not valid:
            continue
        out.append({
            "time": bucket,
            "open": float(valid[0]["open"]),
            "high": max(float(b["high"]) for b in valid),
            "low": min(float(b["low"]) for b in valid),
            "close": float(valid[-1]["close"]),
            "volume": sum(float(b.get("volume", 0) or 0) for b in valid),
        })
    return out


def tv_get_candles(count: int = 200) -> list[dict]:
    """Read enough confirmed bars for Investing Mastery 777 without exceeding CLI output limits.

    A single 1,400-row JSON response is truncated by the CDP/CLI transport at
    about 64 KB. That looked like a JSON parse failure and left every symbol
    with only the initial 300 bars. Read four smaller, offset chunks instead.
    """
    if count <= 0:
        return []
    chunk_size = min(400, count)
    history_goal = min(count, 1100)  # 55 completed 60-minute bars on 3m data
    total_available = 0

    # TradingView initially exposes about 300 bars. Page older bars until the
    # chart has enough HTF context, waiting for the asynchronous bar store to
    # grow before issuing the next CLI read.
    for attempt in range(5):
        first = tv_cli("ohlcv", {"count": str(chunk_size), "offset": "0"}, timeout=20)
        if first and first.get("success"):
            first_bars = first.get("bars") or []
            total_available = int(first.get("total_available", 0) or 0)
            if total_available >= history_goal and len(first_bars) >= min(chunk_size, history_goal):
                break
        if attempt == 4:
            break
        if not first or not first.get("success"):
            time.sleep(3.0)
            continue
        loaded = tv_ui_eval(
            "(function(){var c=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();"
            "var s=c&&c._chartWidget&&c._chartWidget.model().mainSeries();"
            "if(!s)return {ok:false};var b=s.bars();var more=true;try{more=s.requestMoreDataAvailable();}catch(e){}"
            "if(more)try{s.requestMoreData(1000);}catch(e){}return {ok:true,size:b.size(),more:more};})()"
        )
        if not loaded or not loaded.get("success"):
            break
        deadline = time.time() + 8.0
        while time.time() < deadline:
            time.sleep(0.75)
            probe = tv_ui_eval(
                "(function(){var c=window.TradingViewApi&&window.TradingViewApi._activeChartWidgetWV&&window.TradingViewApi._activeChartWidgetWV.value();"
                "var s=c&&c._chartWidget&&c._chartWidget.model().mainSeries();"
                "return {ok:!!s,size:s?s.bars().size():0};})()"
            )
            if probe and probe.get("success"):
                value = probe.get("result") or {}
                if isinstance(value, dict) and int(value.get("size", 0) or 0) >= history_goal:
                    break
        time.sleep(0.5)

    rows_by_time: dict[int, dict] = {}
    offset = 0
    while offset < count:
        requested = min(chunk_size, count - offset)
        result = None
        for _ in range(3):
            result = tv_cli("ohlcv", {"count": str(requested), "offset": str(offset)}, timeout=20)
            if result and result.get("success") and result.get("bars"):
                break
            time.sleep(2.0)
        if not result or not result.get("success"):
            break
        bars = result.get("bars") or []
        total_available = max(total_available, int(result.get("total_available", 0) or 0))
        for bar in bars:
            try:
                rows_by_time[int(bar.get("time", 0))] = bar
            except (TypeError, ValueError):
                continue
        if len(bars) < requested or (total_available and offset + len(bars) >= total_available):
            break
        offset += requested

    return [rows_by_time[key] for key in sorted(rows_by_time)][-count:]


def tv_quote() -> Optional[dict]:
    """Get current price quote for the active chart via MCP CLI."""
    result = tv_cli("quote", timeout=10)
    if result and result.get("success"):
        return {
            "bid": result.get("close", 0),
            "ask": result.get("close", 0),
            "last": result.get("last", 0),
            "open": result.get("open", 0),
            "high": result.get("high", 0),
            "low": result.get("low", 0),
            "volume": result.get("volume", 0),
            "time": result.get("time", 0),
            "description": result.get("description", ""),
            "exchange": result.get("exchange", ""),
        }
    return None


def tv_list_alerts() -> list[dict]:
    """List active alerts via MCP CLI."""
    result = tv_cli("alert", {"action": "list"}, timeout=10)
    if result and result.get("success"):
        return result.get("alerts", [])
    return []


def tv_create_alert(symbol: str, condition: str, price: float, note: str = "") -> Optional[dict]:
    """Create a price alert via MCP CLI."""
    tv_sym = SYMBOL_MAP.get(symbol, symbol)
    result = tv_cli("alert", {"action": "create", "symbol": tv_sym, "condition": condition, "price": str(price)}, timeout=10)
    return result


def tv_delete_alert(alert_id: str) -> bool:
    """Delete an alert via MCP CLI."""
    result = tv_cli("alert", {"action": "delete", "id": alert_id}, timeout=10)
    return result is not None and result.get("success", False)


# ── Daily P&L journal (persisted) ────────────────────────────────────
JOURNAL_FILE = os.path.join(
    os.environ.get(
        "DWELLA_RUNTIME_DIR",
        os.path.join(os.path.expanduser("~"), "Documents", "Dwella", "trading"),
    ),
    "daily_journal.json",
)


def _load_journal() -> dict:
    """Load persisted daily P&L records."""
    try:
        with open(JOURNAL_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"days": {}}


def _save_journal(journal: dict) -> None:
    try:
        with open(JOURNAL_FILE, "w") as f:
            json.dump(journal, f, indent=2)
    except Exception:
        pass


class DailyJournal:
    """Persist verified daily account snapshots and aggregate real activity."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        stored = _load_journal()
        self.days: dict[str, dict] = stored.get("days", {}) if isinstance(stored, dict) else {}
        self._day_start_pnl: Optional[float] = stored.get("start_realized") if isinstance(stored, dict) else None
        self._day_key: str = str(stored.get("start_date", "")) if isinstance(stored, dict) else ""
        self._scanner_event_keys: set[str] = set(stored.get("scanner_event_keys", [])) if isinstance(stored, dict) else set()
        self.current: Optional[dict] = None
        # Preserve only real persisted snapshots; no generated/fake dates.
        if self.days:
            self.current = dict(self.days.get(max(self.days), {})) or None

    def _scanner_day_start(self, today: str) -> Optional[float]:
        try:
            base = os.environ.get("DWELLA_RUNTIME_DIR", os.path.join(os.path.expanduser("~"), "Documents", "Dwella", "trading"))
            with open(os.path.join(base, "scanner_daily.json"), "r") as f:
                data = json.load(f)
            if data.get("date") == today and data.get("start_realized") is not None:
                return float(data["start_realized"])
        except Exception:
            pass
        return None

    def record(self, account: dict) -> None:
        """Update the actual account snapshot for the current UTC trading day."""
        if not account or account.get("balance") is None:
            return
        with self.lock:
            pnl = account.get("realized_pnl", account.get("profit"))
            if pnl is None:
                return
            pnl = float(pnl)
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            start = self._scanner_day_start(today)
            if start is None:
                if today != self._day_key or self._day_start_pnl is None:
                    self._day_key, self._day_start_pnl = today, pnl
                start = self._day_start_pnl
            # A lifetime realized-P&L snapshot cannot prove today's result.
            # Leave the daily value unknown until TradingView exposes a
            # verified closed-trade/account-history event; never manufacture
            # a zero or derive it from a fragile startup baseline.
            previous = self.days.get(today, {})
            verified_pnl = previous.get("verified_pnl")
            day_pnl = float(verified_pnl) if verified_pnl is not None else None
            day = {
                "date": today,
                "account": account.get("name", ""),
                "balance": round(float(account.get("balance") or 0), 2),
                "equity": round(float(account.get("equity") or account.get("balance") or 0), 2),
                "realized_pnl": round(pnl, 2),
                "unrealized_pnl": round(float(account.get("unrealized_pnl") or 0), 2),
                "pnl": round(day_pnl, 2) if day_pnl is not None else None,
                "today_pnl": round(day_pnl, 2) if day_pnl is not None else None,
                "day_start_realized": round(float(start), 2) if start is not None else None,
                "trades": int(previous.get("trades", 0) or 0),
                "verified_pnl": verified_pnl,
                "lifetime_realized_pnl": round(pnl, 2),
                "daily_pnl_verified": verified_pnl is not None,
                "daily_pnl_source": "verified TradingView history" if verified_pnl is not None else "unavailable until verified closed-trade data is visible",
                "history_available": verified_pnl is not None or int(previous.get("trades", 0) or 0) > 0,
                "updated": datetime.now(timezone.utc).isoformat(),
            }
            self.days[today] = day
            self.current = dict(day)
            _save_journal({"days": self.days, "start_realized": self._day_start_pnl, "start_date": self._day_key, "scanner_event_keys": sorted(self._scanner_event_keys), "initialized": True})

    def update_activity(self, trades: list[dict]) -> None:
        """Attach only verified completed orders to their actual calendar days."""
        with self.lock:
            counts: dict[str, int] = {}
            pnl_by_date: dict[str, float] = {}
            for trade in trades:
                date = trade.get("date") or _history_date(trade.get("time"))
                if not date:
                    continue
                if trade.get("table") in {"account-history", "trading-journal"} and trade.get("completed") and trade.get("pnl") is not None:
                    value = float(trade["pnl"])
                    pnl_by_date[date] = round(pnl_by_date.get(date, 0.0) + value, 2)
                    counts[date] = counts.get(date, 0) + 1
            for date in set(counts) | set(pnl_by_date):
                count = counts.get(date, 0)
                day = self.days.get(date)
                if day is None:
                    # A date is created only because TradingView supplied an
                    # actual completed order. P&L remains unknown (null), not
                    # zero, until a verified account snapshot provides it.
                    day = {"date": date, "pnl": None, "today_pnl": None, "trades": 0, "account": "", "updated": ""}
                    self.days[date] = day
                if date in counts:
                    # TradingView's closed history and Dwella's confirmed
                    # execution log can describe the same trade. Never let a
                    # later partial view reduce an already-confirmed count.
                    day["trades"] = max(int(day.get("trades", 0) or 0), count)
                if date in pnl_by_date:
                    day["pnl"] = pnl_by_date[date]
                    day["today_pnl"] = pnl_by_date[date]
                    day["verified_pnl"] = pnl_by_date[date]
                day["updated"] = datetime.now(timezone.utc).isoformat()
            if counts or pnl_by_date:
                _save_journal({"days": self.days, "start_realized": self._day_start_pnl, "start_date": self._day_key, "scanner_event_keys": sorted(self._scanner_event_keys), "initialized": True})

    def update_scanner_activity(self, scanner_snapshot: Optional[dict]) -> None:
        """Record only confirmed scanner entries in the real Journal.

        The scanner writes an execution event only after TradingView confirms
        the position. This supplements TradingView's history table when that
        table is empty, while leaving P&L unknown until a verified close or
        account-history event supplies it.
        """
        if not isinstance(scanner_snapshot, dict):
            return
        events = scanner_snapshot.get("confirmed_entries") or []
        if not isinstance(events, list):
            return
        with self.lock:
            changed = False
            entries_by_date: dict[str, list[dict]] = {}
            for event in events:
                if not isinstance(event, dict):
                    continue
                action = str(event.get("action") or "ENTRY").upper()
                order_id = str(event.get("order_id") or "")
                if action != "ENTRY" or not order_id:
                    continue
                event_key = f"scanner:{order_id}"
                if event_key in self._scanner_event_keys:
                    continue
                date = _history_date(event.get("time"))
                if not date:
                    continue
                self._scanner_event_keys.add(event_key)
                entries_by_date.setdefault(date, []).append(event)
            for date, entries in entries_by_date.items():
                day = self.days.get(date)
                if day is None:
                    day = {"date": date, "pnl": None, "today_pnl": None, "trades": 0, "account": entries[0].get("account_id", ""), "updated": ""}
                    self.days[date] = day
                # A verified TradingView close may correspond to the same
                # scanner entry. Use the larger confirmed count rather than
                # adding both sources and double-counting the trade.
                day["trades"] = max(int(day.get("trades", 0) or 0), len(entries))
                account_id = next((e.get("account_id") for e in entries if e.get("account_id")), "")
                if account_id:
                    day["account"] = account_id
                day["updated"] = datetime.now(timezone.utc).isoformat()
                changed = True
            if changed:
                _save_journal({"days": self.days, "start_realized": self._day_start_pnl, "start_date": self._day_key, "scanner_event_keys": sorted(self._scanner_event_keys), "initialized": True})

    def list(self) -> dict:
        with self.lock:
            all_days = [dict(self.days[k]) for k in sorted(self.days)]
            # A live account snapshot alone is not a traded day. Calendar
            # history contains only a verified P&L event or a completed order;
            # lifetime realized P&L is still exposed in `today` below.
            days = [
                d for d in all_days
                if d.get("verified_pnl") is not None
                or float(d.get("pnl") or 0) != 0
                or int(d.get("trades", 0) or 0) > 0
            ]
            active = [d for d in days if float(d.get("pnl") or 0) != 0 or int(d.get("trades", 0) or 0) > 0]
            total = round(sum(float(d.get("pnl") or 0) for d in days), 2)
            return {"days": days, "summary": {
                "win_days": sum(1 for d in active if float(d.get("pnl") or 0) > 0),
                "loss_days": sum(1 for d in active if float(d.get("pnl") or 0) < 0),
                "traded_days": sum(1 for d in days if int(d.get("trades", 0) or 0) > 0),
                "trade_count": sum(int(d.get("trades", 0) or 0) for d in days),
                "total_pnl": total,
                "today": self.current,
                "history_verified": any(d.get("verified_pnl") is not None for d in days),
                "source": "TradingView account snapshot, verified history, and confirmed Dwella execution log",
            }}


# ── Data state (thread-safe cache) ───────────────────────────────────
class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.connected = False
        self.error: Optional[str] = None
        self.last_update: Optional[str] = None
        self.ticks: dict[str, dict] = {}
        self.candles: dict[str, list[dict]] = {}
        self.candles_by_timeframe: dict[str, dict[str, list[dict]]] = {}
        self.candle_sources: dict[str, dict[str, str]] = {}
        self.account: dict = {}
        self.accounts: list[dict] = []  # All broker accounts
        self.active_account_id: str = ""  # Persisted account Dwella is allowed to trade
        self.selected_account_ids: list[str] = []  # Explicitly saved trade targets
        self.cross_trading: bool = False
        self.actual_account_name: str = ""  # Observed TradingView account; never changes selection
        self.actual_account_id: str = ""
        # Last account TradingView was verified to be on, plus how long ago.
        # Used as a short grace fallback so a transient observation failure
        # does not disarm a connected AutoTrader.
        self.last_good_account_id: str = ""
        self.last_good_time: float = 0.0
        self.observe_failures: int = 0  # consecutive failed account observations
        self.account_observed_at: float = 0.0
        self.account_stale: bool = True
        self.positions: list[dict] = []
        self.trade_history: list[dict] = []
        self._known_symbols: set = set()  # tracks which symbols had positions
        self.alerts: list[dict] = []
        self._load_accounts()  # Load persisted accounts
        self._load_history()
        for s in SYMBOL_MAP:
            self.ticks[s] = {}
            self.candles[s] = []
            self.candles_by_timeframe[s] = {}
            self.candle_sources[s] = {}

    def _accounts_file(self) -> str:
        return os.path.join(
            os.environ.get(
                "DWELLA_RUNTIME_DIR",
                os.path.join(os.path.expanduser("~"), "Documents", "Dwella", "trading"),
            ),
            "accounts.json",
        )

    def _load_accounts(self) -> None:
        """Load persisted accounts from disk."""
        try:
            with open(self._accounts_file(), "r") as f:
                data = json.load(f)
                self.accounts = data.get("accounts", [])
                self.active_account_id = data.get("active_id", "")
                self.selected_account_ids = list(data.get("selected_ids") or ([self.active_account_id] if self.active_account_id else []))
                self.cross_trading = bool(data.get("cross_trading", False))
                # Persisted account rows are targets/labels only. Never
                # restore an old balance as if it were live TradingView data.
                # The next verified DOM scrape repopulates these fields.
                for account in self.accounts:
                    account["balance"] = 0.0
                    account["equity"] = 0.0
                    account["pnl"] = 0.0
                    account["connected"] = False
                    account["verified"] = False
                    account["observed"] = False
                self.actual_account_id = ""
        except (FileNotFoundError, json.JSONDecodeError):
            self.accounts = []
            self.active_account_id = ""
            self.selected_account_ids = []
            self.cross_trading = False
            self.actual_account_id = ""

    def _history_file(self) -> str:
        return os.path.join(
            os.environ.get(
                "DWELLA_RUNTIME_DIR",
                os.path.join(os.path.expanduser("~"), "Documents", "Dwella", "trading"),
            ),
            "trade_history.json",
        )

    def _load_history(self) -> None:
        try:
            with open(self._history_file(), "r") as f:
                self.trade_history = json.load(f).get("trades", [])
        except (FileNotFoundError, json.JSONDecodeError):
            self.trade_history = []

    def _save_history(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._history_file()), exist_ok=True)
            with open(self._history_file(), "w") as f:
                json.dump({"trades": self.trade_history[-200:]}, f, indent=1)
        except Exception:
            pass

    def track_positions(self, positions: list[dict]) -> None:
        """Detect new entries and exits by comparing position sets.
        Records trades to history with entry/exit timestamps and P&L.
        """
        import time as _time
        current = {}
        for p in positions:
            sym = p.get("symbol", "")
            side = "LONG" if p.get("type", 0) == 0 else "SHORT"
            key = f"{sym}:{side}"
            current[key] = p

        now = _time.strftime("%Y-%m-%d %H:%M")

        # Detect new entries
        for key, p in current.items():
            if key not in self._known_symbols:
                self.trade_history.append({
                    "time": now,
                    "symbol": p.get("symbol", ""),
                    "side": "LONG" if p.get("type", 0) == 0 else "SHORT",
                    "qty": p.get("volume", 1),
                    "entry": p.get("price_open", 0),
                    "price": p.get("price_current", 0),
                    "pnl": p.get("profit", 0),
                    "action": "OPEN",
                })
                self._known_symbols.add(key)

        # Detect exits
        for key in list(self._known_symbols):
            if key not in current:
                # Position was closed — record the exit
                # Find the last OPEN record for this key
                for rec in reversed(self.trade_history):
                    if rec.get("action") == "OPEN" and f"{rec.get('symbol','')}:{rec.get('side','')}" == key:
                        rec["exit_time"] = now
                        rec["action"] = "CLOSED"
                        break
                self._known_symbols.discard(key)

        self._save_history()

    def _save_accounts(self) -> None:
        """Persist accounts to disk."""
        try:
            os.makedirs(os.path.dirname(self._accounts_file()), exist_ok=True)
            with open(self._accounts_file(), "w") as f:
                json.dump({
                    "accounts": self.accounts,
                    "active_id": self.active_account_id,
                    "selected_ids": self.selected_account_ids,
                    "cross_trading": self.cross_trading,
                }, f, indent=2)
        except Exception:
            pass

    def add_account(self, name: str, broker: str, account_id: str, account_type: str = "Live") -> dict:
        """Add a new broker account."""
        acct = {
            "id": account_id,
            "name": name,
            "broker": broker,
            "type": account_type,
            "balance": 0,
            "equity": 0,
            "pnl": 0,
            "active": False,
            "connected": False,
            "currency": "USD",
            "leverage": 1,
            "verified": False
        }
        with self.lock:
            # Check for duplicate
            for existing in self.accounts:
                if existing["id"] == account_id:
                    return {"error": "Account already exists"}
            self.accounts.append(acct)
            if not self.active_account_id:
                self.active_account_id = account_id
                acct["active"] = True
            self._save_accounts()
        return acct

    def remove_account(self, account_id: str) -> bool:
        """Remove a broker account."""
        with self.lock:
            before = len(self.accounts)
            self.accounts = [a for a in self.accounts if a["id"] != account_id]
            if self.active_account_id == account_id and self.accounts:
                self.active_account_id = self.accounts[0]["id"]
                self.accounts[0]["active"] = True
            self._save_accounts()
            return len(self.accounts) < before

    def switch_account(self, account_id: str) -> bool:
        """Switch the active trading account."""
        with self.lock:
            found = False
            for a in self.accounts:
                if a["id"] == account_id:
                    a["active"] = True
                    self.active_account_id = account_id
                    found = True
                else:
                    a["active"] = False
            if found:
                self._save_accounts()
            return found

    def update_account_balance(self, account_id: str, balance: float, equity: float, pnl: float) -> None:
        """Update account balance from broker data."""
        with self.lock:
            for a in self.accounts:
                if a["id"] == account_id:
                    a["balance"] = balance
                    a["equity"] = equity
                    a["pnl"] = pnl
                    a["connected"] = True
                    a["verified"] = True
                    break
            self._save_accounts()

    def snapshot(self) -> dict:
        with self.lock:
            candle_ages = {
                s: {
                    tf: candle_age_seconds(rows, tf)
                    for tf, rows in frames.items()
                }
                for s, frames in self.candles_by_timeframe.items()
            }
            stale_symbols = [
                s for s in SYMBOL_MAP
                if candles_are_stale(self.candles.get(s, []), "3")
            ]
            return {
                "connected": self.connected,
                "symbols": list(SYMBOL_MAP),
                "last_update": self.last_update,
                "error": self.error,
                "ticks": json.loads(json.dumps(self.ticks, default=str)),
                "candle_counts": {s: len(c) for s, c in self.candles.items()},
                "candle_counts_by_timeframe": {
                    s: {tf: len(rows) for tf, rows in frames.items()}
                    for s, frames in self.candles_by_timeframe.items()
                },
                "candle_ages_by_timeframe": candle_ages,
                "candle_sources": json.loads(json.dumps(self.candle_sources, default=str)),
                "market_data_fresh": not stale_symbols,
                "market_data_stale_symbols": stale_symbols,
                "account": self.account,
                "accounts": self.accounts,
                "active_account_id": self.active_account_id,
                "selected_account_ids": list(self.selected_account_ids),
                "cross_trading": self.cross_trading,
                "actual_account_name": self.actual_account_name,
                "actual_account_id": self.actual_account_id,
                "account_fresh": bool(self.account and not self.account_stale and
                                       time.time() - self.account_observed_at <= ACCOUNT_SNAPSHOT_GRACE),
                "account_source": "Dwella embedded TradingView session" if self.account else None,
                "positions": json.loads(json.dumps(self.positions, default=str)),
                "alerts": json.loads(json.dumps(self.alerts, default=str)),
            }


# ── Alert manager ─────────────────────────────────────────────────────
class AlertManager:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.alerts: list[dict] = []
        self._next_id = 1

    def add(self, symbol: str, condition: str, price: float, note: str = "") -> dict:
        with self.lock:
            alert = {
                "id": self._next_id,
                "symbol": symbol,
                "condition": condition,
                "price": price,
                "note": note,
                "triggered": False,
                "created": datetime.now(timezone.utc).isoformat(),
            }
            self._next_id += 1
            self.alerts.append(alert)
            return alert

    def remove(self, alert_id: int) -> bool:
        with self.lock:
            for i, a in enumerate(self.alerts):
                if a["id"] == alert_id:
                    self.alerts.pop(i)
                    return True
            return False

    def check(self, symbol: str, current_price: float) -> list[dict]:
        triggered = []
        with self.lock:
            for alert in self.alerts:
                if alert["symbol"] != symbol or alert["triggered"]:
                    continue
                cond = alert["condition"]
                target = alert["price"]
                if cond == "crossing_above" and current_price >= target:
                    alert["triggered"] = True
                    triggered.append(alert.copy())
                elif cond == "crossing_below" and current_price <= target:
                    alert["triggered"] = True
                    triggered.append(alert.copy())
                elif cond == "greater_than" and current_price > target:
                    alert["triggered"] = True
                    triggered.append(alert.copy())
                elif cond == "less_than" and current_price <= target:
                    alert["triggered"] = True
                    triggered.append(alert.copy())
        return triggered

    def list_all(self) -> list[dict]:
        with self.lock:
            return [a.copy() for a in self.alerts]


# ── TradingView keepalive watchdog ──────────────────────────────────
# The pinned build is embedded inside Dwella's own bundle and is always
# preferred: it is the exact tested version with updates blocked. The per-user
# components copy and system installs are fallbacks only (dev runs, or a
# previously-installed pinned copy from an older build).
TV_APP_CANDIDATES = [
    _EMBEDDED_TV_APP,
    _USER_TV_APP,
    "/Applications/Trading and Finance/TradingView.app",
    "/Applications/TradingView.app",
    os.path.expanduser("~/Applications/TradingView.app"),
]
TV_APP_PATH = next((p for p in TV_APP_CANDIDATES if os.path.isdir(p)), TV_APP_CANDIDATES[0])


def tv_app_path() -> str:
    """Resolve the TradingView app path at call time.

    The embedded pinned copy inside Dwella's bundle is preferred; the per-user
    copy and system installs are fallbacks. The static TV_APP_PATH computed at
    import would go stale (the setup flow may install a copy at runtime), so
    every launch/restart re-resolves the candidates.
    """
    for p in TV_APP_CANDIDATES:
        if p and os.path.isdir(p):
            return p
    return next((p for p in TV_APP_CANDIDATES if p), TV_APP_CANDIDATES[0])


TV_APP_BUNDLE_ID = "com.tradingview.tradingviewapp.desktop"
TV_LAUNCH_ARGS = ["--remote-debugging-port=9222", "--remote-allow-origins=*"]

# tv_health() spawns a node subprocess (~1-3s); the splash screen polls
# /tv/status every 1.5s, so cache it briefly to avoid process storms.
_TV_HEALTH_CACHE = {"ts": 0.0, "val": None}
# Last known-GOOD health state: a single failed node call right after a
# healthy one used to flip the UI to OFFLINE for a poll cycle (flapping).
# We keep reporting the last good state for 20s after a failure instead.
_TV_LAST_GOOD = {"ts": 0.0, "val": None}
_TV_HEALTH_LOCK = threading.Lock()


def _cached_tv_health(max_age: float = 5.0) -> dict:
    # Serialize cache evaluation: /tv/status is polled from the UI threads
    # AND poll_loop calls this — without the lock, concurrent cache misses
    # each spawn a node process, defeating the coalescing goal.
    with _TV_HEALTH_LOCK:
        now = time.time()
        cached = _TV_HEALTH_CACHE
        if cached["val"] is not None and now - cached["ts"] < max_age:
            return cached["val"]
        try:
            val = tv_health()
        except Exception:
            val = {"connected": False}
        good = bool(val.get("connected"))
        last = _TV_LAST_GOOD
        if good:
            _TV_LAST_GOOD["ts"] = now
            _TV_LAST_GOOD["val"] = val
        elif last["val"] is not None and now - last["ts"] < 20:
            # Transient failure right after a healthy check — hold the last
            # good state (marked stale) instead of flapping the UI.
            val = dict(last["val"])
            val["stale"] = True
        cached["ts"] = now
        cached["val"] = val
        return val


def _cdp_reachable(timeout: float = 2.0) -> bool:
    """True when Dwella's CDP endpoint (port 9222) is answering.

    Dwella hosts the built-in TradingView webview and exposes its own CDP on
    9222 — there is no separate TradingView Desktop app anymore. Account
    detection, positions and orders all run against that webview target.
    """
    try:
        import socket
        _s = socket.create_connection(("127.0.0.1", 9222), timeout=timeout)
        _s.close()
        return True
    except Exception:
        return False


def _tv_webview_present() -> bool:
    """True when the in-app TradingView webview target exists in Dwella's CDP."""
    try:
        import urllib.request
        _req = urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=3)
        _targets = json.loads(_req.read().decode("utf-8"))
        return any(
            (t.get("type") in ("page", "webview")) and "tradingview.com" in str(t.get("url", ""))
            for t in _targets
        )
    except Exception:
        return False


def _tv_process_running() -> bool:
    try:
        _r = subprocess.run(["pgrep", "-f", "TradingView"], capture_output=True, text=True, timeout=3)
        return _r.returncode == 0 and bool(_r.stdout.strip())
    except Exception:
        return False


def restart_tradingview_with_cdp() -> dict:
    """Verify the built-in TradingView webview is alive in Dwella's window.

    TradingView lives inside Dwella (a webview guest); there is no Desktop
    app to launch or restart. This just confirms Dwella's CDP is up and the
    tradingview.com webview target is present.
    """
    try:
        if _cdp_reachable():
            if _tv_webview_present():
                return {"ok": True, "already_running": True,
                        "message": "TradingView is running inside Dwella"}
            return {"ok": True, "already_running": True,
                    "message": "Dwella CDP is up; TradingView webview still loading"}
        return {"ok": False, "error": "Dwella CDP is not reachable — is the app running?"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def launch_tradingview() -> dict:
    """Ensure the built-in TradingView webview is present (nothing to launch)."""
    try:
        if tv_health().get("connected"):
            return {"ok": True, "already_running": True}
    except Exception:
        pass
    if _cdp_reachable():
        return {"ok": True, "already_running": True,
                "message": "TradingView is built into Dwella — no separate app"}
    return {"ok": False, "error": "Dwella CDP is not reachable — is the app running?"}


# ── Pinned TradingView install + update blocking ──────────────────────
# TradingView Desktop checks its auto-updater (Squirrel/electron-updater)
# against app-update.yml at every launch. A newer build can change the DOM
# and break Dwella's CDP automation, so the pinned copy is pointed at a dead
# local URL and its updater cache is made read-only. The pinned build we
# bundle is the exact one this sidecar's selectors were tested against.
TV_OFFICIAL_DMG_URL = "https://tvd-packages.tradingview.com/stable/latest/darwin/TradingView.dmg"
TV_DEAD_UPDATE_URL = "http://127.0.0.1:1/tv-updates/"
TV_UPDATER_CACHE_DIRS = [
    os.path.expanduser("~/Library/Caches/tradingview-desktop-updater"),
    os.path.expanduser("~/Library/Application Support/tradingview-desktop-updater"),
]


def patch_tv_updates(app_path: str | None = None) -> dict:
    """Pin a TradingView install: dead update URL + read-only updater cache.

    Returns {"ok": True} when the patch is applied. Best-effort: never raises.
    """
    app_path = app_path or _USER_TV_APP
    if not os.path.isdir(app_path):
        return {"ok": False, "applied": False, "error": "TradingView not installed"}
    yml = os.path.join(app_path, "Contents", "Resources", "app-update.yml")
    try:
        with open(yml, "w", encoding="utf-8") as f:
            f.write(
                "provider: generic\n"
                "url: '%s'\n"
                "channel: stable\n"
                "updaterCacheDirName: tradingview-desktop-updater\n" % TV_DEAD_UPDATE_URL
            )
        # Read-only so the app cannot rewrite its own update feed back.
        os.chmod(yml, 0o444)
    except Exception as exc:
        return {"ok": False, "applied": False, "error": f"could not patch {yml}: {exc}"}
    # Rewriting a sealed resource invalidates the app's code signature, which
    # macOS treats as "damaged" for quarantined apps. This copy is local and
    # unquarantined, so re-seal it ad-hoc: the pinned build stays launchable
    # and the broken-seal warning is avoided entirely. When the patched copy
    # is the one embedded inside Dwella's own bundle, the parent bundle's
    # outer seal must also be refreshed (it seals the nested app's hash).
    try:
        subprocess.run(["codesign", "--force", "--deep", "-s", "-", app_path],
                       capture_output=True, timeout=120)
        if _EMBEDDED_TV_APP and os.path.realpath(app_path) == os.path.realpath(_EMBEDDED_TV_APP):
            parent = os.path.dirname(os.path.dirname(_EMBEDDED_TV_APP))  # …/Dwella.app
            if os.path.isfile(os.path.join(parent, "Contents", "Info.plist")):
                subprocess.run(["codesign", "--force", "--deep", "-s", "-", parent],
                               capture_output=True, timeout=180)
    except Exception:
        pass
    # Block the updater caches so even a manual update check cannot download.
    lock_tv_updater_cache()
    return {"ok": True, "applied": True}


def lock_tv_updater_cache() -> None:
    """Make the updater caches read-only so no download can ever land.

    Runs on every component check regardless of the feed state — the dead
    URL stops the check, and this stops the write even if the feed ever
    points somewhere real again. Best-effort: never raises.
    """
    for d in TV_UPDATER_CACHE_DIRS:
        try:
            if not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            subprocess.run(["chmod", "-R", "a-w", d], capture_output=True, timeout=20)
        except Exception:
            pass


def tv_updates_blocked(app_path: str | None = None) -> bool:
    """True when the pinned TradingView's update feed points at the dead URL."""
    app_path = app_path or _USER_TV_APP
    if not os.path.isdir(app_path):
        return False
    yml = os.path.join(app_path, "Contents", "Resources", "app-update.yml")
    try:
        with open(yml, "r", encoding="utf-8") as f:
            return TV_DEAD_UPDATE_URL in f.read()
    except Exception:
        return False


def ensure_tradingview() -> dict:
    """Ensure the pinned TradingView is present and update-blocked.

    TradingView is built into Dwella's own bundle (Contents/Resources/
    TradingView.app), so no separate install is normally needed. This first
    verifies the embedded copy (re-applying the update block + seal if a
    repair is ever needed), then the per-user components copy (legacy/dev),
    and only falls back to downloading the official DMG for source-tree dev
    runs where no embedded bundle exists.
    """
    for app in (_EMBEDDED_TV_APP, _USER_TV_APP):
        if app and os.path.isdir(app) and os.path.isfile(
                os.path.join(app, "Contents", "MacOS", "TradingView")):
            patch_tv_updates(app)
            return {"ok": True, "path": app,
                    "source": "embedded in Dwella" if app == _EMBEDDED_TV_APP else "components",
                    "updates_blocked": tv_updates_blocked(app)}
    return install_tradingview()


def install_tradingview() -> dict:
    """Fallback install of TradingView Desktop into the writable components dir.

    Only used when the embedded bundle is absent (source-tree dev runs):
    download the official DMG, mount it, copy the app out, strip quarantine
    (Gatekeeper) and apply the update-block patch.
    """
    try:
        if os.path.isdir(_USER_TV_APP):
            patch_tv_updates(_USER_TV_APP)
            return {"ok": True, "already_installed": True,
                    "message": "Pinned TradingView already installed",
                    "updates_blocked": tv_updates_blocked(_USER_TV_APP)}
        os.makedirs(_COMPONENTS_DIR, exist_ok=True)
        installed = False
        # Fallback: official TradingView DMG (dev runs without the bundle).
        dmg = "/tmp/dwella_tv_install.dmg"
        mnt = "/tmp/dwella_tv_mount"
        subprocess.run(["curl", "-sL", "-o", dmg, TV_OFFICIAL_DMG_URL],
                       capture_output=True, timeout=900)
        os.makedirs(mnt, exist_ok=True)
        subprocess.run(["hdiutil", "attach", dmg, "-nobrowse", "-mountpoint", mnt],
                       capture_output=True, timeout=120)
        src = os.path.join(mnt, "TradingView.app")
        if os.path.isdir(src):
            import shutil as _shutil
            if os.path.isdir(_USER_TV_APP):
                _shutil.rmtree(_USER_TV_APP)
            _shutil.copytree(src, _USER_TV_APP, symlinks=True)
            installed = True
            source = "official download"
        subprocess.run(["hdiutil", "detach", mnt], capture_output=True, timeout=60)
        if not installed:
            return {"ok": False, "error": "TradingView install failed — app bundle not produced"}
        # Gatekeeper: the copy may inherit quarantine from the DMG/zip.
        subprocess.run(["xattr", "-dr", "com.apple.quarantine", _USER_TV_APP],
                       capture_output=True, timeout=60)
        exe = os.path.join(_USER_TV_APP, "Contents", "MacOS", "TradingView")
        if not os.path.isfile(exe):
            return {"ok": False, "error": "TradingView install incomplete — binary missing"}
        patch_tv_updates(_USER_TV_APP)
        return {"ok": True, "source": source,
                "message": f"TradingView installed from {source} — updates blocked",
                "updates_blocked": tv_updates_blocked(_USER_TV_APP)}
    except Exception as exc:
        return {"ok": False, "error": f"TradingView install error: {exc}"}


def hide_tradingview() -> dict:
    """Best-effort hide for TradingView while keeping its process and session alive.

    Dwella calls this after startup and after the login handshake. macOS may
    require one-time Automation permission for the Python/Terminal host.
    """
    attempts = [
        # System Events controls the actual process window reliably on macOS.
        'tell application "System Events" to set visible of process "TradingView" to false',
    ]
    for script in attempts:
        try:
            r = subprocess.run(
                ["osascript", "-e", script], capture_output=True, text=True, timeout=5
            )
            if r.returncode == 0:
                return {"ok": True, "hidden": True}
        except Exception:
            continue
    return {"ok": False, "hidden": False,
            "error": "Could not hide TradingView — macOS may need Automation permission in System Settings > Privacy & Security"}

def tv_keepalive_loop() -> None:
    """Monitor the built-in TradingView webview inside Dwella.

    TradingView is a webview guest in Dwella's own window — there is no
    separate app to keep alive. Every 20s this verifies Dwella's CDP and the
    tradingview.com webview target are present and logs if they are not.
    """
    # Self-heal any legacy pinned build (harmless no-op when absent) and keep
    # the updater cache locked regardless of the feed state.
    try:
        for _cand in (_EMBEDDED_TV_APP, _USER_TV_APP):
            if _cand and os.path.isdir(_cand) and not tv_updates_blocked(_cand):
                patch_tv_updates(_cand)
        lock_tv_updater_cache()
    except Exception:
        pass
    last_log = 0.0
    while True:
        try:
            cli_ok = bool(tv_health().get("connected"))
            if not cli_ok:
                now = time.time()
                if now - last_log > 60:
                    last_log = now
                    if not _cdp_reachable():
                        print("[keepalive] Dwella CDP (9222) not reachable — app restarting?", flush=True)
                    elif not _tv_webview_present():
                        print("[keepalive] TradingView webview target not found in Dwella — open the TradingView section", flush=True)
        except Exception:
            pass
        time.sleep(20)


# ── Background candle fallback worker ─────────────────────────────────
def _commit_candles(state: State, alerts: AlertManager, symbol: str,
                    candles: list[dict], timeframe: str = "3",
                    source: str = "unknown") -> None:
    if not candles:
        return
    tf = _normalize_timeframe(timeframe)
    last_bar = candles[-1]
    try:
        incoming_time = int(last_bar.get("time", 0) or 0)
    except (TypeError, ValueError):
        incoming_time = 0
    with state.lock:
        existing = state.candles_by_timeframe.setdefault(symbol, {}).get(tf, [])
        try:
            existing_time = int(existing[-1].get("time", 0) or 0) if existing else 0
        except (TypeError, ValueError):
            existing_time = 0
        # A recovery source must never roll a live series backward. It may
        # update the same forming bar, or replace it with a newer bar, but an
        # older Desktop response cannot make the visible price jump backward.
        if existing_time and incoming_time and incoming_time < existing_time:
            return
        state.candles_by_timeframe.setdefault(symbol, {})[tf] = candles
        state.candle_sources.setdefault(symbol, {})[tf] = source
        if tf != "3":
            return
        state.candles[symbol] = candles
        state.ticks[symbol] = {
            "bid": last_bar.get("close", 0),
            "ask": last_bar.get("close", 0),
            "last": last_bar.get("close", 0),
            "open": last_bar.get("open", 0),
            "high": last_bar.get("high", 0),
            "low": last_bar.get("low", 0),
            "volume": last_bar.get("volume", 0),
            "time": last_bar.get("time", 0),
        }
    if last_bar.get("close"):
        alerts.check(symbol, last_bar["close"])


def _fallback_symbols(state: State) -> list[str]:
    """Return symbols whose 3m stream is absent or visibly stale."""
    with state.lock:
        return [
            symbol for symbol in CANDLE_SYMBOLS
            if candles_are_stale(state.candles.get(symbol, []), "3")
            and time.time() >= _DESKTOP_FALLBACK_NEXT.get(symbol, 0.0)
        ]


def candle_fallback_loop(state: State, alerts: AlertManager, poll_sec: float) -> None:
    """Backfill verified Desktop bars when guest tvDatafeed is unavailable.

    A clean friend install may not be able to use tvDatafeed's anonymous
    websocket even though TradingView Desktop/CDP is healthy. In that case
    scan one market per pass through the MCP direct-bars API. The helper
    restores the user's chart after each read and shares the UI lock with
    order placement, so it cannot leave the chart on a scanner symbol or
    race an entry.
    """
    index = 0
    while True:
        time.sleep(max(2.0, poll_sec))
        try:
            stale_symbols = _fallback_symbols(state)
            if not stale_symbols:
                continue
            health = _cached_tv_health()
            if not health.get("connected") or not CANDLE_SYMBOLS:
                continue
            symbol = stale_symbols[index % len(stale_symbols)]
            index += 1
            _DESKTOP_FALLBACK_NEXT[symbol] = time.time() + 15.0
            candles = cli_candles(symbol, FALLBACK_TRIGGER_COUNT, "3")
            if candles:
                # Commit the trigger stream before the slower context reads so
                # the visible price recovers immediately, even if one higher
                # timeframe request is slow or unavailable.
                _commit_candles(state, alerts, symbol, candles, "3", "desktop")
                # Keep the playlist engine usable when the guest websocket is
                # unavailable: the Desktop fallback must populate the same
                # native 1m/5m/15m/1H/4H/D ladder as tvDatafeed does.
                for context_tf in (tf for tf in CANDLE_TIMEFRAMES if tf != "3"):
                    context_rows = cli_candles(symbol, HIGHER_CANDLE_COUNT, context_tf)
                    if context_rows:
                        _commit_candles(state, alerts, symbol, context_rows, context_tf, "desktop")
        except Exception as exc:
            with state.lock:
                state.error = f"Desktop bars fallback: {type(exc).__name__}: {exc}"


# ── Background poll loop ─────────────────────────────────────────────
def poll_loop(state: State, alerts: AlertManager, journal: DailyJournal, poll_sec: float) -> None:
    """
    Fetch candles & quotes every poll_sec.

    Strategy: use tvdatafeed (WebSocket) for market data — it is fast and
    does NOT switch the TradingView chart, so the scanner's order execution
    never fights the data feed. The MCP CLI is reserved for account info,
    open positions, and alerts (which require the DOM).
    """
    while True:
        try:
            # ── Connection status ──
            # tvdatafeed works independently of TradingView Desktop;
            # if it's available and connected, we are LIVE. Use the cached
            # health (shared with /tv/status) so the node status call is
            # coalesced instead of spawned here AND on every UI poll.
            tvd_connected = tvd_connect()
            # A constructed guest client is not necessarily usable: tvDatafeed
            # can keep returning empty/stale frames after its websocket drops.
            # Only use it as the primary source while it has returned data
            # recently; otherwise go straight to the verified Desktop bars
            # fallback instead of blocking the poll loop on dead get_hist calls.
            tvd_ok = tvd_connected and tvd_healthy()
            cli_ok = bool(_cached_tv_health().get("connected"))
            # A connected client still needs its first successful fetch to
            # become healthy. Keep the cold-start path alive long enough to
            # make that fetch instead of waiting for a health flag that only
            # the fetch itself can produce.
            connected = tvd_connected or cli_ok
            if cli_ok:
                # Desktop is the authoritative source for orders and the
                # fallback bars. Account/position reads must continue even
                # when guest tvDatafeed is down.
                pass

            with state.lock:
                state.connected = connected
                state.error = None
            # A health failure must not leave the last account balance looking
            # current forever. A short grace prevents refresh flicker; after
            # that window expire_stale_account clears the trade gate.
            expire_stale_account(state)

            if not connected:
                with state.lock:
                    state.error = "TradingView not running — start TV with --remote-debugging-port=9222 --remote-allow-origins=*"
                time.sleep(poll_sec)
                continue

            _poll_now = time.time()

            # ── Step 1: Candles for primary symbols ──
            # tvDatafeed is fast when healthy. When its guest websocket is
            # stale, use TradingView Desktop's direct-bars API instead of
            # repeatedly calling a dead websocket. The fallback returns only
            # confirmed bars and never fabricates prices.
            # Only probe the guest websocket when it is available. Desktop
            # account/position polling must continue independently, but it
            # should not keep hammering a stale guest feed.
            # A constructed anonymous client is not proof that its websocket
            # is returning bars. Only call get_hist while it has produced
            # recent data; otherwise the direct Desktop-bars worker is the
            # authoritative source and avoids blocking the scanner on a dead
            # guest socket.
            if tvd_connected:
                for short in CANDLE_SYMBOLS:
                    try:
                        # Gate the fetch on the socket being UP (tvd_connected)
                        # rather than on tvd_healthy (data seen recently): on a
                        # cold start no data has flowed yet, so tvd_healthy is
                        # False and the first successful fetch would never
                        # happen — leaving every symbol at 0 candles forever.
                        # A dead socket returns [] quickly and the empty-track
                        # / reconnect-cooldown below still protect the poll.
                        candles = tvd_candles(short, CANDLE_COUNT, "3") if tvd_connected else []
                        last_time = int(candles[-1].get("time", 0) or 0) if candles else 0
                        stale = candles_are_stale(candles, "3")
                        if not candles or stale:
                            # A non-empty but frozen websocket response is
                            # still a failed market-data read. Keep the last
                            # verified bars visible, but let the independent
                            # Desktop worker repair this symbol instead of
                            # repeatedly committing an old price as live.
                            continue
                        _commit_candles(state, alerts, short, candles, "3", "tvdatafeed")
                        # Populate the complete Investing Mastery 777 context ladder from
                        # native TradingView resolutions. These reads are
                        # cached and do not change the visible chart.
                        for context_tf in (tf for tf in CANDLE_TIMEFRAMES if tf != "3"):
                            context_rows = tvd_candles(short, HIGHER_CANDLE_COUNT, context_tf)
                            if context_rows:
                                _commit_candles(state, alerts, short, context_rows, context_tf, "tvdatafeed")
                    except Exception as exc:
                        with state.lock:
                            state.error = f"{short} candles: {type(exc).__name__}: {exc}"

                # Ticks for watchlist symbols (1m candle -> tick)
                for short in TICK_ONLY_SYMBOLS:
                    try:
                        one = tvd_candles(short, 1)
                        if one:
                            last_bar = one[-1]
                            with state.lock:
                                state.ticks[short] = {
                                    "bid": last_bar.get("close", 0),
                                    "ask": last_bar.get("close", 0),
                                    "last": last_bar.get("close", 0),
                                    "open": last_bar.get("open", 0),
                                    "high": last_bar.get("high", 0),
                                    "low": last_bar.get("low", 0),
                                    "volume": last_bar.get("volume", 0),
                                    "time": last_bar.get("time", 0),
                                }
                    except Exception:
                        pass
            else:
                # tvdatafeed unavailable — keep last known data; the
                # keepalive thread will relaunch TV if needed.
                pass

            # ── Step 2: Account info from Paper Trading panel (CDP/DOM) ──
            # Throttled to every 6s: the account balance/PnL updates slowly,
            # and each scrape spawns a node subprocess.
            _throttle = _POLL_THROTTLE
            if cli_ok and _poll_now - _throttle.get("account", 0) >= 6.0:
                _throttle["account"] = _poll_now
                try:
                    # Hold the account lock for the whole read-commit cycle:
                    # refresh_accounts flips TradingView between accounts to
                    # read each balance — a scrape in that window reads the
                    # wrong panel AND can move state.active_account_id to an
                    # account TradingView is only momentarily on (which would
                    # make the scanner trade the wrong account).
                    with _ACCOUNT_LOCK:
                        acct = tv_account()
                        if acct and acct.get("balance"):
                            with state.lock:
                                state.account = acct
                                state.account_observed_at = time.time()
                                state.account_stale = False
                                state.actual_account_name = str(acct.get("name") or "")
                                # Live-update the account that TradingView is
                                # actually using (matched by name first, then by
                                # the active id) so money shown is real, not stale.
                                acct_name = acct.get("name", "")
                                updated = False
                                for a in state.accounts:
                                    if acct_name and a.get("name", "").lower() == acct_name.lower():
                                        a["balance"] = float(acct.get("balance", a.get("balance", 0)))
                                        a["equity"] = float(acct.get("equity") or acct.get("balance") or a.get("equity", a.get("balance", 0)))
                                        a["pnl"] = float(acct.get("realized_pnl") or 0)
                                        a["connected"] = True
                                        a["verified"] = True
                                        state.actual_account_id = a["id"]
                                        a["observed"] = True
                                        updated = True
                                        break
                                if not updated and acct_name:
                                    # The account can be visible in TradingView
                                    # before the next full account discovery.
                                    # Add it as an observed account without
                                    # changing the saved trading target.
                                    observed_id = acct_name.lower().replace(" ", "_").replace("#", "")
                                    observed = next((a for a in state.accounts if a.get("id") == observed_id), None)
                                    if observed is None:
                                        observed = {
                                            "id": observed_id,
                                            "name": acct_name,
                                            "broker": "TradingView",
                                            "type": "Paper" if "paper" in acct_name.lower() else "Live",
                                            "balance": 0.0,
                                            "equity": 0.0,
                                            "pnl": 0.0,
                                            "active": False,
                                            "connected": True,
                                            "currency": acct.get("currency", "USD"),
                                            "leverage": 1,
                                            "verified": False,
                                        }
                                        state.accounts.append(observed)
                                    observed["name"] = acct_name
                                    observed["balance"] = float(acct.get("balance", 0))
                                    observed["equity"] = float(acct.get("equity") or acct.get("balance") or 0)
                                    observed["pnl"] = float(acct.get("realized_pnl") or 0)
                                    observed["connected"] = True
                                    observed["verified"] = True
                                    observed["observed"] = True
                                    state.actual_account_id = observed_id
                                # `active` is the user's persisted trading
                                # target, not a transient DOM observation.
                                for a in state.accounts:
                                    a["active"] = (a["id"] == state.active_account_id)
                                state._save_accounts()
                            # Compute account_ready OUTSIDE the state lock to
                            # avoid deadlock (account_ready acquires state.lock).
                            if scanner := getattr(state, "scanner", None):
                                arm_scanner(scanner, account_ready_for_trading(state))
                            # Record the account TradingView is ACTUALLY
                            # showing — in single-account mode the logged-in
                            # account IS the trading account (the saved target
                            # may differ). Only in cross-trading mode do we
                            # require the visible account to match the target.
                            _journal_ok = bool(state.actual_account_id) and (
                                not state.cross_trading
                                or state.actual_account_id == state.active_account_id
                            )
                            if _journal_ok:
                                try:
                                    journal.record(acct)
                                except Exception:
                                    pass
                        # Auto-discover ALL accounts from TradingView's account
                        # manager (slow MCP call — do it OUTSIDE the state lock)
                        # and merge names/brokers/active state into the store.
                        # Throttled to 30s — it is the single slowest call here.
                        if _poll_now - _throttle.get("sync_accounts", 0) >= 30.0:
                            _throttle["sync_accounts"] = _poll_now
                            try:
                                # Deep discovery makes every account visible in
                                # Accounts without changing the saved target.
                                sync_tv_accounts(state, deep=True)
                            except Exception:
                                pass
                        # In normal single-account mode, the account already
                        # visible in TradingView is the user's trading account.
                        # Repair stale selections from older builds without
                        # clicking or switching the account manager.
                        adopt_visible_account(state)
                        # Auto-disarm hysteresis: the scanner stays armed for a
                        # grace window after the last verified account and only
                        # disarms after sustained observation failure with the
                        # grace expired (TradingView genuinely gone). A single
                        # CDP blip or TradingView reload must never leave the
                        # AutoTrader off.
                        ready, disarm_now = account_ready_state(state)
                        if scanner := getattr(state, "scanner", None):
                            if disarm_now:
                                arm_scanner(scanner, False)
                            elif ready:
                                arm_scanner(scanner, True)

                except Exception:
                    # expire_stale_account() at the top of the next poll owns
                    # the timeout; do not replace a good value during a brief
                    # scrape failure.
                    pass

                # ── Step 3: Open positions (throttled to 4s) ──
                if _poll_now - _throttle.get("positions", 0) >= 4.0:
                    _throttle["positions"] = _poll_now
                    try:
                        positions = tv_positions()
                        if positions is not None:
                            with state.lock:
                                state.positions = positions
                            # Pull verified account/order history and attach
                            # real trade counts to persisted Journal days.
                            try:
                                journal.update_activity(_tv_history_tables())
                                scanner = getattr(state, "scanner", None)
                                if scanner is not None:
                                    journal.update_scanner_activity(scanner.snapshot())
                            except Exception:
                                pass
                    except Exception:
                        pass

                # ── Step 4: Alerts (throttled to 9s) ──
                if _poll_now - _throttle.get("alerts", 0) >= 9.0:
                    _throttle["alerts"] = _poll_now
                    try:
                        tv_alerts = tv_list_alerts()
                        with state.lock:
                            state.alerts = tv_alerts if tv_alerts else state.alerts
                    except Exception:
                        pass

            with state.lock:
                state.last_update = datetime.now(timezone.utc).isoformat()

        except Exception as exc:
            with state.lock:
                state.error = f"poll: {type(exc).__name__}: {exc}"

        time.sleep(poll_sec)


# ── Auto-switch monitor ───────────────────────────────────────────────
def auto_switch_loop(state: State, check_sec: float = 8.0) -> None:
    """
    Watch the scanner: when a configured daily position limit is reached,
    automatically switch to the next account so trading can continue on a
    fresh budget. With the active limit set to zero (unlimited), this monitor
    remains inactive.

    Requires:
      - server.scanner is a ScannerState
      - state.accounts has at least 2 entries
      - AUTO_SWITCH_ENABLED
    """
    last_switched_at = 0.0
    while True:
        try:
            if not AUTO_SWITCH_ENABLED:
                time.sleep(check_sec)
                continue
            scanner = getattr(state, "scanner", None)
            if not scanner:
                time.sleep(check_sec)
                continue
            with scanner.lock:
                taken = scanner.daily_positions_taken
                limit = DAILY_POSITION_LIMIT
                armed = scanner.armed
                last_scan = scanner.last_scan or ""
            hit_limit = limit > 0 and (taken >= limit) and "Daily position limit reached" in last_scan
            if not (armed and hit_limit):
                time.sleep(check_sec)
                continue

            now = time.time()
            if now - last_switched_at < 30:
                time.sleep(check_sec)
                continue

            # Find the active account and pick the next one in rotation
            with state.lock:
                accounts = list(state.accounts)
                active_id = state.active_account_id
            if len(accounts) < 2:
                time.sleep(check_sec)
                continue
            idx = next((i for i, a in enumerate(accounts) if a.get("id") == active_id), 0)
            nxt = accounts[(idx + 1) % len(accounts)]
            if nxt.get("id") == active_id:
                time.sleep(check_sec)
                continue

            res = switch_active_account(state, nxt["id"])
            if res.get("ok") and res.get("tv_switched"):
                # Fresh budget for the new account
                reset_daily_positions(scanner)
                last_switched_at = now
                print(
                    f"[auto-switch] Daily limit hit on {active_id} → switched to {nxt.get('id')} "
                    f"({nxt.get('name')}). Budget reset to 0/3.",
                    flush=True,
                )
            else:
                # Cooldown even on failure so we don't hammer the DOM every
                # check while the account stays unusable.
                last_switched_at = now
                print(f"[auto-switch] could not rotate to {nxt.get('id')}: {res.get('error')}", flush=True)
        except Exception as exc:
            print(f"[auto-switch] error: {exc}", flush=True)
        time.sleep(check_sec)


# ── HTTP handler ──────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def handle_error(self, *a) -> None:
        # Clients (UI polls) routinely disconnect mid-response; a BrokenPipe
        # is not an error worth a full traceback in the log.
        try:
            import sys
            exc = sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
                return
        except Exception:
            pass
        super().handle_error(*a)

    def log_message(self, *a) -> None:
        pass

    def _send(self, code: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # A polling client may close the socket after its timeout. The
            # response was not a trading failure and should not flood logs.
            return

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        state: State = self.server.state
        alerts: AlertManager = self.server.alerts
        path = self.path.split("?")[0]
        params = {}
        if "?" in self.path:
            for pair in self.path.split("?")[1].split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    params[k.upper()] = v

        if path == "/status":
            self._send(200, state.snapshot()); return

        if path == "/tv/status":
            tv = _cached_tv_health()
            expire_stale_account(state)
            with state.lock:
                account = dict(state.account or {})
                account_fresh = bool(account and not state.account_stale and
                                     time.time() - state.account_observed_at <= ACCOUNT_SNAPSHOT_GRACE)
                stale_market_symbols = [
                    symbol for symbol in CANDLE_SYMBOLS
                    if candles_are_stale(state.candles.get(symbol, []), "3")
                ]
            self._send(200, {
                "tv": tv,
                "connected": bool(tv.get("connected")),
                "account": account if account_fresh else {},
                "account_connected": bool(account_fresh),
                "account_fresh": account_fresh,
                "account_source": "Dwella embedded TradingView session" if account_fresh else None,
                "market_data_fresh": not stale_market_symbols,
                "market_data_stale_symbols": stale_market_symbols,
            }); return

        if path == "/tv/check":
            import os.path, socket
            # TradingView is BUILT INTO Dwella's own window (a webview guest)
            # — there is no separate app to install or update. "Installed"
            # means Dwella's CDP is up and the tradingview.com webview target
            # is present. Self-heal any legacy pinned copy (harmless no-op
            # when absent) and keep the updater cache locked.
            tv_managed = _cdp_reachable() and _tv_webview_present()
            try:
                for _cand in (_EMBEDDED_TV_APP, _USER_TV_APP):
                    if _cand and os.path.isdir(_cand) and not tv_updates_blocked(_cand):
                        patch_tv_updates(_cand)
                lock_tv_updater_cache()
            except Exception:
                pass
            tv_installed = tv_managed
            # Check if TradingView process is running
            tv_process_running = False
            try:
                _r = subprocess.run(["pgrep", "-f", "TradingView"], capture_output=True, text=True, timeout=3)
                tv_process_running = _r.returncode == 0 and bool(_r.stdout.strip())
            except Exception:
                pass
            # Check if CDP port 9222 is reachable
            cdp_ok = False
            try:
                _s = socket.create_connection(("127.0.0.1", 9222), timeout=2)
                _s.close()
                cdp_ok = True
            except Exception:
                pass
            # Check if Node.js runtime works
            node_ok = False
            try:
                _r = subprocess.run([NODE_BIN, "--version"], capture_output=True, text=True, timeout=5)
                node_ok = _r.returncode == 0
            except Exception:
                pass
            # Check if MCP CLI can run
            mcp_ok = False
            try:
                _r = subprocess.run([NODE_BIN, MCP_CLI, "--help"], capture_output=True, text=True, timeout=10)
                mcp_ok = _r.returncode == 0 or ("TradingView" in (_r.stdout + _r.stderr))
            except Exception:
                pass
            # Installation checks are deliberately separate from runtime
            # connectivity. These three paths are the durable components that
            # must exist on the device; CDP/process state can change while the
            # app is running and must not make setup reappear.
            node_installed = os.path.isfile(NODE_BIN) and os.access(NODE_BIN, os.X_OK)
            mcp_installed = os.path.isfile(MCP_CLI)
            # Setup requires the built-in TradingView webview (there is no
            # system app to fall back to). Updates can't break a web app, so
            # the "updates blocked" flag is always true for the built-in view.
            durable_ready = bool(tv_managed and node_installed and mcp_installed)
            self._send(200, {
                "tv_installed": tv_installed,
                "tv_managed_installed": tv_managed,
                "tv_updates_blocked": True,
                "tv_process_running": tv_process_running,
                "cdp_ok": cdp_ok,
                "node_ok": node_ok,
                "node_installed": node_installed,
                "mcp_ok": mcp_ok,
                "mcp_installed": mcp_installed,
                "durable_ready": durable_ready,
                "connected": cdp_ok,
                "tv_path": tv_app_path(),
                "node_path": NODE_BIN,
                "mcp_path": MCP_CLI,
            }); return

        if path == "/health":
            self._send(200, {"tv": tv_health(), "symbols": list(SYMBOL_MAP)}); return

        if path == "/tick":
            sym = params.get("SYMBOL", "NQ").upper()
            with state.lock:
                payload = state.ticks.get(sym, {})
            self._send(200, {"symbol": sym, "tick": payload}); return

        if path == "/candles":
            sym = params.get("SYMBOL", "NQ").upper()
            raw_tf = params.get("TIMEFRAME", "3")
            requested_tf = _normalize_timeframe(raw_tf)
            count = max(1, min(int(params.get("COUNT", CANDLE_COUNT)), CANDLE_COUNT))
            with state.lock:
                base_rows = list(state.candles.get(sym, []))
                native_rows = list(state.candles_by_timeframe.get(sym, {}).get(requested_tf, []))
                source = state.candle_sources.get(sym, {}).get(requested_tf, "")
            # Prefer native TradingView resolutions for the Investing Mastery
            # ladder. Only higher frames that can be mathematically aggregated
            # from verified 3m bars may use the cache fallback; 1m/5m are
            # returned empty instead of being mislabeled.
            rows = native_rows or aggregate_candles(base_rows, requested_tf)
            rows = rows[-count:]
            source_tf = requested_tf if native_rows else ("3" if rows and requested_tf != "3" else requested_tf)
            age = candle_age_seconds(rows, requested_tf)
            fresh = bool(rows) and not candles_are_stale(rows, requested_tf)
            self._send(200, {
                "symbol": sym,
                "timeframe": requested_tf,
                "source_timeframe": source_tf,
                "source": source or ("aggregate" if rows and not native_rows else None),
                "fresh": fresh,
                "age_seconds": round(age, 1) if age is not None else None,
                "last_bar_time": rows[-1].get("time") if rows else None,
                "candles": rows,
            }); return

        if path == "/tape":
            sym = params.get("SYMBOL", "NQ").upper()
            with state.lock:
                rows = state.candles.get(sym, [])[-200:]
            tape = []
            for r in rows:
                bull = r.get("close", 0) >= r.get("open", 0)
                tape.append({
                    "time": r.get("time", 0), "bid": r.get("close", 0), "ask": r.get("close", 0),
                    "last": r.get("close", 0), "volume": r.get("volume", 0),
                    "buy": bull, "sell": not bull,
                })
            self._send(200, {"symbol": sym, "tape": tape}); return

        if path == "/book":
            sym = params.get("SYMBOL", "NQ").upper()
            self._send(200, {"symbol": sym, "book": {"bids": [], "asks": []}}); return

        if path == "/account":
            expire_stale_account(state)
            with state.lock:
                payload = dict(state.account or {})
                fresh = bool(payload and not state.account_stale and
                             time.time() - state.account_observed_at <= ACCOUNT_SNAPSHOT_GRACE)
            self._send(200, {
                "account": payload if fresh else {},
                "connected": fresh,
                "fresh": fresh,
                "source": "Dwella embedded TradingView session" if fresh else None,
            }); return

        if path == "/accounts":
            with state.lock:
                payload = {
                    "accounts": state.accounts,
                    "active_id": state.active_account_id,
                    "selected_ids": list(state.selected_account_ids),
                    "cross_trading": state.cross_trading,
                    "actual_account_name": state.actual_account_name,
                    "actual_account_id": state.actual_account_id,
                    "auto_switch": False,
                }
            self._send(200, payload); return

        if path == "/positions":
            with state.lock:
                payload = state.positions
            self._send(200, {"positions": payload}); return

        if path == "/history":
            # Only verified TradingView rows are exposed; local synthetic
            # position snapshots are intentionally excluded.
            trades = tv_history()
            self._send(200, {"trades": trades, "count": len(trades), "source": "TradingView"}); return

        if path == "/journal":
            journal: DailyJournal = getattr(self.server, 'journal', None)
            if journal:
                self._send(200, journal.list()); return
            self._send(200, {"days": [], "summary": {}}); return

        if path == "/alerts":
            with state.lock:
                payload = state.alerts
            self._send(200, {"alerts": payload}); return

        # ── Scanner endpoints ──
        if path == "/scanner":
            scanner: Optional[ScannerState] = getattr(self.server, 'scanner', None)
            if not scanner:
                self._send(200, {"available": False, "error": "scanner module not loaded"}); return
            with state.lock:
                selected = list(state.selected_account_ids)
                active_id = state.active_account_id
                actual_id = state.actual_account_id
            account_ready = account_ready_for_trading(state)
            snapshot = scanner.snapshot()
            snapshot.update({
                "account_id": active_id,
                "selected_account_ids": selected,
                "actual_account_id": actual_id,
                "account_ready": account_ready,
                "disarm_reason": None if account_ready else "Select and save the connected TradingView account",
            })
            self._send(200, {"available": True, **snapshot}); return

        if path == "/scanner/health":
            self._send(200, {"scanner": SCANNER_AVAILABLE}); return

        self._send(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        alerts: AlertManager = self.server.alerts
        path = self.path.split("?")[0]
        if path == "/alerts":
            params = {}
            if "?" in self.path:
                for pair in self.path.split("?")[1].split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        params[k.upper()] = v
            alert_id = int(params.get("ID", 0))
            if not alert_id:
                self._send(400, {"ok": False, "error": "id required"}); return
            ok = alerts.remove(alert_id)
            self._send(200, {"ok": ok}); return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        state: State = self.server.state
        alerts: AlertManager = self.server.alerts
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}

        if path == "/alerts":
            symbol = body.get("symbol", "NQ")
            condition = body.get("condition", "crossing_above")
            price = float(body.get("price", 0))
            note = body.get("note", "")
            if not price:
                self._send(400, {"ok": False, "error": "price required"}); return
            alert = alerts.add(symbol, condition, price, note)
            self._send(200, {"ok": True, "alert": alert}); return

        # ── Scanner control ──
        scanner: Optional[ScannerState] = getattr(self.server, 'scanner', None)

        if path == "/scanner/arm" and scanner:
            with state.lock:
                ready = account_ready_for_trading(state)
            if not ready:
                arm_scanner(scanner, False)
                self._send(409, {"ok": False, "armed": False, "error": "Connected account is not selected and saved"}); return
            arm_scanner(scanner, True)
            self._send(200, {"ok": True, "armed": True}); return

        if path == "/scanner/disarm" and scanner:
            arm_scanner(scanner, False)
            self._send(200, {"ok": True, "armed": False}); return

        if path == "/scanner/reset" and scanner:
            reset_daily_pnl(scanner)
            self._send(200, {"ok": True}); return

        # ── Account management ──
        if path == "/accounts/add":
            result = state.add_account(
                name=body.get("name", "New Account"),
                broker=body.get("broker", "TradingView"),
                account_id=body.get("id", f"acct_{int(time.time())}"),
                account_type=body.get("type", "Live")
            )
            self._send(200, result); return

        if path == "/accounts/remove":
            if "id" in body:
                ok = state.remove_account(body["id"])
                self._send(200, {"ok": ok})
            else:
                self._send(400, {"error": "Missing account id"})
            return

        if path == "/accounts/switch":
            if "id" in body:
                result = switch_active_account(
                    state,
                    body["id"],
                    persist_target=not bool(body.get("temporary")),
                )
                if result.get("ok") and scanner:
                    ready = account_ready_for_trading(state)
                    arm_scanner(scanner, ready)
                self._send(200, result)
            else:
                self._send(400, {"error": "Missing account id"})
            return

        if path == "/accounts/save":
            ids = body.get("selected_ids")
            if not isinstance(ids, list):
                self._send(400, {"ok": False, "error": "selected_ids must be a list"}); return
            with state.lock:
                known = {a.get("id") for a in state.accounts}
                selected = [str(x) for x in ids if str(x) in known]
                if not selected:
                    self._send(400, {"ok": False, "error": "Select at least one account"}); return
                active_id = str(body.get("active_id") or selected[0])
                if active_id not in selected:
                    self._send(400, {"ok": False, "error": "Active account must be selected"}); return
                state.selected_account_ids = selected
                state.cross_trading = bool(body.get("cross_trading", False))
                # Save the user's desired target without touching TradingView.
                # The actual account switch happens only via an explicit
                # /accounts/switch request. The current visible account must
                # be the selected active target before AutoTrader can arm.
                state.active_account_id = active_id
                for a in state.accounts:
                    a["active"] = a.get("id") == active_id
                state._save_accounts()
                account_ready = account_ready_for_trading(state)
                payload = {
                    "ok": True,
                    "active_id": active_id,
                    "selected_ids": selected,
                    "cross_trading": state.cross_trading,
                    "account_ready": account_ready,
                    "armed": account_ready,
                }
            if scanner:
                arm_scanner(scanner, account_ready)
            self._send(200, payload); return

        if path == "/accounts/save-current":
            # Save whatever account TradingView is currently showing.
            # This is the simplest way for the user to tell Dwella
            # "trade THIS account".
            with state.lock:
                actual = state.actual_account_id
                if not actual:
                    self._send(400, {"ok": False, "error": "No TradingView account detected"}); return
                found = next((a for a in state.accounts if a.get("id") == actual), None)
                if not found:
                    self._send(400, {"ok": False, "error": f"Account {actual} not found"}); return
                # Save as the sole selected + active account
                state.selected_account_ids = [actual]
                state.active_account_id = actual
                for a in state.accounts:
                    a["active"] = a.get("id") == actual
                state._save_accounts()
                account_ready = True
            if scanner:
                arm_scanner(scanner, True)
            self._send(200, {
                "ok": True,
                "active_id": actual,
                "selected_ids": [actual],
                "account_ready": True,
                "armed": True,
                "message": f"Now trading on {found.get('name', actual)}",
            }); return

        if path == "/accounts/refresh":
            self._send(200, refresh_accounts(state)); return

        # ── TradingView app control (splash connect flow) ──
        if path == "/tv/install":
            # POST /tv/install — TradingView is built into Dwella's window.
            # This only verifies the webview target; nothing is downloaded or
            # installed (there is no TradingView app on the machine).
            result = {
                "ok": bool(_cdp_reachable()),
                "component": "tv",
                "message": ("TradingView is running inside Dwella" if _tv_webview_present()
                            else "Dwella CDP is up; TradingView section still loading"),
                "updates_blocked": True,
            }
            self._send(200, result); return

        if path == "/tv/launch":
            result = restart_tradingview_with_cdp()
            if result.get("ok"):
                # The caller also polls for account readiness; this immediate
                # hide keeps the TradingView window behind Dwella on relaunch.
                hide_tradingview()
            self._send(200, result); return

        if path == "/tv/hide":
            self._send(200, hide_tradingview()); return

        if path == "/tv/fix":
            import os.path, socket
            component = body.get('component', 'tv')
            result = {'ok': False, 'component': component}
            if component == 'tv' or component == 'cdp':
                # TradingView is built into Dwella's window — there is no app
                # to relaunch. CDP on 9222 is Dwella's own; report its state
                # and wait for the webview if it is still loading.
                if _cdp_reachable():
                    result['ok'] = True
                    result['message'] = ('TradingView is running inside Dwella' if _tv_webview_present()
                                         else 'Dwella CDP is up; TradingView section still loading')
                else:
                    result['message'] = 'Dwella CDP is not reachable — is the app running?'
                self._send(200, result); return
            elif component == 'node':
                try:
                    import platform, shutil, tarfile, io
                    dst = _USER_NODE if _COMPONENTS_DIR else os.path.join(os.path.dirname(NODE_BIN), 'node')
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    if _BUNDLED_NODE and os.path.isfile(_BUNDLED_NODE):
                        shutil.copy2(_BUNDLED_NODE, dst)
                        os.chmod(dst, 0o755)
                        result['ok'] = True
                        result['message'] = 'Node.js runtime installed from the bundled installer'
                    else:
                        arch = 'arm64' if platform.machine().lower() in {'arm64', 'aarch64'} else 'x64'
                        node_url = f'https://nodejs.org/dist/v20.18.0/node-v20.18.0-darwin-{arch}.tar.gz'
                        _r = subprocess.run(['curl', '-sL', node_url], capture_output=True, timeout=120)
                        if _r.returncode == 0:
                            extract_root = '/tmp/dwella_node_install'
                            with tarfile.open(fileobj=io.BytesIO(_r.stdout), mode='r:gz') as tar:
                                tar.extractall(path=extract_root)
                            src = os.path.join(extract_root, f'node-v20.18.0-darwin-{arch}', 'bin', 'node')
                            if os.path.isfile(src):
                                shutil.copy2(src, dst)
                                os.chmod(dst, 0o755)
                                result['ok'] = True
                                result['message'] = 'Node.js runtime downloaded and installed'
                            else:
                                result['message'] = 'Download complete but binary not found'
                        else:
                            result['message'] = 'Download failed'
                except Exception as e:
                    result['message'] = f'Install error: {str(e)}'
            elif component == 'mcp':
                destination = os.path.join(_COMPONENTS_DIR, 'tradingview-mcp')
                if os.path.isfile(MCP_CLI):
                    result['ok'] = True
                    result['message'] = 'Data Bridge already installed'
                elif os.path.isdir(_BUNDLED_MCP_DIR):
                    try:
                        import shutil
                        os.makedirs(destination, exist_ok=True)
                        shutil.copytree(_BUNDLED_MCP_DIR, destination, dirs_exist_ok=True)
                        result['ok'] = os.path.isfile(os.path.join(destination, 'src', 'cli', 'index.js'))
                        result['message'] = 'Data Bridge installed from the bundled installer' if result['ok'] else 'Bundled Data Bridge is incomplete'
                    except Exception as e:
                        result['message'] = f'Data Bridge install error: {str(e)}'
                else:
                    result['message'] = 'Data Bridge installer is missing from this app package'
            self._send(200, result); return

        if path == "/scanner/test" and scanner:
            # Test signal — manually fire a trade
            test_signal = body.get("signal", {})
            if test_signal:
                from scanner import Signal, execute_order, check_risk, fetch_account
                account = fetch_account()
                if not account or float(account.get("balance") or account.get("equity") or 0) <= 0:
                    self._send(409, {"ok": False, "error": "Fresh TradingView account data is required before any order"}); return
                with scanner.lock:
                    scanner._sync_daily(account.get("realized_pnl"))
                allowed, reason = check_risk(scanner, account.get("balance", 0))
                if not allowed:
                    self._send(409, {"ok": False, "error": reason}); return
                sig = Signal(
                    strategy=test_signal.get("strategy", "MANUAL"),
                    symbol=test_signal.get("symbol", "NQ"),
                    direction=test_signal.get("direction", "long"),
                    entry=test_signal.get("entry", 0),
                    stop=test_signal.get("stop", 0),
                    target=test_signal.get("target", 0),
                    atr=test_signal.get("atr", 0),
                    area=test_signal.get("area", "Manual"),
                )
                # Manual/test orders are also one unit; they must not bypass
                # the scanner's no-pyramiding sizing policy.
                order_id = execute_order(sig, qty=1)
                self._send(200, {"ok": bool(order_id), "order_id": order_id, "qty": 1}); return
            self._send(400, {"ok": False, "error": "signal required"}); return

        self._send(404, {"error": "not found"})


# ── Main ──────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=18814)
    parser.add_argument("--poll", type=float, default=POLL_SECONDS)
    args = parser.parse_args(argv)

    state = State()
    alerts = AlertManager()
    journal = DailyJournal()

    # Do not commandeer TradingView's visible chart at startup. The scanner
    # receives independent websocket candles; the user's selected symbol and
    # timeframe remain untouched until an order is actually executed.

    # ── Startup: detect the visible TradingView account ──
    # NEVER overwrite the user's saved account choice.  Just set the
    # actual_account_id so the scanner knows what TV is showing.
    try:
        acct = tv_account()
        if acct and acct.get("balance"):
            acct_name = acct.get("name", "")
            acct_id = acct_name.lower().replace(" ", "_").replace("#", "") if acct_name else ""
            if acct_id:
                state.actual_account_id = acct_id
                state.account_observed_at = time.time()
                state.account_stale = False
                state.account = acct
                # Update the observed account's balance/verification
                found = next((a for a in state.accounts if a.get("id") == acct_id), None)
                if found:
                    found["connected"] = True
                    found["verified"] = True
                    found["observed"] = True
                    found["balance"] = float(acct.get("balance", 0))
                    found["equity"] = float(acct.get("equity") or acct.get("balance") or 0)
                else:
                    state.accounts.append({
                        "id": acct_id, "name": acct_name,
                        "broker": "TradingView", "type": "Live",
                        "balance": float(acct.get("balance", 0)),
                        "equity": float(acct.get("equity") or acct.get("balance") or 0),
                        "pnl": float(acct.get("realized_pnl") or 0),
                        "active": False, "connected": True,
                        "currency": acct.get("currency", "USD"), "leverage": 1,
                        "verified": True, "observed": True,
                    })
                state._save_accounts()
                print(f"[startup] Detected visible account: {acct_name} ({acct_id})", flush=True)
    except Exception as exc:
        print(f"[startup] Account detection failed: {exc}", flush=True)

    poller = threading.Thread(target=poll_loop, args=(state, alerts, journal, args.poll), daemon=True)
    poller.start()
    fallbacker = threading.Thread(target=candle_fallback_loop, args=(state, alerts, args.poll), daemon=True)
    fallbacker.start()

    # Keep TradingView Desktop alive so order execution always works
    keepalive = threading.Thread(target=tv_keepalive_loop, daemon=True)
    keepalive.start()

    server = ThreadingHTTPServer((args.http_host, args.http_port), Handler)
    server.state = state
    server.alerts = alerts
    server.journal = journal

    # ── Start auto-trading scanner ──
    scanner_state = None
    if SCANNER_AVAILABLE:
        scanner_state = ScannerState()
        server.scanner = scanner_state
        state.scanner = scanner_state  # shared ref for auto-switch monitor
        print(f"Scanner available — use /scanner/arm to activate", flush=True)
    else:
        server.scanner = None
        print(f"Scanner module not found — auto-trading disabled", flush=True)

    # ── Start auto-switch monitor (multi-account rotation) ──
    if scanner_state and SCANNER_AVAILABLE:
        threading.Thread(target=auto_switch_loop, args=(state,), daemon=True).start()
        print(f"Auto-switch monitor started — daily entry limit disabled", flush=True)

    # Do not switch accounts during startup. TradingView only exposes one
    # balance at a time, and an automatic discovery refresh used to rotate
    # through every account and leave the wrong one selected. Balances for
    # other accounts are refreshed only when the user presses Refresh.
    print("Account balance refresh is manual — saved account selection is preserved", flush=True)

    def _stop(_sig, _frame):
        print("\nShutting down...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    print(f"Dwella TradingView sidecar listening on http://{args.http_host}:{args.http_port}", flush=True)
    print(f"Using TradingView MCP CLI at {MCP_CLI}", flush=True)
    print(f"Endpoints: /status /scanner /scanner/arm /scanner/disarm", flush=True)
    
    # Start scanner if available
    if scanner_state:
        start_scanner(scanner_state)
        # The poll loop arms this only after it confirms TradingView is on the
        # user's saved account. Startup must not trade an unknown account.
        arm_scanner(scanner_state, False)
        print(f"Auto-trading scanner started — waiting for saved account confirmation", flush=True)
    
    try:
        server.serve_forever()
    finally:
        if scanner_state:
            stop_scanner(scanner_state)
        os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
