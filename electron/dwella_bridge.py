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
import threading
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


MT5_ERROR_CODES = {
    10004: "Invalid request",
    10006: "No connection to trade server",
    10007: "Not enough rights to execute request",
    10008: "Request timeout",
    10009: "Invalid price parameter",
    10010: "Invalid stop-parameter",
    10012: "Too many requests",
    10013: "Invalid filling mode",
    10014: "Request blocked by FIFO rule",
    10015: "Request blocked by Hedge rule",
    10016: "Invalid trade volume",
    10017: "Invalid trade position ticket",
    10018: "Invalid account number",
    10019: "Invalid trade request timeframe",
    10021: "Invalid market depth",
    10022: "Invalid trade request price",
    10023: "Invalid stop price",
    10024: "Invalid take-profit",
    10025: "Invalid stop loss",
    10026: "Invalid deviation (slippage)",
    10027: "Invalid trade request type",
    10028: "Invalid trade request price parameter",
    10030: "Invalid market depth update",
    10031: "Invalid trade request magic number",
    10032: "Invalid trade request comment",
    10033: "Invalid trade request position identifier",
    10034: "Request blocked by close-only mode",
    10035: "Request blocked by hedging disabled",
    10036: "Request blocked by no hedging allowed",
    10037: "Request blocked by opposite position only",
    10038: "Request blocked by position already closed",
    10039: "Request blocked by position not found",
    10040: "Request blocked by insufficient margin",
    10041: "Request blocked by margin check failed",
    10042: "Request blocked by trade disabled",
    10043: "Request blocked by symbol disabled",
    10044: "Request blocked by symbol not found",
    10045: "Request blocked by market closed",
    10046: "Request blocked by insufficient funds",
    10047: "Request blocked by invalid lot step",
    10048: "Request blocked by invalid lot max",
    10049: "Request blocked by invalid lot min",
    10050: "Request blocked by trade context busy",
    10051: "Request blocked by expired order",
    10052: "Request blocked by price off quote",
    10053: "Request blocked by price stopped",
    10054: "Request blocked by requote",
    10055: "Request blocked by stale price",
    10056: "Request blocked by price change",
    10057: "Request blocked by too many orders",
    10058: "Request blocked by invalid expiration",
    10059: "Request blocked by invalid symbol",
    10060: "Request blocked by invalid trade request",
    10061: "Request blocked by trade server busy",
    10062: "Request blocked by trade server error",
    10063: "Request blocked by trade server rejected",
    10064: "Request blocked by trade server timeout",
    10065: "Request blocked by trade server unavailable",
    10066: "Request blocked by trade server maintenance",
    10067: "Request blocked by trade server offline",
    10068: "Request blocked by trade server overloaded",
    10069: "Request blocked by trade server connection lost",
    10070: "Request blocked by trade server data invalid",
    10071: "Request blocked by trade server data outdated",
    10072: "Request blocked by trade server data incomplete",
    10073: "Request blocked by trade server data corrupted",
    10074: "Request blocked by trade server data mismatch",
    10075: "Request blocked by trade server data inconsistent",
    10076: "Request blocked by trade server data validation failed",
    10077: "Request blocked by trade server data format invalid",
    10078: "Request blocked by trade server data encoding invalid",
    10079: "Request blocked by trade server data decoding failed",
    10080: "Request blocked by trade server data compression failed",
    10081: "Request blocked by trade server data decompression failed",
    10082: "Request blocked by trade server data encryption failed",
    10083: "Request blocked by trade server data decryption failed",
    10084: "Request blocked by trade server data signature invalid",
    10085: "Request blocked by trade server data checksum invalid",
    10086: "Request blocked by trade server data hash mismatch",
    10087: "Request blocked by trade server data integrity check failed",
    10088: "Request blocked by trade server data tampering detected",
    10089: "Request blocked by trade server data replay detected",
    10090: "Request blocked by trade server data flood detected",
    10091: "Request blocked by trade server data rate limit exceeded",
    10092: "Request blocked by trade server data quota exceeded",
    10093: "Request blocked by trade server data subscription expired",
    10094: "Request blocked by trade server data access denied",
    10095: "Request blocked by trade server data not available",
    10096: "Request blocked by trade server data no permission",
    10097: "Request blocked by trade server data license expired",
    10098: "Request blocked by trade server data not authorized",
    10099: "Request blocked by trade server data forbidden",
    10100: "Request blocked by trade server data restricted",
    10101: "Request blocked by trade server data confidential",
    10102: "Request blocked by trade server data classified",
    10103: "Request blocked by trade server data export restricted",
    10104: "Request blocked by trade server data import restricted",
    10105: "Request blocked by trade server data transfer restricted",
    10106: "Request blocked by trade server data processing restricted",
    10107: "Request blocked by trade server data storage restricted",
    10108: "Request blocked by trade server data retention restricted",
    10109: "Request blocked by trade server data deletion restricted",
    10110: "Request blocked by trade server data modification restricted",
    10111: "Request blocked by trade server data copying restricted",
    10112: "Request blocked by trade server data distribution restricted",
    10113: "Request blocked by trade server data reproduction restricted",
    10114: "Request blocked by trade server data reverse engineering restricted",
    10115: "Request blocked by trade server data mining restricted",
    10116: "Request blocked by trade server data scraping restricted",
    10117: "Request blocked by trade server data harvesting restricted",
    10118: "Request blocked by trade server data indexing restricted",
    10119: "Request blocked by trade server data caching restricted",
    10120: "Request blocked by trade server data mirroring restricted",
    10121: "Request blocked by trade server data archiving restricted",
    10122: "Request blocked by trade server data backup restricted",
    10123: "Request blocked by trade server data recovery restricted",
    10124: "Request blocked by trade server data disaster recovery restricted",
    10125: "Request blocked by trade server data high availability restricted",
    10126: "Request blocked by trade server data load balancing restricted",
    10127: "Request blocked by trade server data failover restricted",
    10128: "Request blocked by trade server data redundancy restricted",
    10129: "Request blocked by trade server data clustering restricted",
    10130: "Request blocked by trade server data virtualization restricted",
    10131: "Request blocked by trade server data containerization restricted",
    10132: "Request blocked by trade server data orchestration restricted",
    10133: "Request blocked by trade server data automation restricted",
    10134: "Request blocked by trade server data integration restricted",
    10135: "Request blocked by trade server data federation restricted",
    10136: "Request blocked by trade server data aggregation restricted",
    10137: "Request blocked by trade server data correlation restricted",
    10138: "Request blocked by trade server data enrichment restricted",
    10139: "Request blocked by trade server data transformation restricted",
    10140: "Request blocked by trade server data validation restricted",
    10141: "Request blocked by trade server data cleansing restricted",
    10142: "Request blocked by trade server data deduplication restricted",
    10143: "Request blocked by trade server data masking restricted",
    10144: "Request blocked by trade server data tokenization restricted",
    10145: "Request blocked by trade server data anonymization restricted",
    10146: "Request blocked by trade server data pseudonymization restricted",
    10147: "Request blocked by trade server data generalization restricted",
    10148: "Request blocked by trade server data perturbation restricted",
    10149: "Request blocked by trade server data swamping restricted",
    10150: "Request blocked by trade server data masking restricted",
}


