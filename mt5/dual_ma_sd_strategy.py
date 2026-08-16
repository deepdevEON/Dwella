#!/usr/bin/env python3
"""Dual MA SD Oscillator — SMC execution layer.

Python companion for the supplied Pine v6 "Dual MA SD Oscillator"
(SchizoQuant).  The oscillator is the entry/exit authority:

    fastMA = EMA(src, maFast)     slowMA = EMA(src, maSlow)
    spread = fastMA - slowMA      smoothed = EMA(spread, maSmooth)
    upperBand = +stdev(smoothed, upperSDLen)
    lowerBand = -stdev(smoothed, lowerSDLen)
    smoothed > upperBand  -> BULL state (long)
    smoothed < lowerBand  -> BEAR state (short)

A state FLIP (BEAR -> BULL / BULL -> BEAR) on a confirmed bar is the only
entry.  The opposite flip closes the position and reverses.

The Pine indicator itself defines no stop or target.  The SMC layer supplies
the missing protective structure:

  - Stop: the protected swing on the entry side (confirmed pivot low for a
    long, pivot high for a short) with a 1x ATR buffer, tightened so the
    trade never risks more than the scanner's per-trade risk cap.
  - Target: the prior confirmed opposite swing (structure target).  When no
    opposite swing exists yet the target falls back to a measured 1R.
  - Exits: the native stop, a structure-break (CHoCH) exit when a confirmed
    bar closes through the last opposite swing, and the opposite oscillator
    flip (handled by the scanner as exit-and-reverse).

An optional event gate requires a qualifying SMC event (liquidity sweep or
fair-value-gap retrace) inside the leg being reversed before a flip can fire,
so the oscillator never trades empty structure.  All reads use closed bars;
nothing repaints.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

STRATEGY_NAME = "DUAL_MA_SD"
TIMEFRAME = "15"

# Pine defaults from the supplied indicator.
MA_FAST = 1
MA_SLOW = 30
MA_SMOOTH = 1
UPPER_SD_LEN = 25
LOWER_SD_LEN = 25
# SMC tuning (this code, not the indicator).
SWING_LEFT = 5          # pivot lookback for protected swings
EVENT_MAX_BARS = 60     # a qualifying event older than this no longer qualifies
STOP_ATR_MULT = 0.5     # buffer beyond the protected swing, in ATR (tighter for scalping)
MIN_RR = 1.0            # never take a structure setup worse than 1R
MAX_EXTENSION_ATR = 3.0 # fail closed if price is absurdly far from the swing
MAX_STOP_ATR = 3.0      # hard cap: total stop distance never exceeds this many ATR


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
    strategy: str = STRATEGY_NAME
    symbol: str = ""
    direction: str = ""  # long / short
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0   # structure target (1R)
    target2: float = 0.0  # reserved: 2R when the structure target is wide
    target3: float = 0.0
    atr: float = 0.0
    confirmed: bool = True
    bar_time: int = 0
    setup_key: str = ""
    phase: str = "ENTRY"
    pattern: str = ""     # "BULL flip · sweep → swing" style description
    grade: str = "SMC"
    score: float = 0.0
    framework: str = ""   # "structure-long" / "structure-short" / ""
    bias: int = 0
    event: str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _ema(series: list[float], length: int) -> list[float]:
    if length <= 0 or not series:
        return []
    alpha = 2.0 / (length + 1.0)
    out: list[float] = []
    seed = series[0]
    value = seed
    for i, item in enumerate(series):
        if i == 0:
            value = item
        else:
            value = item * alpha + value * (1.0 - alpha)
        out.append(value)
    return out


def _stdev(series: list[float]) -> float:
    if len(series) < 2:
        return 0.0
    mean = sum(series) / len(series)
    var = sum((x - mean) ** 2 for x in series) / len(series)
    return math.sqrt(var)


def _pivot_low(bars: list[Candle], index: int, left: int) -> Optional[float]:
    if index < left or index + left >= len(bars):
        return None
    pivot = bars[index].low
    for offset in range(1, left + 1):
        if bars[index - offset].low <= pivot or bars[index + offset].low <= pivot:
            return None
    return pivot


def _pivot_high(bars: list[Candle], index: int, left: int) -> Optional[float]:
    if index < left or index + left >= len(bars):
        return None
    pivot = bars[index].high
    for offset in range(1, left + 1):
        if bars[index - offset].high >= pivot or bars[index + offset].high >= pivot:
            return None
    return pivot


def _tr(candle: Candle, previous_close: Optional[float]) -> float:
    if previous_close is None:
        return max(0.0, candle.high - candle.low)
    return max(
        candle.high - candle.low,
        abs(candle.high - previous_close),
        abs(candle.low - previous_close),
    )


def _rma(values: list[float], length: int) -> Optional[float]:
    if len(values) < length:
        return None
    value = sum(values[:length]) / length
    for item in values[length:]:
        value = (value * (length - 1) + item) / length
    return value


class DualMaSdEngine:
    """Stateful 3-minute oscillator + SMC structure engine."""

    def __init__(
        self,
        symbol: str = "",
        *,
        ma_fast: int = MA_FAST,
        ma_slow: int = MA_SLOW,
        ma_smooth: int = MA_SMOOTH,
        upper_sd_len: int = UPPER_SD_LEN,
        lower_sd_len: int = LOWER_SD_LEN,
        swing_left: int = SWING_LEFT,
        event_gate: bool = True,
        event_max_bars: int = EVENT_MAX_BARS,
        stop_atr_mult: float = STOP_ATR_MULT,
        min_rr: float = MIN_RR,
        max_extension_atr: float = MAX_EXTENSION_ATR,
        max_stop_atr: float = MAX_STOP_ATR,
    ):
        self.symbol = symbol
        self.ma_fast = ma_fast
        self.ma_slow = ma_slow
        self.ma_smooth = ma_smooth
        self.upper_sd_len = upper_sd_len
        self.lower_sd_len = lower_sd_len
        self.swing_left = swing_left
        self.event_gate = event_gate
        self.event_max_bars = event_max_bars
        self.stop_atr_mult = stop_atr_mult
        self.min_rr = min_rr
        self.max_extension_atr = max_extension_atr
        self.max_stop_atr = max_stop_atr

        # Oscillator state
        self.state = 0             # 1 = BULL, -1 = BEAR, 0 = flat/neutral
        self.smoothed = 0.0
        self.upper_band = 0.0
        self.lower_band = 0.0
        self.fast_ma = 0.0
        self.slow_ma = 0.0

        # SMC structure state
        self.trend = 0             # 1 = higher highs/lows, -1 = lower, 0 = flat
        self.last_swing_high: Optional[float] = None
        self.last_swing_low: Optional[float] = None
        self.last_swing_high_bar = 0
        self.last_swing_low_bar = 0
        self.last_sweep: Optional[tuple[int, str, float]] = None   # (bar, "high"/"low", level)
        self._active_fvgs: list[tuple[float, float, int, str]] = []  # (top, bottom, bar, "bull"/"bear")
        self._last_fvg_touch = -1

        # Diagnostics
        self.last_bar_time = 0
        self.last_signal: Optional[Signal] = None
        self.last_direction = 0
        self.last_event = ""
        self.last_gate = "warming up"
        self.last_pattern = ""
        self._bars: list[Candle] = []
        self._trs: list[float] = []
        self._atr14 = 0.0
        self._closed_series: list[float] = []

    # ── Oscillator math (Pine port, closed bars only) ────────────────
    def _compute_oscillator(self, closes: list[float]) -> tuple[float, float, float]:
        if len(closes) < max(self.upper_sd_len, self.lower_sd_len, self.ma_slow) + 2:
            return 0.0, 0.0, 0.0
        fast = _ema(closes, self.ma_fast)
        slow = _ema(closes, self.ma_slow)
        spread = [f - s for f, s in zip(fast, slow)]
        smoothed = _ema(spread, self.ma_smooth)
        upper = _stdev(smoothed[-self.upper_sd_len:])
        lower = -_stdev(smoothed[-self.lower_sd_len:])
        return smoothed[-1], upper, lower

    # ── SMC structure tracking ───────────────────────────────────────
    def _update_swings(self, index: int) -> None:
        # A pivot at bar p needs p+left future bars to be confirmable, so it
        # can only be detected from index p+left onward.  Check the window of
        # bars that JUST became confirmable (index-left .. index) instead of
        # only the current bar, otherwise every pivot is missed forever.
        for p in range(max(0, index - self.swing_left), index + 1):
            pv_lo = _pivot_low(self._bars, p, self.swing_left)
            pv_hi = _pivot_high(self._bars, p, self.swing_left)
            if pv_lo is not None:
                if self.last_swing_low is None or pv_lo != self.last_swing_low:
                    self.last_swing_low = pv_lo
                    self.last_swing_low_bar = p
            if pv_hi is not None:
                if self.last_swing_high is None or pv_hi != self.last_swing_high:
                    self.last_swing_high = pv_hi
                    self.last_swing_high_bar = p
        # Trend from the last two confirmed swings of each side.
        lo_lookback = [b.low for b in self._bars[max(0, index - 40):index + 1]]
        hi_lookback = [b.high for b in self._bars[max(0, index - 40):index + 1]]
        lo_higher = len(lo_lookback) >= 3 and lo_lookback[-1] > lo_lookback[-3]
        hi_higher = len(hi_lookback) >= 3 and hi_lookback[-1] > hi_lookback[-3]
        if hi_higher and lo_higher:
            self.trend = 1
        elif len(lo_lookback) >= 3 and len(hi_lookback) >= 3 and not hi_higher and not lo_higher and lo_lookback[-1] < lo_lookback[-3]:
            self.trend = -1
        else:
            self.trend = 0

    def _update_sweeps(self, index: int) -> None:
        bar = self._bars[index]
        if self.last_swing_low is not None and bar.low < self.last_swing_low and bar.close > self.last_swing_low:
            self.last_sweep = (index, "low", self.last_swing_low)
        if self.last_swing_high is not None and bar.high > self.last_swing_high and bar.close < self.last_swing_high:
            self.last_sweep = (index, "high", self.last_swing_high)

    def _update_fvgs(self, index: int) -> None:
        bar = self._bars[index]
        if index >= 2:
            two_back, previous = self._bars[index - 2], self._bars[index - 1]
            if previous.low > two_back.high:
                self._active_fvgs.append((previous.low, two_back.high, index - 1, "bull"))
            if previous.high < two_back.low:
                self._active_fvgs.append((two_back.low, previous.high, index - 1, "bear"))
        kept: list[tuple[float, float, int, str]] = []
        for top, bottom, origin, kind in self._active_fvgs:
            if bar.close < bottom or bar.close > top:
                continue  # gap filled / invalidated
            if bar.high >= bottom and bar.low <= top:
                self._last_fvg_touch = index
                kept.append((top, bottom, origin, kind))
            else:
                kept.append((top, bottom, origin, kind))
        self._active_fvgs = kept

    def _event_for(self, index: int, bullish: bool) -> str:
        events: list[tuple[int, str]] = []
        if self.last_sweep is not None and index - self.last_sweep[0] <= self.event_max_bars:
            if (bullish and self.last_sweep[1] == "low") or (not bullish and self.last_sweep[1] == "high"):
                events.append((self.last_sweep[0], "LQ"))
        if self._last_fvg_touch >= 0 and index - self._last_fvg_touch <= self.event_max_bars:
            for _top, _bottom, _origin, kind in self._active_fvgs:
                if (bullish and kind == "bull") or (not bullish and kind == "bear"):
                    events.append((self._last_fvg_touch, "FVG"))
                    break
        if not events:
            return ""
        best = max(bar for bar, _n in events)
        return "+".join(sorted({name for bar, name in events if bar == best}))

    def _structure_stop(self, index: int, bullish: bool) -> Optional[float]:
        if self._atr14 <= 0:
            return None
        price = self._bars[index].close
        buffer = self.stop_atr_mult * self._atr14
        max_stop = self.max_stop_atr * self._atr14
        # Scalping stop: use the recent 5-bar extreme (tighter than full swing)
        # with a small ATR buffer, then cap the total distance.
        recent = self._bars[max(0, index - 5):index + 1]
        recent_extreme = min(b.low for b in recent) if bullish else max(b.high for b in recent)
        # Also check the swing if it's closer than the recent extreme
        base = self.last_swing_low if bullish else self.last_swing_high
        if bullish:
            candidates = [recent_extreme - buffer]
            if base is not None and base - buffer < price:
                candidates.append(base - buffer)
            stop = max(candidates)  # pick the tightest valid stop
            if stop >= price or (price - stop) > max_stop:
                return None
            return stop
        else:
            candidates = [recent_extreme + buffer]
            if base is not None and base + buffer > price:
                candidates.append(base + buffer)
            stop = min(candidates)  # pick the tightest valid stop
            if stop <= price or (stop - price) > max_stop:
                return None
            return stop

    def _structure_target(self, bullish: bool) -> Optional[float]:
        if bullish:
            return self.last_swing_high
        return self.last_swing_low

    # ── Bar processing ───────────────────────────────────────────────
    def _process_bar(self, candle: Candle, index: int) -> Optional[Signal]:
        previous_close = self._bars[-1].close if self._bars else None
        self._trs.append(_tr(candle, previous_close))
        atr = _rma(self._trs, 14) or 0.0
        self._atr14 = atr
        self._bars.append(candle)
        self._closed_series.append(candle.close)

        self._update_swings(index)
        self._update_sweeps(index)
        self._update_fvgs(index)

        smoothed, upper, lower = self._compute_oscillator(self._closed_series)
        self.smoothed, self.upper_band, self.lower_band = smoothed, upper, lower
        fast = _ema(self._closed_series, self.ma_fast)
        slow = _ema(self._closed_series, self.ma_slow)
        self.fast_ma = fast[-1] if fast else 0.0
        self.slow_ma = slow[-1] if slow else 0.0

        if upper <= 0 or lower >= 0 or atr <= 0:
            self.last_gate = "warming up"
            return None

        new_state = 1 if smoothed > upper else -1 if smoothed < lower else 0
        flip = new_state != 0 and new_state != self.state
        if not flip:
            self.last_gate = "oscillator state held" if new_state != 0 else "neutral zone"
            return None
        self.state = new_state
        bullish = new_state == 1

        # Event gate (optional): the flip must react out of real structure.
        if self.event_gate:
            event = self._event_for(index, bullish)
            if not event:
                self.last_gate = "flip blocked: no SMC event inside the leg"
                return None
        else:
            event = ""

        stop = self._structure_stop(index, bullish)
        if stop is None:
            self.last_gate = "protected swing unavailable or on wrong side"
            return None

        entry = candle.close
        risk = abs(entry - stop)
        if risk <= 0:
            self.last_gate = "zero-risk structure"
            return None

        # Fail closed on absurd extension: entry far beyond the swing.
        if self._atr14 > 0:
            base = self.last_swing_low if bullish else self.last_swing_high
            if base is not None and abs(entry - base) / self._atr14 > self.max_extension_atr:
                self.last_gate = "flip blocked: over-extended from structure"
                return None

        target = self._structure_target(bullish)
        if target is None or (bullish and target <= entry) or (not bullish and target >= entry):
            target = entry + risk if bullish else entry - risk
            target2 = entry + 2 * risk if bullish else entry - 2 * risk
            target_src = "1R fallback"
        else:
            reward = abs(target - entry)
            if reward / risk < self.min_rr:
                self.last_gate = "flip blocked: structure target below 1R"
                return None
            target2 = target + (target - entry) if bullish else target - (entry - target)
            target_src = "prior swing"

        self.last_direction = new_state
        self.last_event = event or "none"
        self.last_pattern = f"{'BULL' if bullish else 'BEAR'} flip · {event or 'state'} → swing"
        self.last_gate = "flip confirmed"
        self.last_signal = Signal(
            symbol=self.symbol,
            direction="long" if bullish else "short",
            entry=entry,
            stop=stop,
            target=target,
            target2=target2,
            atr=atr,
            bar_time=candle.time,
            setup_key=f"{self.symbol}:{STRATEGY_NAME}:{new_state}:{candle.time}",
            pattern=self.last_pattern,
            framework="structure-long" if self.trend == 1 else "structure-short" if self.trend == -1 else "",
            bias=new_state,
            event=event or "state",
        )
        return self.last_signal

    def process_candles(self, candles: list[Candle]) -> Optional[Signal]:
        if len(candles) < 40:
            return None
        closed = candles[:-1]
        result: Optional[Signal] = None
        if not self.last_bar_time:
            # Warm-up pass: a flip can fire mid-history.  Return the most
            # recent signal produced, not only the final bar's (which is
            # almost always a "held" bar and would discard the flip).
            for index, candle in enumerate(closed):
                signal = self._process_bar(candle, index)
                if signal:
                    result = signal
        else:
            for candle in closed:
                if candle.time > self.last_bar_time:
                    signal = self._process_bar(candle, len(self._bars))
                    if signal:
                        result = signal
        if closed:
            self.last_bar_time = closed[-1].time
        return result

    # ── SMC state for the position manager ───────────────────────────
    def structure_state(self) -> dict:
        return {
            "trend": self.trend,
            "last_swing_high": self.last_swing_high,
            "last_swing_low": self.last_swing_low,
            "last_swing_high_bar": self.last_swing_high_bar,
            "last_swing_low_bar": self.last_swing_low_bar,
            "last_sweep": self.last_sweep,
        }

    def get_dashboard(self) -> dict:
        return {
            "strategy": STRATEGY_NAME,
            "pattern": self.last_signal.pattern if self.last_signal else "NONE",
            "phase": "ENTRY" if self.last_signal else "WATCHING",
            "direction": "BUY" if self.last_direction > 0 else "SELL" if self.last_direction < 0 else "NONE",
            "entry": self.last_signal.entry if self.last_signal else None,
            "stop": self.last_signal.stop if self.last_signal else None,
            "target_1r": self.last_signal.target if self.last_signal else None,
            "target_2r": self.last_signal.target2 if self.last_signal else None,
            "state": "BULL" if self.state == 1 else "BEAR" if self.state == -1 else "NEUTRAL",
            "smoothed": self.smoothed,
            "upper_band": self.upper_band,
            "lower_band": self.lower_band,
            "fast_ma": self.fast_ma,
            "slow_ma": self.slow_ma,
            "trend": "UP" if self.trend == 1 else "DOWN" if self.trend == -1 else "FLAT",
            "last_swing_high": self.last_swing_high,
            "last_swing_low": self.last_swing_low,
            "last_event": self.last_event,
            "gate": self.last_gate,
            "timeframe": TIMEFRAME,
            "params": {
                "ma_fast": self.ma_fast,
                "ma_slow": self.ma_slow,
                "ma_smooth": self.ma_smooth,
                "upper_sd_len": self.upper_sd_len,
                "lower_sd_len": self.lower_sd_len,
                "swing_left": self.swing_left,
                "event_gate": self.event_gate,
                "stop_atr_mult": self.stop_atr_mult,
                "min_rr": self.min_rr,
            },
        }
