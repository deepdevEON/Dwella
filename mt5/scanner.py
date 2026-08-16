#!/usr/bin/env python3
"""
scanner.py — Dwella Auto-Trading Scanner

Watches live candles for every configured futures contract via the sidecar,
runs the SNIPER (EMA pullback) + BARK/IZZY/PICK/SLUG strategies,
and executes trades directly through TradingView Paper Trading.

Architecture:
  sidecar (/candles) → scanner (strategy eval) → TV UI (order execution)

Risk rules (from Helios):
  - Daily loss limit: 7% of account balance
  - Fixed stop: ATR × 1.15 (confirmation distance)
  - Target: 2R (risk-reward 1:2)
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

# ── Config ────────────────────────────────────────────────────────────
# Every symbol here is scanned independently. The daily limit still caps
# confirmed entries at three, but a signal on one contract can never fall
# through to another contract.
SYMBOLS = ["ENQ", "MES", "GCE", "YM", "ES", "RTY", "CL", "SI", "NQ"]
SIDECAR_URL = "http://127.0.0.1:18814"
SCAN_INTERVAL = 3.0          # seconds between scans
CANDLE_LOOKBACK = 100        # candles to fetch per symbol
COOLDOWN_SECONDS = 300       # 5 min between trades per symbol
DAILY_LOSS_PCT = 0.07        # 7% daily loss limit
MAX_POSITIONS = 3            # max concurrent positions
DAILY_POSITION_LIMIT = 3     # max NEW positions per day (user rule: 3/day)

# Persisted daily counters survive sidecar restarts (launchd KeepAlive).
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scanner_daily.json")
# One confirmed setup produces one entry of one contract. This is a hard
# guard for both the scanner and the persisted setup de-duplication below.
DEFAULT_QTY = 1
ATR_PERIOD = 14              # ATR lookback
POINT_VALUES = {
    "ENQ": 5.0,    # Micro Nasdaq (MNQ)
    "MES": 1.25,   # Micro S&P
    "GCE": 10.0,   # Gold
    "YM": 5.0,     # Dow Jones mini
    "ES": 50.0,    # E-mini S&P
    "RTY": 50.0,   # Russell 2000 mini
    "CL": 1000.0,  # Crude oil
    "SI": 5000.0,  # Silver
    "NQ": 20.0,    # E-mini Nasdaq
}

# Dwella short name → TradingView symbol (also used by execute_order).
TV_SYMBOL_MAP = {
    "ENQ": "CME_MINI:MNQ1!", "MES": "CME_MINI:MES1!", "GCE": "COMEX:GC1!",
    "YM": "CBOT_MINI:YM1!", "ES": "CME_MINI:ES1!", "RTY": "CME_MINI:RTY1!",
    "CL": "NYMEX:CL1!", "SI": "COMEX:SI1!", "NQ": "CME_MINI:NQ1!",
}
# Reverse: TradingView position symbol → Dwella short name. Matching is
# tolerant: "NYMEX:CL1!", "CL1!", "CL" all resolve to "CL".
def short_symbol(tv_symbol: str) -> str:
    """Map a TradingView position symbol back to a Dwella short name."""
    import re as _re
    s = (tv_symbol or "").upper()
    # Normalise: drop the exchange prefix (before ':') and the '!' suffix,
    # so "NYMEX:CL1!" -> "CL1", "CL" -> "CL", "CME_MINI:MNQ1!" -> "MNQ1".
    bare = s.split(":")[-1].replace("!", "").strip()
    for short, tv in TV_SYMBOL_MAP.items():
        tv_root = tv.split(":")[-1].replace("!", "").strip()
        # Exact root match wins first ("CL1" -> CL, "YM1" -> YM).
        if tv_root == bare:
            return short
    # Then try a contained root match, but guard against false positives
    # like "YM" matching inside "NYMEX" — require the root to appear as a
    # whole token (not part of a longer name).
    for short, tv in TV_SYMBOL_MAP.items():
        tv_root = tv.split(":")[-1].replace("!", "").strip()
        root_short = _re.sub(r"\d", "", tv_root)  # "MNQ1" -> "MNQ"
        if root_short and (bare == root_short or bare.startswith(root_short) or bare.endswith(root_short)):
            return short
    # Fallback: take the alphabetic root (only if it's a known exchange root
    # — never "YM" from "NYMEX").
    m = _re.match(r"[A-Z]+", bare)
    return m.group(0) if m else s
EMA_FAST = 8                 # fast EMA period
EMA_SLOW = 21                # slow EMA period
ENTRY_ATR_MULT = 1.15        # ATR confirmation multiplier
STOP_ATR_MULT = 1.0          # stop distance = 1× confirmation
TARGET_R = 2.0               # target = 2R

MCP_CLI = os.environ.get(
    "DWELLA_MCP_CLI",
    os.path.join(os.path.expanduser("~"), "tradingview-mcp", "src", "cli", "index.js"),
)
NODE_BIN = os.environ.get("DWELLA_NODE", "node")

# ── Indicators ────────────────────────────────────────────────────────

def ema(values: list[float], period: int) -> Optional[float]:
    """Exponential moving average."""
    if not values or len(values) < period:
        return None
    k = 2.0 / (period + 1)
    e = values[0]
    for v in values[1:]:
        e = v * k + e * (1 - k)
    return e


def sma(values: list[float], period: int) -> Optional[float]:
    """Simple moving average."""
    if not values or len(values) < period:
        return None
    return sum(values[-period:]) / period


def compute_atr(candles: list[dict], period: int = 14) -> float:
    """Wilder's ATR."""
    if len(candles) < 2:
        return 0.0
    start = max(0, len(candles) - period - 1)
    trs = []
    for i in range(start + 1, len(candles)):
        c = candles[i]
        prev_close = candles[i - 1].get("close", c.get("open", 0))
        tr = max(
            c.get("high", 0) - c.get("low", 0),
            abs(c.get("high", 0) - prev_close),
            abs(c.get("low", 0) - prev_close),
        )
        trs.append(tr)
    return sum(trs) / len(trs) if trs else 0.0


