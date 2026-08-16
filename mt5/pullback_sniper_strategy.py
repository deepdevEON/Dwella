#!/usr/bin/env python3
"""
pullback_sniper_strategy.py — Pullback Sniper Method [trade_w_samet]

Exact Python translation of the Pine Script v6 indicator with the same name.

Signal pipeline (mirrors the Pine exactly):
  01. Trend engine: EMA50 / EMA200 / EMA21 with a 5-bar slope check.
  02. Breakout engine: close breaks highest(high[1], 20) / lowest(low[1], 20)
      with a minimum breakout body of 0.20 × ATR.
  03. Setup state machine: breakout creates a directional setup with an
      invalidation level (lowest(low[1],12) / highest(high[1],12)), requires
      >= 2 bars after the breakout, then a pullback touch of the EMA21
      (low <= pullbackEma for longs), and expires after 60 bars.
  04. Confirmation engine ("Balanced"): close beyond the pullback EMA,
      bullish body, and either a close beyond the prior high or a lower
      wick >= 50% of the body. Entry distance must be <= 1.0 × ATR.
  05. Optional filters: McGinley Dynamic distance (0.25 × ATR) and an RSI
      direction filter (off by default), plus a 20-bar signal cooldown.
  06. Trade visual engine: SL = close - 2 × ATR(14); TP3 = entry + 2R;
      TP1 = 25% of TP3 distance (0.5R); TP2 = 50% (1R).
  07. Exit management: TP1/TP2/TP3 stage tracking, protected-TP exits when
      SL is touched after a TP, same-candle TP/SL handling, TP3 direction
      lock, and TP1/TP2/TP3/SL + win-rate statistics.

Simulation model
----------------
The scanner feeds a fixed-size sliding window of candles. Each call the
engine re-simulates the ENTIRE window with local setup/trade state (exactly
how Pine re-evaluates the series on every new bar), so nothing persists
except cumulative statistics. This makes it immune to window-slide index
drift. A signal is only emitted when the newest bar is genuinely new
(timestamp > last processed) and it confirms a fresh setup.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional


# ═══════════════════════════════════════════════════════════════════════
# CONFIGURATION  (Pine defaults)
# ═══════════════════════════════════════════════════════════════════════

# 01. Trend Engine
FAST_EMA_LENGTH = 50
SLOW_EMA_LENGTH = 200
PULLBACK_EMA_LENGTH = 21
SLOPE_LOOKBACK = 5

# 02. Breakout / Pullback Engine
BREAKOUT_LOOKBACK = 20
INVALIDATION_LOOKBACK = 12
MIN_BARS_AFTER_BREAKOUT = 2
MAX_BARS_TO_FIND_PULLBACK = 60

# 03. Confirmation Engine
CONFIRMATION_MODE = "Balanced"  # Fast / Balanced / Strict
ATR_LENGTH = 14
MIN_BREAKOUT_BODY_ATR = 0.20
MIN_CONFIRM_BODY_ATR = 0.25
MAX_ENTRY_DISTANCE_ATR = 1.00
USE_COOLDOWN = True
COOLDOWN_BARS = 20

# 04. Optional Filters
USE_MCGINLEY_FILTER = True
MCGINLEY_LENGTH = 100
MCGINLEY_DISTANCE_ATR = 0.25
USE_RSI_FILTER = False
RSI_LENGTH = 14
RSI_LONG_MIN = 50.0
RSI_SHORT_MAX = 50.0

# 05/06. Trade Visual / Levels
TRADE_ATR_LENGTH = 14
TRADE_ATR_MULTIPLIER = 2.0
TP3_REWARD_R = 2.0
TP1_PERCENT_OF_TP3 = 25.0
TP2_PERCENT_OF_TP3 = 50.0
HIDE_EARLY_SL_BARS = 3


# ═══════════════════════════════════════════════════════════════════════
# DATA STRUCTURES
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class Signal:
    """Trading signal from the Pullback Sniper engine."""
    strategy: str = "PULLBACK_SNIPER"
    symbol: str = ""
    direction: str = ""  # "long" / "short"
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0    # TP1 (primary)
    target2: float = 0.0   # TP2
    target3: float = 0.0   # TP3
    atr: float = 0.0
    confirmed: bool = True
    bar_time: int = 0
    setup_key: str = ""

    def to_dict(self) -> dict:
        return {
            "strategy": self.strategy,
            "symbol": self.symbol,
            "direction": self.direction,
            "entry": self.entry,
            "stop": self.stop,
            "target": self.target,
            "target2": self.target2,
            "target3": self.target3,
            "atr": self.atr,
            "confirmed": self.confirmed,
            "bar_time": self.bar_time,
            "setup_key": self.setup_key,
        }


@dataclass
class Stats:
    total_closed: int = 0
    tp1: int = 0
    tp2: int = 0
    tp3: int = 0
    sl: int = 0
    win_trades: int = 0
    total_r: float = 0.0
    gross_win_r: float = 0.0
    gross_loss_r: float = 0.0
    total_bars: int = 0
    max_win_streak: int = 0
    max_loss_streak: int = 0
    cur_win_streak: int = 0
    cur_loss_streak: int = 0
    cur_streak: int = 0
    long_total: int = 0
    long_wins: int = 0
    short_total: int = 0
    short_wins: int = 0


# ═══════════════════════════════════════════════════════════════════════
# INDICATOR HELPERS
# ═══════════════════════════════════════════════════════════════════════

def ema_series(values: list[float], length: int) -> list[Optional[float]]:
    """EMA seeded with SMA of the first `length` bars (Pine semantics)."""
    n = len(values)
    out: list[Optional[float]] = [None] * n
    if n < length or length <= 0:
        return out
    alpha = 2.0 / (length + 1)
    seed = sum(values[:length]) / length
    prev = seed
    out[length - 1] = seed
    for i in range(length, n):
        prev = values[i] * alpha + prev * (1 - alpha)
        out[i] = prev
    return out


def atr_series(highs, lows, closes, length: int) -> list[Optional[float]]:
    """Wilder's ATR (RMA of true range) — Pine ta.atr semantics."""
    n = len(closes)
    out: list[Optional[float]] = [None] * n
    if n < length + 1 or length <= 0:
        return out
    trs = []
    for i in range(1, n):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i - 1])
        lc = abs(lows[i] - closes[i - 1])
        trs.append(max(hl, hc, lc))
    seed = sum(trs[:length]) / length
    out[length] = seed  # candle `length` = first bar with a full ATR window
    prev = seed
    for i in range(length, len(trs)):
        prev = (prev * (length - 1) + trs[i]) / length
        out[i + 1] = prev
    return out


