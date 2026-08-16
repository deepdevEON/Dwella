#!/usr/bin/env python3
"""
tradovate_server.py — Dwella Tradovate bridge sidecar.

Connects directly to the Tradovate REST API for all market data, account,
and position information. No MetaTrader 5 dependency.

Endpoints (JSON):
    GET  /status              -> { connected, symbols, last_update, error, ticks, candle_counts, account, positions }
    GET  /tick?symbol=ENQ     -> { symbol, tick: { bid, ask, last, time } }
    GET  /candles?symbol=ENQ  -> { symbol, timeframe, candles: [...] }
    GET  /account             -> { account: {...} }
    GET  /positions           -> { positions: [...] }
    GET  /tv/status           -> { tradovate: {...} }
    POST /tv/token            -> accept tokens from webview (accessToken, mdAccessToken, env)
    POST /tv/logout           -> end session

Run:  python3 tradovate_server.py           (default: http 127.0.0.1:18814)
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

# ── Symbol mapping: Dwella short name → Tradovate search pattern ────────────
# The sidecar resolves these to contract IDs on first poll.
SYMBOL_MAP = {"ENQ": "NQ", "MES": "MES", "GCE": "GC"}
POLL_SECONDS = 3.0
CANDLE_COUNT = 200
CANDLE_RESOLUTION = 3  # 3-minute candles (was 5)


# ── Tradovate REST helper ───────────────────────────────────────────────────
def _tv(method: str, url: str, payload: Optional[dict] = None, token: Optional[str] = None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8") or "{}")
        except Exception:
            return exc.code, {"errorText": str(exc)}
    except Exception as exc:
        return 0, {"errorText": f"{type(exc).__name__}: {exc}"}


# ── Tradovate session (auth + token renewal) ───────────────────────────────
class TradovateSession:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.env = "DEMO"
        self.name: Optional[str] = None
        self.token: Optional[str] = None
        self.md_token: Optional[str] = None
        self.account_id: Optional[int] = None
        self.expires_at: float = 0.0
        self.last_error: Optional[str] = None

    def base(self) -> str:
        return ("https://demo.tradovateapi.com/v1" if self.env == "DEMO"
                else "https://live.tradovateapi.com/v1")

    def set_tokens(self, access_token: str, md_token: str = "", env: str = "DEMO") -> bool:
        if not access_token:
            return False
        with self.lock:
            self.env = env.upper()
            self.token = access_token
            self.md_token = md_token or ""
            self.expires_at = time.time() + 3600
            self.last_error = None
        self._resolve_account()
        return True

    def _resolve_account(self) -> None:
        code, data = _tv("GET", f"{self.base()}/account/find", token=self.token)
        with self.lock:
            if isinstance(data, list) and data:
                self.account_id = data[0].get("id")
                self.name = data[0].get("name", self.name)
            elif isinstance(data, dict):
                items = data.get("items") or []
                if items:
                    self.account_id = items[0].get("id")
                    self.name = items[0].get("name", self.name)

    def renew(self) -> bool:
        with self.lock:
            token = self.token
            if not token:
                return False
        code, data = _tv("GET", f"{self.base()}/auth/renewAccessToken", token=token)
        new_token = data.get("accessToken") if isinstance(data, dict) else None
        if code == 200 and new_token:
            with self.lock:
                self.token = new_token
                ms = data.get("expireTime")
                self.expires_at = (time.time() + float(ms) / 1000) if ms else time.time() + 3600
            return True
        return False

    def status(self) -> dict:
        with self.lock:
            logged_in = bool(self.token)
            expires_in = max(0.0, self.expires_at - time.time()) if self.expires_at else 0.0
        if logged_in and expires_in < 120:
            self.renew()
        with self.lock:
            ei = max(0.0, self.expires_at - time.time()) if self.expires_at else 0.0
            return {
                "loggedIn": bool(self.token),
                "env": self.env,
                "name": self.name,
                "accountId": self.account_id,
                "expiresInSec": int(ei) if self.token else None,
                "error": self.last_error,
            }

    def logout(self) -> None:
        with self.lock:
            self.token = self.md_token = self.account_id = None
            self.expires_at = 0.0
            self.last_error = None


# ── Data state (thread-safe cache) ─────────────────────────────────────────
class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.connected = False
        self.error: Optional[str] = None
        self.last_update: Optional[str] = None
        self.ticks: dict[str, dict] = {}
        self.candles: dict[str, list[dict]] = {}
        self.account: dict = {}
        self.positions: list[dict] = []
        for s in SYMBOL_MAP:
            self.ticks[s] = {}
            self.candles[s] = []

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "connected": self.connected,
                "symbols": list(SYMBOL_MAP),
                "last_update": self.last_update,
                "error": self.error,
                "ticks": json.loads(json.dumps(self.ticks, default=str)),
                "candle_counts": {s: len(c) for s, c in self.candles.items()},
                "account": self.account,
                "positions": json.loads(json.dumps(self.positions, default=str)),
            }


# ── Background poll loop ───────────────────────────────────────────────────
def poll_loop(tv: TradovateSession, state: State, poll_sec: float) -> None:
    """Fetch candles, account, positions from Tradovate REST every poll_sec."""
    conids: dict[str, int] = {}  # short → contract ID

    while True:
        try:
            if not tv.token:
                with state.lock:
                    state.connected = False
                    state.error = "Not logged in — open Tradovate in Settings"
                time.sleep(poll_sec)
                continue

            with state.lock:
                state.connected = True
                state.error = None

            # ── Resolve contract IDs (once) ─────────────────────────────
            for short, pattern in SYMBOL_MAP.items():
                if short in conids:
                    continue
                code, data = _tv("GET", f"{tv.base()}/contract/find?name={pattern}", token=tv.token)
                if code == 200 and isinstance(data, list) and data:
                    cid = data[0].get("id")
                    if cid:
                        conids[short] = int(cid)

            # ── Candles for each symbol ─────────────────────────────────
            for short, cid in conids.items():
                try:
                    now = datetime.now(timezone.utc)
                    frm = int((now - timedelta(days=5)).timestamp() * 1000)
                    to = int(now.timestamp() * 1000)
                    code, data = _tv(
                        "GET",
                        f"{tv.base()}/marketdata/bars?conid={cid}&resolution={CANDLE_RESOLUTION}&from={frm}&to={to}",
                        token=tv.token,
                    )
                    if code == 200 and isinstance(data, dict):
                        bars = data.get("bars") or data.get("items") or []
                        rows = []
                        for b in bars:
                            ts = b.get("timestamp") or b.get("t") or ""
                            if isinstance(ts, str) and ts:
                                try:
                                    t_epoch = int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
                                except Exception:
                                    t_epoch = 0
                            else:
                                t_epoch = int(ts) if ts else 0
                            rows.append({
                                "time": t_epoch,
                                "open": float(b.get("open") or b.get("o") or 0),
                                "high": float(b.get("high") or b.get("h") or 0),
                                "low": float(b.get("low") or b.get("l") or 0),
                                "close": float(b.get("close") or b.get("c") or 0),
                                "volume": int(b.get("volume") or b.get("v") or b.get("tick_volume") or 0),
                            })
                        rows.sort(key=lambda r: r["time"])
                        if rows:
                            with state.lock:
                                state.candles[short] = rows[-CANDLE_COUNT:]
                                last = rows[-1]
                                state.ticks[short] = {
                                    "bid": last["close"],
                                    "ask": last["close"],
                                    "last": last["close"],
                                    "time": last["time"],
                                }
                except Exception as exc:
                    with state.lock:
                        state.error = f"{short}: {type(exc).__name__}: {exc}"

            # ── Account info ────────────────────────────────────────────
            try:
                code, data = _tv("GET", f"{tv.base()}/account/find", token=tv.token)
                if code == 200 and isinstance(data, list) and data:
                    a = data[0]
                    with state.lock:
                        state.account = {
                            "login": a.get("id", 0),
                            "name": a.get("name", ""),
                            "server": tv.env,
                            "currency": "USD",
                            "balance": float(a.get("balance", 0) or 0),
                            "equity": float(a.get("equity", 0) or 0),
                            "margin": float(a.get("marginUsed", 0) or 0),
                            "margin_free": float(a.get("marginAvailable", 0) or 0),
                            "margin_level": 0,
                            "profit": float(a.get("pnl", 0) or 0),
                            "leverage": 0,
                        }
            except Exception as exc:
                with state.lock:
                    state.error = f"account: {type(exc).__name__}: {exc}"

            # ── Open positions ──────────────────────────────────────────
            try:
                code, data = _tv("GET", f"{tv.base()}/position/findopenpositions", token=tv.token)
                if code == 200 and isinstance(data, list):
                    with state.lock:
                        state.positions = [
                            {
                                "ticket": p.get("id", 0),
                                "symbol": (p.get("contract") or {}).get("name", ""),
                                "type": 0 if (p.get("netPos") or 0) > 0 else 1,
                                "volume": abs(p.get("netPos") or 0),
                                "price_open": float(p.get("avgPrice", 0) or 0),
                                "sl": 0,
                                "tp": 0,
                                "profit": float(p.get("pnl", 0) or 0),
                                "swap": 0,
                                "time": 0,
                                "comment": "",
                            }
                            for p in data
                        ]
            except Exception as exc:
                with state.lock:
                    state.error = f"positions: {type(exc).__name__}: {exc}"

            with state.lock:
                state.last_update = datetime.now(timezone.utc).isoformat()

        except Exception as exc:
            with state.lock:
                state.error = f"poll: {type(exc).__name__}: {exc}"

        time.sleep(poll_sec)


# ── HTTP handler ───────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:
        pass

    def _send(self, code: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── GET ─────────────────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        state: State = self.server.state
        tv: TradovateSession = self.server.tv
        path = self.path.split("?")[0]
        params = {}
        if "?" in self.path:
            for pair in self.path.split("?")[1].split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    params[k.upper()] = v

        if path == "/status":
            self._send(200, state.snapshot()); return

        if path == "/tick":
            sym = params.get("SYMBOL", "ENQ").upper()
            with state.lock:
                payload = state.ticks.get(sym, {})
            self._send(200, {"symbol": sym, "tick": payload}); return

        if path == "/candles":
            sym = params.get("SYMBOL", "ENQ").upper()
            count = int(params.get("COUNT", CANDLE_COUNT))
            with state.lock:
                rows = state.candles.get(sym, [])[-count:]
            self._send(200, {"symbol": sym, "timeframe": "m5", "candles": rows}); return

        if path == "/tape":
            # Tradovate REST doesn't provide tick-level tape — return candle-derived delta
            sym = params.get("SYMBOL", "ENQ").upper()
            with state.lock:
                rows = state.candles.get(sym, [])[-200:]
            tape = []
            for r in rows:
                bull = r["close"] >= r["open"]
                tape.append({
                    "time": r["time"], "bid": r["close"], "ask": r["close"],
                    "last": r["close"], "volume": r["volume"],
                    "buy": bull, "sell": not bull,
                })
            self._send(200, {"symbol": sym, "tape": tape}); return

        if path == "/book":
            # Tradovate REST doesn't provide L2 depth — return empty
            sym = params.get("SYMBOL", "ENQ").upper()
            self._send(200, {"symbol": sym, "book": {"bids": [], "asks": []}}); return

        if path == "/account":
            with state.lock:
                payload = state.account
            self._send(200, {"account": payload}); return

        if path == "/positions":
            with state.lock:
                payload = state.positions
            self._send(200, {"positions": payload}); return

        if path == "/tv/status":
            self._send(200, {"tradovate": tv.status()}); return

        if path == "/tv/openorders":
            if not tv.token:
                self._send(200, {"orders": []}); return
            code, data = _tv("GET", f"{tv.base()}/order/findopenorders", token=tv.token)
            orders = data if isinstance(data, list) else []
            self._send(200, {"orders": orders}); return

        self._send(404, {"error": "not found"})

    # ── DELETE ──────────────────────────────────────────────────────────
    def do_DELETE(self) -> None:  # noqa: N802
        tv: TradovateSession = self.server.tv
        path = self.path.split("?")[0]
        if path == "/tv/cancel":
            # Cancel an order by orderId
            params = {}
            if "?" in self.path:
                for pair in self.path.split("?")[1].split("&"):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        params[k.upper()] = v
            order_id = params.get("ORDERID")
            if not order_id:
                self._send(400, {"ok": False, "error": "orderId required"}); return
            if not tv.token:
                self._send(400, {"ok": False, "error": "Not logged in"}); return
            code, data = _tv("GET", f"{tv.base()}/order/cancelorder?orderid={order_id}", token=tv.token)
            self._send(200, {"ok": code == 200, "data": data}); return
        self._send(404, {"error": "not found"})

    # ── POST ────────────────────────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        tv: TradovateSession = self.server.tv
        path = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            body = {}

        if path == "/tv/token":
            at = body.get("accessToken") or ""
            mt = body.get("mdAccessToken") or ""
            env = body.get("env") or "DEMO"
            if not at:
                self._send(400, {"ok": False, "error": "accessToken required"}); return
            ok = tv.set_tokens(at, mt, env)
            self._send(200, {"ok": ok, "tradovate": tv.status()}); return

        if path == "/tv/login":
            # Legacy: accept username/password and call accesstokenrequest
            name = body.get("name") or ""
            pw = body.get("password") or ""
            app_id = body.get("appId") or ""
            env = body.get("env") or "DEMO"
            if not name or not pw or not app_id:
                self._send(400, {"ok": False, "error": "name, password, appId required"}); return
            base = ("https://demo.tradovateapi.com/v1" if env.upper() == "DEMO"
                    else "https://live.tradovateapi.com/v1")
            code, data = _tv("POST", f"{base}/auth/accesstokenrequest",
                             {"name": name, "password": pw, "appId": app_id, "appVersion": "1.0"})
            tok = data.get("accessToken") if isinstance(data, dict) else None
            if code != 200 or not tok:
                err = (data.get("errorText") or data.get("errorCode") or f"HTTP {code}"
                       if isinstance(data, dict) else f"HTTP {code}")
                self._send(200, {"ok": False, "error": str(err), "tradovate": tv.status()}); return
            ok = tv.set_tokens(tok, data.get("mdAccessToken", ""), env)
            self._send(200, {"ok": ok, "tradovate": tv.status()}); return

        if path == "/tv/logout":
            tv.logout()
            self._send(200, {"ok": True, "tradovate": tv.status()}); return

        # ── ORDER EXECUTION ─────────────────────────────────────────────
        if path == "/tv/order":
            if not tv.token:
                self._send(400, {"ok": False, "error": "Not logged in to Tradovate"}); return
            action = body.get("action") or ""  # Buy / Sell
            symbol = body.get("symbol") or ""  # e.g. ENQ, MES, GCE
            order_type = body.get("orderType") or "Market"  # Market / Limit / Stop
            qty = body.get("qty") or 1
            price = body.get("price")  # for limit/stop
            sl = body.get("sl")  # stop-loss price
            tp = body.get("tp")  # take-profit price
            tif = body.get("timeInForce") or "Day"
            comment = body.get("comment") or "Dwella"
            if not action or not symbol:
                self._send(400, {"ok": False, "error": "action and symbol required"}); return
            # Resolve contract name (ENQ → NQDec26, etc.)
            sym_upper = symbol.upper().replace("@", "")
            con_name = SYMBOL_MAP.get(sym_upper, sym_upper)
            # Find the active contract via Tradovate API
            code, data = _tv("GET", f"{tv.base()}/contract/find?name={con_name}", token=tv.token)
            contracts = data if isinstance(data, list) else (data.get("items") or []) if isinstance(data, dict) else []
            if not contracts:
                self._send(200, {"ok": False, "error": f"Contract not found for {con_name}", "detail": data}); return
            contract = contracts[0]
            contract_name = contract.get("name", con_name)
            # Build order payload
            order = {
                "accountId": tv.account_id,
                "action": action,
                "symbol": contract_name,
                "orderQty": int(qty),
                "orderType": order_type,
                "timeInForce": tif,
                "isAutomated": True,
                "comment": comment,
            }
            if price and order_type in ("Limit", "Stop", "StopLimit"):
                order["price"] = float(price)
            # Place the primary order
            code, data = _tv("POST", f"{tv.base()}/order/placeorder", order, token=tv.token)
            if code != 200 or not isinstance(data, dict) or data.get("errorCode"):
                err = data.get("errorText") or data.get("errorCode") or f"HTTP {code}"
                self._send(200, {"ok": False, "error": str(err), "detail": data}); return
            order_id = data.get("orderId") or data.get("orderNo")
            result = {"ok": True, "orderId": order_id, "detail": data}
            # Place bracket (OCO) for SL + TP if both provided
            if sl and tp and order_id:
                oco_payload = {
                    "accountId": tv.account_id,
                    "action": "Sell" if action == "Buy" else "Buy",
                    "symbol": contract_name,
                    "orderQty": int(qty),
                    "orderType": "Limit",
                    "price": float(tp),
                    "stopPrice": float(sl),
                    "timeInForce": tif,
                    "isAutomated": True,
                    "comment": f"{comment} OCO",
                }
                oco_code, oco_data = _tv("POST", f"{tv.base()}/order/placeoco", oco_payload, token=tv.token)
                result["oco"] = {"ok": oco_code == 200, "detail": oco_data}
            elif sl and order_id:
                # Standalone stop-loss
                sl_payload = {
                    "accountId": tv.account_id,
                    "action": "Sell" if action == "Buy" else "Buy",
                    "symbol": contract_name,
                    "orderQty": int(qty),
                    "orderType": "Stop",
                    "stopPrice": float(sl),
                    "timeInForce": tif,
                    "isAutomated": True,
                    "comment": f"{comment} SL",
                }
                sl_code, sl_data = _tv("POST", f"{tv.base()}/order/placeorder", sl_payload, token=tv.token)
                result["sl"] = {"ok": sl_code == 200, "detail": sl_data}
            self._send(200, result); return

        self._send(404, {"error": "not found"})


# ── Main ───────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=18814)
    parser.add_argument("--poll", type=float, default=POLL_SECONDS)
    args = parser.parse_args(argv)

    state = State()
    tv = TradovateSession()

    poller = threading.Thread(target=poll_loop, args=(tv, state, args.poll), daemon=True)
    poller.start()

    server = ThreadingHTTPServer((args.http_host, args.http_port), Handler)
    server.state = state
    server.tv = tv

    def _stop(_sig, _frame):
        print("\nShutting down...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    print(f"Dwella Tradovate sidecar listening on http://{args.http_host}:{args.http_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
