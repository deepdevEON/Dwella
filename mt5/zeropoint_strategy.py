#!/usr/bin/env python3
"""
zeropoint_strategy.py — ZeroPoint™ PRO Strategy

Translated from TradingView Pine Script v6 to Python.

Core components:
  1. ATR-based trailing stop (direction flip = signal)
  2. Market structure: BOS, CHoCH, swing points
  3. Order Blocks
  4. Trade execution with TP1, TP2, TP3 targets
  5. Win rate tracking and statistics

Improvements over the Pine original:
  - Breakeven trail: once TP1 is hit, the stop moves to entry.
  - Volatility gate: no entries when ATR is unusually low (dead market).
  - Optional EMA50 trend filter: longs only above the 50 EMA, shorts below.
"""
from __future__ import annotations

import math
import statistics
from collections import deque
from dataclasses import dataclass, field
from typing import Optional


# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

# ATR Trailing Stop
ATR_MULTIPLIER = 3.0
ATR_PERIOD = 10

# TP/SL Targets (ATR multipliers)
TP1_ATR_MULT = 2.0
TP2_ATR_MULT = 3.5
TP3_ATR_MULT = 5.0
TP2_ENABLED = True
TP3_ENABLED = True

# Stop Loss
USE_STRUCTURE_SL = True
SL_ATR_MULT = 1.5
SL_BUFFER_PCT = 0.1

# Market Structure
SWING_LENGTH = 5

# Order Blocks
OB_EXTEND = 50
MAX_OB_COUNT = 5
OB_MITIGATION = "Close"  # "Close" or "Wick"
OB_ZONE_TYPE = "Body"    # "Body" or "Wick"

# ── Improvements ──────────────────────────────────────────────────────
# Move the stop to breakeven once TP1 is tagged.
BREAKEVEN_ON_TP1 = True
# Skip entries when ATR is unusually low: below a fraction of its recent
# median (regime collapse) OR below a fraction of price (always-dead bar,
# e.g. pre-market lulls). Both are safe across symbol types.
VOL_FILTER = True
VOL_MEDIAN_LEN = 60
VOL_MIN_RATIO = 0.45
VOL_MIN_ATR_PCT = 0.005  # percent of price; 0.005 = 5 bps
# Optional EMA trend filter (OFF by default — it lags at inflection
# points, exactly when the ATR-trail flip fires, so it tends to block
# every reversal entry. Flip to True only if you accept the latency).
TREND_FILTER = False
TREND_EMA = 50


# ═══════════════════════════════════════════════════════════════════════════════
# DATA STRUCTURES
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class TradeState:
    """Tracks the current active trade and win rate statistics."""
    entry_price: float = 0.0
    tp1_level: float = 0.0
    tp2_level: float = 0.0
    tp3_level: float = 0.0
    sl_level: float = 0.0
    trade_dir: int = 0  # 1 = long, -1 = short, 0 = flat
    risk_pips: float = 0.0
    rr_ratio: float = 0.0
    tp1_hit: bool = False
    tp2_hit: bool = False
    tp3_hit: bool = False
    sl_hit: bool = False
    trade_closed: bool = False
    max_profit_reached: float = 0.0
    sl_moved: bool = False  # stop already moved to breakeven

    # Win rate tracking
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    total_profit_pct: float = 0.0
    total_loss_pct: float = 0.0
    max_consecutive_wins: int = 0
    max_consecutive_losses: int = 0
    current_consecutive_wins: int = 0
    current_consecutive_losses: int = 0


@dataclass
class MarketStructure:
    """Tracks market structure: swing points, BOS, CHoCH."""
    last_swing_high: float = 0.0
    last_swing_low: float = 0.0
    last_swing_high_bar: int = 0
    last_swing_low_bar: int = 0
    prev_swing_high: float = 0.0
    prev_swing_low: float = 0.0
    market_trend: int = 0  # 1 = bullish, -1 = bearish, 0 = neutral


@dataclass
class OrderBlock:
    """Order block zone."""
    top: float
    bottom: float
    start_bar: int
    is_bullish: bool