def rsi_series(closes: list[float], length: int) -> list[Optional[float]]:
    """Wilder's RSI."""
    n = len(closes)
    out: list[Optional[float]] = [None] * n
    if n < length + 1:
        return out
    gains = []
    losses = []
    for i in range(1, n):
        ch = closes[i] - closes[i - 1]
        gains.append(max(ch, 0.0))
        losses.append(max(-ch, 0.0))
    avg_gain = sum(gains[:length]) / length
    avg_loss = sum(losses[:length]) / length
    out[length] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)
    for i in range(length, len(gains)):
        avg_gain = (avg_gain * (length - 1) + gains[i]) / length
        avg_loss = (avg_loss * (length - 1) + losses[i]) / length
        out[i + 1] = 100.0 if avg_loss == 0 else 100.0 - 100.0 / (1 + avg_gain / avg_loss)
    return out


def mcginley_series(closes: list[float], ema100: list[Optional[float]], length: int) -> list[Optional[float]]:
    """McGinley Dynamic."""
    n = len(closes)
    out: list[Optional[float]] = [None] * n
    prev: Optional[float] = None
    for i in range(n):
        seed = ema100[i]
        if prev is None:
            prev = seed if seed is not None else closes[i]
            out[i] = prev
            continue
        base = prev if prev and prev != 0 else closes[i]
        ratio = closes[i] / base if base != 0 else 1.0
        divider = length * math.pow(ratio, 4)
        if divider == 0:
            divider = 1.0
        prev = prev + (closes[i] - prev) / divider
        out[i] = prev
    return out


# ═══════════════════════════════════════════════════════════════════════
# ENGINE
# ═══════════════════════════════════════════════════════════════════════