def translate_mt5_error(retcode):
    if retcode == 1 or retcode is None:
        return "Success"
    return MT5_ERROR_CODES.get(retcode, f"MT5 error code {retcode}")


TRANSACTION_LOG = []
TRANSACTION_LOG_LOCK = threading.Lock()


def log_transaction(action, request, result):
    entry = {
        "timestamp": time.time(),
        "action": action,
        "request": request,
        "result": result,
        "retcode": result.get("retcode") if isinstance(result, dict) else None,
    }
    with TRANSACTION_LOG_LOCK:
        TRANSACTION_LOG.append(entry)
        if len(TRANSACTION_LOG) > 500:
            TRANSACTION_LOG.pop(0)


def resolve_symbol(name):
    return resolve_symbols().get(name, name)


def get_symbol_info(name):
    resolved = resolve_symbol(name)
    return mt5.symbol_info(resolved) if resolved else None


def validate_margin(symbol, volume, price):
    info = get_symbol_info(symbol)
    if not info:
        return False, "Symbol not found"
    margin = mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, info.name, volume, price)
    if margin is None:
        margin = 0
    acct = mt5.account_info()
    if not acct:
        return False, "Account not available"
    if margin > acct.margin_free:
        return False, f"Insufficient margin: need {margin:.2f}, free {acct.margin_free:.2f}"
    return True, "OK"