def confirmation_distance(atr: float) -> float:
    """ATR × 1.15 — the confirmation threshold."""
    return atr * ENTRY_ATR_MULT


# ── Signal types ──────────────────────────────────────────────────────

@dataclass
class Signal:
    strategy: str       # SNIPER, BARK, IZZY, PICK, SLUG
    symbol: str         # one of the configured futures symbols
    direction: str      # long / short
    entry: float
    stop: float
    target: float
    atr: float
    area: str = ""
    confirmed: bool = True
    time: float = field(default_factory=time.time)
    executed: bool = False
    order_id: str = ""
    # Stable setup identity and sizing shown in the live setup panel.
    bar_time: int = 0
    setup_key: str = ""
    qty: int = DEFAULT_QTY
    risk_usd: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# ── Scanner state ─────────────────────────────────────────────────────

def _load_daily_state() -> dict:
    """Load persisted daily counters (survives restarts)."""
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_daily_state(state: dict) -> None:
    """Persist daily counters."""
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
    armed: bool = False          # must be armed to execute trades
    signals: list[dict] = field(default_factory=list)
    trade_log: list[dict] = field(default_factory=list)
    daily_pnl: float = 0.0
    daily_start_balance: float = 0.0
    daily_start_realized: Optional[float] = None
    daily_start_date: str = ""
    open_positions: int = 0
    open_symbols: set[str] = field(default_factory=set)  # symbols WITH an open position (no re-entry)
    last_scan: str = ""
    errors: list[str] = field(default_factory=list)
    cooldowns: dict = field(default_factory=dict)  # symbol -> last trade time
    pnl_today: float = 0.0
    scan_log: list[dict] = field(default_factory=list)  # per-symbol scan diagnostics
    # ── Daily position limit (3/day, persisted) ──
    daily_positions_taken: int = 0
    daily_date: str = ""
    # Signal fingerprints already executed today. This prevents the same
    # live candle/setup from adding another contract on the next scan.
    triggered_setups: set[str] = field(default_factory=set)

    def _sync_daily(self, realized_pnl: Optional[float] = None) -> None:
        """Load persisted counters and keep the realized-P&L baseline day-scoped."""
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
                "config": {
                    "scan_interval": SCAN_INTERVAL,
                    "daily_loss_pct": DAILY_LOSS_PCT,
                    "max_positions": MAX_POSITIONS,
                    "cooldown_seconds": COOLDOWN_SECONDS,
                    "default_qty": DEFAULT_QTY,
                    "entry_units": DEFAULT_QTY,
                    "target_r": TARGET_R,
                    "daily_position_limit": DAILY_POSITION_LIMIT,
                },
            }


