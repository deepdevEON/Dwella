#!/usr/bin/env python3
"""
mt5_live_server.py — Dwella live MT5 bridge sidecar.

Connects to the Wine-hosted MT5 terminal through the ``mt5linux`` RPyC bridge
(same setup as MT5_TokyoReversal/mt5_candle_downloader.py), polls live ticks
and M5 candles for the configured symbols, and serves them over HTTP so the
Electron renderer can consume REAL market data.

Endpoints (JSON):
    GET /status                     -> { connected, terminal, symbols, last_update, error }
    GET /tick?symbol=ENQ            -> { bid, ask, last, time }
    GET /candles?symbol=ENQ&count=200 -> { symbol, timeframe, candles: [...] }

Read-only: this server never places orders, exactly like the downloader.

Run:  python3 mt5/mt5_live_server.py            (defaults: bridge 127.0.0.1:18812, http 18814)
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

# Dwella symbol -> MT5 symbol mapping (matches the broker's Market Watch)
SYMBOL_MAP = {"ENQ": "@ENQ", "MES": "@MES", "GCE": "@GCE"}
TIMEFRAME = "TIMEFRAME_M5"
POLL_SECONDS = 3.0
CANDLE_COUNT = 200


# MT5 tick flags (COPY_TICKS_ALL):
#   TICK_FLAG_BID=1, TICK_FLAG_ASK=2, TICK_FLAG_LAST=4, TICK_FLAG_VOLUME=8,
#   TICK_FLAG_BUY=16 (tick was a buy/aggressor), TICK_FLAG_SELL=32 (sell/aggressor)
TICK_FLAG_BUY = 16
TICK_FLAG_SELL = 32
TICK_FLAGS_ALL = 0x03  # COPY_TICKS_ALL
TICK_HISTORY_SECONDS = 120  # how far back we keep real tick tape
# Market depth (BookInfo.type): 1 = sell/ask, 2 = buy/bid (MT5 MqlBookInfo)
BOOK_TYPE_SELL = 1
BOOK_TYPE_BUY = 2


class State:
    """Thread-safe cache of the latest data from MT5."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.connected = False
        self.terminal: Any = None
        self.error: Optional[str] = None
        self.last_update: Optional[str] = None
        self.ticks: dict[str, dict] = {}
        self.tick_tape: dict[str, list[dict]] = {}  # real tick history (aggressor flags)
        self.book: dict[str, dict] = {}  # real L2 depth (Market Depth)
        self.candles: dict[str, list[dict]] = {}
        self.account: dict = {}
        self.positions: list[dict] = []
        for sym in SYMBOL_MAP:
            self.ticks[sym] = {}
            self.tick_tape[sym] = []
            self.book[sym] = {"bids": [], "asks": []}
            self.candles[sym] = []

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "connected": self.connected,
                "terminal": self.terminal,
                "symbols": list(SYMBOL_MAP),
                "last_update": self.last_update,
                "error": self.error,
                "ticks": json.loads(json.dumps(self.ticks, default=str)),
                "candle_counts": {s: len(c) for s, c in self.candles.items()},
                "book_counts": {s: (len(b.get("bids", [])) + len(b.get("asks", []))) for s, b in self.book.items()},
                "tape_counts": {s: len(t) for s, t in self.tick_tape.items()},
                "account": self.account,
                "positions": json.loads(json.dumps(self.positions, default=str)),
            }


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────
# Tradovate REST session — the exact auth flow recovered from Helios:
#   1) POST /auth/accesstokenrequest  (name + password + appId)
#   2) proactive refresh via /auth/renewAccessToken (Bearer)
# Tokens live in memory ONLY (never written to disk). The sidecar is
# read-only for MT5 but acts as the trader's Tradovate auth holder.
# ─────────────────────────────────────────────────────────────────────
def _tv_request(method: str, url: str, payload: Optional[dict] = None, token: Optional[str] = None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8") or "{}")
        except Exception:
            return exc.code, {"errorText": str(exc)}
    except Exception as exc:
        return 0, {"errorText": f"{type(exc).__name__}: {exc}"}


class TradovateSession:
    """Minimal Tradovate REST session with Helios-style token renewal."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.env = "DEMO"
        self.name: Optional[str] = None
        self.app_id: Optional[str] = None
        self.token: Optional[str] = None
        self.md_token: Optional[str] = None
        self.account_id: Optional[int] = None
        self.expires_at: float = 0.0
        self.last_error: Optional[str] = None

    def base_url(self) -> str:
        return "https://demo.tradovateapi.com/v1" if self.env == "DEMO" else "https://live.tradovateapi.com/v1"

    def login(self, name: str, password: str, app_id: str, app_version: str = "1.0", env: str = "DEMO") -> bool:
        with self.lock:
            self.env = env.upper()
            self.name = name
            self.app_id = app_id
        code, data = _tv_request(
            "POST",
            f"{self.base_url()}/auth/accesstokenrequest",
            {"name": name, "password": password, "appId": app_id, "appVersion": app_version},
        )
        token = data.get("accessToken") if isinstance(data, dict) else None
        if code != 200 or not token:
            err = data.get("errorText") or data.get("errorCode") or f"HTTP {code}" if isinstance(data, dict) else f"HTTP {code}"
            with self.lock:
                self.last_error = str(err)
                self.token = None
                self.name = None  # don't leak the attempted username on failure
                self.app_id = None
            return False
        with self.lock:
            self.token = token
            self.md_token = data.get("mdAccessToken", "") or ""
            expire_ms = data.get("expireTime")
            self.expires_at = (time.time() + float(expire_ms) / 1000.0) if expire_ms else (time.time() + 3600)
            self.last_error = None
        # Resolve account id (best-effort)
        code, accs = _tv_request("GET", f"{self.base_url()}/account/find", token=token)
        with self.lock:
            if isinstance(accs, list) and accs:
                self.account_id = accs[0].get("id")
            elif isinstance(accs, dict):
                items = accs.get("items") or []
                self.account_id = items[0].get("id") if items else None
            else:
                self.account_id = None
        return True

    def renew(self) -> bool:
        """Proactive token renewal (same endpoint Helios uses)."""
        with self.lock:
            token = self.token
            if not token:
                return False
        code, data = _tv_request("GET", f"{self.base_url()}/auth/renewAccessToken", token=token)
        new_token = data.get("accessToken") if isinstance(data, dict) else None
        if code == 200 and new_token:
            with self.lock:
                self.token = new_token
                expire_ms = data.get("expireTime")
                self.expires_at = (time.time() + float(expire_ms) / 1000.0) if expire_ms else (time.time() + 3600)
            return True
        return False

    def status(self) -> dict:
        with self.lock:
            logged_in = bool(self.token)
            # auto-renew if about to expire (< 2 min left)
            expires_in = max(0.0, self.expires_at - time.time()) if self.expires_at else 0.0
        if logged_in and self.expires_at and expires_in < 120:
            self.renew()
        with self.lock:
            expires_in = max(0.0, self.expires_at - time.time()) if self.expires_at else 0.0
            return {
                "loggedIn": bool(self.token),
                "env": self.env,
                "name": self.name,
                "accountId": self.account_id,
                "expiresInSec": int(expires_in) if self.token else None,
                "error": self.last_error,
            }

    def set_tokens(self, access_token: str, md_token: str = "", env: str = "DEMO") -> bool:
        """Accept pre-harvested tokens from the webview (Helios pattern).
        The webview's preload script intercepts XHR/fetch responses from
        trader.tradovate.com and forwards the accessToken + mdAccessToken
        here. No credentials needed — the browser handled the auth.
        """
        if not access_token:
            return False
        with self.lock:
            self.env = env.upper()
            self.token = access_token
            self.md_token = md_token or ""
            self.expires_at = time.time() + 3600  # assume 1h; renew will fix
            self.last_error = None
        # Resolve account id (best-effort)
        code, accs = _tv_request("GET", f"{self.base_url()}/account/find", token=access_token)
        with self.lock:
            if isinstance(accs, list) and accs:
                self.account_id = accs[0].get("id")
                self.name = accs[0].get("name", self.name)
            elif isinstance(accs, dict):
                items = accs.get("items") or []
                if items:
                    self.account_id = items[0].get("id")
                    self.name = items[0].get("name", self.name)
            else:
                self.account_id = None
        return True

    def logout(self) -> None:
        with self.lock:
            self.token = None
            self.md_token = None
            self.account_id = None
            self.expires_at = 0.0
            self.last_error = None


def candle_rows(rates) -> list[dict]:
    """Convert MT5 numpy rate rows to plain JSON candle records."""
    rows = []
    if rates is None:
        return rows
    for rate in rates:
        rows.append(
            {
                "time": int(rate["time"]),
                "open": float(rate["open"]),
                "high": float(rate["high"]),
                "low": float(rate["low"]),
                "close": float(rate["close"]),
                "volume": int(rate["tick_volume"]),
            }
        )
    rows.sort(key=lambda r: r["time"])
    return rows


def account_payload(acct) -> dict:
    """Map MT5 account_info to a plain dict (real numbers, no simulation)."""
    if acct is None:
        return {}
    return {
        "login": int(getattr(acct, "login", 0) or 0),
        "name": str(getattr(acct, "name", "") or ""),
        "server": str(getattr(acct, "server", "") or ""),
        "currency": str(getattr(acct, "currency", "") or ""),
        "balance": float(getattr(acct, "balance", 0) or 0),
        "equity": float(getattr(acct, "equity", 0) or 0),
        "margin": float(getattr(acct, "margin", 0) or 0),
        "margin_free": float(getattr(acct, "margin_free", 0) or 0),
        "margin_level": float(getattr(acct, "margin_level", 0) or 0),
        "profit": float(getattr(acct, "profit", 0) or 0),
        "leverage": int(getattr(acct, "leverage", 0) or 0),
    }


def position_payload(pos) -> dict:
    """Map an MT5 position (real open trade) to a plain dict."""
    if pos is None:
        return {}
    return {
        "ticket": int(getattr(pos, "ticket", 0) or 0),
        "symbol": str(getattr(pos, "symbol", "") or ""),
        "type": int(getattr(pos, "type", 0) or 0),  # 0=buy, 1=sell
        "volume": float(getattr(pos, "volume", 0) or 0),
        "price_open": float(getattr(pos, "price_open", 0) or 0),
        "sl": float(getattr(pos, "sl", 0) or 0),
        "tp": float(getattr(pos, "tp", 0) or 0),
        "profit": float(getattr(pos, "profit", 0) or 0),
        "swap": float(getattr(pos, "swap", 0) or 0),
        "time": int(getattr(pos, "time", 0) or 0),
        "comment": str(getattr(pos, "comment", "") or ""),
    }


def tick_tape_rows(ticks) -> list[dict]:
    """Convert MT5 real tick rows to a lean tape (with buy/sell aggressor flags)."""
    rows = []
    if ticks is None:
        return rows
    for t in ticks:
        flags = int(t["flags"] or 0)
        rows.append(
            {
                "time": int(t["time"]),
                "bid": float(t["bid"] or 0),
                "ask": float(t["ask"] or 0),
                "last": float(t["last"] or 0),
                "volume": int(t["volume"] or 0),
                "buy": bool(flags & TICK_FLAG_BUY),
                "sell": bool(flags & TICK_FLAG_SELL),
            }
        )
    rows.sort(key=lambda r: r["time"])
    return rows


def book_payload(book) -> dict:
    """Convert MT5 Market Depth (BookInfo) rows into { bids: [...], asks: [...] }.
    BookInfo.type: 1 = sell (ask side), 2 = buy (bid side)."""
    bids = []
    asks = []
    if book:
        for row in book:
            try:
                btype = int(getattr(row, "type", 0) or 0)
                price = float(getattr(row, "price", 0) or 0)
                volume = float(getattr(row, "volume_dbl", 0) or 0) or float(getattr(row, "volume", 0) or 0)
                item = {"price": price, "volume": volume}
                if btype == BOOK_TYPE_BUY:
                    bids.append(item)
                elif btype == BOOK_TYPE_SELL:
                    asks.append(item)
            except Exception:
                continue
    # Sort bids descending (best bid first), asks ascending (best ask first)
    bids.sort(key=lambda x: x["price"], reverse=True)
    asks.sort(key=lambda x: x["price"])
    return {"bids": bids[:25], "asks": asks[:25]}


def poll_loop(mt5, state: State, symbol_map: dict[str, str], poll_seconds: float) -> None:
    """Background loop: refresh ticks, tick tape, L2 depth, candles, account + positions."""
    subscribed: set[str] = set()
    while True:
        try:
            connected = bool(mt5.initialize())
            state.connected = connected
            if not connected:
                state.error = f"initialize failed: {mt5.last_error()}"
                time.sleep(poll_seconds)
                continue
            state.error = None
            for short, full in symbol_map.items():
                try:
                    tick = mt5.symbol_info_tick(full)
                    if tick is not None:
                        with state.lock:
                            state.ticks[short] = {
                                "bid": float(tick.bid),
                                "ask": float(tick.ask),
                                "last": float(tick.last or tick.bid),
                                "time": int(tick.time),
                            }
                    # Real tick tape (aggressor direction from tick flags)
                    try:
                        from_dt = datetime.now(timezone.utc) - timedelta(seconds=TICK_HISTORY_SECONDS)
                        ticks = mt5.copy_ticks_from(full, from_dt, 0, TICK_FLAGS_ALL)
                        rows = tick_tape_rows(ticks)
                        if rows:
                            with state.lock:
                                state.tick_tape[short] = rows
                    except Exception:
                        pass  # tape is best-effort
                    # Real L2 depth (subscribe once, then read)
                    try:
                        if full not in subscribed:
                            mt5.market_book_add(full)
                            subscribed.add(full)
                        book = mt5.market_book_get(full)
                        payload = book_payload(book)
                        if payload["bids"] or payload["asks"]:
                            with state.lock:
                                state.book[short] = payload
                    except Exception:
                        pass  # depth is best-effort (broker may not provide it)
                    constant = getattr(mt5, TIMEFRAME)
                    rates = mt5.copy_rates_from_pos(full, constant, 0, CANDLE_COUNT)
                    rows = candle_rows(rates)
                    if rows:
                        with state.lock:
                            state.candles[short] = rows
                except Exception as exc:  # per-symbol errors don't kill the loop
                    state.error = f"{short}: {type(exc).__name__}: {exc}"
            # Real account + open positions (every poll keeps them fresh)
            try:
                acct = mt5.account_info()
                with state.lock:
                    state.account = account_payload(acct)
            except Exception as exc:
                state.error = f"account: {type(exc).__name__}: {exc}"
            try:
                poss = mt5.positions_get()
                with state.lock:
                    state.positions = [position_payload(p) for p in (poss or [])]
            except Exception as exc:
                state.error = f"positions: {type(exc).__name__}: {exc}"
            with state.lock:
                state.last_update = iso_now()
        except Exception as exc:
            state.error = f"poll error: {type(exc).__name__}: {exc}"
        time.sleep(poll_seconds)


def _is_loopback_origin(origin: Optional[str]) -> bool:
    """Only allow Electron (file:// → Origin: null) and loopback origins.
    Without this, ANY local webpage could read MT5/Tradovate data from the
    sidecar (localhost CSRF/SSRF vector)."""
    if not origin:
        return True  # non-browser clients (curl, Electron without Origin)
    if origin == "null":
        return True  # Electron file:// pages send Origin: null
    try:
        host = origin.split("//", 1)[1].split(":", 1)[0] if "//" in origin else origin.split(":", 1)[0]
        return host in ("127.0.0.1", "localhost", "[::1]")
    except Exception:
        return False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # quieter logs
        pass

    def _send(self, code: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        origin = self.headers.get("Origin")
        if _is_loopback_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin or "*")
        else:
            # Reject cross-origin reads from arbitrary websites
            self.send_header("Access-Control-Allow-Origin", "null")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        state: State = self.server.state
        path = self.path.split("?")[0]
        params = {}
        if "?" in self.path:
            for pair in self.path.split("?")[1].split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    params[k.upper()] = v

        if path == "/status":
            self._send(200, state.snapshot())
            return

        if path == "/tick":
            sym = params.get("SYMBOL", "ENQ").upper()
            with state.lock:
                payload = state.ticks.get(sym, {})
            self._send(200, {"symbol": sym, "tick": payload})
            return

        if path == "/candles":
            sym = params.get("SYMBOL", "ENQ").upper()
            count = int(params.get("COUNT", CANDLE_COUNT))
            with state.lock:
                rows = state.candles.get(sym, [])[-count:]
            self._send(200, {"symbol": sym, "timeframe": "m5", "candles": rows})
            return

        if path == "/tape":
            """Real tick tape (last ~120s) with buy/sell aggressor flags."""
            sym = params.get("SYMBOL", "ENQ").upper()
            count = int(params.get("COUNT", 200))
            with state.lock:
                rows = state.tick_tape.get(sym, [])[-count:]
            self._send(200, {"symbol": sym, "tape": rows})
            return

        if path == "/book":
            """Real L2 market depth for a symbol."""
            sym = params.get("SYMBOL", "ENQ").upper()
            with state.lock:
                payload = state.book.get(sym, {"bids": [], "asks": []})
            self._send(200, {"symbol": sym, "book": payload})
            return

        if path == "/account":
            with state.lock:
                payload = state.account
            self._send(200, {"account": payload})
            return

        if path == "/positions":
            with state.lock:
                payload = state.positions
            self._send(200, {"positions": payload})
            return

        if path == "/tv/status":
            tv: TradovateSession = self.server.tv
            self._send(200, {"tradovate": tv.status()})
            return

        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        state: State = self.server.state
        tv: TradovateSession = self.server.tv
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}

        if path == "/tv/login":
            name = body.get("name") or ""
            password = body.get("password") or ""
            app_id = body.get("appId") or ""
            app_version = body.get("appVersion") or "1.0"
            env = body.get("env") or "DEMO"
            if not name or not password or not app_id:
                self._send(400, {"ok": False, "error": "name, password and appId are required"})
                return
            ok = tv.login(name, password, app_id, app_version, env)
            self._send(200, {"ok": ok, "tradovate": tv.status()})
            return

        if path == "/tv/token":
            access_token = body.get("accessToken") or ""
            md_token = body.get("mdAccessToken") or ""
            env = body.get("env") or "DEMO"
            if not access_token:
                self._send(400, {"ok": False, "error": "accessToken is required"})
                return
            ok = tv.set_tokens(access_token, md_token, env)
            self._send(200, {"ok": ok, "tradovate": tv.status()})
            return

        if path == "/tv/logout":
            tv.logout()
            self._send(200, {"ok": True, "tradovate": tv.status()})
            return

        self._send(404, {"error": "not found"})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-host", default="127.0.0.1")
    parser.add_argument("--bridge-port", type=int, default=18812)
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=18814)
    parser.add_argument("--poll", type=float, default=POLL_SECONDS)
    args = parser.parse_args(argv)

    try:
        from mt5linux import MetaTrader5
    except ImportError as exc:
        print(f"mt5linux not available: {exc}", flush=True)
        return 2

    state = State()
    print(f"Connecting to MT5 bridge {args.bridge_host}:{args.bridge_port} ...", flush=True)
    mt5 = MetaTrader5(host=args.bridge_host, port=args.bridge_port, timeout=60)
    try:
        if mt5.initialize():
            info = mt5.terminal_info()
            state.terminal = getattr(info, "name", "MetaTrader 5")
            print(f"Connected to {state.terminal}", flush=True)
        else:
            print(f"initialize failed: {mt5.last_error()}", flush=True)
    except Exception as exc:
        print(f"initial connect error: {exc}", flush=True)

    poller = threading.Thread(
        target=poll_loop, args=(mt5, state, SYMBOL_MAP, args.poll), daemon=True
    )
    poller.start()

    server = ThreadingHTTPServer((args.http_host, args.http_port), Handler)
    server.state = state
    server.tv = TradovateSession()

    def _stop(_sig, _frame):
        print("\nShutting down...", flush=True)
        # shutdown() must NOT run in the same thread as serve_forever() or it
        # deadlocks — delegate to a helper thread so the main loop can exit.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    print(f"Dwella MT5 sidecar listening on http://{args.http_host}:{args.http_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        try:
            # Bound the RPyC teardown so exit is never blocked by a slow bridge
            _shutdown = threading.Thread(target=mt5.shutdown)
            _shutdown.start()
            _shutdown.join(timeout=3)
        except Exception:
            pass
        os._exit(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
