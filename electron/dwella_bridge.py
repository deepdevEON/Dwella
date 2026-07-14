# Dwella MT5 bridge - runs inside the MetaTrader 5 environment and serves
# real-time broker quotes at http://127.0.0.1:8643 for the Dwella desktop app.
#
# Works both on the macOS Wine prefix (where the terminal path is injected) and on
# native Windows (where mt5.initialize() discovers the terminal via the registry).
# To point the bridge at a specific terminal on native Windows, set the
# MT5_TERMINAL_PATH environment variable before launching the bridge.
import json
import os
import re
import time
from datetime import date, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import MetaTrader5 as mt5

PORT = 8643

# Logical dashboard symbols -> candidate MT5 symbol prefixes (CQG/AMP style first),
# including broker-specific continuous-contract suffixes. Order matters: the first
# candidate that resolves to a live, quotable symbol wins.
CANDIDATES = {
    "NQ": ["@ENQ", "ENQ", "NQ#", "NQ.US", "NQ.CONT", "NQ", "MNQ", "USTEC", "NAS100"],
    "GC": ["@GCE", "GCE", "GC#", "GC.US", "GC.CONT", "GC", "MGC", "XAUUSD", "GOLD"],
    "ES": ["@EP", "@ES", "EP", "ES#", "ES.US", "ES.CONT", "ES", "MES", "US500", "SPX500"],
}

# Per-underlying futures contract specifications. tick_size is the minimum price
# increment, point_value is the USD value of a 1.0 price move, margin is an
# indicative initial margin per contract (broker-dependent).
FUTURES_META = {
    "NQ":  {"name": "Nasdaq 100 E-mini", "exchange": "CME",   "tick_size": 0.25, "point_value": 20.0,  "contract_size": 20,  "margin": 1500, "decimals": 2,
             "micro": "MNQ", "micro_point_value": 2.0,  "micro_tick_size": 0.25},
    "ES":  {"name": "S&P 500 E-mini",     "exchange": "CME",   "tick_size": 0.25, "point_value": 50.0,  "contract_size": 50,  "margin": 1200, "decimals": 2,
             "micro": "MES", "micro_point_value": 5.0,  "micro_tick_size": 0.25},
    "GC":  {"name": "Gold (COMEX)",       "exchange": "COMEX", "tick_size": 0.1,  "point_value": 100.0, "contract_size": 100, "margin": 1100, "decimals": 1,
             "micro": "MGC", "micro_point_value": 10.0, "micro_tick_size": 0.1},
}

# Underlying root -> list of contract symbol roots to scan in the symbol list and
# the broker-specific continuous-contract symbol synonyms used for resolution.
FUTURES_ROOTS = {
    "NQ": {"roots": ["NQ", "MNQ"], "continuous": ["NQ#", "NQ.US", "NQ.CONT", "@ENQ", "ENQ"]},
    "ES": {"roots": ["ES", "MES"], "continuous": ["ES#", "ES.US", "ES.CONT", "@EP", "@ES", "EP"]},
    "GC": {"roots": ["GC", "MGC"], "continuous": ["GC#", "GC.US", "GC.CONT", "@GCE", "GCE"]},
}

# CME futures month codes: Jan=F, Feb=G, Mar=H, Apr=J, May=K, Jun=M,
# Jul=N, Aug=Q, Sep=U, Oct=V, Nov=X, Dec=Z.
MONTH_CODES = {"F": 1, "G": 2, "H": 3, "J": 4, "K": 5, "M": 6,
                "N": 7, "Q": 8, "U": 9, "V": 10, "X": 11, "Z": 12}
CODE_FOR_MONTH = {v: k for k, v in MONTH_CODES.items()}

# Days before a front-month expiration at which we roll to the next contract.
ROLL_DAYS_BEFORE = 1

STATE = {"initialized": False, "resolved": {}, "resolved_at": 0}


def ensure_init():
    if STATE["initialized"]:
        return True
    kwargs = {}
    tp = os.environ.get("MT5_TERMINAL_PATH")
    if tp:
        kwargs["path"] = tp
    login = os.environ.get("MT5_LOGIN")
    password = os.environ.get("MT5_PASSWORD")
    server = os.environ.get("MT5_SERVER")
    if login and password:
        kwargs["login"] = int(login)
        kwargs["password"] = password
        if server:
            kwargs["server"] = server
    try:
        if mt5.initialize(**kwargs):
            STATE["initialized"] = True
            return True
    except Exception:
        if not tp and not login:
            try:
                if mt5.initialize():
                    STATE["initialized"] = True
                    return True
            except Exception:
                pass
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


