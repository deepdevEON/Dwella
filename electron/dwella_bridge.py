# Dwella MT5 bridge - runs inside the MetaTrader 5 Wine prefix on Windows Python.
# Serves real-time broker quotes at http://127.0.0.1:8643 for the Dwella desktop app.
import os
import json
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import MetaTrader5 as mt5

PORT = 8643
CREDENTIALS_PATH = os.environ.get("DWLLA_MT5_CREDENTIALS", "")
# Logical dashboard symbols -> candidate MT5 symbol prefixes (CQG/AMP style first).
CANDIDATES = {
    "NQ": ["@ENQ", "ENQ", "NQ", "MNQ", "USTEC", "NAS100"],
    "GC": ["@GCE", "GCE", "GC", "MGC", "XAUUSD", "GOLD"],
    "ES": ["@EP", "@ES", "EP", "ES", "MES", "US500", "SPX500"],
}

STATE = {"initialized": False, "resolved": {}, "resolved_at": 0}


def ensure_init():
    if STATE["initialized"]:
        return True
    if mt5.initialize():
        STATE["initialized"] = True
        return True
    return False


def current_price(name, retries=3):
    """Latest price + time for a symbol; falls back to daily bars for
    freshly-selected symbols whose tick cache is still empty."""
    for attempt in range(retries):
        tick = mt5.symbol_info_tick(name)
        if tick:
            price = tick.last or tick.bid or 0
            if price > 0:
                return float(price), int(tick.time)
        time.sleep(0.4)
    rates = mt5.copy_rates_from_pos(name, mt5.TIMEFRAME_D1, 0, 1)
    if rates is not None and len(rates):
        return float(rates[-1]["close"]), int(rates[-1]["time"])
    return 0.0, 0


def prev_close(name, price):
    info = mt5.symbol_info(name)
    if info and info.session_close and info.session_close > 0 and abs(info.session_close - price) > 1e-9:
        return float(info.session_close)
    rates = mt5.copy_rates_from_pos(name, mt5.TIMEFRAME_D1, 0, 2)
    if rates is not None and len(rates) >= 2:
        return float(rates[0]["close"])
    return None


def resolve_symbols():
    now = time.time()
    if STATE["resolved"] and now - STATE["resolved_at"] < 3600:
        return STATE["resolved"]
    all_names = [s.name for s in (mt5.symbols_get() or [])]
    resolved = {}
    for logical, cands in CANDIDATES.items():
        pool = []
        for c in cands:
            if c in all_names and c not in pool:
                pool.append(c)
            for n in all_names:
                if n.startswith(c) and len(n) <= len(c) + 4 and n not in pool:
                    pool.append(n)
        best, best_time = None, 0
        for name in pool[:12]:
            mt5.symbol_select(name, True)
            price, tick_time = current_price(name)
            if price > 0 and tick_time > best_time:
                best, best_time = name, tick_time
        if best:
            resolved[logical] = best
    if resolved:
        STATE["resolved"] = resolved
        STATE["resolved_at"] = now
    return resolved


def quotes():
    if not ensure_init():
        return {"ok": False, "error": "mt5_initialize_failed", "detail": str(mt5.last_error())}
    out = []
    for logical, name in resolve_symbols().items():
        price, tick_time = current_price(name, retries=1)
        if price <= 0:
            continue
        prev = prev_close(name, price)
        change = (price - prev) / prev * 100.0 if prev else None
        out.append({"s": logical, "symbol": name, "ok": True, "price": price,
                    "changePct": change, "time": tick_time, "src": "mt5"})
    return {"ok": True, "quotes": out}


TIMEFRAMES = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 16385, "H4": 16388, "D1": 16408}


def bars(logical, tf, count):
    if not ensure_init():
        return {"ok": False, "error": "mt5_initialize_failed"}
    name = resolve_symbols().get(logical)
    if not name:
        return {"ok": False, "error": "symbol_unresolved"}
    timeframe = TIMEFRAMES.get(tf, 5)
    count = max(10, min(int(count), 500))
    rates = mt5.copy_rates_from_pos(name, timeframe, 0, count)
    if rates is None or not len(rates):
        return {"ok": False, "error": "no_bars"}
    out = [{"t": int(r["time"]), "o": float(r["open"]), "h": float(r["high"]),
            "l": float(r["low"]), "c": float(r["close"]), "v": int(r["tick_volume"])} for r in rates]
    return {"ok": True, "symbol": name, "tf": tf, "bars": out}


def account():
    if not ensure_init():
        return {"ok": False, "error": "mt5_initialize_failed"}
    a = mt5.account_info()
    if not a:
        return {"ok": False, "error": "no_account"}
    return {"ok": True, "balance": a.balance, "equity": a.equity, "profit": a.profit,
            "marginFree": a.margin_free, "currency": a.currency, "leverage": a.leverage,
            "server": a.server, "company": a.company, "login": a.login}


def positions():
    if not ensure_init():
        return {"ok": False, "error": "mt5_initialize_failed"}
    poss = mt5.positions_get() or []
    return {"ok": True, "positions": [
        {"symbol": p.symbol, "side": "Long" if p.type == 0 else "Short", "volume": p.volume,
         "entry": p.price_open, "current": p.price_current, "profit": p.profit} for p in poss]}


def health():
    initialized = ensure_init()
    acct = mt5.account_info() if initialized else None
    term = mt5.terminal_info() if initialized else None
    return {"ok": initialized,
            "connected": bool(term and term.connected),
            "broker": getattr(acct, "company", None),
            "server": getattr(acct, "server", None),
            "symbols": STATE["resolved"]}


def do_login(login, password, server):
    if not login or not password:
        return {"ok": False, "error": "missing_credentials", "detail": "Login and password are required."}
    try:
        ok = mt5.initialize(login=int(login), password=password, server=server or "")
    except Exception as exc:
        return {"ok": False, "error": "initialize_exception", "detail": str(exc)}
    if not ok:
        err = mt5.last_error()
        return {"ok": False, "error": "login_failed", "code": err[0], "detail": err[1]}
    STATE["initialized"] = True
    acct = mt5.account_info()
    return {
        "ok": True,
        "login": acct.login if acct else int(login),
        "server": getattr(acct, "server", server or ""),
        "company": getattr(acct, "company", ""),
        "balance": acct.balance if acct else 0,
        "equity": acct.equity if acct else 0,
    }


def do_logout():
    try:
        mt5.shutdown()
    except Exception:
        pass
    STATE["initialized"] = False
    STATE["resolved"] = {}
    STATE["resolved_at"] = 0
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def _cors(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        q = parse_qs(parsed.query)
        if parsed.path == "/quotes":
            body = quotes()
        elif parsed.path == "/bars":
            body = bars(q.get("s", ["NQ"])[0], q.get("tf", ["M5"])[0], q.get("count", ["180"])[0])
        elif parsed.path == "/account":
            body = account()
        elif parsed.path == "/positions":
            body = positions()
        elif parsed.path == "/health":
            body = health()
        else:
            body = {"ok": False, "error": "not_found"}
        self._cors(body)

    def do_POST(self):
        from urllib.parse import urlparse
        parsed = urlparse(self.path)
        data = self._read_body()
        if parsed.path == "/login":
            body = do_login(data.get("login"), data.get("password"), data.get("server"))
        elif parsed.path == "/logout":
            body = do_logout()
        else:
            body = {"ok": False, "error": "not_found"}
        self._cors(body)


if __name__ == "__main__":
    ensure_init()
    print("Dwella MT5 bridge on 127.0.0.1:%d, mt5=%s" % (PORT, STATE["initialized"]))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