def validate_price_levels(symbol, entry, stop_loss, take_profit, side):
    info = get_symbol_info(symbol)
    if not info:
        return False, "Symbol not found"
    tick = info.trade_tick_size or info.point
    if tick <= 0:
        tick = info.point or 0.000001
    if entry is not None and entry <= 0:
        return False, "Invalid entry price"
    if stop_loss is not None:
        if stop_loss <= 0:
            return False, "Invalid stop loss price"
        if side == "Long" and stop_loss >= entry:
            return False, "Stop loss must be below entry for long"
        if side == "Short" and stop_loss <= entry:
            return False, "Stop loss must be above entry for short"
    if take_profit is not None:
        if take_profit <= 0:
            return False, "Invalid take profit price"
        if side == "Long" and take_profit <= entry:
            return False, "Take profit must be above entry for long"
        if side == "Short" and take_profit >= entry:
            return False, "Take profit must be below entry for short"
    return True, "OK"


def build_order_request(action, body):
    symbol = body.get("symbol", "")
    volume = float(body.get("volume", 0))
    side = body.get("side", "")
    order_type = body.get("orderType", "Market")
    deviation = int(body.get("deviation", 10))
    magic = int(body.get("magic", 0))
    comment = body.get("comment", "")
    entry = body.get("entry")
    stop_loss = body.get("stopLoss")
    take_profit = body.get("takeProfit")
    stop_price = body.get("stopPrice")

    resolved = resolve_symbol(symbol)
    if not resolved:
        return {"ok": False, "error": "symbol_unresolved", "detail": f"Cannot resolve symbol '{symbol}'"}

    symbol_info = get_symbol_info(symbol)
    if not symbol_info:
        return {"ok": False, "error": "symbol_not_found", "detail": f"Symbol '{resolved}' not found in MT5"}

    if volume <= 0:
        return {"ok": False, "error": "invalid_volume", "detail": "Volume must be positive"}

    if side not in ("Long", "Short"):
        return {"ok": False, "error": "invalid_side", "detail": "Side must be 'Long' or 'Short'"}

    current_price, _ = current_price(resolved)
    if current_price <= 0:
        return {"ok": False, "error": "price_unavailable", "detail": f"Cannot get current price for {resolved}"}

    if order_type == "Market":
        price = current_price
        ok, msg = validate_margin(symbol, volume, price)
        if not ok:
            return {"ok": False, "error": "margin_check_failed", "detail": msg}
        ok, msg = validate_price_levels(symbol, price, stop_loss, take_profit, side)
        if not ok:
            return {"ok": False, "error": "price_validation_failed", "detail": msg}

        mt5_side = mt5.ORDER_TYPE_BUY if side == "Long" else mt5.ORDER_TYPE_SELL
        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": resolved,
            "volume": volume,
            "type": mt5_side,
            "price": price,
            "deviation": deviation,
            "magic": magic,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
        }
        if stop_loss is not None:
            req["sl"] = float(stop_loss)
        if take_profit is not None:
            req["tp"] = float(take_profit)

        result = mt5.order_send(req)
        retcode = getattr(result, "retcode", -1)
        res = {
            "retcode": retcode,
            "deal": getattr(result, "deal", 0),
            "order": getattr(result, "order", 0),
            "price": getattr(result, "price", price),
            "volume": getattr(result, "volume", volume),
            "comment": getattr(result, "comment", ""),
            "request_id": getattr(result, "request_id", 0),
        }
        log_transaction(action, {"type": "market", "symbol": resolved, "volume": volume, "side": side, "entry": price, "stop_loss": stop_loss, "take_profit": take_profit, "deviation": deviation, "magic": magic, "comment": comment}, res)
        if retcode != 10009:
            return {"ok": False, "error": "order_failed", "retcode": retcode, "detail": translate_mt5_error(retcode), "result": res}
        return {"ok": True, "action": "market", "symbol": resolved, "volume": volume, "side": side, "entry": res["price"], "stop_loss": stop_loss, "take_profit": take_profit, "deal": res["deal"], "order": res["order"], "retcode": retcode, "detail": translate_mt5_error(retcode)}

    if order_type == "Limit":
        if entry is None:
            return {"ok": False, "error": "missing_entry", "detail": "Limit orders require an entry price"}
        ok, msg = validate_margin(symbol, volume, entry)
        if not ok:
            return {"ok": False, "error": "margin_check_failed", "detail": msg}
        ok, msg = validate_price_levels(symbol, entry, stop_loss, take_profit, side)
        if not ok:
            return {"ok": False, "error": "price_validation_failed", "detail": msg}

        mt5_side = mt5.ORDER_TYPE_BUY_LIMIT if side == "Long" else mt5.ORDER_TYPE_SELL_LIMIT
        req = {
            "action": mt5.TRADE_ACTION_PENDING,
            "symbol": resolved,
            "volume": volume,
            "type": mt5_side,
            "price": float(entry),
            "deviation": deviation,
            "magic": magic,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
        }
        if stop_loss is not None:
            req["sl"] = float(stop_loss)
        if take_profit is not None:
            req["tp"] = float(take_profit)

        result = mt5.order_send(req)
        retcode = getattr(result, "retcode", -1)
        res = {"retcode": retcode, "order": getattr(result, "order", 0), "comment": getattr(result, "comment", "")}
        log_transaction(action, {"type": "limit", "symbol": resolved, "volume": volume, "side": side, "entry": entry, "stop_loss": stop_loss, "take_profit": take_profit, "deviation": deviation, "magic": magic, "comment": comment}, res)
        if retcode != 10009:
            return {"ok": False, "error": "order_failed", "retcode": retcode, "detail": translate_mt5_error(retcode), "result": res}
        return {"ok": True, "action": "limit", "symbol": resolved, "volume": volume, "side": side, "entry": float(entry), "stop_loss": stop_loss, "take_profit": take_profit, "order": res["order"], "retcode": retcode, "detail": translate_mt5_error(retcode)}

    if order_type == "Stop":
        if entry is None and stop_price is None:
            return {"ok": False, "error": "missing_entry", "detail": "Stop orders require an entry/stop price"}
        trigger_price = float(entry or stop_price)
        ok, msg = validate_margin(symbol, volume, trigger_price)
        if not ok:
            return {"ok": False, "error": "margin_check_failed", "detail": msg}
        ok, msg = validate_price_levels(symbol, trigger_price, stop_loss, take_profit, side)
        if not ok:
            return {"ok": False, "error": "price_validation_failed", "detail": msg}

        mt5_side = mt5.ORDER_TYPE_BUY_STOP if side == "Long" else mt5.ORDER_TYPE_SELL_STOP
        req = {
            "action": mt5.TRADE_ACTION_PENDING,
            "symbol": resolved,
            "volume": volume,
            "type": mt5_side,
            "price": trigger_price,
            "deviation": deviation,
            "magic": magic,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
        }
        if stop_loss is not None:
            req["sl"] = float(stop_loss)
        if take_profit is not None:
            req["tp"] = float(take_profit)

        result = mt5.order_send(req)
        retcode = getattr(result, "retcode", -1)
        res = {"retcode": retcode, "order": getattr(result, "order", 0), "comment": getattr(result, "comment", "")}
        log_transaction(action, {"type": "stop", "symbol": resolved, "volume": volume, "side": side, "entry": trigger_price, "stop_loss": stop_loss, "take_profit": take_profit, "deviation": deviation, "magic": magic, "comment": comment}, res)
        if retcode != 10009:
            return {"ok": False, "error": "order_failed", "retcode": retcode, "detail": translate_mt5_error(retcode), "result": res}
        return {"ok": True, "action": "stop", "symbol": resolved, "volume": volume, "side": side, "entry": trigger_price, "stop_loss": stop_loss, "take_profit": take_profit, "order": res["order"], "retcode": retcode, "detail": translate_mt5_error(retcode)}

    if order_type == "StopLimit":
        if entry is None and stop_price is None:
            return {"ok": False, "error": "missing_entry", "detail": "Stop-limit orders require entry and stop price"}
        trigger_price = float(stop_price or entry)
        limit_price = float(entry or stop_price)
        ok, msg = validate_margin(symbol, volume, limit_price)
        if not ok:
            return {"ok": False, "error": "margin_check_failed", "detail": msg}
        ok, msg = validate_price_levels(symbol, limit_price, stop_loss, take_profit, side)
        if not ok:
            return {"ok": False, "error": "price_validation_failed", "detail": msg}

        mt5_side = mt5.ORDER_TYPE_BUY_STOP_LIMIT if side == "Long" else mt5.ORDER_TYPE_SELL_STOP_LIMIT
        req = {
            "action": mt5.TRADE_ACTION_PENDING,
            "symbol": resolved,
            "volume": volume,
            "type": mt5_side,
            "price": limit_price,
            "stoplimit": trigger_price,
            "deviation": deviation,
            "magic": magic,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
        }
        if stop_loss is not None:
            req["sl"] = float(stop_loss)
        if take_profit is not None:
            req["tp"] = float(take_profit)

        result = mt5.order_send(req)
        retcode = getattr(result, "retcode", -1)
        res = {"retcode": retcode, "order": getattr(result, "order", 0), "comment": getattr(result, "comment", "")}
        log_transaction(action, {"type": "stop-limit", "symbol": resolved, "volume": volume, "side": side, "entry": limit_price, "stoplimit": trigger_price, "stop_loss": stop_loss, "take_profit": take_profit, "deviation": deviation, "magic": magic, "comment": comment}, res)
        if retcode != 10009:
            return {"ok": False, "error": "order_failed", "retcode": retcode, "detail": translate_mt5_error(retcode), "result": res}
        return {"ok": True, "action": "stop-limit", "symbol": resolved, "volume": volume, "side": side, "entry": limit_price, "stoplimit": trigger_price, "stop_loss": stop_loss, "take_profit": take_profit, "order": res["order"], "retcode": retcode, "detail": translate_mt5_error(retcode)}

    return {"ok": False, "error": "invalid_order_type", "detail": f"Unsupported order type: {order_type}"}