# ── Strategy: SNIPER EMA Pullback ────────────────────────────────────

def scan_sniper(candles: list[dict], symbol: str, current_price: float) -> Optional[Signal]:
    """
    SNIPER — EMA pullback strategy (ported from Helios).
    
    Trend: fast EMA > slow EMA → uptrend
    Setup: price pulls back toward slow EMA (within 0.6 ATR),
           previous close was below slow EMA, last close reclaimed above.
    Entry: on the reclaim candle close.
    Stop: ATR below entry (long) or above (short).
    Target: 2R from stop.
    """
    if len(candles) < EMA_SLOW + 5:
        return None
    
    closes = [c.get("close", 0) for c in candles]
    atr = compute_atr(candles, ATR_PERIOD)
    if atr <= 0:
        return None
    
    confirm = confirmation_distance(atr)
    
    fast = ema(closes, EMA_FAST)
    slow = ema(closes, EMA_SLOW)
    if fast is None or slow is None:
        return None
    
    last = closes[-1]
    prev = closes[-2] if len(closes) >= 2 else last
    prev3 = closes[-4] if len(closes) >= 4 else last
    
    trend_up = fast > slow
    dist_to_slow = (last - slow) if trend_up else (slow - last)
    pulled_in = dist_to_slow <= max(atr * 0.85, confirm * 0.5)
    
    # Reclaim: previous was near or below slow, last flipped back above
    # Relaxed: allow prev within 0.1 ATR above slow (slight overshoot)
    reclaim_zone = atr * 0.1
    reclaimed_up = trend_up and prev <= slow + reclaim_zone and last > slow
    reclaimed_dn = not trend_up and prev >= slow - reclaim_zone and last < slow
    
    momentum = last - prev3
    confirmed = (momentum > 0) if trend_up else (momentum < 0)
    
    # Also accept: price bounced off slow EMA zone with momentum
    # (price touched slow EMA area and bounced, even if prev was above)
    bounced = trend_up and dist_to_slow <= atr * 0.3 and last > prev and momentum > 0
    bounced_dn = not trend_up and dist_to_slow <= atr * 0.3 and last < prev and momentum < 0
    
    if (pulled_in and (reclaimed_up or reclaimed_dn) and confirmed) or (bounced or bounced_dn):
        direction = "long" if trend_up else "short"
        stop_dist = max(confirm, atr * STOP_ATR_MULT)
        target_dist = stop_dist * TARGET_R
        
        entry = current_price
        stop = entry - stop_dist if direction == "long" else entry + stop_dist
        target = entry + target_dist if direction == "long" else entry - target_dist
        
        return Signal(
            strategy="SNIPER",
            symbol=symbol,
            direction=direction,
            entry=entry,
            stop=stop,
            target=target,
            atr=atr,
            area=f"Slow EMA {slow:.2f}",
            confirmed=True,
        )
    return None


# ── Strategy: BARK (event at any level) ──────────────────────────────