class PullbackSniperEngine:
    """Pullback Sniper Method engine — one instance per symbol.

    Stateless across calls except for cumulative Stats and the last
    processed bar timestamp (used to only emit on genuinely new bars).
    """

    def __init__(self, symbol: str = ""):
        self.symbol = symbol
        self.stats = Stats()
        self.last_bar_time: int = 0
        self.last_atr = 0.0
        self.last_price = 0.0
        self.last_signal_side = 0
        self.last_signal_r: Optional[float] = None
        self._bull_trend = False
        self._bear_trend = False

    # ── Stats recording (only for bars newer than last processed) ─────
    def _record_exit(self, result_r: float, bars_in_trade: int, is_win: bool,
                     stage: int, side: int):
        s = self.stats
        s.total_closed += 1
        s.total_r += result_r
        s.total_bars += bars_in_trade
        if is_win:
            s.win_trades += 1
            s.gross_win_r += result_r
            s.cur_win_streak += 1
            s.cur_loss_streak = 0
            s.max_win_streak = max(s.max_win_streak, s.cur_win_streak)
            s.cur_streak = s.cur_win_streak
        else:
            s.gross_loss_r += abs(result_r)
            s.cur_loss_streak += 1
            s.cur_win_streak = 0
            s.max_loss_streak = max(s.max_loss_streak, s.cur_loss_streak)
            s.cur_streak = -s.cur_loss_streak
        if side == 1:
            s.long_total += 1
            if is_win:
                s.long_wins += 1
        else:
            s.short_total += 1
            if is_win:
                s.short_wins += 1
        if stage == 3:
            s.tp3 += 1
        elif stage == 2:
            s.tp2 += 1
        elif stage == 1:
            s.tp1 += 1
        else:
            s.sl += 1

    # ── Main entry point ──────────────────────────────────────────────
    def process_candle(self, candles: list[Candle]) -> Optional[Signal]:
        """Re-simulate the whole window. Returns a Signal only when the
        newest bar is genuinely new and confirms a fresh setup."""
        n = len(candles)
        if n < SLOW_EMA_LENGTH + 20:
            return None

        closes = [c.close for c in candles]
        highs = [c.high for c in candles]
        lows = [c.low for c in candles]
        opens = [c.open for c in candles]

        fast_ema = ema_series(closes, FAST_EMA_LENGTH)
        slow_ema = ema_series(closes, SLOW_EMA_LENGTH)
        pull_ema = ema_series(closes, PULLBACK_EMA_LENGTH)
        atr = atr_series(highs, lows, closes, ATR_LENGTH)
        trade_atr = atr_series(highs, lows, closes, TRADE_ATR_LENGTH)
        rsi = rsi_series(closes, RSI_LENGTH)
        ema100 = ema_series(closes, MCGINLEY_LENGTH)
        mcginley = mcginley_series(closes, ema100, MCGINLEY_LENGTH)

        last_time = candles[-1].time
        newest = last_time > self.last_bar_time
        emitted: Optional[Signal] = None

        # Local (per-simulation) state — Pine var semantics within window
        setup_active = False
        setup_direction = 0
        setup_start_bar = 0
        setup_invalidation = 0.0
        setup_pullback_hit = False
        setup_completed = False

        last_signal_bar: Optional[int] = None
        last_signal_side = 0

        trade_active = False
        trade_side = 0
        trade_entry_bar = 0
        trade_entry = 0.0
        trade_stop = 0.0
        trade_tp1 = 0.0
        trade_tp2 = 0.0
        trade_tp3 = 0.0
        trade_best_tp_stage = 0
        tp3_direction_lock = 0

        for i in range(n):
            c = candles[i]
            fe = fast_ema[i]
            se = slow_ema[i]
            pe = pull_ema[i]
            a = atr[i] or 0.0
            ta = trade_atr[i] or 0.0
            r = rsi[i]
            mg = mcginley[i]

            if fe is None or se is None or pe is None or a <= 0:
                continue

            body = abs(c.close - c.open)
            upper_wick = c.high - max(c.open, c.close)
            lower_wick = min(c.open, c.close) - c.low

            fe_prev = fe
            if i - SLOPE_LOOKBACK >= 0 and fast_ema[i - SLOPE_LOOKBACK] is not None:
                fe_prev = fast_ema[i - SLOPE_LOOKBACK]
            else:
                fe_prev = fe

            bull_trend = (fe > se and c.close > se and fe > fe_prev)
            bear_trend = (fe < se and c.close < se and fe < fe_prev)
            if i == n - 1:
                self._bull_trend = bull_trend
                self._bear_trend = bear_trend

            # Breakout levels (excluding the current bar)
            lo = max(0, i - BREAKOUT_LOOKBACK)
            highest_before = max(highs[lo:i]) if lo < i else c.high
            lowest_before = min(lows[lo:i]) if lo < i else c.low

            breakout_body_ok = body >= a * MIN_BREAKOUT_BODY_ATR
            bull_breakout = bull_trend and c.close > highest_before and c.close > c.open and breakout_body_ok
            bear_breakout = bear_trend and c.close < lowest_before and c.close < c.open and breakout_body_ok

            # ── Setup creation ──
            can_create = (not trade_active) and (not setup_active or setup_completed)
            if bull_breakout and can_create:
                lo2 = max(0, i - INVALIDATION_LOOKBACK)
                setup_active = True
                setup_direction = 1
                setup_start_bar = i
                setup_invalidation = min(lows[lo2:i]) if lo2 < i else c.low
                setup_pullback_hit = False
                setup_completed = False
            if bear_breakout and can_create:
                lo2 = max(0, i - INVALIDATION_LOOKBACK)
                setup_active = True
                setup_direction = -1
                setup_start_bar = i
                setup_invalidation = max(highs[lo2:i]) if lo2 < i else c.high
                setup_pullback_hit = False
                setup_completed = False

            # ── Setup management (expiry / invalidation) ──
            bars_since_setup = (i - setup_start_bar) if setup_active else 0
            setup_expired = (setup_active and not setup_completed
                             and bars_since_setup > MAX_BARS_TO_FIND_PULLBACK)
            setup_invalidated = False
            if setup_active and not setup_completed:
                if setup_direction == 1 and c.close < setup_invalidation:
                    setup_invalidated = True
                elif setup_direction == -1 and c.close > setup_invalidation:
                    setup_invalidated = True
            if setup_expired or setup_invalidated:
                setup_active = False
                setup_direction = 0
                setup_start_bar = 0
                setup_invalidation = 0.0
                setup_pullback_hit = False
                setup_completed = False

            # ── Pullback touch ──
            if (setup_active and setup_direction == 1 and not setup_pullback_hit
                    and bars_since_setup >= MIN_BARS_AFTER_BREAKOUT
                    and c.low <= pe and c.close > setup_invalidation):
                setup_pullback_hit = True
            if (setup_active and setup_direction == -1 and not setup_pullback_hit
                    and bars_since_setup >= MIN_BARS_AFTER_BREAKOUT
                    and c.high >= pe and c.close < setup_invalidation):
                setup_pullback_hit = True

            # ── Confirmation ──
            entry_distance_ok = abs(c.close - pe) <= a * MAX_ENTRY_DISTANCE_ATR
            confirm_body_ok = body >= a * MIN_CONFIRM_BODY_ATR
            prev_high = highs[i - 1] if i >= 1 else c.high
            prev_low = lows[i - 1] if i >= 1 else c.low

            long_fast = c.close > pe and c.close > c.open
            short_fast = c.close < pe and c.close < c.open
            long_balanced = c.close > pe and c.close > c.open and (
                c.close > prev_high or lower_wick >= body * 0.50)
            short_balanced = c.close < pe and c.close < c.open and (
                c.close < prev_low or upper_wick >= body * 0.50)
            long_strict = c.close > pe and c.close > prev_high and c.close > c.open and confirm_body_ok
            short_strict = c.close < pe and c.close < prev_low and c.close < c.open and confirm_body_ok

            if CONFIRMATION_MODE == "Fast":
                long_confirm, short_confirm = long_fast, short_fast
            elif CONFIRMATION_MODE == "Strict":
                long_confirm, short_confirm = long_strict, short_strict
            else:
                long_confirm, short_confirm = long_balanced, short_balanced

            # ── Filters ──
            mcginley_allowed = True
            if USE_MCGINLEY_FILTER and mg is not None:
                mcginley_allowed = abs(c.close - mg) >= a * MCGINLEY_DISTANCE_ATR
            rsi_long_allowed = (not USE_RSI_FILTER) or (r is not None and r >= RSI_LONG_MIN)
            rsi_short_allowed = (not USE_RSI_FILTER) or (r is not None and r <= RSI_SHORT_MAX)

            cooldown_allowed = True
            if USE_COOLDOWN:
                if last_signal_bar is None:
                    cooldown_allowed = True
                else:
                    cooldown_allowed = (i - last_signal_bar) >= COOLDOWN_BARS

            # ── Trade management for an open trade (Pine section 17) ──
            trade_closed_this_bar = False
            exit_recorded = False
            if trade_active:
                tp1_touched = (c.high >= trade_tp1) if trade_side == 1 else (c.low <= trade_tp1)
                tp2_touched = (c.high >= trade_tp2) if trade_side == 1 else (c.low <= trade_tp2)
                tp3_touched = (c.high >= trade_tp3) if trade_side == 1 else (c.low <= trade_tp3)
                sl_touched = (c.low <= trade_stop) if trade_side == 1 else (c.high >= trade_stop)

                touched_stage = 3 if tp3_touched else (2 if tp2_touched else (1 if tp1_touched else 0))
                same_candle_tp_sl = sl_touched and touched_stage > 0
                if touched_stage > trade_best_tp_stage and not same_candle_tp_sl:
                    trade_best_tp_stage = touched_stage

                final_tp3 = (not same_candle_tp_sl) and trade_best_tp_stage == 3
                final_sl = sl_touched and (trade_best_tp_stage == 0 or same_candle_tp_sl)
                final_protected_tp = sl_touched and not same_candle_tp_sl and 0 < trade_best_tp_stage < 3

                if final_tp3 or final_sl or final_protected_tp:
                    trade_closed_this_bar = True
                    bars_in_trade = i - trade_entry_bar
                    early_sl_hide = final_sl and bars_in_trade <= HIDE_EARLY_SL_BARS

                    if final_tp3:
                        result_r = TP3_REWARD_R
                        stage = 3
                    elif final_protected_tp:
                        stage = trade_best_tp_stage
                        result_r = (TP3_REWARD_R * (TP2_PERCENT_OF_TP3 / 100.0)) if stage == 2 \
                            else (TP3_REWARD_R * (TP1_PERCENT_OF_TP3 / 100.0))
                    else:
                        stage = 0
                        result_r = -1.0

                    # Only count exits on bars we have not seen before, so
                    # cumulative stats do not double-count the window.
                    if not early_sl_hide and c.time > self.last_bar_time:
                        self._record_exit(result_r, bars_in_trade, result_r > 0, stage, trade_side)
                        exit_recorded = True

                    if final_tp3:
                        tp3_direction_lock = trade_side

                    trade_active = False
                    trade_side = 0
                    trade_entry_bar = 0
                    trade_entry = 0.0
                    trade_stop = 0.0
                    trade_tp1 = 0.0
                    trade_tp2 = 0.0
                    trade_tp3 = 0.0
                    trade_best_tp_stage = 0

            # ── Direction unlock ──
            long_unlocked = tp3_direction_lock == 0 or tp3_direction_lock == -1
            short_unlocked = tp3_direction_lock == 0 or tp3_direction_lock == 1

            trade_can_open = (not trade_active) and (not trade_closed_this_bar) and ta is not None

            strong_long = (setup_active and setup_direction == 1 and setup_pullback_hit
                           and bull_trend and long_confirm and entry_distance_ok
                           and mcginley_allowed and rsi_long_allowed and cooldown_allowed
                           and trade_can_open and long_unlocked)
            strong_short = (setup_active and setup_direction == -1 and setup_pullback_hit
                            and bear_trend and short_confirm and entry_distance_ok
                            and mcginley_allowed and rsi_short_allowed and cooldown_allowed
                            and trade_can_open and short_unlocked)

            if strong_long or strong_short:
                last_signal_bar = i
                last_signal_side = 1 if strong_long else -1
                self.last_signal_side = last_signal_side
                setup_completed = True
                setup_active = False
                setup_pullback_hit = False

                # ── Trade entry (Pine section 20) ──
                trade_active = True
                trade_side = 1 if strong_long else -1
                trade_entry_bar = i
                trade_entry = c.close
                trade_stop = c.close - (ta * TRADE_ATR_MULTIPLIER) if strong_long \
                    else c.close + (ta * TRADE_ATR_MULTIPLIER)
                trade_best_tp_stage = 0

                risk = abs(trade_entry - trade_stop)
                trade_tp3 = trade_entry + risk * TP3_REWARD_R if strong_long \
                    else trade_entry - risk * TP3_REWARD_R
                trade_tp1 = trade_entry + risk * TP3_REWARD_R * (TP1_PERCENT_OF_TP3 / 100.0) if strong_long \
                    else trade_entry - risk * TP3_REWARD_R * (TP1_PERCENT_OF_TP3 / 100.0)
                trade_tp2 = trade_entry + risk * TP3_REWARD_R * (TP2_PERCENT_OF_TP3 / 100.0) if strong_long \
                    else trade_entry - risk * TP3_REWARD_R * (TP2_PERCENT_OF_TP3 / 100.0)

                if tp3_direction_lock == -1 and strong_long:
                    tp3_direction_lock = 0
                if tp3_direction_lock == 1 and strong_short:
                    tp3_direction_lock = 0

                if i == n - 1 and newest:
                    emitted = Signal(
                        strategy="PULLBACK_SNIPER",
                        symbol=self.symbol,
                        direction="long" if strong_long else "short",
                        entry=trade_entry,
                        stop=trade_stop,
                        target=trade_tp1,
                        target2=trade_tp2,
                        target3=trade_tp3,
                        atr=round(ta, 6),
                        confirmed=True,
                        bar_time=c.time,
                        setup_key=f"{self.symbol}:PULLBACK_SNIPER:{'long' if strong_long else 'short'}:{c.time}",
                    )
                    self.last_signal_r = TP3_REWARD_R

            self.last_atr = a
            self.last_price = c.close

        if newest:
            self.last_bar_time = last_time
        return emitted

    # ── Dashboard ─────────────────────────────────────────────────────
    def get_dashboard(self) -> dict:
        s = self.stats
        losses = s.total_closed - s.win_trades
        wr = (s.win_trades / s.total_closed * 100.0) if s.total_closed > 0 else 0.0
        avg_win = s.gross_win_r / s.win_trades if s.win_trades > 0 else 0.0
        avg_loss = s.gross_loss_r / losses if losses > 0 else 0.0
        pf = (s.gross_win_r / s.gross_loss_r) if s.gross_loss_r > 0 else (999.0 if s.gross_win_r > 0 else 0.0)
        long_wr = (s.long_wins / s.long_total * 100.0) if s.long_total > 0 else 0.0
        short_wr = (s.short_wins / s.short_total * 100.0) if s.short_total > 0 else 0.0

        trend = "BULLISH" if self._bull_trend else ("BEARISH" if self._bear_trend else "NEUTRAL")
        return {
            "strategy": "PULLBACK_SNIPER",
            "trend": trend,
            "last_signal": "LONG" if self.last_signal_side == 1 else ("SHORT" if self.last_signal_side == -1 else "NONE"),
            "total_trades": s.total_closed,
            "tp1_count": s.tp1, "tp2_count": s.tp2, "tp3_count": s.tp3, "sl_count": s.sl,
            "win_rate": round(wr, 1),
            "avg_win_r": round(avg_win, 2),
            "avg_loss_r": round(avg_loss, 2),
            "profit_factor": round(pf, 2) if pf < 100 else "∞",
            "long_win_rate": round(long_wr, 1),
            "short_win_rate": round(short_wr, 1),
            "max_win_streak": s.max_win_streak,
            "max_loss_streak": s.max_loss_streak,
            "atr": round(self.last_atr, 6),
            "price": round(self.last_price, 4),
            "params": {
                "ema": [FAST_EMA_LENGTH, SLOW_EMA_LENGTH, PULLBACK_EMA_LENGTH],
                "breakout": BREAKOUT_LOOKBACK,
                "invalidation": INVALIDATION_LOOKBACK,
                "max_pullback_bars": MAX_BARS_TO_FIND_PULLBACK,
                "confirmation": CONFIRMATION_MODE,
                "sl_atr_mult": TRADE_ATR_MULTIPLIER,
                "tp3_r": TP3_REWARD_R,
                "tp1_pct": TP1_PERCENT_OF_TP3,
                "tp2_pct": TP2_PERCENT_OF_TP3,
            },
        }