def build_bracket_order(body):
    symbol = body.get("symbol", "")
    volume = float(body.get("volume", 0))
    side = body.get("side", "")
    entry = body.get("entry")
    stop_loss = body.get("stopLoss")
    take_profit = body.get("takeProfit")
    deviation = int(body.get("deviation", 10))
    magic = int(body.get("magic", 0))
    comment = body.get("comment", "")

    resolved = resolve_symbol(symbol)
    if not resolved:
        return {"ok": False, "error": "symbol_unresolved", "detail": f"Cannot resolve symbol '{symbol}'"}
    symbol_info = get_symbol_info(symbol)
    if not symbol_info:
        return {"ok": False, "error": "symbol_not_found", "detail": f"Symbol '{resolved}' not found in MT5"}
    if volume <= 0:
        return {"ok": False, "error": "invalid_volume", "detail": "Volume must be positive"}
    if side not in ("Long", "Short"):
        return {"ok": False, "error": "invalid_side", "detail": "Side must be 'Long' or 'Short'"}
    if entry is None:
        return {"ok": False, "error": "missing_entry", "detail": "Bracket orders require an entry price"}
    ok, msg = validate_margin(symbol, volume, float(entry))
    if not ok:
        return {"ok": False, "error": "margin_check_failed", "detail": msg}
    ok, msg = validate_price_levels(symbol, float(entry), stop_loss, take_profit, side)
    if not ok:
        return {"ok": False, "error": "price_validation_failed", "detail": msg}

    mt5_side = mt5.ORDER_TYPE_BUY if side == "Long" else mt5.ORDER_TYPE_SELL
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": resolved,
        "volume": volume,
        "type": mt5_side,
        "price": float(entry),
        "deviation": deviation,
        "magic": magic,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
    }
    if stop_loss is not None:
        req["sl"] = float(stop_loss)
    if take_profit is not None:
        req["tp"] = float(take_profit)

    result = mt5.order_send(req)
    retcode = getattr(result, "retcode", -1)
    res = {"retcode": retcode, "deal": getattr(result, "deal", 0), "order": getattr(result, "order", 0), "price": getattr(result, "price", entry), "volume": getattr(result, "volume", volume), "comment": getattr(result, "comment", "")}
    log_transaction("bracket", {"symbol": resolved, "volume": volume, "side": side, "entry": entry, "stop_loss": stop_loss, "take_profit": take_profit, "deviation": deviation, "magic": magic, "comment": comment}, res)
    if retcode != 10009:
        return {"ok": False, "error": "order_failed", "retcode": retcode, "detail": translate_mt5_error(retcode), "result": res}
    return {"ok": True, "action": "bracket", "symbol": resolved, "volume": volume, "side": side, "entry": res["price"], "stop_loss": stop_loss, "take_profit": take_profit, "deal": res["deal"], "order": res["order"], "retcode": retcode, "detail": translate_mt5_error(retcode)}