@dataclass
class Signal:
    """Trading signal from ZeroPoint."""
    strategy: str = "ZEROPOINT"
    symbol: str = ""
    direction: str = ""  # "long" or "short"
    entry: float = 0.0
    stop: float = 0.0
    target1: float = 0.0
    target2: float = 0.0
    target3: float = 0.0
    atr: float = 0.0
    confirmed: bool = False
    bar_time: int = 0
    setup_key: str = ""

    def to_dict(self) -> dict:
        return {
            "strategy": self.strategy,
            "symbol": self.symbol,
            "direction": self.direction,
            "entry": self.entry,
            "stop": self.stop,
            "target1": self.target1,
            "target2": self.target2,
            "target3": self.target3,
            "atr": self.atr,
            "confirmed": self.confirmed,
            "bar_time": self.bar_time,
            "setup_key": self.setup_key,
        }


# ═══════════════════════════════════════════════════════════════════════════════
# INDICATOR FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

def compute_atr(candles: list[Candle], period: int = 14) -> float:
    """Wilder's ATR."""
    if len(candles) < 2:
        return 0.0
    start = max(0, len(candles) - period - 1)
    trs = []
    for i in range(start + 1, len(candles)):
        c = candles[i]
        prev_close = candles[i - 1].close
        tr = max(
            c.high - c.low,
            abs(c.high - prev_close),
            abs(c.low - prev_close),
        )
        trs.append(tr)
    return sum(trs) / len(trs) if trs else 0.0


def ema(values: list[float], period: int) -> Optional[float]:
    """Exponential moving average of the series, evaluated at the last value."""
    if not values or len(values) < period:
        return None
    k = 2.0 / (period + 1)
    e = values[0]
    for v in values[1:]:
        e = v * k + e * (1 - k)
    return e


def find_pivot_high(candles: list[Candle], left: int, right: int) -> Optional[float]:
    """Find pivot high (swing high)."""
    if len(candles) < left + right + 1:
        return None
    idx = len(candles) - 1 - right
    if idx < left:
        return None
    high = candles[idx].high
    for i in range(1, left + 1):
        if candles[idx - i].high >= high:
            return None
    for i in range(1, right + 1):
        if candles[idx + i].high >= high:
            return None
    return high


def find_pivot_low(candles: list[Candle], left: int, right: int) -> Optional[float]:
    """Find pivot low (swing low)."""
    if len(candles) < left + right + 1:
        return None
    idx = len(candles) - 1 - right
    if idx < left:
        return None
    low = candles[idx].low
    for i in range(1, left + 1):
        if candles[idx - i].low <= low:
            return None
    for i in range(1, right + 1):
        if candles[idx + i].low <= low:
            return None
    return low


# ═══════════════════════════════════════════════════════════════════════════════
# ZEROPOINT ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

