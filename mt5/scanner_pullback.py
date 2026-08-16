#!/usr/bin/env python3
"""
scanner_pullback.py — Dwella Auto-Trading Scanner (Investing Mastery 777)

Watches every configured futures contract through the sidecar, reads native
1m/5m/15m/1H/4H/D context, and runs the BOB Investing Mastery rules on one
confirmed 3m trigger: red support, blue resistance, reclaim-close timing,
counted wick evidence, and higher-timeframe conflict protection.

Execution safeguards:
  - No fixed local daily-loss gate; prop-firm drawdown rules remain external
  - Native protective stop beyond the reclaimed level and measured target
  - One confirmed entry per setup, exactly 1 contract, never a duplicate
  - Max 3 open positions
  - Cooldown: 5 min between trades on the same symbol
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional

from investing_mastery_777_strategy import (
    Candle,
    InvestingMastery777Engine,
    timeframe_bias,
)  # noqa: E402

# Sole active strategy. This is the mechanical implementation of BOB's
# Investing Mastery lessons: red/blue wick levels, reclaim-close timing,
# counted evidence, and higher-timeframe stacking.
STRATEGY_NAME = "INVESTING_MASTERY_777"


def _make_engine(symbol: str) -> InvestingMastery777Engine:
    """Instantiate the one strategy used by Dwella's scanner."""
    return InvestingMastery777Engine(symbol=symbol)

# ── Config ────────────────────────────────────────────────────────────
# All configured markets trade — index futures (NQ E-mini Nasdaq, MES micro
# S&P, YM mini Dow, ES E-mini S&P, RTY mini Russell) plus commodities (GCE
# gold, CL oil, SI silver). Gold is fine: the hard 2%-of-account per-trade
# stop rule below is what keeps every stop inside the strategy's risk limits
# — a commodity only enters when its pattern stop is tight enough to fit the
# cap, so no humongous stops ever reach the ticket.
SYMBOLS = ["NQ", "MES", "GCE", "YM", "ES", "RTY", "CL", "SI"]
SIDECAR_URL = "http://127.0.0.1:18814"
SCAN_INTERVAL = 3.0
SCAN_TIMEFRAME = "3"          # confirmed trigger timeframe
# Investing Mastery reads the native ladder. The 3m stream is the only entry
# authority; 1m/5m/15m/1H/4H/D add level and directional context, never duplicate
# orders. This is "read the grain, not the clock" rather than relabelling bars.
CONTEXT_TIMEFRAMES = ("1", "5", "15", "60", "240", "D")
MIN_CONTEXT_ALIGNMENT = 2
# Never fire a new order from a stale final bar. This prevents a Friday
# close or an interrupted data feed from looking like a live breakout during
# the next session/weekend. Open positions remain managed independently.
MAX_ENTRY_DATA_AGE_SECONDS = 10 * 60
CANDLE_LOOKBACK = 1400        # enough 3m history for 60m EMA context
COOLDOWN_SECONDS = 300
# Do not impose a generic 7% daily stop: prop-firm drawdown rules vary and
# the firm's own risk engine remains authoritative. Other local safeguards
# still apply (one contract, 2% per-trade risk, position and trade caps).
DAILY_LOSS_PCT = 0.0
# Hard per-trade cap: a single stop-loss may never risk more than 2% of the
# account. This is what prevents a "humongous" stop (e.g. gold at $100/pt)
# from ever reaching the ticket — the entry is skipped instead.
MAX_RISK_PER_TRADE_PCT = 0.05  # 5% for paper scalping (accommodates natural futures volatility)
MAX_POSITIONS = 3
DAILY_POSITION_LIMIT = 0     # 0 = unlimited daily entries

# Trading window (LOCAL time): open new trades 24/5 for paper scalping.
# Open trades are still managed (TP/SL) regardless of window.
TRADING_START_HOUR = 0
TRADING_END_HOUR = 23
# Explicit temporary paper-trading test mode. It bypasses only the clock
# window; all account, risk, position, daily-count, and one-contract gates
# remain active. Live accounts are rejected while this mode is enabled.
TEST_MODE = os.environ.get("DWELLA_TEST_MODE", "").strip().lower() in {"1", "true", "yes", "paper"}

# Position sizing: ALWAYS 1 contract (1 unit). The minimum is 1 contract
# and it must never exceed 1 — the order ticket quantity is re-set to 1 on
# every entry, and the full position exits at TP1 or the stop loss.
# There is no daily entry-count limit. Account, position, risk, cooldown,
# confirmed-signal, and native-stop safeguards remain active.
DEFAULT_QTY = 1
PARTIAL_SPLIT = [1]           # single contract: one full exit at TP1/stop

# Runtime state belongs in the user's Dwella data directory, never beside the
# packaged application. This keeps a DMG install clean and preserves per-user
# daily limits/partial-profit state across app updates.
RUNTIME_DIR = os.environ.get(
    "DWELLA_RUNTIME_DIR",
    os.path.join(os.path.expanduser("~"), "Documents", "Dwella", "trading"),
)
STATE_FILE = os.path.join(RUNTIME_DIR, "scanner_daily.json")
MANAGED_FILE = os.path.join(RUNTIME_DIR, "managed_trades.json")
EXECUTION_LOG_FILE = os.path.join(RUNTIME_DIR, "confirmed_executions.json")

POINT_VALUES = {
    # NQ = E-mini Nasdaq $20/pt; MES = Micro E-mini S&P $5/pt (was wrong at 1.25)
    "NQ": 20.0, "MES": 5.0, "GCE": 100.0, "YM": 5.0,
    "ES": 50.0, "RTY": 50.0, "CL": 1000.0, "SI": 5000.0,
}

TV_SYMBOL_MAP = {
    "NQ": "CME_MINI:NQ1!", "MES": "CME_MINI:MES1!", "GCE": "COMEX:GC1!",
    "YM": "CBOT_MINI:YM1!", "ES": "CME_MINI:ES1!", "RTY": "CME_MINI:RTY1!",
    "CL": "NYMEX:CL1!", "SI": "COMEX:SI1!",
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
# TradingView Desktop has one chart/order UI. Serialize symbol changes and
# order placement so a candle fallback can never switch the chart between the
# scanner's verified symbol and its order click.
TV_UI_LOCK = threading.RLock()


# ── Signal types ──────────────────────────────────────────────────────

@dataclass
class Signal:
    strategy: str = STRATEGY_NAME
    symbol: str = ""
    direction: str = ""  # long / short
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0   # TP1 (primary)
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
    timeframe_alignment: dict = field(default_factory=dict)
    alignment_count: int = 0
    timeframes_checked: int = 0
    pattern: str = ""
    framework: str = ""
    bean_count: int = 0
    seven_score: dict = field(default_factory=dict)
    higher_timeframe_conflict: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


# ── Scanner state ─────────────────────────────────────────────────────

def _load_json(path: str) -> dict:
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_json(path: str, data) -> None:
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
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
    # Per-symbol diagnostics explain which gate currently prevents a signal.
    # This is observational only; execution still uses the exact engine result.
    daily_positions_taken: int = 0
    daily_date: str = ""
    triggered_setups: set[str] = field(default_factory=set)
    dashboards: dict = field(default_factory=dict)
    account_id: str = ""
    account_targets: list[str] = field(default_factory=list)
    account_cursor: int = 0
    # Managed trades with live partial-profit tracking
    managed_trades: dict = field(default_factory=dict)
    execution_log: list[dict] = field(default_factory=list)

    def _sync_daily(self, realized_pnl: Optional[float] = None) -> None:
        saved = _load_json(STATE_FILE)
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
            _save_json(STATE_FILE, {
                "date": today,
                "positions_taken": 0,
                "setup_keys": [],
                "start_realized": realized_pnl,
            })
        self.daily_date = today
        if realized_pnl is not None and self.daily_start_realized is not None:
            self.daily_pnl = round(float(realized_pnl) - float(self.daily_start_realized), 2)
            self.pnl_today = self.daily_pnl

    def _load_managed(self) -> None:
        saved = _load_json(MANAGED_FILE)
        self.managed_trades = saved.get("trades", {})
        execution_saved = _load_json(EXECUTION_LOG_FILE)
        entries = execution_saved.get("entries", [])
        self.execution_log = entries if isinstance(entries, list) else []

    def _save_managed(self) -> None:
        _save_json(MANAGED_FILE, {"trades": self.managed_trades})

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "running": self.running,
                "armed": self.armed,
                "signals": self.signals[-20:],
                "trade_log": self.trade_log[-50:],
                "confirmed_entries": self.execution_log[-200:],
                "daily_pnl": self.daily_pnl,
                "pnl_today": self.pnl_today,
                "open_positions": self.open_positions,
                "last_scan": self.last_scan,
                "errors": self.errors[-10:],
                "scan_log": self.scan_log[-12:],
                "symbols": SYMBOLS,
                "timeframe": SCAN_TIMEFRAME,
                "trigger_timeframe": SCAN_TIMEFRAME,
                "timeframe_ladder": [SCAN_TIMEFRAME, *CONTEXT_TIMEFRAMES],
                "daily_positions_taken": self.daily_positions_taken,
                "daily_position_limit": DAILY_POSITION_LIMIT,
                "daily_date": self.daily_date,
                "daily_start_realized": self.daily_start_realized,
                "triggered_setups": len(self.triggered_setups),
                "entry_units": DEFAULT_QTY,
                "strategy": STRATEGY_NAME,
                "strategy_version": "Investing Mastery 777 · 3m reclaim trigger · native 1m / 5m / 15m / 1H / 4H / D stack",
                "context_timeframes": list(CONTEXT_TIMEFRAMES),
                "min_context_alignment": MIN_CONTEXT_ALIGNMENT,
                "analysis_mode": "ACTIVE" if self.armed else "PASSIVE",
                "dashboards": self.dashboards,
                "account_id": self.account_id,
                "account_targets": list(self.account_targets),
                "managed_trades": list(self.managed_trades.values()),
                "partial_profit_plan": "1 contract — native adaptive trailing stop; confirmed opposite BUY/SELL signal closes and reverses",
                "config": {
                    "scan_interval": SCAN_INTERVAL,
                    "timeframe": SCAN_TIMEFRAME,
                    "daily_loss_pct": DAILY_LOSS_PCT,
                    "max_positions": MAX_POSITIONS,
                    "cooldown_seconds": COOLDOWN_SECONDS,
                    "default_qty": DEFAULT_QTY,
                    "entry_units": DEFAULT_QTY,
                    "daily_position_limit": DAILY_POSITION_LIMIT,
                    "partial_split": PARTIAL_SPLIT,
                    "trading_window": f"{TRADING_START_HOUR:02d}:00–{TRADING_END_HOUR:02d}:00 local",
                    "test_mode": TEST_MODE,
                    "max_risk_per_trade_pct": MAX_RISK_PER_TRADE_PCT,
                },
            }


