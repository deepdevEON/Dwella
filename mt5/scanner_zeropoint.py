#!/usr/bin/env python3
"""
scanner_zeropoint.py — Dwella Auto-Trading Scanner with ZeroPoint™ PRO

Watches live candles for every configured futures contract via the sidecar,
runs the ZeroPoint PRO strategy (ATR trailing stop + market structure + order blocks),
and executes trades directly through TradingView Paper Trading.

Architecture:
  sidecar (/candles) → scanner (ZeroPoint eval) → TV UI (order execution)

Risk rules:
  - Daily loss limit: 7% of account balance
  - ATR-based stop loss with smart structure
  - TP1/TP2/TP3 targets
  - Max 3 open positions
  - Cooldown: 5 min between trades on same symbol
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

# Import ZeroPoint strategy
from zeropoint_strategy import ZeroPointEngine, Signal as ZPSignal, Candle

# ── Config ────────────────────────────────────────────────────────────
SYMBOLS = ["ENQ", "MES", "GCE", "YM", "ES", "RTY", "CL", "SI", "NQ"]
SIDECAR_URL = "http://127.0.0.1:18814"
SCAN_INTERVAL = 3.0
CANDLE_LOOKBACK = 100
COOLDOWN_SECONDS = 300
DAILY_LOSS_PCT = 0.07
MAX_POSITIONS = 3
DAILY_POSITION_LIMIT = 3

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scanner_daily.json")
DEFAULT_QTY = 1

POINT_VALUES = {
    # ENQ = Micro E-mini Nasdaq (MNQ1!) $2/pt; GCE = full Gold (GC1!) $100/pt
    "ENQ": 2.0, "MES": 1.25, "GCE": 100.0, "YM": 5.0,
    "ES": 50.0, "RTY": 50.0, "CL": 1000.0, "SI": 5000.0, "NQ": 20.0,
}

TV_SYMBOL_MAP = {
    "ENQ": "CME_MINI:MNQ1!", "MES": "CME_MINI:MES1!", "GCE": "COMEX:GC1!",
    "YM": "CBOT_MINI:YM1!", "ES": "CME_MINI:ES1!", "RTY": "CME_MINI:RTY1!",
    "CL": "NYMEX:CL1!", "SI": "COMEX:SI1!", "NQ": "CME_MINI:NQ1!",
}

def short_symbol(tv_symbol: str) -> str:
    """Map a TradingView position symbol back to a Dwella short name."""
    import re as _re
    s = (tv_symbol or "").upper()
    bare = s.split(":")[-1].replace("!", "").strip()
    for short, tv in TV_SYMBOL_MAP.items():
        tv_root = tv.split(":")[-1].replace("!", "").strip()
        if tv_root == bare:
            return short
    for short, tv in TV_SYMBOL_MAP.items():
        tv_root = tv.split(":")[-1].replace("!", "").strip()
        root_short = _re.sub(r"\d", "", tv_root)
        if root_short and (bare == root_short or bare.startswith(root_short) or bare.endswith(root_short)):
            return short
    m = _re.match(r"[A-Z]+", bare)
    return m.group(0) if m else s

MCP_CLI = os.environ.get(
    "DWELLA_MCP_CLI",
    os.path.join(os.path.expanduser("~"), "tradingview-mcp", "src", "cli", "index.js"),
)
NODE_BIN = os.environ.get("DWELLA_NODE", "node")


# ── Signal types ──────────────────────────────────────────────────────

@dataclass
class Signal:
    strategy: str = "ZEROPOINT"
    symbol: str = ""
    direction: str = ""  # long / short
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0  # TP1 (primary target)
    target2: float = 0.0  # TP2
    target3: float = 0.0  # TP3
    atr: float = 0.0
    area: str = ""
    confirmed: bool = True
    time: float = field(default_factory=time.time)
    executed: bool = False
    order_id: str = ""
    bar_time: int = 0
    setup_key: str = ""
    qty: int = DEFAULT_QTY
    risk_usd: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# ── Scanner state ─────────────────────────────────────────────────────

def _load_daily_state() -> dict:
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_daily_state(state: dict) -> None:
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass


def _today_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@dataclass
class ScannerState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    running: bool = False
    armed: bool = False
    signals: list[dict] = field(default_factory=list)
    trade_log: list[dict] = field(default_factory=list)
    daily_pnl: float = 0.0
    daily_start_balance: float = 0.0
    daily_start_realized: Optional[float] = None
    daily_start_date: str = ""
    open_positions: int = 0
    open_symbols: set[str] = field(default_factory=set)
    last_scan: str = ""
    errors: list[str] = field(default_factory=list)
    cooldowns: dict = field(default_factory=dict)
    pnl_today: float = 0.0
    scan_log: list[dict] = field(default_factory=list)
    daily_positions_taken: int = 0
    daily_date: str = ""
    triggered_setups: set[str] = field(default_factory=set)
    # ZeroPoint dashboard data per symbol
    zeropoint_dashboards: dict = field(default_factory=dict)

    def _sync_daily(self, realized_pnl: Optional[float] = None) -> None:
        saved = _load_daily_state()
        today = _today_key()
        same_day = saved.get("date") == today
        if same_day:
            self.daily_positions_taken = int(saved.get("positions_taken", 0))
            self.triggered_setups = set(saved.get("setup_keys", []))
            self.daily_start_realized = saved.get("start_realized")
            self.daily_start_date = today
        else:
            self.daily_positions_taken = 0
            self.triggered_setups = set()
            self.daily_start_realized = realized_pnl
            self.daily_start_date = today
            _save_daily_state({
                "date": today,
                "positions_taken": 0,
                "setup_keys": [],
                "start_realized": realized_pnl,
            })
        self.daily_date = today
        if realized_pnl is not None and self.daily_start_realized is not None:
            self.daily_pnl = round(float(realized_pnl) - float(self.daily_start_realized), 2)
            self.pnl_today = self.daily_pnl

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "running": self.running,
                "armed": self.armed,
                "signals": self.signals[-20:],
                "trade_log": self.trade_log[-50:],
                "daily_pnl": self.daily_pnl,
                "pnl_today": self.pnl_today,
                "open_positions": self.open_positions,
                "last_scan": self.last_scan,
                "errors": self.errors[-10:],
                "scan_log": self.scan_log[-12:],
                "symbols": SYMBOLS,
                "daily_positions_taken": self.daily_positions_taken,
                "daily_position_limit": DAILY_POSITION_LIMIT,
                "daily_date": self.daily_date,
                "daily_start_realized": self.daily_start_realized,
                "triggered_setups": len(self.triggered_setups),
                "entry_units": DEFAULT_QTY,
                "strategy": "ZEROPOINT",
                "zeropoint_dashboards": self.zeropoint_dashboards,
                "config": {
                    "scan_interval": SCAN_INTERVAL,
                    "daily_loss_pct": DAILY_LOSS_PCT,
                    "max_positions": MAX_POSITIONS,
                    "cooldown_seconds": COOLDOWN_SECONDS,
                    "default_qty": DEFAULT_QTY,
                    "entry_units": DEFAULT_QTY,
                    "daily_position_limit": DAILY_POSITION_LIMIT,
                },
            }


# ── ZeroPoint Strategy Engine ─────────────────────────────────────────

# Create a ZeroPoint engine instance for each symbol
_zp_engines: dict[str, ZeroPointEngine] = {}


def get_zp_engine(symbol: str) -> ZeroPointEngine:
    """Get or create ZeroPoint engine for a symbol."""
    if symbol not in _zp_engines:
        _zp_engines[symbol] = ZeroPointEngine(symbol=symbol)
    return _zp_engines[symbol]


def scan_zeropoint(candles: list[dict], symbol: str, current_price: float) -> list[Signal]:
    """
    Run ZeroPoint PRO strategy on candles.
    Returns list of signals (usually 0 or 1).
    """
    if len(candles) < 20:
        return []
        
    engine = get_zp_engine(symbol)
    
    # Convert dict candles to Candle objects
    candle_objs = []
    for c in candles:
        candle_objs.append(Candle(
            time=int(c.get("time", 0)),
            open=float(c.get("open", 0)),
            high=float(c.get("high", 0)),
            low=float(c.get("low", 0)),
            close=float(c.get("close", 0)),
            volume=float(c.get("volume", 0)),
        ))
    
    # Process the latest candle
    signal = engine.process_candle(candle_objs)
    
    if signal and signal.confirmed:
        return [Signal(
            strategy="ZEROPOINT",
            symbol=symbol,
            direction=signal.direction,
            entry=signal.entry,
            stop=signal.stop,
            target=signal.target1,  # TP1 is primary
            target2=signal.target2,
            target3=signal.target3,
            atr=signal.atr,
            area=f"ATR Trail Flip",
            confirmed=True,
            bar_time=signal.bar_time,
            setup_key=signal.setup_key,
        )]
    
    return []


# ── TradingView order execution via UI automation ─────────────────────

def tv_ui_eval(js_code: str, timeout: int = 15) -> Optional[dict]:
    cmd = [NODE_BIN, MCP_CLI, "ui", "eval", js_code]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        return None
    except Exception:
        return None


def tv_ui_click(selector: str, value: str) -> Optional[dict]:
    cmd = ["node", MCP_CLI, "ui", "click", "-b", selector, "-v", value]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        return None
    except Exception:
        return None


def _tv_symbol_root(tv_sym: str) -> str:
    import re as _re
    s = (tv_sym or "").split(":")[-1].replace("!", "").upper().strip()
    return _re.sub(r"\d+$", "", s)


def _tv_chart_on(target_root: str) -> bool:
    try:
        result = subprocess.run([NODE_BIN, MCP_CLI, "state"], capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout or "{}")
        cur_root = _tv_symbol_root(data.get("symbol", ""))
        return cur_root == target_root or cur_root.startswith(target_root)
    except Exception:
        return False


def tv_set_symbol(tv_sym: str) -> bool:
    target_root = _tv_symbol_root(tv_sym)
    cmd = [NODE_BIN, MCP_CLI, "symbol", tv_sym]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and _tv_chart_on(target_root):
            return True
    except Exception:
        pass
    js = f"(function(){{var w=TradingView&&TradingView.activeChart&&TradingView.activeChart();if(w){{try{{w.setSymbol('{tv_sym}');return {{ok:true}}}}catch(e){{}}}}return {{ok:false}}}})()"
    res = tv_ui_eval(js)
    try:
        r = json.loads(res["result"]) if res and isinstance(res.get("result"), str) else (res or {}).get("result")
        if r and r.get("ok"):
            time.sleep(1.2)
            return _tv_chart_on(target_root)
    except Exception:
        pass
    return False


def execute_order(signal: Signal, qty: int = DEFAULT_QTY) -> Optional[str]:
    """Execute a trade via TradingView Paper Trading UI."""
    symbol = signal.symbol
    direction = signal.direction
    
    tv_sym = TV_SYMBOL_MAP.get(symbol)
    if not tv_sym or not tv_set_symbol(tv_sym):
        return None
    
    ready = False
    expected = signal.entry
    for _ in range(20):
        time.sleep(0.5)
        chk = tv_ui_eval(f"""
        (function() {{
            var btn = document.querySelector('[data-name="buy-order-button"]');
            if (!btn) return {{ready: false}};
            var txt = (btn.textContent || '').trim();
            var m = txt.match(/[\\d,.]+/);
            if (!m) return {{ready: false}};
            var price = parseFloat(m[0].replace(/,/g, ''));
            return {{ready: price > 0, price: price}};
        }})()
        """)
        try:
            r = json.loads(chk["result"]) if isinstance(chk.get("result"), str) else chk.get("result")
        except Exception:
            r = None
        if r and r.get("ready") and r.get("price") > 0:
            if abs(r["price"] - expected) / max(expected, 1) < 0.2:
                ready = True
                break
    if not ready:
        return None
    
    mkt_js = """
    (function() {
        var panel = document.querySelector('[data-name="order-panel"]');
        if (!panel) return {ok: false};
        var btns = Array.from(panel.querySelectorAll('button'));
        for (var b of btns) {
            if ((b.textContent || '').trim() === 'Market') { b.click(); return {ok: true}; }
        }
        return {ok: false};
    })()
    """
    tv_ui_eval(mkt_js)
    time.sleep(0.6)

    side_name = "side-control-buy" if direction == "long" else "side-control-sell"
    side_js = f"""
    (function() {{
        var panel = document.querySelector('[data-name="order-panel"]');
        if (!panel) return {{ok: false, error: 'no order panel'}};
        var side = panel.querySelector('[data-name="{side_name}"]');
        if (!side) return {{ok: false, error: 'no side control'}};
        side.click();
        return {{ok: true}};
    }})()
    """
    r1 = tv_ui_eval(side_js)
    try:
        s1 = json.loads(r1["result"]) if r1 and isinstance(r1.get("result"), str) else (r1 or {}).get("result")
    except Exception:
        s1 = None
    if not (s1 and s1.get("ok")):
        head_sel = "buy-order-button" if direction == "long" else "sell-order-button"
        fb = tv_ui_eval(f'(function(){{var b=document.querySelector(\'[data-name="{head_sel}"]\');if(!b)return {{ok:false}};b.click();return {{ok:true}}}})()')
    time.sleep(0.8)

    sl_price = signal.stop
    tp_price = signal.target  # TP1
    sltp_js = f"""
    (function() {{
        var panel = document.querySelector('[data-name="order-panel"]');
        if (!panel) return {{ok: false, error: 'no order panel'}};
        var inputs = Array.from(panel.querySelectorAll('input')).filter(function(i) {{
            var r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        }});
        var setVal = function(inp, val) {{
            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inp, val);
            inp.dispatchEvent(new Event('input', {{bubbles: true}}));
            inp.dispatchEvent(new Event('change', {{bubbles: true}}));
        }};
        var boxes = inputs.filter(function(i) {{ return i.type === 'checkbox'; }});
        for (var b of boxes) {{ if (!b.checked) {{ b.click(); }} }}
        var found = {{sl: null, tp: null}};
        for (var i = 0; i < inputs.length; i++) {{
            var inp = inputs[i];
            if (inp.type !== 'text' && inp.type !== 'number') continue;
            var node = inp; var ctx = '';
            for (var d = 0; d < 5 && node; d++) {{
                node = node.parentElement;
                if (node) {{ ctx = (node.textContent || '').replace(/\\s+/g, ' '); if (ctx) break; }}
            }}
            var lc = ctx.toLowerCase();
            if (!found.sl && /stop loss/.test(lc)) found.sl = inp;
            if (!found.tp && /take profit/.test(lc)) found.tp = inp;
        }}
        if (found.tp) setVal(found.tp, '{tp_price:.2f}');
        if (found.sl) setVal(found.sl, '{sl_price:.2f}');
        return {{ok: true, sl: !!found.sl, tp: !!found.tp}};
    }})()
    """
    tv_ui_eval(sltp_js)
    time.sleep(0.6)

    confirm_js = """
    (function() {
        var panel = document.querySelector('[data-name="order-panel"]');
        if (!panel) return {ok: false, error: 'no order panel'};
        var btn = panel.querySelector('[data-name="place-and-modify-button"]');
        if (!btn) return {ok: false, error: 'no confirm button'};
        btn.click();
        return {ok: true};
    })()
    """
    r2 = tv_ui_eval(confirm_js)
    try:
        s2 = json.loads(r2["result"]) if r2 and isinstance(r2.get("result"), str) else (r2 or {}).get("result")
    except Exception:
        s2 = None
    if not (s2 and s2.get("ok")):
        return None

    time.sleep(2.5)
    verify_js = f"""
    (function() {{
        var table = document.querySelector('[data-name="Paper.orders-table"]');
        if (!table) return {{ok: false, error: 'no orders table'}};
        var rows = table.querySelectorAll('tbody tr');
        for (var i = 0; i < rows.length; i++) {{
            var txt = rows[i].textContent || '';
            var expected = {{
                'ENQ': ['MNQ1', 'MNQ'], 'MES': ['MES1', 'MES'], 'GCE': ['GC1', 'GC'],
                'YM': ['YM1', 'YM'], 'ES': ['ES1', 'ES'], 'RTY': ['RTY1', 'RTY'],
                'CL': ['CL1', 'CL'], 'SI': ['SI1', 'SI'], 'NQ': ['NQ1', 'NQ']
            }}['{symbol}'] || ['{symbol}'];
            var looksNew = expected.some(function (name) {{ return txt.indexOf(name) !== -1; }});
            if (looksNew && (txt.toLowerCase().indexOf('fill') !== -1 || txt.toLowerCase().indexOf('placing') !== -1 || txt.toLowerCase().indexOf('working') !== -1)) {{
                return {{ok: true, status: 'found'}};
            }}
        }}
        return {{ok: false, rows: rows.length}};
    }})()
    """
    r3 = tv_ui_eval(verify_js)
    try:
        s3 = json.loads(r3["result"]) if r3 and isinstance(r3.get("result"), str) else (r3 or {}).get("result")
    except Exception:
        s3 = None
    if not (s3 and s3.get("ok")):
        return None

    return f"TV-{symbol}-{int(time.time())}"


# ── Risk management ───────────────────────────────────────────────────

def check_risk(state: ScannerState, balance: float) -> tuple[bool, str]:
    with state.lock:
        state._sync_daily()
        if state.daily_start_balance > 0:
            loss_limit = state.daily_start_balance * DAILY_LOSS_PCT
            if state.daily_pnl <= -loss_limit:
                return False, f"Daily loss limit hit (${state.daily_pnl:.2f} / -${loss_limit:.2f})"
        if state.open_positions >= MAX_POSITIONS:
            return False, f"Max positions reached ({state.open_positions}/{MAX_POSITIONS})"
        if state.daily_positions_taken >= DAILY_POSITION_LIMIT:
            return False, f"Daily position limit reached ({state.daily_positions_taken}/{DAILY_POSITION_LIMIT})"
    return True, "OK"


def account_entry_units(signal: Signal, account: dict) -> int:
    """
    Decide whether a signal is sizeable. Returns DEFAULT_QTY (trade it) or 0
    (skip). Unknown balance (scrape failed) never blocks a trade — otherwise
    a single DOM hiccup would silently stop ALL trading.
    """
    balance = float(account.get("balance") or account.get("equity") or 0)
    available = float(account.get("margin_free") or account.get("available_funds") or balance)
    # Degenerate signals — never trade them: stop at/behind entry, or on
    # the wrong side of the position entirely.
    if signal.direction == "long" and signal.stop >= signal.entry:
        return 0
    if signal.direction == "short" and signal.stop <= signal.entry:
        return 0
    unit_risk = abs(signal.entry - signal.stop) * POINT_VALUES.get(signal.symbol, 0)
    if unit_risk <= 0:
        return 0
    # Can't judge risk without numbers — proceed with the default size.
    if balance <= 0 or available <= 0:
        return DEFAULT_QTY
    # A single unit may never risk more than the daily loss budget.
    if unit_risk > balance * DAILY_LOSS_PCT:
        return 0
    return DEFAULT_QTY


def check_cooldown(state: ScannerState, symbol: str) -> bool:
    with state.lock:
        last = state.cooldowns.get(symbol, 0)
        return time.time() - last >= COOLDOWN_SECONDS


# ── Data fetching ─────────────────────────────────────────────────────

def fetch_candles(symbol: str) -> list[dict]:
    import urllib.request
    try:
        url = f"{SIDECAR_URL}/candles?symbol={symbol}&count={CANDLE_LOOKBACK}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("candles", [])
    except Exception:
        return []


def fetch_account() -> dict:
    import urllib.request
    try:
        url = f"{SIDECAR_URL}/account"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("account", {})
    except Exception:
        return {}


def fetch_positions() -> list[dict]:
    import urllib.request
    try:
        url = f"{SIDECAR_URL}/positions"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("positions", [])
    except Exception:
        return []


# ── Main scanner loop ────────────────────────────────────────────────

def scanner_loop(state: ScannerState) -> None:
    import urllib.request
    
    while state.running:
        try:
            with state.lock:
                disarmed = not state.armed
                if disarmed:
                    state.last_scan = "Disarmed — scanning but not executing"
            if disarmed:
                time.sleep(SCAN_INTERVAL)
                continue
            
            account = fetch_account()
            balance = account.get("balance", 100000)
            realized = account.get("realized_pnl")
            with state.lock:
                state._sync_daily(float(realized) if realized is not None else None)
                if realized is not None and state.daily_start_realized is not None:
                    state.daily_pnl = round(float(realized) - float(state.daily_start_realized), 2)
                    state.pnl_today = state.daily_pnl

            try:
                real_positions = fetch_positions()
                with state.lock:
                    state.open_positions = len(real_positions)
                    state.open_symbols = {
                        short_symbol(p.get("symbol", "")) for p in real_positions
                    } - {None, ""}
            except Exception:
                pass
            
            with state.lock:
                if state.daily_start_balance == 0:
                    state.daily_start_balance = balance
            
            allowed, reason = check_risk(state, balance)
            if not allowed:
                with state.lock:
                    state.last_scan = f"Risk: {reason}"
                time.sleep(SCAN_INTERVAL)
                continue
            
            all_signals = []
            scan_entries = []
            dashboards = {}
            
            for symbol in SYMBOLS:
                candles = fetch_candles(symbol)
                if not candles or len(candles) < 20:
                    scan_entries.append({"symbol": symbol, "status": "no data", "candles": len(candles) if candles else 0})
                    continue
                
                current_price = candles[-1].get("close", 0)
                if current_price <= 0:
                    scan_entries.append({"symbol": symbol, "status": "no price"})
                    continue
                
                # Run ZeroPoint strategy
                signals = scan_zeropoint(candles, symbol, current_price)
                
                # Get ZeroPoint dashboard data
                engine = get_zp_engine(symbol)
                dashboards[symbol] = engine.get_dashboard()
                
                bar_time = int(candles[-1].get("time", 0) or 0)
                for signal in signals:
                    signal.bar_time = bar_time
                    signal.setup_key = f"{symbol}:ZEROPOINT:{signal.direction}:{bar_time}"
                    signal.qty = DEFAULT_QTY
                    signal.risk_usd = round(
                        abs(signal.entry - signal.stop) * POINT_VALUES.get(symbol, 0), 2
                    )
                all_signals.extend(signals)
                
                scan_entries.append({
                    "symbol": symbol,
                    "status": "signal" if signals else "watching",
                    "price": round(current_price, 2),
                    "candles": len(candles),
                    "dashboard": dashboards.get(symbol, {}),
                })
            
            with state.lock:
                state.signals = [s.to_dict() for s in all_signals[-20:]]
                state.scan_log = scan_entries
                state.zeropoint_dashboards = dashboards
                state.last_scan = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
            
            for signal in all_signals:
                if not signal.confirmed:
                    continue

                allowed, _ = check_risk(state, balance)
                if not allowed:
                    continue

                with state.lock:
                    if signal.setup_key and signal.setup_key in state.triggered_setups:
                        continue

                if not check_cooldown(state, signal.symbol):
                    continue

                with state.lock:
                    if signal.symbol in state.open_symbols:
                        state.last_scan = f"Skipped {signal.symbol}: position already open"
                        continue

                units = account_entry_units(signal, account)
                signal.qty = units
                if units != DEFAULT_QTY:
                    with state.lock:
                        state.last_scan = f"Risk: {signal.symbol} setup too large"
                    continue
                try:
                    order_id = execute_order(signal, qty=DEFAULT_QTY)
                except Exception as exc:
                    order_id = None
                    with state.lock:
                        state.errors.append(f"EXEC {signal.symbol}: {exc}")
                        if len(state.errors) > 50:
                            state.errors = state.errors[-50:]
                if order_id:
                    signal.executed = True
                    signal.order_id = order_id
                    
                    with state.lock:
                        state.trade_log.append({
                            "time": datetime.now(timezone.utc).isoformat(),
                            "strategy": "ZEROPOINT",
                            "symbol": signal.symbol,
                            "direction": signal.direction,
                            "entry": signal.entry,
                            "stop": signal.stop,
                            "target": signal.target,
                            "target2": signal.target2,
                            "target3": signal.target3,
                            "order_id": order_id,
                            "atr": signal.atr,
                        })
                        state.cooldowns[signal.symbol] = time.time()
                        state.open_positions += 1
                        state.open_symbols.add(signal.symbol)
                        state._sync_daily()
                        state.daily_positions_taken += 1
                        if signal.setup_key:
                            state.triggered_setups.add(signal.setup_key)
                        _save_daily_state({
                            "date": _today_key(),
                            "positions_taken": state.daily_positions_taken,
                            "setup_keys": sorted(state.triggered_setups),
                            "start_realized": state.daily_start_realized,
                        })
            
        except Exception as exc:
            with state.lock:
                state.errors.append(f"{datetime.now(timezone.utc).strftime('%H:%M')}: {exc}")
                if len(state.errors) > 50:
                    state.errors = state.errors[-50:]
        
        time.sleep(SCAN_INTERVAL)


# ── Public API ────────────────────────────────────────────────────────

def start_scanner(state: ScannerState) -> threading.Thread:
    with state.lock:
        state.running = True
    t = threading.Thread(target=scanner_loop, args=(state,), daemon=True)
    t.start()
    return t


def stop_scanner(state: ScannerState) -> None:
    with state.lock:
        state.running = False
        state.armed = False


def arm_scanner(state: ScannerState, armed: bool = True) -> None:
    with state.lock:
        state.armed = armed


def reset_daily_pnl(state: ScannerState) -> None:
    with state.lock:
        state.daily_pnl = 0.0
        state.pnl_today = 0.0
        state.daily_start_balance = 0.0
        state.daily_start_realized = None
        state.daily_start_date = ""
        state.cooldowns.clear()


def reset_daily_positions(state: ScannerState) -> None:
    with state.lock:
        state.daily_positions_taken = 0
        state.triggered_setups = set()
        state.cooldowns.clear()
        state.daily_date = _today_key()
        _save_daily_state({
            "date": state.daily_date,
            "positions_taken": 0,
            "setup_keys": [],
            "start_realized": state.daily_start_realized,
        })