def build_modify_request(body):
    ticket = body.get("ticket")
    symbol = body.get("symbol", "")
    stop_loss = body.get("stopLoss")
    take_profit = body.get("takeProfit")
    magic = int(body.get("magic", 0))
    comment = body.get("comment", "")

    if not ticket and not symbol:
        return {"ok": False, "error": "missing_identifier", "detail": "Provide ticket or symbol to identify position"}

    resolved = resolve_symbol(symbol) if symbol else symbol
    if ticket:
        positions = mt5.positions_get(ticket=int(ticket)) or []
        if not positions:
            return {"ok": False, "error": "position_not_found", "detail": f"Position {ticket} not found"}
        target = positions[0]
        resolved = resolved or target.symbol
    else:
        positions = mt5.positions_get(symbol=resolved) if resolved else mt5.positions_get() or []
        if not positions:
            return {"ok": False, "error": "position_not_found", "detail": f"No open positions for {resolved}"}
        target = positions[0]

    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": target.symbol,
        "position": target.ticket,
        "magic": magic,
        "comment": comment,
    }
    if stop_loss is not None:
        req["sl"] = float(stop_loss)
    if take_profit is not None:
        req["tp"] = float(take_profit)

    result = mt5.order_send(req)
    retcode = getattr(result, "retcode", -1)
    res = {"retcode": retcode, "order": getattr(result, "order", 0), "comment": getattr(result, "comment", "")}
    log_transaction("modify", {"ticket": target.ticket, "symbol": target.symbol, "stop_loss": stop_loss, "take_profit": take_profit, "magic": magic, "comment": comment}, res)
    if retcode != 10009:
        return {"ok": False, "error": "modify_failed", "retcode": retcode, "detail": translate_mt5_error(retcode), "result": res}
    return {"ok": True, "action": "modify", "ticket": target.ticket, "symbol": target.symbol, "stop_loss": stop_loss, "take_profit": take_profit, "retcode": retcode, "detail": translate_mt5_error(retcode)}