# ── Futures contract pipeline ────────────────────────────────────────────────

def contract_expiration(underlying, year, month):
    """Expiration date for a futures contract.

    CME equity-index futures (NQ/ES and their micros) expire on the third
    Friday of the contract month. COMEX metals (GC/MGC) expire on the third
    last business day of the contract month.
    """
    if underlying in ("NQ", "ES", "MNQ", "MES"):
        first = date(year, month, 1)
        offset = (4 - first.weekday()) % 7  # Friday == 4
        fridays = [first + timedelta(days=offset + 7 * i) for i in range(3)]
        return fridays[2]
    # Metals: third last business day of the month.
    if month == 12:
        nxt = date(year + 1, 1, 1)
    else:
        nxt = date(year, month + 1, 1)
    last = nxt - timedelta(days=1)
    bd = last
    seen = 0
    while seen < 3:
        if bd.weekday() < 5:
            seen += 1
        bd -= timedelta(days=1)
    return bd + timedelta(days=1)


def parse_contract(symbol):
    """Parse a futures contract symbol like 'NQH25' -> (root, year, month, code)."""
    m = re.match(r"^([A-Z]+?)([FGHJKMNQUVXZ])(\d{2})$", symbol)
    if not m:
        return None
    return m.group(1), 2000 + int(m.group(3)), MONTH_CODES[m.group(2)], m.group(2)


def futures_chain(underlying):
    """Return all available futures contracts for an underlying root."""
    if not ensure_init():
        return {"ok": False, "error": "mt5_initialize_failed"}
    meta = FUTURES_META.get(underlying, {})
    cfg = FUTURES_ROOTS.get(underlying, {"roots": [underlying], "continuous": []})
    all_names = [s.name for s in (mt5.symbols_get() or [])]
    root_pat = "^(?:" + "|".join(re.escape(r) for r in cfg["roots"]) + r")([FGHJKMNQUVXZ])(\d{2})$"
    contracts = []
    for name in all_names:
        parsed = parse_contract(name)
        if not parsed:
            continue
        root, year, month, code = parsed
        if root not in cfg["roots"]:
            continue
        if not re.match(root_pat, name):
            continue
        exp = contract_expiration(root, year, month)
        info = mt5.symbol_info(name)
        is_micro = (root == meta.get("micro"))
        tick = getattr(info, "trade_tick_size", None) or (meta.get("micro_tick_size") if is_micro else meta.get("tick_size"))
        pv = meta.get("micro_point_value") if is_micro else meta.get("point_value")
        contracts.append({
            "symbol": name,
            "underlying": underlying,
            "root": root,
            "month": month,
            "year": year,
            "month_code": code,
            "expiration": exp.isoformat(),
            "tick_size": tick,
            "point_value": pv,
            "tick_value": round((tick or 0) * (pv or 0), 4),
            "micro": is_micro,
            "contract_size": meta.get("contract_size"),
            "margin": meta.get("margin"),
            "exchange": meta.get("exchange"),
            "name": meta.get("name"),
        })
    contracts.sort(key=lambda c: (c["year"], c["month"]))
    return {"ok": True, "underlying": underlying,
            "continuous": cfg["continuous"], "contracts": contracts, "spec": meta}


def futures_spec(underlying):
    """Return static contract specifications for an underlying."""
    meta = FUTURES_META.get(underlying)
    if not meta:
        return {"ok": False, "error": "unknown_underlying", "underlying": underlying}
    return {"ok": True, "underlying": underlying, "spec": meta,
            "continuous": FUTURES_ROOTS.get(underlying, {}).get("continuous", [])}


def _front_index(contracts, today):
    """Index of the front-month contract (first contract not yet expired)."""
    for i, c in enumerate(contracts):
        if date.fromisoformat(c["expiration"]) >= today:
            return i
    return len(contracts) - 1


