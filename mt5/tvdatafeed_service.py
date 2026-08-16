#!/usr/bin/env python3
"""
tvdatafeed_service.py — Dwella TradingView data service.

Uses tvdatafeed library to pull live candle data directly from TradingView
without requiring TradingView Desktop or CDP.

Endpoints (JSON):
    GET  /status                -> { connected, symbols, last_update, ticks, candle_counts }
    GET  /tick?symbol=ENQ       -> { symbol, tick: { bid, ask, last, time } }
    GET  /candles?symbol=ENQ&timeframe=3&count=200  -> { symbol, timeframe, candles: [...] }
    GET  /health                -> { connected: true, ... }

Run:  python3 tvdatafeed_service.py           (default: http 127.0.0.1:18814)
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

# ── tvdatafeed imports ────────────────────────────────────────────────
from tvDatafeed import TvDatafeed, Interval

# ── Symbol mapping: Dwella short name → TradingView symbol ────────────
SYMBOL_MAP = {
    "ENQ": ("CME_MINI:MNQ1!", "CME_MINI"),
    "MES": ("CME_MINI:MES1!", "CME_MINI"),
    "GCE": ("COMEX:GC1!", "COMEX"),
    "ES": ("CME_MINI:ES1!", "CME_MINI"),
    "YM": ("CBOT:YM1!", "CBOT"),
    "RTY": ("CME_MINI:RTY1!", "CME_MINI"),
    "CL": ("NYMEX:CL1!", "NYMEX"),
    "SI": ("COMEX:SI1!", "COMEX"),
    "NQ": ("CME_MINI:NQ1!", "CME_MINI"),
}

# ── Timeframe mapping: Dwella short → tvdatafeed Interval ─────────────
TIMEFRAME_MAP = {
    "1": Interval.in_1_minute,
    "3": Interval.in_3_minute,
    "5": Interval.in_5_minute,
    "15": Interval.in_15_minute,
    "30": Interval.in_30_minute,
    "60": Interval.in_1_hour,
    "120": Interval.in_2_hour,
    "240": Interval.in_4_hour,
    "D": Interval.in_daily,
    "W": Interval.in_weekly,
    "M": Interval.in_monthly,
}

POLL_SECONDS = 3.0
CANDLE_COUNT = 200
# Primary symbols that need full candle data for sparklines
PRIMARY_SYMBOLS = ["ENQ", "MES", "GCE"]


# ── TvDatafeed client wrapper ─────────────────────────────────────────
class TvClient:
    def __init__(self, username: str = "guest", password: str = "") -> None:
        self.username = username
        self.password = password
        self._client: Optional[TvDatafeed] = None
        self.lock = threading.Lock()

    def connect(self) -> bool:
        """Initialize the TvDatafeed client."""
        try:
            with self.lock:
                if self.username and self.username != "guest" and self.password:
                    self._client = TvDatafeed(self.username, self.password)
                else:
                    self._client = TvDatafeed()  # anonymous
                return True
        except Exception as exc:
            print(f"[tvdatafeed] connection error: {exc}", flush=True)
            return False

    def get_candles(self, symbol: str, timeframe: str = "3", count: int = 200) -> list[dict]:
        """Fetch OHLCV candles for a symbol."""
        if not self._client:
            return []
        try:
            tv_sym, exchange = SYMBOL_MAP.get(symbol, (symbol, ""))
            interval = TIMEFRAME_MAP.get(timeframe, Interval.in_3_minute)
            with self.lock:
                df = self._client.get_hist(symbol=tv_sym, exchange=exchange, interval=interval, n_bars=count)
            if df is None or df.empty:
                return []
            # Convert DataFrame to list of dicts
            candles = []
            for _, row in df.iterrows():
                candles.append({
                    "time": int(row.get("datetime", datetime.now(timezone.utc).timestamp()) if "datetime" in row.index else datetime.now(timezone.utc).timestamp()),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": float(row.get("volume", 0)),
                })
            return candles
        except Exception as exc:
            print(f"[tvdatafeed] get_candles error for {symbol}: {exc}", flush=True)
            return []

    def get_tick(self, symbol: str) -> dict:
        """Get the latest tick data for a symbol (from the last candle)."""
        candles = self.get_candles(symbol, "1", 1)
        if candles:
            last = candles[-1]
            return {
                "bid": last["close"],
                "ask": last["close"],
                "last": last["close"],
                "open": last["open"],
                "high": last["high"],
                "low": last["low"],
                "volume": last["volume"],
                "time": last["time"],
            }
        return {}


# ── Data state (thread-safe cache) ───────────────────────────────────
class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.connected = False
        self.error: Optional[str] = None
        self.last_update: Optional[str] = None
        self.ticks: dict[str, dict] = {}
        self.candles: dict[str, list[dict]] = {}
        for s in SYMBOL_MAP:
            self.ticks[s] = {}
            self.candles[s] = []

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "connected": self.connected,
                "symbols": list(SYMBOL_MAP.keys()),
                "last_update": self.last_update,
                "error": self.error,
                "ticks": json.loads(json.dumps(self.ticks, default=str)),
                "candle_counts": {s: len(c) for s, c in self.candles.items()},
            }


# ── Background poll loop ─────────────────────────────────────────────
def poll_loop(client: TvClient, state: State, poll_sec: float) -> None:
    """Fetch candles for all symbols from TradingView via tvdatafeed."""
    while True:
        try:
            # Check connection
            if not client._client:
                connected = client.connect()
                with state.lock:
                    state.connected = connected
                    state.error = None if connected else "Failed to connect to TradingView"
                if not connected:
                    time.sleep(poll_sec)
                    continue

            with state.lock:
                state.connected = True
                state.error = None

            # Fetch candles for primary symbols (ENQ, MES, GCE)
            for sym in PRIMARY_SYMBOLS:
                try:
                    candles = client.get_candles(sym, "3", CANDLE_COUNT)
                    if candles:
                        with state.lock:
                            state.candles[sym] = candles
                        # Extract tick from last candle
                        last = candles[-1]
                        with state.lock:
                            state.ticks[sym] = {
                                "bid": last["close"],
                                "ask": last["close"],
                                "last": last["close"],
                                "open": last["open"],
                                "high": last["high"],
                                "low": last["low"],
                                "volume": last["volume"],
                                "time": last["time"],
                            }
                except Exception as exc:
                    with state.lock:
                        state.error = f"{sym} candles: {exc}"

            # Fetch ticks for other symbols (just ticks, no full candles)
            for sym in ["ES", "YM", "RTY", "CL", "SI"]:
                try:
                    tick = client.get_tick(sym)
                    if tick:
                        with state.lock:
                            state.ticks[sym] = tick
                except Exception as exc:
                    with state.lock:
                        state.error = f"{sym} tick: {exc}"

            with state.lock:
                state.last_update = datetime.now(timezone.utc).isoformat()

        except Exception as exc:
            with state.lock:
                state.error = f"poll: {exc}"

        time.sleep(poll_sec)


# ── HTTP handler ──────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:
        pass

    def _send(self, code: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        state: State = self.server.state
        path = self.path.split("?")[0]
        params = {}
        if "?" in self.path:
            for pair in self.path.split("?")[1].split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    # Store both uppercase and lowercase for case-insensitive access
                    params[k.upper()] = v
                    params[k.lower()] = v

        def get_param(key: str, default: str = "") -> str:
            """Get parameter value case-insensitively."""
            return params.get(key.upper(), params.get(key.lower(), default))

        if path == "/status":
            self._send(200, state.snapshot())
            return

        if path == "/health":
            with state.lock:
                self._send(200, {"connected": state.connected, "symbols": list(SYMBOL_MAP.keys())})
            return

        if path == "/tick":
            sym = get_param("symbol", "ENQ").upper()
            with state.lock:
                payload = state.ticks.get(sym, {})
            self._send(200, {"symbol": sym, "tick": payload})
            return

        if path == "/candles":
            sym = get_param("symbol", "ENQ").upper()
            tf = get_param("timeframe", "3")
            count = int(get_param("count", str(CANDLE_COUNT)))
            with state.lock:
                rows = state.candles.get(sym, [])[-count:]
            self._send(200, {"symbol": sym, "timeframe": tf, "candles": rows})
            return

        self._send(404, {"error": "not found"})


# ── Main ──────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=18814)
    parser.add_argument("--poll", type=float, default=POLL_SECONDS)
    parser.add_argument("--username", default=os.environ.get("TRADINGVIEW_USERNAME", "guest"))
    parser.add_argument("--password", default=os.environ.get("TRADINGVIEW_PASSWORD", ""))
    args = parser.parse_args(argv)

    client = TvClient(args.username, args.password)
    state = State()

    # Initial connection
    print(f"Connecting to TradingView as {args.username}...", flush=True)
    connected = client.connect()
    print(f"Connection: {'OK' if connected else 'FAILED'}", flush=True)

    poller = threading.Thread(target=poll_loop, args=(client, state, args.poll), daemon=True)
    poller.start()

    server = ThreadingHTTPServer((args.http_host, args.http_port), Handler)
    server.state = state

    def _stop(_sig, _frame):
        print("\nShutting down...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    print(f"Dwella tvdatafeed service listening on http://{args.http_host}:{args.http_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