# ── Engine instances ─────────────────────────────────────────────────
_engines: dict[str, Any] = {}


def get_engine(symbol: str, account_id: str = ""):
    # TradingView exposes one active account at a time. Keep strategy state
    # separate per account so rotating selected accounts does not consume the
    # same bar/setup state twice or suppress a valid signal on the next account.
    key = f"{account_id}:{symbol}" if account_id else symbol
    if key not in _engines:
        _engines[key] = _make_engine(symbol=symbol)
    return _engines[key] 


def build_context_snapshot(timeframe_candles: Optional[dict[str, list[dict]]]) -> dict:
    """Return closed-bar bias and red/blue wick levels for every context frame."""
    alignment = {}
    for tf in CONTEXT_TIMEFRAMES:
        rows = (timeframe_candles or {}).get(tf) or []
        if rows:
            def _to_objs(rows_: list[dict]) -> list[Candle]:
                return [Candle(
                    time=int(c.get("time", 0)),
                    open=float(c.get("open", 0)),
                    high=float(c.get("high", 0)),
                    low=float(c.get("low", 0)),
                    close=float(c.get("close", 0)),
                    volume=float(c.get("volume", 0)),
                ) for c in rows_]
            alignment[tf] = timeframe_bias(_to_objs(rows))
        else:
            alignment[tf] = {"bias": "NEUTRAL", "ready": False, "bars": 0}
    return alignment


def scan_pullback(candles: list[dict], symbol: str, current_price: float,
                  account_id: str = "", htf_candles: Optional[list[dict]] = None,
                  timeframe_candles: Optional[dict[str, list[dict]]] = None) -> list[Signal]:
    """Run Investing Mastery 777 on the trigger timeframe with native context.

    ``timeframe_candles`` is optional for compatibility with older callers.
    The playlist engine itself applies the higher-timeframe-first conflict
    rule; the wrapper only normalizes its result into the scanner's stable
    signal/playbook data flow.
    """
    if len(candles) < 60:
        return []
    engine = get_engine(symbol, account_id)

    def _to_objs(rows: list[dict]) -> list[Candle]:
        objs = []
        for c in rows:
            objs.append(Candle(
                time=int(c.get("time", 0)),
                open=float(c.get("open", 0)),
                high=float(c.get("high", 0)),
                low=float(c.get("low", 0)),
                close=float(c.get("close", 0)),
                volume=float(c.get("volume", 0)),
            ))
        return objs

    candle_objs = _to_objs(candles)
    context_objs = {tf: _to_objs(rows) for tf, rows in (timeframe_candles or {}).items() if rows}
    # Older callers supplied only ``htf_candles``. Preserve that input as the
    # 60m context instead of silently downgrading the playlist engine to a
    # trigger-only read.
    if htf_candles and "60" not in context_objs:
        context_objs["60"] = _to_objs(htf_candles)
    sig = engine.process_candles(candle_objs, timeframe_candles=context_objs)
    if sig and sig.confirmed:
        # Read the same closed-bar ladder used by the engine for the playbook.
        # The engine itself rejects higher-frame conflicts before a signal.
        alignment = getattr(sig, "timeframe_alignment", None) or build_context_snapshot(timeframe_candles)
        direction_bias = "BULLISH" if sig.direction == "long" else "BEARISH"
        ready = {tf: data for tf, data in alignment.items() if data.get("ready")}
        aligned = int(getattr(sig, "alignment_count", 0) or sum(
            1 for data in ready.values() if data.get("bias") == direction_bias
        ))
        checked = int(getattr(sig, "timeframes_checked", 0) or len(ready))
        # The playlist engine has already enforced its higher-timeframe gate;
        # this wrapper only preserves the stable scanner signal shape.
        # Engine modules expose ``pattern`` and/or ``framework``; build a
        # stable display area whichever is present and fall back to the
        # playlist strategy name when neither is populated.
        pattern = getattr(sig, "pattern", "") or ""
        framework = getattr(sig, "framework", "") or ""
        if pattern and framework and framework != pattern:
            area = f"{pattern} · {framework}"
        elif pattern:
            area = pattern
        elif framework:
            area = framework
        else:
            area = STRATEGY_NAME
        return [Signal(
            strategy=STRATEGY_NAME,
            symbol=symbol,
            direction=sig.direction,
            entry=sig.entry,
            stop=sig.stop,
            target=sig.target,
            target2=sig.target2,
            target3=sig.target3,
            atr=sig.atr,
            area=area,
            confirmed=True,
            bar_time=sig.bar_time,            setup_key=sig.setup_key,
            timeframe_alignment=alignment,
            alignment_count=aligned,
            timeframes_checked=checked,
            pattern=getattr(sig, "pattern", "") or "",
            framework=getattr(sig, "framework", "") or "",
            bean_count=int(getattr(sig, "bean_count", 0) or 0),
            seven_score=getattr(sig, "seven_score", {}) or {},
            higher_timeframe_conflict=bool(getattr(sig, "higher_timeframe_conflict", False)),
        )]
 
    return []


# Compatibility entry point retained for older sidecar callers.
def scan_zeropoint(candles: list[dict], symbol: str, current_price: float) -> list[Signal]:
    return scan_pullback(candles, symbol, current_price)


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


def _ui_payload(response: Optional[dict]) -> dict:
    """Return the inner payload from the MCP UI-eval response."""
    if not response or not response.get("success"):
        return {}
    result = response.get("result")
    if isinstance(result, dict):
        return result
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, json.JSONDecodeError):
            return {}
    return {}


def _tv_symbol_root(tv_sym: str) -> str:
    import re as _re
    s = (tv_sym or "").split(":")[-1].replace("!", "").upper().strip()
    return _re.sub(r"\d+$", "", s)


def _tv_chart_state() -> tuple[str, str]:
    """Return the user's visible TradingView symbol and resolution."""
    try:
        result = subprocess.run([NODE_BIN, MCP_CLI, "state"], capture_output=True, text=True, timeout=10)
        data = json.loads(result.stdout or "{}")
        symbol = str(data.get("symbol") or "").strip()
        resolution = str(data.get("resolution") or data.get("chart_resolution") or "").strip()
        return (symbol if (":" in symbol or symbol) else "", resolution)
    except Exception:
        return "", ""


def _tv_chart_symbol() -> str:
    return _tv_chart_state()[0]