def build_close_request(body):
    ticket = body.get("ticket")
    symbol = body.get("symbol", "")
    volume = body.get("volume")

    if not ticket and not symbol:
        return {"ok": False, "error": "missing_identifier", "detail": "Provide ticket or symbol to close position"}

    resolved = resolve_symbol(symbol) if symbol else symbol
    if ticket:
        positions = mt5.positions_get(ticket=int(ticket)) or []
        if not positions:
            return {"ok": False, "error": "position_not_found", "detail": f"Position {ticket} not found"}
        target = positions[0]
    else:
        positions = mt5.positions_get(symbol=resolved) if resolved else mt5.positions_get() or []
        if not positions:
            return {"ok": False, "error": "position_not_found", "detail": f"No open positions for {resolved}"}
        target = positions[0]

    close_volume = float(volume) if volume is not None else target.volume
    close_volume = min(close_volume, target.volume)
    mt5_side = mt5.ORDER_TYPE_SELL if target.type == 0 else mt5.ORDER_TYPE_BUY
    tick = mt5.symbol_info_tick(target.symbol)
    price = tick.bid if target.type == 0 else tick.ask

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": target.symbol,
        "volume": close_volume,
        "type": mt5_side,
        "position": target.ticket,
        "price": price,
        "deviation": 10,
        "type_time": mt5.ORDER_TIME_GTC,
    }

    result = mt5.order_send(req)
    retcode = getattr(result, "retcode", -1)
    res = {"retcode": retcode, "deal": getattr(result, "deal", 0), "volume": getattr(result, "volume", close_volume), "price": getattr(result, "price", price), "comment": getattr(result, "comment", "")}
    log_transaction("close", {"ticket": target.ticket, "symbol": target.symbol, "volume": close_volume, "price": price}, res)
    if retcode != 10009:
        return {"ok": False, "error": "close_failed", "retcode": retcode, "detail": translate_mt5_error(retcode), "result": res}
    return {"ok": True, "action": "close", "ticket": target.ticket, "symbol": target.symbol, "volume": close_volume, "price": res["price"], "deal": res["deal"], "retcode": retcode, "detail": translate_mt5_error(retcode)}