class ZeroPointEngine:
    """
    ZeroPoint™ PRO strategy engine.

    Maintains state across candles and generates signals when the
    ATR trailing stop flips direction.

    IMPORTANT (fixed): the engine is keyed on the *candle timestamp*, not
    on the array position. The scanner feeds a fixed-size sliding window,
    so `len(candles) - 1` is constant and index-based dedup silently froze
    the engine after its first call — no signals ever fired.
    """

    def __init__(self, symbol: str = ""):
        self.symbol = symbol
        self.trade = TradeState()
        self.structure = MarketStructure()
        self.order_blocks: list[OrderBlock] = []

        # Trailing stop state
        self.xATRTrailingStop: float = 0.0
        self.pos: int = 0  # 1 = bullish, -1 = bearish
        self.last_signal_dir: int = 0

        # Last processed bar timestamp (0 = none yet)
        self.last_bar_time: int = 0

        # Self-calibrating volatility history (per symbol)
        self.atr_history: deque = deque(maxlen=VOL_MEDIAN_LEN)
        self.last_atr: float = 0.0
        # Filter diagnostics for the dashboard
        self.last_filter: str = ""

    def reset_trade(self):
        """Reset trade state for new trade."""
        self.trade.trade_closed = False
        self.trade.tp1_hit = False
        self.trade.tp2_hit = False
        self.trade.tp3_hit = False
        self.trade.sl_hit = False
        self.trade.max_profit_reached = 0.0
        self.trade.sl_moved = False

    # ── signal filters ──────────────────────────────────────────────
    def _volatility_allows(self, atr: float, close: float) -> bool:
        """Block entries when ATR is unusually low.

        Two independent gates: (1) ATR collapsed below a fraction of its
        recent median (regime change), (2) ATR is a tiny fraction of price
        (always-dead bar, e.g. pre-market lulls).
        """
        if not VOL_FILTER:
            return True
        if close > 0 and atr < close * (VOL_MIN_ATR_PCT / 100.0):
            self.last_filter = (f"volatility gate (ATR {atr:.4f} < {VOL_MIN_ATR_PCT:.3f}% of price {close:.2f})")
            return False
        if len(self.atr_history) < 20:
            return True  # not enough history to judge yet
        med = statistics.median(self.atr_history)
        if med <= 0:
            return True
        if atr < VOL_MIN_RATIO * med:
            self.last_filter = f"volatility gate (ATR {atr:.4f} < {VOL_MIN_RATIO:.2f}× median {med:.4f})"
            return False
        return True

    def _trend_allows(self, candles: list[Candle], direction: str) -> bool:
        """Longs only above the 50 EMA, shorts only below it."""
        if not TREND_FILTER:
            return True
        closes = [c.close for c in candles]
        e = ema(closes, TREND_EMA)
        if e is None:
            return True
        close = candles[-1].close
        if direction == "long" and close < e:
            self.last_filter = f"trend filter (close {close:.2f} < EMA{TREND_EMA} {e:.2f})"
            return False
        if direction == "short" and close > e:
            self.last_filter = f"trend filter (close {close:.2f} > EMA{TREND_EMA} {e:.2f})"
            return False
        return True

    def _filters_allow(self, candles: list[Candle], atr: float, direction: str) -> bool:
        self.last_filter = ""
        close = candles[-1].close if candles else 0.0
        if not self._volatility_allows(atr, close):
            return False
        if not self._trend_allows(candles, direction):
            return False
        return True

    # ── trade management ────────────────────────────────────────────
    def _manage_long(self, current: Candle) -> None:
        t = self.trade
        if current.high >= t.tp1_level:
            t.tp1_hit = True
            if BREAKEVEN_ON_TP1 and not t.sl_moved and t.sl_level < t.entry_price:
                t.sl_level = t.entry_price
                t.sl_moved = True
        if TP2_ENABLED and current.high >= t.tp2_level:
            t.tp2_hit = True
        if TP3_ENABLED and current.high >= t.tp3_level:
            t.tp3_hit = True

        if current.high - t.entry_price > t.max_profit_reached:
            t.max_profit_reached = current.high - t.entry_price

        # SL check (only if TP1 not hit — matches Pine)
        if current.low <= t.sl_level and not t.tp1_hit:
            self._record_loss(current.low, side=1)

    def _manage_short(self, current: Candle) -> None:
        t = self.trade
        if current.low <= t.tp1_level:
            t.tp1_hit = True
            if BREAKEVEN_ON_TP1 and not t.sl_moved and t.sl_level > t.entry_price:
                t.sl_level = t.entry_price
                t.sl_moved = True
        if TP2_ENABLED and current.low <= t.tp2_level:
            t.tp2_hit = True
        if TP3_ENABLED and current.low <= t.tp3_level:
            t.tp3_hit = True

        if t.entry_price - current.low > t.max_profit_reached:
            t.max_profit_reached = t.entry_price - current.low

        # SL check (only if TP1 not hit — matches Pine)
        if current.high >= t.sl_level and not t.tp1_hit:
            self._record_loss(current.high, side=-1)

    def _record_loss(self, hit_price: float, side: int) -> None:
        t = self.trade
        t.sl_hit = True
        t.trade_closed = True
        t.losses += 1
        t.total_trades += 1
        if side == 1:
            t.total_loss_pct += (t.entry_price - t.sl_level) / t.entry_price * 100
        else:
            t.total_loss_pct += (t.sl_level - t.entry_price) / t.entry_price * 100
        t.current_consecutive_losses += 1
        t.current_consecutive_wins = 0
        if t.current_consecutive_losses > t.max_consecutive_losses:
            t.max_consecutive_losses = t.current_consecutive_losses

    def _close_on_signal(self, current: Candle) -> None:
        """Close the active trade (win/loss) when the trail flips direction."""
        t = self.trade
        if t.trade_dir == 0 or t.trade_closed:
            return
        final_pnl = 0.0
        if t.trade_dir == 1:
            final_pnl = (t.tp1_level - t.entry_price) / t.entry_price * 100 if t.tp1_hit \
                else (current.close - t.entry_price) / t.entry_price * 100
        elif t.trade_dir == -1:
            final_pnl = (t.entry_price - t.tp1_level) / t.entry_price * 100 if t.tp1_hit \
                else (t.entry_price - current.close) / t.entry_price * 100

        if final_pnl > 0 or t.tp1_hit:
            t.wins += 1
            t.total_trades += 1
            t.total_profit_pct += abs(final_pnl)
            t.current_consecutive_wins += 1
            t.current_consecutive_losses = 0
            if t.current_consecutive_wins > t.max_consecutive_wins:
                t.max_consecutive_wins = t.current_consecutive_wins
        else:
            t.losses += 1
            t.total_trades += 1
            t.total_loss_pct += abs(final_pnl)
            t.current_consecutive_losses += 1
            t.current_consecutive_wins = 0
            if t.current_consecutive_losses > t.max_consecutive_losses:
                t.max_consecutive_losses = t.current_consecutive_losses
        t.trade_closed = True

    # ── main entry point ────────────────────────────────────────────
    def process_candle(self, candles: list[Candle]) -> Optional[Signal]:
        """
        Process a new candle and return a Signal if triggered.

        Called once per (symbol, snapshot). The engine evaluates on each
        *new* bar timestamp, so a fixed sliding window can never freeze it.
        """
        if len(candles) < ATR_PERIOD + 10:
            return None

        current = candles[-1]
        bar_time = current.time

        # Same bar already processed — nothing new to evaluate.
        if bar_time == self.last_bar_time:
            return None
        self.last_bar_time = bar_time

        atr = compute_atr(candles, ATR_PERIOD)
        if atr <= 0:
            return None
        self.last_atr = atr
        self.atr_history.append(atr)

        n_loss = ATR_MULTIPLIER * atr
        src = current.close
        prev_pos = self.pos
        prev_src = candles[-2].close if len(candles) > 1 else src

        if prev_pos == 0:
            # First bar ever seen: establish the initial trail, no signal.
            self.xATRTrailingStop = src
            self.pos = 1
            return None

        prev_stop = self.xATRTrailingStop if self.xATRTrailingStop > 0 else src

        # ── ATR TRAILING STOP (Pine-equivalent state machine) ──
        if src > prev_stop and prev_src > prev_stop:
            self.xATRTrailingStop = max(prev_stop, src - n_loss)
            self.pos = 1
        elif src < prev_stop and prev_src < prev_stop:
            self.xATRTrailingStop = min(prev_stop, src + n_loss)
            self.pos = -1
        elif src > prev_stop:
            self.xATRTrailingStop = src - n_loss
            self.pos = 1
        else:
            self.xATRTrailingStop = src + n_loss
            self.pos = -1

        # ── DETECT DIRECTION FLIP (pos changed vs. previous bar) ──
        buy_signal = (self.pos == 1 and prev_pos == -1 and self.last_signal_dir != 1)
        sell_signal = (self.pos == -1 and prev_pos == 1 and self.last_signal_dir != -1)

        # ── MARKET STRUCTURE (Swing Points) ──
        pivot_high = find_pivot_high(candles, SWING_LENGTH, SWING_LENGTH)
        pivot_low = find_pivot_low(candles, SWING_LENGTH, SWING_LENGTH)

        if pivot_high is not None:
            self.structure.prev_swing_high = self.structure.last_swing_high
            self.structure.last_swing_high = pivot_high
            self.structure.last_swing_high_bar = bar_time

        if pivot_low is not None:
            self.structure.prev_swing_low = self.structure.last_swing_low
            self.structure.last_swing_low = pivot_low
            self.structure.last_swing_low_bar = bar_time

        recent_swing_low = min(c.low for c in candles[-10:]) if len(candles) >= 10 else current.low
        recent_swing_high = max(c.high for c in candles[-10:]) if len(candles) >= 10 else current.high

        # ── BOS / CHoCH ──
        bos_up = (self.structure.last_swing_high > 0 and
                  current.close > self.structure.last_swing_high and
                  candles[-2].close <= self.structure.last_swing_high and
                  self.structure.market_trend == 1)
        bos_down = (self.structure.last_swing_low > 0 and
                    current.close < self.structure.last_swing_low and
                    candles[-2].close >= self.structure.last_swing_low and
                    self.structure.market_trend == -1)
        choch_up = (self.structure.last_swing_high > 0 and
                    current.close > self.structure.last_swing_high and
                    candles[-2].close <= self.structure.last_swing_high and
                    self.structure.market_trend == -1)
        choch_down = (self.structure.last_swing_low > 0 and
                      current.close < self.structure.last_swing_low and
                      candles[-2].close >= self.structure.last_swing_low and
                      self.structure.market_trend == 1)

        if choch_up or bos_up:
            self.structure.market_trend = 1
        if choch_down or bos_down:
            self.structure.market_trend = -1

        # ── ORDER BLOCKS ──
        if bos_up or choch_up:
            for i in range(1, min(6, len(candles))):
                if candles[-i].close < candles[-i].open:  # bearish candle
                    if OB_ZONE_TYPE == "Body":
                        ob_top = max(candles[-i].open, candles[-i].close)
                        ob_bottom = min(candles[-i].open, candles[-i].close)
                    else:
                        ob_top = candles[-i].high
                        ob_bottom = candles[-i].low
                    self.order_blocks.append(OrderBlock(
                        top=ob_top, bottom=ob_bottom,
                        start_bar=bar_time, is_bullish=True,
                    ))
                    break

        if bos_down or choch_down:
            for i in range(1, min(6, len(candles))):
                if candles[-i].close > candles[-i].open:  # bullish candle
                    if OB_ZONE_TYPE == "Body":
                        ob_top = max(candles[-i].open, candles[-i].close)
                        ob_bottom = min(candles[-i].open, candles[-i].close)
                    else:
                        ob_top = candles[-i].high
                        ob_bottom = candles[-i].low
                    self.order_blocks.append(OrderBlock(
                        top=ob_top, bottom=ob_bottom,
                        start_bar=bar_time, is_bullish=False,
                    ))
                    break

        if len(self.order_blocks) > MAX_OB_COUNT:
            self.order_blocks = self.order_blocks[-MAX_OB_COUNT:]

        for ob in self.order_blocks[:]:
            if ob.is_bullish and current.low <= ob.top and current.low >= ob.bottom:
                if OB_MITIGATION == "Close" and current.close < ob.bottom:
                    self.order_blocks.remove(ob)
                elif OB_MITIGATION == "Wick" and current.low < ob.bottom:
                    self.order_blocks.remove(ob)
            elif not ob.is_bullish and current.high >= ob.bottom and current.high <= ob.top:
                if OB_MITIGATION == "Close" and current.close > ob.top:
                    self.order_blocks.remove(ob)
                elif OB_MITIGATION == "Wick" and current.high > ob.top:
                    self.order_blocks.remove(ob)

        # ── CHECK EXISTING TRADE (TP / SL / breakeven) ──
        if self.trade.trade_dir == 1 and not self.trade.trade_closed:
            self._manage_long(current)
        elif self.trade.trade_dir == -1 and not self.trade.trade_closed:
            self._manage_short(current)

        # Close trade on signal switch
        if (buy_signal or sell_signal) and self.trade.trade_dir != 0 and not self.trade.trade_closed:
            self._close_on_signal(current)

        # ── NEW TRADE ENTRY ──
        signal = None
        if buy_signal:
            signal = self._entry(current, atr, recent_swing_low, recent_swing_high, "long", candles)
        elif sell_signal:
            signal = self._entry(current, atr, recent_swing_low, recent_swing_high, "short", candles)

        return signal

    def _entry(self, current: Candle, atr: float,
               recent_swing_low: float, recent_swing_high: float,
               direction: str, candles: list[Candle]) -> Optional[Signal]:
        """Filters + entry setup + signal emission for a detected flip."""
        if not self._filters_allow(candles, atr, direction):
            return None

        t = self.trade
        self.reset_trade()
        t.entry_price = current.close
        t.trade_dir = 1 if direction == "long" else -1

        if direction == "long":
            t.tp1_level = current.close + (atr * TP1_ATR_MULT)
            t.tp2_level = current.close + (atr * TP2_ATR_MULT) if TP2_ENABLED else 0.0
            t.tp3_level = current.close + (atr * TP3_ATR_MULT) if TP3_ENABLED else 0.0
            if USE_STRUCTURE_SL and recent_swing_low > 0:
                buffer = recent_swing_low * (SL_BUFFER_PCT / 100)
                structural_sl = recent_swing_low - buffer
                min_sl = current.close - (atr * SL_ATR_MULT)
                t.sl_level = min_sl if structural_sl > min_sl else structural_sl
            else:
                t.sl_level = current.close - (atr * SL_ATR_MULT)
            t.risk_pips = t.entry_price - t.sl_level
            t.rr_ratio = (t.tp1_level - t.entry_price) / t.risk_pips if t.risk_pips > 0 else 0
        else:
            t.tp1_level = current.close - (atr * TP1_ATR_MULT)
            t.tp2_level = current.close - (atr * TP2_ATR_MULT) if TP2_ENABLED else 0.0
            t.tp3_level = current.close - (atr * TP3_ATR_MULT) if TP3_ENABLED else 0.0
            if USE_STRUCTURE_SL and recent_swing_high > 0:
                buffer = recent_swing_high * (SL_BUFFER_PCT / 100)
                structural_sl = recent_swing_high + buffer
                min_sl = current.close + (atr * SL_ATR_MULT)
                t.sl_level = min_sl if structural_sl < min_sl else structural_sl
            else:
                t.sl_level = current.close + (atr * SL_ATR_MULT)
            t.risk_pips = t.sl_level - t.entry_price
            t.rr_ratio = (t.entry_price - t.tp1_level) / t.risk_pips if t.risk_pips > 0 else 0

        self.last_signal_dir = t.trade_dir

        return Signal(
            symbol=self.symbol,
            direction=direction,
            entry=t.entry_price,
            stop=t.sl_level,
            target1=t.tp1_level,
            target2=t.tp2_level,
            target3=t.tp3_level,
            atr=atr,
            confirmed=True,
            bar_time=current.time,
            setup_key=f"{self.symbol}:ZEROPOINT:{direction}:{current.time}",
        )

    def get_dashboard(self) -> dict:
        """Return dashboard data for UI display."""
        win_rate = (self.trade.wins / self.trade.total_trades * 100) if self.trade.total_trades > 0 else 0.0
        avg_win = (self.trade.total_profit_pct / self.trade.wins) if self.trade.wins > 0 else 0.0
        avg_loss = (self.trade.total_loss_pct / self.trade.losses) if self.trade.losses > 0 else 0.0
        profit_factor = (self.trade.total_profit_pct / self.trade.total_loss_pct) if self.trade.total_loss_pct > 0 else (999.0 if self.trade.total_profit_pct > 0 else 0.0)

        struct_text = "▲ BULLISH" if self.structure.market_trend == 1 else ("▼ BEARISH" if self.structure.market_trend == -1 else "— NEUTRAL")
        bias_text = "▲ LONG" if self.pos == 1 else "▼ SHORT"
        trade_text = "◆ LONG" if self.trade.trade_dir == 1 else ("◆ SHORT" if self.trade.trade_dir == -1 else "— FLAT")

        return {
            "structure": struct_text,
            "bias": bias_text,
            "trade": trade_text,
            "entry": self.trade.entry_price if self.trade.trade_dir != 0 else None,
            "tp1": self.trade.tp1_level if self.trade.trade_dir != 0 else None,
            "tp1_hit": self.trade.tp1_hit,
            "tp2": self.trade.tp2_level if self.trade.trade_dir != 0 and TP2_ENABLED else None,
            "tp2_hit": self.trade.tp2_hit,
            "tp3": self.trade.tp3_level if self.trade.trade_dir != 0 and TP3_ENABLED else None,
            "tp3_hit": self.trade.tp3_hit,
            "sl": self.trade.sl_level if self.trade.trade_dir != 0 else None,
            "sl_hit": self.trade.sl_hit,
            "win_rate": round(win_rate, 1),
            "total_trades": self.trade.total_trades,
            "profit_factor": round(profit_factor, 2) if profit_factor < 100 else "∞",
            "best_run": self.trade.max_consecutive_wins,
            "trailing_stop": self.xATRTrailingStop,
            "atr": round(self.last_atr, 4),
            "last_filter": self.last_filter,
            "filters": {
                "breakeven_on_tp1": BREAKEVEN_ON_TP1,
                "volatility_gate": VOL_FILTER,
                "trend_filter": TREND_FILTER,
            },
        }