def scan_bark(candles: list[dict], symbol: str, current_price: float) -> Optional[Signal]:
    """
    BARK — Blind ATR Retest Confirm.
    Detects strong momentum moves (ATR breakout) then retest.
    """
    if len(candles) < ATR_PERIOD + 10:
        return None
    
    atr = compute_atr(candles, ATR_PERIOD)
    if atr <= 0:
        return None
    
    confirm = confirmation_distance(atr)
    
    # Check for ATR breakout in last 5 candles
    closes = [c.get("close", 0) for c in candles]
    highs = [c.get("high", 0) for c in candles]
    lows = [c.get("low", 0) for c in candles]
    
    # Look back 5 bars for a breakout
    for i in range(-6, -1):
        if abs(i) > len(candles):
            continue
        bar_range = highs[i] - lows[i]
        if bar_range >= confirm:
            # Strong breakout candle — check for retest
            breakout_dir = "long" if closes[i] > closes[i - 1] else "short"
            
            # Retest: price comes back toward the breakout level
            breakout_level = closes[i]
            retest_dist = abs(current_price - breakout_level)
            
            if retest_dist <= atr * 0.5:
                # Retest confirmed — momentum back in direction
                recent_momentum = closes[-1] - closes[-3] if len(closes) >= 3 else 0
                momentum_ok = (recent_momentum > 0) if breakout_dir == "long" else (recent_momentum < 0)
                
                if momentum_ok:
                    stop_dist = confirm
                    target_dist = stop_dist * TARGET_R
                    entry = current_price
                    stop = entry - stop_dist if breakout_dir == "long" else entry + stop_dist
                    target = entry + target_dist if breakout_dir == "long" else entry - target_dist
                    
                    return Signal(
                        strategy="BARK",
                        symbol=symbol,
                        direction=breakout_dir,
                        entry=entry,
                        stop=stop,
                        target=target,
                        atr=atr,
                        area=f"Retest @ {breakout_level:.2f}",
                        confirmed=True,
                    )
    return None


# ── Strategy: SNIPER combined scan ─────────────────────────────
def scan_all(candles: list[dict], symbol: str, current_price: float) -> list[Signal]:
    """Run strategies and return confirmed signals. Only SNIPER is active."""
    signals = []

    # SNIPER (primary — ported from Helios)
    s = scan_sniper(candles, symbol, current_price)
    if s:
        signals.append(s)

    return signals


# ── TradingView order execution via UI automation ─────────────────────

def tv_ui_eval(js_code: str, timeout: int = 15) -> Optional[dict]:
    """Execute JavaScript in TradingView via MCP CLI."""
    cmd = [NODE_BIN, MCP_CLI, "ui", "eval", js_code]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        return None
    except Exception:
        return None


def tv_ui_click(selector: str, value: str) -> Optional[dict]:
    """Click a UI element in TradingView."""
    cmd = ["node", MCP_CLI, "ui", "click", "-b", selector, "-v", value]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        return None
    except Exception:
        return None


def _tv_symbol_root(tv_sym: str) -> str:
    """Normalise a TV symbol ('CME_MINI:MNQ1!') to its root ('MNQ') for comparison."""
    import re as _re
    s = (tv_sym or "").split(":")[-1].replace("!", "").upper().strip()
    return _re.sub(r"\d+$", "", s)


def _tv_chart_on(target_root: str) -> bool:
    """Query the chart's current symbol and check its root matches the target."""
    try:
        result = subprocess.run([NODE_BIN, MCP_CLI, "state"], capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout or "{}")
        cur_root = _tv_symbol_root(data.get("symbol", ""))
        # Tolerant match: TradingView may resolve the dated contract
        # ("COMEX:GCZ5!" -> "GCZ") for a continuous request ("COMEX:GC1!"
        # -> "GC"). After the ":" split there are no prefix collisions
        # among MNQ/ES/MES/GC/SI/CL/RTY/YM ("MES" never starts with "ES").
        return cur_root == target_root or cur_root.startswith(target_root)
    except Exception:
        return False


def tv_set_symbol(tv_sym: str) -> bool:
    """Switch the TradingView chart to the given symbol via the MCP CLI.

    The symbol MUST be passed as a positional argument: the CLI's `symbol`
    command only SETS the chart when it receives a positional, while the
    `--symbol` flag form silently acts as a GET (returns the current symbol
    with success:true). Passing it as a flag previously made the scanner
    believe the chart switched when it hadn't — orders then fired on the
    WRONG pair (index pairs are all within 20% price, so the entry-price
    sanity check could not catch it).
    """
    target_root = _tv_symbol_root(tv_sym)
    cmd = [NODE_BIN, MCP_CLI, "symbol", tv_sym]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0 and _tv_chart_on(target_root):
            return True
    except Exception:
        pass
    # Fallback: try UI eval with internal API, then verify the switch applied.
    js = f"(function(){{var w=TradingView&&TradingView.activeChart&&TradingView.activeChart();if(w){{try{{w.setSymbol('{tv_sym}');return {{ok:true}}}}catch(e){{}}}}return {{ok:false}}}})()"
    res = tv_ui_eval(js)
    try:
        r = json.loads(res["result"]) if res and isinstance(res.get("result"), str) else (res or {}).get("result")
        if r and r.get("ok"):
            time.sleep(1.2)  # let the chart apply the symbol
            return _tv_chart_on(target_root)
    except Exception:
        pass
    return False