def _bar_obj(r):
    return {"t": int(r["time"]), "o": float(r["open"]), "h": float(r["high"]),
            "l": float(r["low"]), "c": float(r["close"]), "v": int(r["tick_volume"])}


def futures_continuous(underlying, tf, count):
    """Build a continuous (difference-adjusted / Panama) price series across the
    front-month roll. Detects when the front-month is within ROLL_DAYS_BEFORE of
    expiration and stitches the next contract on, adjusting it to be continuous
    with the outgoing contract at the roll boundary."""
    if not ensure_init():
        return {"ok": False, "error": "mt5_initialize_failed"}
    chain = futures_chain(underlying)
    if not chain.get("ok"):
        return {"ok": False, "error": chain.get("error", "chain_failed")}
    contracts = chain["contracts"]
    if not contracts:
        return {"ok": False, "error": "no_contracts", "underlying": underlying}

    count = max(10, min(int(count), 1000))
    timeframe = TIMEFRAMES.get(tf, 5)
    today = date.today()

    idx = _front_index(contracts, today)
    c0 = contracts[idx]
    c1 = contracts[idx + 1] if idx + 1 < len(contracts) else None
    exp0 = date.fromisoformat(c0["expiration"])
    roll_date = exp0 - timedelta(days=ROLL_DAYS_BEFORE)
    rolled = (today >= roll_date) and c1 is not None
    active_symbol = c1["symbol"] if rolled else c0["symbol"]

    # Pull enough history to span a possible roll inside the lookback window.
    look = count * 3
    bars0 = mt5.copy_rates_from_pos(c0["symbol"], timeframe, 0, look)
    bars1 = mt5.copy_rates_from_pos(c1["symbol"], timeframe, 0, look) if c1 else None

    out = []
    if rolled and bars0 is not None and bars1 is not None and len(bars0) and len(bars1):
        t0 = {b["time"] for b in bars0}
        t1 = {b["time"] for b in bars1}
        overlap = sorted(t0 & t1)
        if overlap:
            roll_ts = overlap[-1]
            c0_close = next(b["close"] for b in bars0 if b["time"] == roll_ts)
            c1_close = next(b["close"] for b in bars1 if b["time"] == roll_ts)
            diff = float(c0_close - c1_close)
            m0 = {b["time"]: _bar_obj(b) for b in bars0}
            m1 = {b["time"]: _bar_obj(b) for b in bars1}
            for t in sorted(set(m0) | set(m1)):
                if t <= roll_ts:
                    if t in m0:
                        out.append(m0[t])
                else:
                    if t in m1:
                        b = dict(m1[t])
                        b["o"] += diff
                        b["h"] += diff
                        b["l"] += diff
                        b["c"] += diff
                        out.append(b)
            out.sort(key=lambda x: x["t"])
    else:
        # No roll in window (or prior contract unavailable): use the active contract.
        src = (c1 if rolled else c0)
        src_bars = bars1 if (rolled and bars1 is not None) else bars0
        if src_bars is not None and len(src_bars):
            out = [_bar_obj(b) for b in src_bars]
        elif bars0 is not None and len(bars0):
            out = [_bar_obj(b) for b in bars0]
            active_symbol = c0["symbol"]

    if not out:
        return {"ok": False, "error": "no_bars", "underlying": underlying}

    out = out[-count:]
    return {
        "ok": True,
        "underlying": underlying,
        "symbol": active_symbol,
        "tf": tf,
        "continuous": True,
        "rolled": rolled,
        "front": c0["symbol"],
        "next": c1["symbol"] if c1 else None,
        "roll_date": roll_date.isoformat(),
        "expiration": exp0.isoformat(),
        "bars": out,
    }


# ── HTTP server ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

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
        elif parsed.path == "/futures/chain":
            body = futures_chain(q.get("s", ["NQ"])[0])
        elif parsed.path == "/futures/continuous":
            body = futures_continuous(q.get("s", ["NQ"])[0], q.get("tf", ["M5"])[0], q.get("count", ["180"])[0])
        elif parsed.path == "/futures/spec":
            body = futures_spec(q.get("s", ["NQ"])[0])
        else:
            body = {"ok": False, "error": "not_found"}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ensure_init()
    print("Dwella MT5 bridge on 127.0.0.1:%d, mt5=%s" % (PORT, STATE["initialized"]))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