def _tv_set_timeframe(resolution: str) -> bool:
    if not resolution:
        return True
    try:
        result = subprocess.run(
            [NODE_BIN, MCP_CLI, "timeframe", resolution],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def _tv_chart_on(target_root: str) -> bool:
    current = _tv_chart_symbol()
    return bool(current and (_tv_symbol_root(current) == target_root or _tv_symbol_root(current).startswith(target_root)))


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


def _set_input_value(inp, val):
    return (
        "(function(){"
        "var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
        "setter.call(inp,val);"
        "inp.dispatchEvent(new Event('input',{bubbles:true}));"
        "inp.dispatchEvent(new Event('change',{bubbles:true}));"
        "})()"
    )


def _order_panel_js(quantity: int, sl: Optional[float] = None, tp: Optional[float] = None,
                    side: Optional[str] = None, symbol_root: Optional[str] = None) -> str:
    """Build the JS that fills the order panel: side, quantity, SL/TP.

    IMPORTANT: this builds a JS string, so every literal `{` in the output
    must be escaped as `{{` inside the Python f-strings below.
    """
    parts = [
        "(function(){",
        "var panel=document.querySelector('[data-name=\"order-dialog-popup\"]')||document.querySelector('[data-name=\"order-panel\"]');",
        "if(!panel)return {ok:false,error:'no panel'};",
    ]
    if symbol_root:
        parts.append(
            f"var expectedRoot='{symbol_root.upper()}';"
            "var panelText=(panel.textContent||'').toUpperCase();"
            "if(panelText.indexOf(expectedRoot)<0)return {ok:false,error:'order dialog symbol mismatch',expected:expectedRoot};"
        )
    if side:
        parts.append(f"var sideName='side-control-{side}';".replace("'", "'"))
        parts.append("var sb=panel.querySelector('[data-name=\"'+sideName+'\"]');")
        parts.append("if(!sb)return {ok:false,error:'side control missing'};sb.click();")
    parts.append("var q=document.getElementById('quantity-field')||panel.querySelector('[data-qa-id=\\\"ui-lib-Input-input units-quantity-field-input\\\"]');")
    parts.append(
        "if(q){var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
    )
    parts.append("if(!q)return {ok:false,error:'quantity input missing'};")
    parts.append(
        f"setter.call(q,'{quantity}');q.dispatchEvent(new Event('input',{{bubbles:true}}));"
        "q.dispatchEvent(new Event('change',{bubbles:true}));}"
    )
    parts.append(
        "var setVal=function(inp,val){if(!inp)return false;"
        "var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
        "inp.focus();s.call(inp,String(val));"
        "inp.dispatchEvent(new Event('input',{bubbles:true}));"
        "inp.dispatchEvent(new Event('change',{bubbles:true}));"
        "inp.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter'}));"
        "inp.blur();return true;};"
        "var numVal=function(inp){return inp?Number(String(inp.value||'').replace(/,/g,'')):NaN;};"
    )
    # TradingView keeps bracket fields disabled until their corresponding
    # switch is enabled. Select them by stable data-qa-id rather than walking
    # changing CSS/class names, then enable and fill the actual price inputs.
    tp_enabled = str(tp is not None).lower()
    sl_enabled = str(sl is not None).lower()
    parts.append(
        "var tpCheck=panel.querySelector('[data-qa-id=\"order-ticket-take-profit-checkbox-bracket\"]');"
        "var slCheck=panel.querySelector('[data-qa-id=\"order-ticket-stop-loss-checkbox-bracket\"]');"
        f"if(tpCheck&&tpCheck.checked!=={tp_enabled})tpCheck.click();"
        f"if(slCheck&&slCheck.checked!=={sl_enabled})slCheck.click();"
    )
    parts.append("var tpInput=panel.querySelector('[data-qa-id=\"ui-lib-Input-input order-ticket-take-profit-input\"]');")
    parts.append("var slInput=panel.querySelector('[data-qa-id=\"ui-lib-Input-input order-ticket-stop-loss-input\"]');")
    tp_js = f"if(tpInput&&{str(tp is not None).lower()})setVal(tpInput,'{tp:.2f}');" if tp is not None else ""
    sl_js = f"if(slInput&&{str(sl is not None).lower()})setVal(slInput,'{sl:.2f}');" if sl is not None else ""
    parts.append(tp_js)
    parts.append(sl_js)
    parts.append(
        f"var qtyOk=!!q&&String(q.value)==='{quantity}';"
        f"var slOk=!{str(sl is not None).lower()}||(slInput&&Number.isFinite(numVal(slInput))&&Math.abs(numVal(slInput)-{format_price_for_js(sl or 0)})<=0.02);"
        f"var tpOk=!{str(tp is not None).lower()}||(tpInput&&Number.isFinite(numVal(tpInput))&&Math.abs(numVal(tpInput)-{format_price_for_js(tp or 0)})<=0.02);"
        "return {ok:qtyOk&&slOk&&tpOk,sl:slOk,tp:tpOk,qty:q?q.value:null,slValue:slInput?slInput.value:null,tpValue:tpInput?tpInput.value:null};"
    )
    parts.append("})()")
    return "".join(parts)


def _place_order_on_symbol_unlocked(symbol: str, direction: str, qty: int,
                                   sl: Optional[float] = None, tp: Optional[float] = None,
                                   confirm_position: bool = False) -> Optional[str]:
    """Open the order panel, fill it, and place a market order.

    Entry orders request a live-position confirmation; partial exits use the
    TradingView rejection/toast result because their position quantity moves
    in the opposite direction from the order side.
    """
    before_positions = fetch_positions() if confirm_position else []
    before_qty = _position_qty(before_positions, symbol, direction) if confirm_position else 0.0
    tv_sym = TV_SYMBOL_MAP.get(symbol)
    if not tv_sym or not tv_set_symbol(tv_sym):
        return None

    # Click the buy/sell button to open the order ticket. The chart may still
    # be applying the symbol, so wait for the verified ticket and then set the
    # side explicitly inside the ticket before filling any values.
    head_btn = "buy-order-button" if direction == "long" else "sell-order-button"
    opened = None
    for _ in range(12):
        opened = tv_ui_eval(
            f'(function(){{var b=document.querySelector(\'[data-name="{head_btn}"]\');'
            "if(!b)return {ok:false,error:'order button missing'};b.click();return {ok:true};})()"
        )
        if opened and _ui_payload(opened).get("ok"):
            break
        time.sleep(0.35)
    if not (opened and _ui_payload(opened).get("ok")):
        raise RuntimeError((_ui_payload(opened) or {}).get("error", "TradingView order button did not open"))
    time.sleep(0.9)

    side = "buy" if direction == "long" else "sell"
    js = _order_panel_js(
        qty, sl=sl, tp=tp, side=side,
        symbol_root=_tv_symbol_root(tv_sym),
    )
    filled = tv_ui_eval(js)
    filled_payload = _ui_payload(filled)
    if not filled_payload.get("ok"):
        raise RuntimeError(filled_payload.get("error", "TradingView order ticket fields were unavailable"))
    time.sleep(0.7)

    confirm = tv_ui_eval(
        "(function(){var panel=document.querySelector('[data-name=\"order-dialog-popup\"]')||document.querySelector('[data-name=\"order-panel\"]');"
        "if(!panel)return {ok:false,error:'order panel disappeared'};"
        "var b=panel.querySelector('[data-name=\"place-and-modify-button\"]');"
        "if(!b)return {ok:false,error:'place button missing'};"
        "if(b.getAttribute('aria-disabled')==='true'||b.disabled)return {ok:false,error:'order ticket disabled: '+(panel.textContent||'').slice(-300)};"
        "b.click();return {ok:true};})()"
    )
    confirm_payload = _ui_payload(confirm)
    if not confirm_payload.get("ok"):
        raise RuntimeError(confirm_payload.get("error", "TradingView place button was unavailable or disabled"))
    time.sleep(1.2)
    verify = tv_ui_eval(
        "(function(){var t='';var els=document.querySelectorAll('[class*=\"toast\"],[class*=\"notification\"],[role=\"alert\"]');"
        "for(var i=0;i<els.length;i++){var x=(els[i].textContent||'').trim();if(x)t+=x+' ';}"
        "return {text:t.slice(-500)};})()"
    )
    result = (verify or {}).get("result") if isinstance(verify, dict) else None
    text = result.get("text", "") if isinstance(result, dict) else str(result or "")
    lowered = text.lower()
    # Only treat a toast as belonging to this order when it is a fresh
    # rejection. Old notifications remain mounted in TradingView's DOM.
    # Position confirmation below is authoritative for entries.
    if any(word in lowered for word in ("rejected", "not enough", "insufficient", "failed", "error")) and not confirm_position:
        raise RuntimeError(text[-500:])

    # A successful click is not proof of an entry fill. Confirm the live
    # position increased before recording a new trade; this prevents ghost
    # entries when TradingView rejects an order or the ticket is stale.
    if confirm_position:
        for _ in range(6):
            time.sleep(0.7)
            after_positions = fetch_positions()
            after_qty = _position_qty(after_positions, symbol, direction)
            opposite_delta = _position_delta(
                before_positions, after_positions, symbol, _opposite_direction(direction)
            )
            if after_qty >= before_qty + max(1, qty):
                if opposite_delta >= max(1, qty):
                    raise RuntimeError(
                        f"TradingView opened both sides for {symbol}; expected {direction}"
                    )
                native_levels_ok = sl is None or _native_stop_matches(
                    after_positions, symbol, direction, float(sl)
                )
                if native_levels_ok and tp is not None:
                    native_levels_ok = _native_bracket_matches(
                        after_positions, symbol, direction, float(sl), float(tp)
                    )
                if not native_levels_ok:
                    # Never leave an unprotected entry running. The active
                    # strategy requires its protective stop to be native;
                    # the measured target must also be attached.
                    try:
                        close_partial(symbol, direction, min(DEFAULT_QTY, int(qty)))
                    except Exception:
                        pass
                    raise RuntimeError(
                        f"TradingView position {symbol} lacks native "
                        f"SL {sl}" + (f" / TP2 {tp}" if tp is not None else "")
                    )
                return f"TV-{symbol}-{int(time.time())}"
            if opposite_delta >= max(1, qty):
                # A click on the wrong TradingView side is never a harmless
                # execution failure: it leaves a live position in the exact
                # opposite direction. Attempt one immediate compensating
                # close, then fail the signal so it is not recorded as a
                # valid strategy trade.
                try:
                    close_partial(symbol, _opposite_direction(direction), min(DEFAULT_QTY, int(opposite_delta)))
                except Exception:
                    pass
                raise RuntimeError(
                    f"TradingView opened { _opposite_direction(direction) } for {symbol}; expected {direction}"
                )
        relevant = text.replace("Show more", "").strip()
        raise RuntimeError(relevant[-500:] or "TradingView did not confirm a position change")
    return f"TV-{symbol}-{int(time.time())}"


def _place_order_unlocked(symbol: str, direction: str, qty: int,
                          sl: Optional[float] = None, tp: Optional[float] = None,
                          confirm_position: bool = False) -> Optional[str]:
    """Execute on the requested symbol, then restore the user's chart.

    TradingView exposes one chart to both the order ticket and the user. The
    scanner must temporarily select the traded contract to place/verify the
    order, but it must never leave the user's chart on a different market.
    """
    previous_symbol, previous_resolution = _tv_chart_state()
    # If the chart context cannot be read, fail closed rather than placing an
    # order and leaving the user's chart on an unknown market/timeframe.
    if not previous_symbol:
        return None
    requested_symbol = TV_SYMBOL_MAP.get(symbol, "")
    try:
        return _place_order_on_symbol_unlocked(
            symbol, direction, qty, sl=sl, tp=tp, confirm_position=confirm_position,
        )
    finally:
        if previous_symbol and requested_symbol and _tv_symbol_root(previous_symbol) != _tv_symbol_root(requested_symbol):
            try:
                with TV_UI_LOCK:
                    if tv_set_symbol(previous_symbol):
                        _tv_set_timeframe(previous_resolution)
            except Exception:
                pass


def _place_order(symbol: str, direction: str, qty: int,
                 sl: Optional[float] = None, tp: Optional[float] = None) -> Optional[str]:
    with TV_UI_LOCK:
        return _place_order_unlocked(symbol, direction, qty, sl=sl, tp=tp)


def _modify_bracket_fields_js(sl: float, tp: float) -> str:
    """Build a TradingView position-bracket modification script.

    TradingView uses the same order-ticket controls for modifying an open
    position. Keep quantity/side untouched and change only SL/TP.
    """
    return (
        "(function(){"
        "var panel=document.querySelector('[data-name=\\\"order-dialog-popup\\\"]')||"
        "document.querySelector('[data-name=\\\"order-panel\\\"]')||"
        "document.querySelector('[data-name=\\\"position-modify-dialog\\\"]')||"
        "document.querySelector('[role=\\\"dialog\\\"]');"
        "if(!panel)return {ok:false,error:'modify panel missing'};"
        "var setVal=function(inp,val){if(!inp)return false;"
        "var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
        "inp.focus();s.call(inp,String(val));"
        "inp.dispatchEvent(new Event('input',{bubbles:true}));"
        "inp.dispatchEvent(new Event('change',{bubbles:true}));"
        "inp.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter'}));"
        "inp.blur();return true;};"
        "var tpCheck=panel.querySelector('[data-qa-id=\\\"order-ticket-take-profit-checkbox-bracket\\\"]');"
        "var slCheck=panel.querySelector('[data-qa-id=\\\"order-ticket-stop-loss-checkbox-bracket\\\"]');"
        "if(tpCheck&&!tpCheck.checked)tpCheck.click();if(slCheck&&!slCheck.checked)slCheck.click();"
        "var tp=panel.querySelector('[data-qa-id*=\\\"take-profit-input\\\"]');"
        "var sl=panel.querySelector('[data-qa-id*=\\\"stop-loss-input\\\"]');"
        "var slOk=setVal(sl,'"+format_price_for_js(sl)+"');"
        "var tpOk=setVal(tp,'"+format_price_for_js(tp)+"');"
        "var btn=panel.querySelector('[data-name=\\\"place-and-modify-button\\\"]');"
        "if(!slOk||!tpOk||!btn)return {ok:false,error:'modify fields unavailable',sl:slOk,tp:tpOk,button:!!btn};"
        "if(btn.getAttribute('aria-disabled')==='true'||btn.disabled)return {ok:false,error:'modify button disabled'};"
        "btn.click();return {ok:true};})()"
    )


def format_price_for_js(value: float) -> str:
    return f"{float(value):.10f}".rstrip("0").rstrip(".")


def _modify_open_bracket(symbol: str, direction: str, sl: float, tp: float) -> bool:
    """Move an existing position's native SL to ``sl`` while retaining ``tp``.

    TradingView Desktop exposes position modification through a row/dialog
    rather than a stable public API. We therefore verify the position row,
    fill both bracket prices, click the modify action, and return success only
    when the UI accepted the edit. The caller keeps a persisted virtual-stop
    fallback if a particular Desktop build exposes different selectors.
    """
    with TV_UI_LOCK:
        previous_symbol, previous_resolution = _tv_chart_state()
        requested_symbol = TV_SYMBOL_MAP.get(symbol, "")
        if not previous_symbol or not requested_symbol:
            return False
        try:
            if not tv_set_symbol(requested_symbol):
                return False
            open_js = (
                "(function(){var table=document.querySelector('[data-name=\\\"Paper.positions-table\\\"]');"
                "if(!table)return {ok:false,error:'positions table missing'};"
                "var rows=table.querySelectorAll('tr.ka-row,tr[class*=\\\"ka-row\\\"]');"
                "var want='"+("short" if direction == "short" else "long")+"';"
                "for(var i=0;i<rows.length;i++){var text=(rows[i].textContent||'').toLowerCase();"
                "if(text.indexOf(want)<0)continue;"
                "var b=rows[i].querySelector('[data-name*=\\\"modify\\\"],button[aria-label*=\\\"Modify\\\"],button[title*=\\\"Modify\\\"]');"
                "if(b){b.click();return {ok:true,action:'modify'};}rows[i].click();return {ok:true,action:'row'};}"
                "return {ok:false,error:'position row missing'};})()"
            )
            opened = tv_ui_eval(open_js, timeout=8)
            if not (opened and opened.get("success")):
                return False
            time.sleep(0.5)
            edited = tv_ui_eval(_modify_bracket_fields_js(sl, tp), timeout=8)
            if not (edited and edited.get("success")):
                return False
            result = edited.get("result")
            if isinstance(result, str):
                try:
                    result = json.loads(result)
                except json.JSONDecodeError:
                    result = {}
            if not (isinstance(result, dict) and result.get("ok")):
                return False

            # A successful click only proves that the dialog accepted the
            # fields locally. Confirm the live position row reflects both
            # prices before calling the promotion native; otherwise the
            # manager will retain/retry its protected fallback.
            expected_sl = float(sl)
            expected_tp = float(tp)
            for _ in range(8):
                time.sleep(0.5)
                for position in fetch_positions():
                    if short_symbol(position.get("symbol", "")) != symbol:
                        continue
                    position_side = "long" if int(position.get("type", 0)) == 0 else "short"
                    if position_side != direction:
                        continue
                    try:
                        actual_sl = float(position.get("sl", 0) or 0)
                        actual_tp = float(position.get("tp", 0) or 0)
                    except (TypeError, ValueError):
                        continue
                    tolerance = max(0.01, abs(expected_sl) * 0.00002, abs(expected_tp) * 0.00002)
                    if actual_sl > 0 and actual_tp > 0 and abs(actual_sl - expected_sl) <= tolerance and abs(actual_tp - expected_tp) <= tolerance:
                        return True
            return False
        finally:
            if previous_symbol and requested_symbol and _tv_symbol_root(previous_symbol) != _tv_symbol_root(requested_symbol):
                try:
                    tv_set_symbol(previous_symbol)
                    _tv_set_timeframe(previous_resolution)
                except Exception:
                    pass


def execute_order(signal: Signal, qty: int = DEFAULT_QTY) -> Optional[str]:
    """Place one contract with the strategy's native protective stop."""
    # Hard-cap every entry at the user's one-contract rule, even if an
    # external caller passes a larger qty. Keep the entire unit open for the
    # measured TP2. The manager promotes the stop to TP1 after TP1 is touched.
    entry_qty = DEFAULT_QTY
    with TV_UI_LOCK:
        target = signal.target2
        return _place_order_unlocked(signal.symbol, signal.direction, entry_qty,
                                     sl=signal.stop, tp=target,
                                     confirm_position=True)


def close_partial(symbol: str, direction: str, qty: int) -> Optional[str]:
    """Close a partial quantity with a market order on the opposite side."""
    close_dir = "short" if direction == "long" else "long"
    return _place_order(symbol, close_dir, qty)


# ── Risk management ───────────────────────────────────────────────────

def check_risk(state: ScannerState, balance: float) -> tuple[bool, str]:
    with state.lock:
        state._sync_daily()
        if DAILY_LOSS_PCT > 0 and state.daily_start_balance > 0:
            loss_limit = state.daily_start_balance * DAILY_LOSS_PCT
            if state.daily_pnl <= -loss_limit:
                return False, f"Daily loss limit hit (${state.daily_pnl:.2f} / -${loss_limit:.2f})"
        if state.open_positions >= MAX_POSITIONS:
            return False, f"Max positions reached ({state.open_positions}/{MAX_POSITIONS})"
        if DAILY_POSITION_LIMIT > 0 and state.daily_positions_taken >= DAILY_POSITION_LIMIT:
            return False, f"Daily position limit reached ({state.daily_positions_taken}/{DAILY_POSITION_LIMIT})"
    return True, "OK"


def account_entry_units(signal: Signal, account: dict) -> int:
    """Return the entry size: always exactly 1 contract, or 0 to skip.

    Position sizing is hard-capped at ONE contract — the minimum allowed.
    The hard gate is dollar risk: the stop may never risk more than 2% of
    the account (this is what prevents humongous stops, e.g. a $3k gold
    stop on a $50k account). Margin affordability is delegated to the
    TradingView order ticket — rejections are detected there and never
    counted as trades. Unknown balances never authorize an order.
    """
    balance = float(account.get("balance") or account.get("equity") or 0)
    if not pine_levels_valid(signal):
        return 0
    unit_risk = abs(signal.entry - signal.stop) * POINT_VALUES.get(signal.symbol, 0)
    if unit_risk <= 0:
        return 0
    if balance <= 0:
        return 0
    # Per-trade risk cap (hard): the stop may never risk more than 2% of the
    # account. Blocks wide stops before they ever reach the order ticket.
    if unit_risk > balance * MAX_RISK_PER_TRADE_PCT:
        return 0
    return 1


def check_cooldown(state: ScannerState, symbol: str) -> bool:
    with state.lock:
        last = state.cooldowns.get(symbol, 0)
        return time.time() - last >= COOLDOWN_SECONDS


def in_trading_window(now: Optional[datetime] = None) -> bool:
    """True when inside the window, or when explicit paper test mode is on."""
    if TEST_MODE:
        return True
    now = now or datetime.now()
    return TRADING_START_HOUR <= now.hour <= TRADING_END_HOUR


# ── Data fetching ─────────────────────────────────────────────────────

def _get(url: str, timeout: int = 6) -> Optional[Any]:
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def fetch_candles(symbol: str, timeframe: Optional[str] = None) -> list[dict]:
    tf = timeframe or SCAN_TIMEFRAME
    d = _get(f"{SIDECAR_URL}/candles?symbol={symbol}&timeframe={tf}&count={CANDLE_LOOKBACK}") or {}
    rows = d.get("candles", [])
    # Higher-timeframe analysis must be genuine. The sidecar may expose a
    # mathematically useful aggregate for the chart while a native stream is
    # still recovering, but the 777 engine must wait rather than count 3m
    # bars as 15m/1H/4H/D context.
    requested_tf = "D" if str(tf).upper() == "1440" else str(tf).upper()
    source_tf = str(d.get("source_timeframe") or requested_tf).upper()
    if requested_tf != str(SCAN_TIMEFRAME).upper() and source_tf != requested_tf:
        return []
    return rows


def fetch_context_candles(symbol: str) -> dict[str, list[dict]]:
    """Fetch the Investing Mastery native context ladder without touching the visible chart."""
    return {
        tf: fetch_candles(symbol, tf)
        for tf in CONTEXT_TIMEFRAMES
    }


def fetch_account() -> dict:
    """Return only a fresh account snapshot from the embedded TV session."""
    d = _get(f"{SIDECAR_URL}/account") or {}
    if d.get("fresh") is False or d.get("connected") is False:
        return {}
    return d.get("account", {})


def fetch_positions() -> list[dict]:
    d = _get(f"{SIDECAR_URL}/positions")
    return (d or {}).get("positions", [])


def fetch_actual_account_id() -> str:
    """Return the account TradingView is currently showing ('' if unknown)."""
    d = _get(f"{SIDECAR_URL}/accounts") or {}
    return str(d.get("actual_account_id") or "")


def fetch_cross_trading_enabled() -> bool:
    """Whether cross-trading (account rotation) is enabled."""
    d = _get(f"{SIDECAR_URL}/accounts") or {}
    return bool(d.get("cross_trading"))


def fetch_account_targets() -> list[str]:
    """Return the account(s) the scanner is allowed to trade on.

    With cross-trading OFF (the default), trade on whatever account
    TradingView is currently logged into — the account the user signed in
    with is the account orders will hit, so the saved target must never
    block the scanner when a different (verified) account is visible.
    Only when the user explicitly enables cross-trading do we rotate
    through the saved account list.
    """
    d = _get(f"{SIDECAR_URL}/accounts") or {}
    actual = str(d.get("actual_account_id") or "")
    cross = bool(d.get("cross_trading"))
    if not cross:
        if actual:
            return [actual]
        active = str(d.get("active_id") or "")
        return [active] if active else []
    selected = [str(x) for x in (d.get("selected_ids") or []) if x]
    active = str(d.get("active_id") or "")
    if not selected and active:
        selected = [active]
    return selected


def ensure_account_target(account_id: str) -> bool:
    """Ensure TradingView is visibly on account_id before scanning/trading."""
    d = _get(f"{SIDECAR_URL}/accounts") or {}
    if str(d.get("actual_account_id") or "") == account_id:
        return True
    import urllib.request
    try:
        req = urllib.request.Request(
            f"{SIDECAR_URL}/accounts/switch",
            data=json.dumps({"id": account_id, "temporary": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            result = json.loads(resp.read())
        if not result.get("ok"):
            return False
    except Exception:
        return False
    for _ in range(12):
        time.sleep(0.5)
        d = _get(f"{SIDECAR_URL}/accounts") or {}
        if str(d.get("actual_account_id") or "") == account_id:
            return True
    return False


# ── Partial profit manager ────────────────────────────────────────────

def _position_qty(positions: list[dict], symbol: str, direction: str) -> float:
    """Return the visible quantity on one side of a symbol."""
    wanted = "LONG" if direction == "long" else "SHORT"
    for p in positions:
        if short_symbol(p.get("symbol", "")) == symbol:
            side = "LONG" if int(p.get("type", 0)) == 0 else "SHORT"
            if side == wanted:
                try:
                    return float(p.get("volume", 0))
                except (TypeError, ValueError):
                    return 0.0
    return 0.0


def _opposite_direction(direction: str) -> str:
    return "short" if direction == "long" else "long"


def _position_delta(before: list[dict], after: list[dict], symbol: str, direction: str) -> float:
    return max(0.0, _position_qty(after, symbol, direction) - _position_qty(before, symbol, direction))


def pine_levels_valid(signal: Signal) -> bool:
    """Require strategy levels to be on the protective side before entry."""
    if signal.strategy == "CONFLUENCE_SUITE":
        try:
            entry = float(signal.entry)
            stop = float(signal.stop)
            return all(math.isfinite(v) and v > 0 for v in (entry, stop)) and (
                stop < entry if signal.direction == "long" else
                stop > entry if signal.direction == "short" else False
            )
        except (TypeError, ValueError):
            return False
    if signal.strategy in ("ESSENCE_MODEL", "DUAL_MA_SD", "NATE_TRADEZ", STRATEGY_NAME):
        try:
            entry = float(signal.entry)
            stop = float(signal.stop)
            target = float(signal.target)
            target2 = float(signal.target2)
            values_ok = all(math.isfinite(v) and v > 0 for v in (entry, stop, target, target2))
            return values_ok and (
                stop < entry < target < target2 if signal.direction == "long" else
                stop > entry > target > target2 if signal.direction == "short" else False
            )
        except (TypeError, ValueError):
            return False

    # The fallback geometry check is retained for old persisted records.
    try:
        entry = float(signal.entry)
        stop = float(signal.stop)
        tp1 = float(signal.target)
        tp2 = float(signal.target2)
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(v) and v > 0 for v in (entry, stop, tp1, tp2)):
        return False
    if signal.direction == "long":
        return stop < entry < tp1 < tp2
    if signal.direction == "short":
        return stop > entry > tp1 > tp2
    return False


def _native_stop_matches(positions: list[dict], symbol: str, direction: str,
                         expected_sl: float) -> bool:
    """Confirm the broker-visible protective stop equals the signal stop."""
    wanted_type = 0 if direction == "long" else 1
    for position in positions:
        if short_symbol(position.get("symbol", "")) != symbol:
            continue
        if int(position.get("type", -1)) != wanted_type:
            continue
        try:
            actual_sl = float(position.get("sl", 0) or 0)
        except (TypeError, ValueError):
            return False
        tolerance = max(0.01, abs(expected_sl) * 0.00002)
        return actual_sl > 0 and abs(actual_sl - float(expected_sl)) <= tolerance
    return False


def _native_bracket_matches(positions: list[dict], symbol: str, direction: str,
                            expected_sl: float, expected_tp: float) -> bool:
    """Confirm the broker-visible bracket equals Pine's SL and TP2."""
    wanted_type = 0 if direction == "long" else 1
    for position in positions:
        if short_symbol(position.get("symbol", "")) != symbol:
            continue
        if int(position.get("type", -1)) != wanted_type:
            continue
        try:
            actual_sl = float(position.get("sl", 0) or 0)
            actual_tp = float(position.get("tp", 0) or 0)
        except (TypeError, ValueError):
            return False
        tolerance = max(0.01, abs(expected_sl) * 0.00002, abs(expected_tp) * 0.00002)
        return (
            actual_sl > 0 and actual_tp > 0
            and abs(actual_sl - float(expected_sl)) <= tolerance
            and abs(actual_tp - float(expected_tp)) <= tolerance
        )
    return False


def manage_partial_profits(state: ScannerState) -> None:
    """Manage one-contract strategy entries and their 1R promotion.

    Entry protection is an actual TradingView bracket at the initial SL and
    measured TP2. When a verified candle reaches TP1, persist a promoted stop
    at TP1. If a later price update reverses through that level, send one
    market close for the full unit. This mirrors moving SL to TP1 without
    pretending a brittle DOM edit of an existing TradingView bracket is safe;
    the original native SL remains a catastrophic fallback if the sidecar
    goes offline. TP2 remains native and closes the position automatically.
    """
    with state.lock:
        trades = dict(state.managed_trades)
        account_id = state.account_id
    if not trades:
        return

    actual = fetch_actual_account_id()
    cross = fetch_cross_trading_enabled()
    account_id = actual or account_id
    if not account_id:
        return
    positions = fetch_positions()
    pos_map = {}
    for p in positions:
        sym = short_symbol(p.get("symbol", ""))
        side = "LONG" if int(p.get("type", 0)) == 0 else "SHORT"
        pos_map[f"{sym}:{side}"] = p

    updated = False
    for managed_key, tr in list(trades.items()):
        symbol = tr.get("symbol") or managed_key.rsplit(":", 1)[-1]
        # Cross-trading rotates between saved accounts: never manage a trade
        # registered for a different account against the currently visible
        # one. In single-account mode the visible account IS the trading
        # account, so legacy/mislabeled keys are still managed (their
        # positions live on the visible account).
        if cross and tr.get("account_id") and tr.get("account_id") != account_id:
            continue
        side = "LONG" if tr.get("direction") == "long" else "SHORT"
        key = f"{symbol}:{side}"
        pos = pos_map.get(key)
        candles = fetch_candles(symbol)
        if not candles:
            continue
        latest = candles[-1]
        price = float(latest.get("close", 0))
        if price <= 0:
            continue
        # Use the candle excursion, not only its close, so a fast move that
        # touched TP is managed even if it retraced before the next poll.
        favorable_price = (
            float(latest.get("high", price))
            if tr.get("direction") == "long"
            else float(latest.get("low", price))
        )

        # Position gone → trade ended (closed by bracket SL/TP3 or manually)
        if not pos:
            with state.lock:
                state.managed_trades.pop(managed_key, None)
            updated = True
            with state.lock:
                state.trade_log.append({
                    "time": datetime.now(timezone.utc).isoformat(),
                    "strategy": tr.get("strategy") or STRATEGY_NAME,
                    "account_id": account_id,
                    "symbol": symbol,
                    "direction": tr.get("direction"),
                    "action": "CLOSED",
                    "note": f"position exited after {tr.get('stage',0)}/{max(1, int(tr.get('qty_total', 1)))} stage(s)",
                })
            continue

        qty_total = int(tr.get("qty_total", DEFAULT_QTY))
        # One contract is never split. TP2 is attached natively at entry;
        # only TP1 promotion and the promoted-stop reversal are managed here.
        promoted_stop = tr.get("promoted_stop")
        tp1 = float(tr.get("tp1", 0) or 0)
        direction = tr.get("direction", "long")

        # Scalp flow (Nate Tradez): a position only ever exits when (a) its
        # native stop-loss is hit, or (b) the next confirmed opposite signal
        # prints — the scanner closes the current unit and reverses into the
        # new direction. Nothing exits on structure changes mid-trade.

        if promoted_stop is None and tp1 > 0:
            reached_tp1 = (
                favorable_price >= tp1 if direction == "long"
                else favorable_price <= tp1
            )
            if reached_tp1:
                # First try to move the actual TradingView stop. TP2 is sent
                # again in the same modification so the measured target stays
                # live. If the Desktop build rejects the UI edit, retain the
                # persisted virtual stop; the original native SL remains in
                # place as the catastrophic fallback.
                native_promoted = False
                try:
                    native_promoted = _modify_open_bracket(
                        symbol, direction, tp1, float(tr.get("tp2") or 0)
                    )
                except Exception as exc:
                    with state.lock:
                        state.errors.append(f"TP1 MODIFY {symbol}: {exc}")
                        state.errors = state.errors[-50:]
                with state.lock:
                    current_trade = state.managed_trades.get(managed_key)
                    if current_trade and current_trade.get("promoted_stop") is None:
                        current_trade["promoted_stop"] = tp1
                        current_trade["stage"] = 1
                        current_trade["native_stop_promoted"] = native_promoted
                        current_trade["native_promotion_pending"] = not native_promoted
                        current_trade["native_promotion_last_attempt"] = time.time()
                        current_trade["promotion_time"] = datetime.now(timezone.utc).isoformat()
                        state.trade_log.append({
                            "time": datetime.now(timezone.utc).isoformat(),
                            "strategy": tr.get("strategy") or STRATEGY_NAME,
                            "symbol": symbol,
                            "direction": direction,
                            "action": "TP1_PROTECTED",
                            "stop_moved_to": tp1,
                            "tp2": tr.get("tp2"),
                            "native_bracket_updated": native_promoted,
                            "qty": qty_total,
                        })
                updated = True
                # OHLC cannot tell whether TP1 or the reversal happened first
                # when both are inside one candle. Defer the reversal decision
                # to the next confirmed candle rather than inventing ordering.
                continue

        if promoted_stop is not None:
            # Use the adverse wick, not only the close. A scalping reversal
            # can touch the promoted stop and close back on the profitable side.
            adverse_price = (
                float(latest.get("low", price))
                if direction == "long"
                else float(latest.get("high", price))
            )
            stop_hit = (
                adverse_price <= float(promoted_stop) if direction == "long"
                else adverse_price >= float(promoted_stop)
            )

            # If the first native modification was not confirmed, retry it
            # while the virtual TP1 stop remains active. Never lower the
            # original protective stop or remove TP2 while retrying.
            if not stop_hit and tr.get("native_promotion_pending"):
                last_attempt = float(tr.get("native_promotion_last_attempt", 0) or 0)
                if time.time() - last_attempt >= 5.0:
                    native_promoted = False
                    try:
                        native_promoted = _modify_open_bracket(
                            symbol, direction, float(promoted_stop), float(tr.get("tp2") or 0)
                        )
                    except Exception as exc:
                        with state.lock:
                            state.errors.append(f"TP1 MODIFY RETRY {symbol}: {exc}")
                            state.errors = state.errors[-50:]
                    with state.lock:
                        current_trade = state.managed_trades.get(managed_key)
                        if current_trade:
                            current_trade["native_promotion_last_attempt"] = time.time()
                            if native_promoted:
                                current_trade["native_promotion_pending"] = False
                                current_trade["native_stop_promoted"] = True
                                state.trade_log.append({
                                    "time": datetime.now(timezone.utc).isoformat(),
                                    "strategy": tr.get("strategy") or STRATEGY_NAME,
                                    "symbol": symbol,
                                    "direction": direction,
                                    "action": "TP1_NATIVE_RETRY_CONFIRMED",
                                    "stop_moved_to": promoted_stop,
                                    "tp2": tr.get("tp2"),
                                })
                    updated = True

            if stop_hit:
                have = pos.get("volume", qty_total)
                try:
                    close_qty = min(DEFAULT_QTY, int(float(have)))
                except (TypeError, ValueError):
                    close_qty = DEFAULT_QTY
                if close_qty > 0:
                    pending_since = float(tr.get("exit_pending_since", 0) or 0)
                    # Keep a submitted exit in flight until the position
                    # endpoint confirms it disappeared. If a broker/UI
                    # rejection leaves it open, retry only after a longer
                    # backoff; never fire duplicate closes every scan poll.
                    if not pending_since or time.time() - pending_since >= 15.0:
                        oid = close_partial(symbol, direction, close_qty)
                        if oid:
                            # Do not delete the managed trade on a submitted
                            # order ID alone. TradingView can reject or delay
                            # the close; keep retry state until the position
                            # endpoint confirms volume reached zero.
                            with state.lock:
                                current_trade = state.managed_trades.get(managed_key)
                                if current_trade:
                                    current_trade["exit_pending_since"] = time.time()
                                    current_trade["exit_order_id"] = oid
                                    state.trade_log.append({
                                        "time": datetime.now(timezone.utc).isoformat(),
                                        "strategy": tr.get("strategy") or STRATEGY_NAME,
                                        "symbol": symbol,
                                        "direction": direction,
                                        "action": "TP1_STOP_EXIT_SUBMITTED",
                                        "qty": close_qty,
                                        "price": price,
                                        "stop": promoted_stop,
                                        "order_id": oid,
                                    })
                            updated = True

    if updated:
        with state.lock:
            state._save_managed()


# ── Passive playbook analysis ─────────────────────────────────────────

def refresh_playbook_diagnostics(state: ScannerState) -> None:
    """Analyze the complete native ladder without authorizing execution.

    The chart/playbook should remain informative while AutoTrader is paused.
    This path deliberately performs no account switching, risk checks, or
    order calls; it only refreshes the same engine dashboards the active loop
    uses once the user explicitly arms trading.
    """
    dashboards: dict[str, dict] = {}
    scan_entries: list[dict] = []
    signals: list[Signal] = []
    with state.lock:
        account_id = state.account_id

    for symbol in SYMBOLS:
        try:
            candles = fetch_candles(symbol)
            if not candles or len(candles) < 60:
                scan_entries.append({
                    "symbol": symbol,
                    "status": "no data",
                    "candles": len(candles) if candles else 0,
                })
                continue
            current_price = float(candles[-1].get("close", 0) or 0)
            if current_price <= 0:
                scan_entries.append({"symbol": symbol, "status": "no price"})
                continue

            timeframe_candles = fetch_context_candles(symbol)
            signal_rows = scan_pullback(
                candles,
                symbol,
                current_price,
                account_id,
                htf_candles=timeframe_candles.get("60", []),
                timeframe_candles=timeframe_candles,
            )
            engine = get_engine(symbol, account_id)
            dashboard = engine.get_dashboard()
            context = build_context_snapshot(timeframe_candles)
            timeframes = dict(dashboard.get("timeframes") or {})
            for tf, read in context.items():
                timeframes.setdefault(tf, read)
            dashboard["timeframes"] = {
                tf: timeframes.get(tf, {"timeframe": tf, "ready": False, "bias": "NEUTRAL", "bars": 0})
                for tf in [SCAN_TIMEFRAME, *CONTEXT_TIMEFRAMES]
            }
            dashboard["timeframe_ladder"] = [SCAN_TIMEFRAME, *CONTEXT_TIMEFRAMES]
            dashboard["analysis_mode"] = "PASSIVE"
            dashboard["ready_timeframes"] = [
                tf for tf, read in dashboard["timeframes"].items() if read.get("ready")
            ]
            dashboard["timeframes_checked"] = len(dashboard["ready_timeframes"])
            dashboards[symbol] = dashboard
            signals.extend(signal_rows)
            scan_entries.append({
                "symbol": symbol,
                "status": "signal" if signal_rows else "watching",
                "price": round(current_price, 2),
                "candles": len(candles),
                "dashboard": dashboard,
                "timeframe_alignment": dashboard["timeframes"],
                "gate": "signal-confirmed" if signal_rows else dashboard.get("gate", "watching"),
            })
        except Exception as exc:
            scan_entries.append({"symbol": symbol, "status": "error", "error": str(exc)})

    with state.lock:
        state.signals = [signal.to_dict() for signal in signals[-20:]]
        state.scan_log = scan_entries
        state.dashboards = dashboards
        state.last_scan = (
            datetime.now(timezone.utc).strftime("%H:%M:%S UTC")
            + " · analysis only (AutoTrader paused)"
        )


# ── Main scanner loop ─────────────────────────────────────────────────

def scanner_loop(state: ScannerState) -> None:
    while state.running:
        try:
            with state.lock:
                disarmed = not state.armed
                if disarmed:
                    state.last_scan = "Disarmed — scanning but not executing"
            if disarmed:
                # Keep the complete Investing Mastery playbook current while
                # paused, but never enter the execution path until the user
                # explicitly arms AutoTrader.
                refresh_playbook_diagnostics(state)
                time.sleep(SCAN_INTERVAL)
                continue

            # TradingView exposes one active account at a time. When the user
            # explicitly enables cross-trading, visit each saved/verified
            # account sequentially and confirm the switch before evaluating or
            # placing anything. With cross-trading off, stay on the saved
            # active account and never rotate.
            targets = fetch_account_targets()
            if not targets:
                with state.lock:
                    state.last_scan = "Account selection required — save an account before scanning"
                time.sleep(SCAN_INTERVAL)
                continue
            with state.lock:
                state.account_targets = list(targets)
                state.account_cursor = state.account_cursor % len(targets)
                target_account = targets[state.account_cursor]
                state.account_cursor = (state.account_cursor + 1) % len(targets)
            if not ensure_account_target(target_account):
                with state.lock:
                    state.account_id = target_account
                    state.last_scan = f"Account {target_account} could not be confirmed in TradingView"
                time.sleep(SCAN_INTERVAL)
                continue
            with state.lock:
                state.account_id = target_account

            account = fetch_account()
            if TEST_MODE and "paper" not in str(account.get("server", "")).lower():
                with state.lock:
                    state.last_scan = "Test mode blocked — Paper Trading account required"
                time.sleep(SCAN_INTERVAL)
                continue
            balance = account.get("balance", 0)
            realized = account.get("realized_pnl")
            with state.lock:
                state._sync_daily(float(realized) if realized is not None else None)

            try:
                real_positions = fetch_positions()
                with state.lock:
                    state.open_positions = len(real_positions)
                    state.open_symbols = {
                        short_symbol(p.get("symbol", "")) for p in real_positions
                        if float(p.get("volume", 0) or 0) > 0
                    } - {None, ""}
                position_sides = {}
                for position in real_positions:
                    if float(position.get("volume", 0) or 0) <= 0:
                        continue
                    symbol_name = short_symbol(position.get("symbol", ""))
                    if symbol_name:
                        position_sides[symbol_name] = "long" if int(position.get("type", -1)) == 0 else "short"
            except Exception:
                real_positions = []
                position_sides = {}

            with state.lock:
                if state.daily_start_balance == 0 and balance:
                    state.daily_start_balance = balance

            allowed, reason = check_risk(state, balance)
            if not allowed:
                with state.lock:
                    state.last_scan = f"Risk: {reason} — still listening for exits"

            # Protective stop management always runs, even when the daily
            # entry cap or concurrent-position cap is reached.
            manage_partial_profits(state)
            entry_window = in_trading_window()
            if not entry_window:
                with state.lock:
                    state.last_scan = (
                        f"Outside entry window ({TRADING_START_HOUR:02d}:00–"
                        f"{TRADING_END_HOUR:02d}:00 local) — listening for exits"
                    )

            all_signals = []
            scan_entries = []
            dashboards = {}

            for symbol in SYMBOLS:
                candles = fetch_candles(symbol)
                if not candles or len(candles) < 220:
                    scan_entries.append({
                        "symbol": symbol, "status": "no data",
                        "candles": len(candles) if candles else 0,
                    })
                    continue
                current_price = candles[-1].get("close", 0)
                if current_price <= 0:
                    scan_entries.append({"symbol": symbol, "status": "no price"})
                    continue
                bar_time = int(candles[-1].get("time", 0) or 0)
                data_age = time.time() - bar_time if bar_time > 0 else float("inf")
                if data_age > MAX_ENTRY_DATA_AGE_SECONDS:
                    scan_entries.append({
                        "symbol": symbol,
                        "status": "stale data",
                        "price": round(current_price, 2),
                        "candles": len(candles),
                        "age_seconds": round(data_age),
                        "gate": "market-data-stale",
                    })
                    continue

                timeframe_candles = fetch_context_candles(symbol)
                htf_candles = timeframe_candles.get("60", [])
                signals = scan_pullback(
                    candles,
                    symbol,
                    current_price,
                    state.account_id,
                    htf_candles=htf_candles,
                    timeframe_candles=timeframe_candles,
                )
                engine = get_engine(symbol, state.account_id)
                dashboard = engine.get_dashboard()
                context = build_context_snapshot(timeframe_candles)
                ready_context = {tf: data for tf, data in context.items() if data.get("ready")}
                # The engine is the source of truth for a playlist signal; the
                # dashboard still exposes a readable vote count when it is only
                # watching and no direction exists yet.
                dashboard["timeframes"] = dashboard.get("timeframes") or context
                dashboard["alignment_count"] = (
                    dashboard.get("alignment_count", 0)
                    if signals else 0
                )
                dashboard["timeframes_checked"] = dashboard.get("timeframes_checked", len(ready_context))
                dashboards[symbol] = dashboard

                for signal in signals:
                    # The engine evaluates the last closed trigger bar. Keep
                    # that timestamp for idempotency; the newest feed row is
                    # still forming and must never become the setup key.
                    signal.bar_time = int(signal.bar_time or 0)
                    signal.setup_key = f"{state.account_id}:{symbol}:{STRATEGY_NAME}:{signal.direction}:{signal.bar_time}"
                    signal.qty = DEFAULT_QTY
                    signal.risk_usd = round(
                        abs(signal.entry - signal.stop) * POINT_VALUES.get(symbol, 0) * DEFAULT_QTY, 2)
                all_signals.extend(signals)

                dashboard = dashboards.get(symbol, {})
                scan_entries.append({
                    "symbol": symbol,
                    "status": "signal" if signals else "watching",
                    "price": round(current_price, 2),
                    "candles": len(candles),
                    "dashboard": dashboard,
                    "timeframe_alignment": dashboard.get("timeframes", {}),
                    "gate": "signal-confirmed" if signals else (
                        dashboard.get("gate", "watching-protected-trigger")
                    ),
                })

            with state.lock:
                state.signals = [s.to_dict() for s in all_signals[-20:]]
                state.scan_log = scan_entries
                state.dashboards = dashboards
                state.last_scan = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")

            for signal in all_signals:
                if not signal.confirmed:
                    continue

                with state.lock:
                    if signal.setup_key and signal.setup_key in state.triggered_setups:
                        continue

                existing_side = position_sides.get(signal.symbol)
                if existing_side == signal.direction:
                    with state.lock:
                        state.last_scan = f"Skipped {signal.symbol}: same-side position already open"
                    continue

                # A confirmed opposite-signal (new setup) is an exit
                # first. If entries are allowed, the same signal then opens
                # exactly one unit in the opposite direction.
                if existing_side and existing_side != signal.direction:
                    try:
                        exit_id = close_partial(signal.symbol, existing_side, DEFAULT_QTY)
                    except Exception as exc:
                        exit_id = None
                        with state.lock:
                            state.errors.append(f"REVERSAL EXIT {signal.symbol}: {exc}")
                    if not exit_id:
                        with state.lock:
                            state.last_scan = f"Reversal blocked {signal.symbol}: exit was not submitted"
                        continue
                    flat = False
                    for _ in range(8):
                        time.sleep(0.5)
                        remaining = fetch_positions()
                        if _position_qty(remaining, signal.symbol, existing_side) <= 0:
                            flat = True
                            break
                    if not flat:
                        with state.lock:
                            state.last_scan = f"Reversal blocked {signal.symbol}: old position remains open"
                        continue
                    position_sides.pop(signal.symbol, None)
                    with state.lock:
                        state.open_positions = max(0, state.open_positions - 1)
                        state.open_symbols.discard(signal.symbol)
                        for key in [key for key, trade in state.managed_trades.items() if trade.get("symbol") == signal.symbol]:
                            state.managed_trades.pop(key, None)
                        state.trade_log.append({
                            "time": datetime.now(timezone.utc).isoformat(),
                            "strategy": STRATEGY_NAME,
                            "symbol": signal.symbol,
                            "direction": existing_side,
                            "action": "OPPOSITE_SIGNAL_EXIT",
                            "signal": signal.direction,
                            "order_id": exit_id,
                        })
                        state._save_managed()

                if not entry_window:
                    continue
                allowed, _ = check_risk(state, balance)
                if not allowed:
                    continue
                if not check_cooldown(state, signal.symbol):
                    continue

                units = account_entry_units(signal, account)
                signal.qty = units
                if units <= 0:
                    with state.lock:
                        state.last_scan = f"Risk: {signal.symbol} requires more available margin"
                    continue

                try:
                    order_id = execute_order(signal, qty=units)
                except Exception as exc:
                    order_id = None
                    with state.lock:
                        state.errors.append(f"EXEC {signal.symbol}: {exc}")
                        state.last_scan = f"Execution error {signal.symbol}: {exc}"
                        if len(state.errors) > 50:
                            state.errors = state.errors[-50:]

                if not order_id:
                    with state.lock:
                        if not state.last_scan.startswith("Execution error"):
                            state.last_scan = f"Execution failed {signal.symbol}: TradingView did not confirm the order"
                    # Do not mark the setup or daily count. The next scan may
                    # retry after the UI recovers, while the visible status
                    # explains why no position exists.

                if order_id:
                    signal.executed = True
                    signal.order_id = order_id
                    # Resolve the trading account OUTSIDE the lock: this makes
                    # an HTTP call to the sidecar's own /accounts endpoint and
                    # must never block other lock users while it round-trips.
                    trade_account = fetch_actual_account_id() or state.account_id

                    with state.lock:
                        execution_event = {
                            "time": datetime.now(timezone.utc).isoformat(),
                            "action": "ENTRY",
                            "strategy": STRATEGY_NAME,
                            "symbol": signal.symbol,
                            "direction": signal.direction,
                            "entry": signal.entry,
                            "stop": signal.stop,
                            "target": signal.target,
                            "target2": signal.target2,
                            "target3": signal.target3,
                            "qty": units,
                            "order_id": order_id,
                            "atr": signal.atr,
                            "account_id": state.account_id,
                            "pattern": signal.area,
                        }
                        state.trade_log.append(execution_event)
                        state.execution_log.append(execution_event)
                        _save_json(EXECUTION_LOG_FILE, {"entries": state.execution_log[-200:]})
                        state.cooldowns[signal.symbol] = time.time()
                        state.open_positions += 1
                        state.open_symbols.add(signal.symbol)
                        state._sync_daily()
                        state.daily_positions_taken += 1
                        if signal.setup_key:
                            state.triggered_setups.add(signal.setup_key)
                        # Register the trade for partial-profit management.
                        # Tag it with the account orders were actually placed
                        # on (the visible account), so partial-profit
                        # management follows the correct account. Only one
                        # managed entry may exist per symbol — a stale entry
                        # for the same market would double-close partials.
                        for _old_key in [k for k, v in state.managed_trades.items()
                                         if v.get("symbol") == signal.symbol]:
                            del state.managed_trades[_old_key]
                        managed_key = f"{trade_account}:{signal.symbol}"
                        state.managed_trades[managed_key] = {
                            "account_id": trade_account,
                            "symbol": signal.symbol,
                            "strategy": STRATEGY_NAME,
                            "direction": signal.direction,
                            "entry": signal.entry,
                            "stop": signal.stop,
                            "tp1": signal.target,
                            "tp2": signal.target2,
                            "tp3": signal.target3,
                            "qty_total": DEFAULT_QTY,
                            "stage": 0,
                            "partials_closed": 0,
                            "promoted_stop": None,
                            "promotion_time": None,
                            "opened": datetime.now(timezone.utc).isoformat(),
                        }
                        state._save_managed()
                        _save_json(STATE_FILE, {
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


# ── Public API (matches scanner_zeropoint) ────────────────────────────

def start_scanner(state: ScannerState) -> threading.Thread:
    with state.lock:
        state.running = True
        state._load_managed()
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
        _save_json(STATE_FILE, {
            "date": state.daily_date,
            "positions_taken": 0,
            "setup_keys": [],
            "start_realized": state.daily_start_realized,
        })