def execute_order(signal: Signal, qty: int = DEFAULT_QTY) -> Optional[str]:
    """
    Execute a trade via TradingView Paper Trading UI.
    
    Steps (TradingView paper panel DOM):
    1. Switch chart to the signal's symbol
    2. Click the paper-trading Buy/Sell market button
       (elements: [data-name="buy-order-button"] / [data-name="sell-order-button"])
    3. Confirm order placement by checking the orders table
    """
    symbol = signal.symbol
    direction = signal.direction
    sl_price = signal.stop
    tp_price = signal.target
    
    # Step 1: Switch chart to the symbol
    # Never fall back to the currently selected chart: that can place an
    # order on the previous pair if a mapping is missing.
    tv_sym = TV_SYMBOL_MAP.get(symbol)
    if not tv_sym or not tv_set_symbol(tv_sym):
        return None
    
    # Step 2: Wait for the chart to fully load — poll until the buy button
    # shows a price within range of the signal entry (prevents clicking while
    # the button still shows the PREVIOUS symbol's price).
    ready = False
    expected = signal.entry
    for _ in range(20):  # up to ~10s
        time.sleep(0.5)
        chk = tv_ui_eval(f"""
        (function() {{
            var btn = document.querySelector('[data-name="buy-order-button"]');
            if (!btn) return {{ready: false}};
            var txt = (btn.textContent || '').trim();
            var m = txt.match(/[\d,.]+/);
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
            # Price sanity: within 20% of expected entry means chart caught up
            if abs(r["price"] - expected) / max(expected, 1) < 0.2:
                ready = True
                break
    if not ready:
        return None
    
    # Step 3: Ensure order type is MARKET (the panel defaults to LIMIT,
    # which adds a limit-price input that scrambles the field layout)
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

    # Step 4: Set order side via the order panel side control
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
        # Fallback: click the header buy/sell button to open side
        head_sel = "buy-order-button" if direction == "long" else "sell-order-button"
        fb = tv_ui_eval(f"(function(){{var b=document.querySelector('[data-name=\"{head_sel}\"]');if(!b)return {{ok:false}};b.click();return {{ok:true}}}})()")
    time.sleep(0.8)

    # Step 5: Set SL / TP prices by LABEL (robust to layout changes)
    sl_price = signal.stop
    tp_price = signal.target
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
        // Enable SL and TP checkboxes first
        var boxes = inputs.filter(function(i) {{ return i.type === 'checkbox'; }});
        for (var b of boxes) {{ if (!b.checked) {{ b.click(); }} }}
        // Find price inputs by their row label
        var found = {{sl: null, tp: null}};
        for (var i = 0; i < inputs.length; i++) {{
            var inp = inputs[i];
            if (inp.type !== 'text' && inp.type !== 'number') continue;
            var node = inp; var ctx = '';
            for (var d = 0; d < 5 && node; d++) {{
                node = node.parentElement;
                if (node) {{ ctx = (node.textContent || '').replace(/\s+/g, ' '); if (ctx) break; }}
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

    # Step 5: Click the confirm button (place-and-modify-button)
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

    # Step 6: Verify the order actually landed in the paper orders table
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
        return None  # order did NOT land — do not log a phantom trade

    return f"TV-{symbol}-{int(time.time())}"


# ── Risk management ───────────────────────────────────────────────────

def check_risk(state: ScannerState, balance: float) -> tuple[bool, str]:
    """Check if we're allowed to take a new trade."""
    with state.lock:
        # Sync daily counters (reset if the calendar day rolled over)
        state._sync_daily()

        # Daily loss limit
        if state.daily_start_balance > 0:
            loss_limit = state.daily_start_balance * DAILY_LOSS_PCT
            if state.daily_pnl <= -loss_limit:
                return False, f"Daily loss limit hit (${state.daily_pnl:.2f} / -${loss_limit:.2f})"
        
        # Max positions
        if state.open_positions >= MAX_POSITIONS:
            return False, f"Max positions reached ({state.open_positions}/{MAX_POSITIONS})"
        
        # Daily position limit (3 new positions per day)
        if state.daily_positions_taken >= DAILY_POSITION_LIMIT:
            return False, f"Daily position limit reached ({state.daily_positions_taken}/{DAILY_POSITION_LIMIT}) — 3 positions max per day"
        
        # Cooldown check
        now = time.time()
        for sym, last_trade_time in state.cooldowns.items():
            if now - last_trade_time < COOLDOWN_SECONDS:
                remaining = int(COOLDOWN_SECONDS - (now - last_trade_time))
                # Only block if it's the same symbol
                # (we check this at call time, not here)
    
    return True, "OK"


def account_entry_units(signal: Signal, account: dict) -> int:
    """Return the safe live entry size for this account and setup.

    The live policy is intentionally strict: one unit per confirmed setup,
    never pyramiding. We still refuse that one unit when its calculated stop
    risk is larger than the account's daily risk budget or no buying power is
    reported by the connected account.
    """
    balance = float(account.get("balance") or account.get("equity") or 0)
    available = float(account.get("margin_free") or account.get("available_funds") or balance)
    unit_risk = abs(signal.entry - signal.stop) * POINT_VALUES.get(signal.symbol, 0)
    if balance <= 0 or available <= 0 or unit_risk <= 0:
        return 0
    if unit_risk > balance * DAILY_LOSS_PCT:
        return 0
    return DEFAULT_QTY


def check_cooldown(state: ScannerState, symbol: str) -> bool:
    """Check if symbol is on cooldown."""
    with state.lock:
        last = state.cooldowns.get(symbol, 0)
        return time.time() - last >= COOLDOWN_SECONDS


# ── Main scanner loop ────────────────────────────────────────────────

def fetch_candles(symbol: str) -> list[dict]:
    """Fetch candles from the sidecar."""
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
    """Fetch account info from the sidecar."""
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
    """Fetch actual open positions from the sidecar."""
    import urllib.request
    try:
        url = f"{SIDECAR_URL}/positions"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("positions", [])
    except Exception:
        return []


def scanner_loop(state: ScannerState) -> None:
    """Main scanner loop — runs every SCAN_INTERVAL seconds."""
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
            
            # Fetch account for risk checks
            account = fetch_account()
            balance = account.get("balance", 100000)
            realized = account.get("realized_pnl")
            with state.lock:
                state._sync_daily(float(realized) if realized is not None else None)
                if realized is not None and state.daily_start_realized is not None:
                    state.daily_pnl = round(float(realized) - float(state.daily_start_realized), 2)
                    state.pnl_today = state.daily_pnl

            # Reconcile open_positions from the ACTUAL TradingView positions
            # (the in-memory counter resets on restart; the broker is truth).
            # Track WHICH symbols are open so we never re-enter a pair that
            # already has a position — one position per symbol, period.
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
            
            # Risk check
            allowed, reason = check_risk(state, balance)
            if not allowed:
                with state.lock:
                    state.last_scan = f"Risk: {reason}"
                time.sleep(SCAN_INTERVAL)
                continue
            
            # Scan each symbol
            all_signals = []
            scan_entries = []
            for symbol in SYMBOLS:
                candles = fetch_candles(symbol)
                if not candles or len(candles) < 20:
                    scan_entries.append({"symbol": symbol, "status": "no data", "candles": len(candles) if candles else 0})
                    continue
                
                current_price = candles[-1].get("close", 0)
                if current_price <= 0:
                    scan_entries.append({"symbol": symbol, "status": "no price"})
                    continue
                
                # Compute diagnostics
                closes = [c.get("close", 0) for c in candles]
                fast_e = ema(closes, EMA_FAST)
                slow_e = ema(closes, EMA_SLOW)
                atr_val = compute_atr(candles, ATR_PERIOD)
                trend = "up" if fast_e and slow_e and fast_e > slow_e else "down" if fast_e and slow_e else "flat"
                dist = abs(current_price - slow_e) if slow_e else 0
                dist_atr = dist / atr_val if atr_val > 0 else 0
                
                signals = scan_all(candles, symbol, current_price)
                # Use the actual live candle timestamp, not wall-clock time,
                # so the same setup cannot fire again while that candle is
                # still current (including across a 3-minute boundary).
                bar_time = int(candles[-1].get("time", 0) or 0)
                for signal in signals:
                    signal.bar_time = bar_time
                    signal.setup_key = f"{symbol}:{signal.strategy}:{signal.direction}:{bar_time}"
                    signal.qty = DEFAULT_QTY
                    signal.risk_usd = round(
                        abs(signal.entry - signal.stop) * POINT_VALUES.get(symbol, 0), 2
                    )
                all_signals.extend(signals)
                
                scan_entries.append({
                    "symbol": symbol,
                    "status": "signal" if signals else "watching",
                    "price": round(current_price, 2),
                    "trend": trend,
                    "fast_ema": round(fast_e, 2) if fast_e else None,
                    "slow_ema": round(slow_e, 2) if slow_e else None,
                    "atr": round(atr_val, 2) if atr_val else None,
                    "dist_to_slow_atr": round(dist_atr, 2),
                    "candles": len(candles),
                })
            
            # Update state with new signals
            with state.lock:
                state.signals = [s.to_dict() for s in all_signals[-20:]]
                state.scan_log = scan_entries
                state.last_scan = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
            
            # Execute confirmed signals
            for signal in all_signals:
                if not signal.confirmed:
                    continue

                # Re-check risk per signal. A scan can contain several pairs;
                # the initial check above must not allow 4 entries in one pass.
                allowed, _ = check_risk(state, balance)
                if not allowed:
                    continue

                # Never add contracts to an already-triggered setup. The
                # fingerprint is persisted for today's session and only gets
                # recorded after TradingView confirms the order landed.
                with state.lock:
                    if signal.setup_key and signal.setup_key in state.triggered_setups:
                        continue

                if not check_cooldown(state, signal.symbol):
                    continue

                # NEVER re-enter a symbol that already has an open position.
                # One position per pair: if the broker already holds CL, we
                # do not add another CL even if a fresh setup appears. The
                # position must be closed first.
                with state.lock:
                    if signal.symbol in state.open_symbols:
                        state.last_scan = f"Skipped {signal.symbol}: position already open — no re-entry"
                        continue

                # Auto-trading is deliberately one unit per confirmed setup.
                # Validate that one unit fits the live account before sending;
                # never scale up or add contracts on later scans.
                units = account_entry_units(signal, account)
                signal.qty = units
                if units != DEFAULT_QTY:
                    with state.lock:
                        state.last_scan = f"Risk: {signal.symbol} setup too large for current account"
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
                            "strategy": signal.strategy,
                            "symbol": signal.symbol,
                            "direction": signal.direction,
                            "entry": signal.entry,
                            "stop": signal.stop,
                            "target": signal.target,
                            "order_id": order_id,
                            "atr": signal.atr,
                            "area": signal.area,
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
    """Start the scanner in a background thread."""
    with state.lock:
        state.running = True
    t = threading.Thread(target=scanner_loop, args=(state,), daemon=True)
    t.start()
    return t


def stop_scanner(state: ScannerState) -> None:
    """Stop the scanner."""
    with state.lock:
        state.running = False
        state.armed = False


def arm_scanner(state: ScannerState, armed: bool = True) -> None:
    """Arm or disarm the scanner."""
    with state.lock:
        state.armed = armed


def reset_daily_pnl(state: ScannerState) -> None:
    """Reset daily PnL tracking (call at start of new trading day)."""
    with state.lock:
        state.daily_pnl = 0.0
        state.pnl_today = 0.0
        state.daily_start_balance = 0.0
        state.daily_start_realized = None
        state.daily_start_date = ""
        state.cooldowns.clear()


def reset_daily_positions(state: ScannerState) -> None:
    """Reset the daily position counter (used when switching to a fresh account).

    Each account gets its own 3/day budget. When account A is exhausted, the
    sidecar switches to account B and resets this counter so trading resumes.
    """
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