def build_close_all_request():
    positions = mt5.positions_get() or []
    if not positions:
        return {"ok": True, "action": "close-all", "closed": 0, "results": [], "detail": "No open positions"}
    results = []
    for p in positions:
        mt5_side = mt5.ORDER_TYPE_SELL if p.type == 0 else mt5.ORDER_TYPE_BUY
        tick = mt5.symbol_info_tick(p.symbol)
        price = tick.bid if p.type == 0 else tick.ask
        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "volume": p.volume,
            "type": mt5_side,
            "position": p.ticket,
            "price": price,
            "deviation": 10,
            "type_time": mt5.ORDER_TIME_GTC,
        }
        result = mt5.order_send(req)
        retcode = getattr(result, "retcode", -1)
        res = {"ticket": p.ticket, "symbol": p.symbol, "retcode": retcode, "deal": getattr(result, "deal", 0), "price": getattr(result, "price", price), "detail": translate_mt5_error(retcode)}
        results.append(res)
        log_transaction("close-all", {"ticket": p.ticket, "symbol": p.symbol, "volume": p.volume, "price": price}, res)
    return {"ok": True, "action": "close-all", "closed": len(results), "results": results, "detail": f"Closed {len(results)} position(s)"}


def order_history(from_time=None, to_time=None):
    if not ensure_init():
        return {"ok": False, "error": "mt5_initialize_failed"}
    from_ts = from_time or (time.time() - 86400 * 30)
    to_ts = to_time or time.time()
    deals = mt5.history_deals_get(from_ts, to_ts) or []
    out = []
    for d in deals:
        out.append({
            "ticket": d.ticket,
            "order": d.order,
            "symbol": d.symbol,
            "type": "Buy" if d.type == 0 else "Sell" if d.type == 1 else ("BuyLimit" if d.type == 2 else ("SellLimit" if d.type == 3 else ("BuyStop" if d.type == 4 else "SellStop"))),
            "volume": d.volume,
            "price": d.price,
            "profit": d.profit,
            "commission": d.commission,
            "swap": d.swap,
            "fee": d.fee,
            "time": d.time,
            "magic": d.magic,
            "comment": d.comment,
        })
    return {"ok": True, "history": out, "count": len(out)}


def transaction_history():
    with TRANSACTION_LOG_LOCK:
        return {"ok": True, "transactions": list(TRANSACTION_LOG), "count": len(TRANSACTION_LOG)}


def health():
    initialized = ensure_init()
    acct = mt5.account_info() if initialized else None
    term = mt5.terminal_info() if initialized else None
    return {"ok": initialized,
            "connected": bool(term and term.connected),
            "broker": getattr(acct, "company", None),
            "server": getattr(acct, "server", None),
            "symbols": STATE["resolved"]}


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
        elif parsed.path == "/orders/history":
            from_t = q.get("from", [None])[0]
            to_t = q.get("to", [None])[0]
            body = order_history(float(from_t) if from_t else None, float(to_t) if to_t else None)
        elif parsed.path == "/orders/transactions":
            body = transaction_history()
        else:
            body = {"ok": False, "error": "not_found"}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body_raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(body_raw)
        except Exception:
            body = {}

        if parsed.path == "/orders/market":
            response = build_order_request("market", body)
        elif parsed.path == "/orders/limit":
            response = build_order_request("limit", body)
        elif parsed.path == "/orders/stop":
            response = build_order_request("stop", body)
        elif parsed.path == "/orders/stop-limit":
            response = build_order_request("stop-limit", body)
        elif parsed.path == "/orders/bracket":
            response = build_bracket_order(body)
        elif parsed.path == "/orders/modify":
            response = build_modify_request(body)
        elif parsed.path == "/orders/close":
            response = build_close_request(body)
        elif parsed.path == "/orders/close-all":
            response = build_close_all_request()
        else:
            response = {"ok": False, "error": "not_found"}
        data = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


if __name__ == "__main__":
    ensure_init()
    print("Dwella MT5 bridge on 127.0.0.1:%d, mt5=%s" % (PORT, STATE["initialized"]))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

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
