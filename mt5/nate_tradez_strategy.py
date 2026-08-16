#!/usr/bin/env python3
"""Nate Tradez — ICT-style three-timeframe strategy engine.

Python implementation of the concepts Nate Tradez (YouTube @NLTradez)
teaches in his public videos ("TRADE RECAP 7/15/2026", "5 Things Quietly
Killing Your Trading System", shorts).  His model is an ICT/smart-money
playbook traded on NQ futures:

  - THREE TIMEFRAME ALIGNMENT ("the anatomy of an A+ trade"):
      HTF (60m):  market sentiment — trend vs range vs event.  Decides
                  direction (range: short premium / long discount; trend:
                  trade with it; event: never fight the volume).
      MTF (15m):  the model — order buildup / accumulation, liquidity
                  sweep, then a MARKET STRUCTURE SHIFT (MSS) with real
                  displacement.  Decides where price is going.
      LTF (15m):  the entry model — price rebalances into the OTE zone
                  (62–79% retracement of the displacement leg) aligned
                  with a fair value gap, after RSI was driven to an
                  extreme and rebalanced, beyond the EMA (overstretched).
                  Entry = the rejection close back through the FVG.

  - MSS (market structure shift): an uptrend is HH + HL only.  A close
    (with displacement) below the level that made the last high ends it.
    The MSS level is always the last opposite swing; displacement means a
    deep close THROUGH it, never a wick.

  - STOP: tight — just beyond the swept extreme / the leg extreme.  An
    OTE entry lets the stop shrink (1:1.8 -> 1:4 RR).

  - TARGET: standard-deviation projection (2–2.5 sigma) of the range,
    aligned with the HTF extreme / next liquidity.

  - IF/THEN bias: never marry a bias — if price displaces past the level
    with no reversal, the working direction flips.

  - ONE TRADE PER DAY per symbol (his discipline: "once I made the switch
    to taking one trade a day max, that's when everything changed").

All reads use confirmed closed bars; nothing repaints.  The engine is a
drop-in for the scanner's confirmed-bar interface.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

STRATEGY_NAME = "NATE_TRADEZ"
TIMEFRAME = "3"            # entry resolution (the sidecar's verified 3m base feed)
HTF_TIMEFRAME = "60"       # higher-timeframe sentiment layer

# ---- Model constants (from the videos / ICT) ----
SWING_LEFT = 4             # 3m pivot confirmation lookback (4 bars each side)
HTF_SWING_LEFT = 2         # 60m pivot confirmation lookback
OTE_MIN = 0.62             # ICT Optimal Trade Entry zone
OTE_MAX = 0.79
RSI_LEN = 14
RSI_EXTREME = 35           # RSI < 35 (dump) / > 65 (pump) during the displacement leg
RSI_REBALANCE = 42         # RSI must have recovered past this before entry (short side)
DISP_ATR = 0.75            # MSS requires a close this many ATR beyond the level
SETUP_MAX_AGE = 60         # an armed OTE setup expires after this many 3m bars (~3h)
EVENT_MAX_BARS = 60        # sweep must be recent enough to qualify the setup (3h on 3m)
STOP_ATR_BUFFER = 0.5      # buffer beyond the protected extreme, in ATR
MAX_STOP_ATR = 3.0         # hard cap: stop distance never exceeds this many ATR
MIN_RR = 1.0               # never fire a setup with worse than 1R to the SD target
SD_TARGET_MULT = 2.0       # "standard deviation 2 to 2.5" take-profit projection
ONE_ENTRY_PER_DAY = True   # Nate: one trade a day max, per symbol
HTF_TREND_MIN_SWINGS = 2   # 60m swings needed before HTF sentiment is trusted

# ---- Data containers (same shape as the other engines) ----

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
    direction: str = ""      # long / short
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0      # SD-2 projection (primary TP)
    target2: float = 0.0     # 2R extension
    target3: float = 0.0
    atr: float = 0.0
    confirmed: bool = True
    bar_time: int = 0
    setup_key: str = ""
    phase: str = "ENTRY"
    pattern: str = ""        # human description, e.g. "OTE SHORT · sweep → MSS → FVG"
    grade: str = "A"
    score: float = 0.0
    framework: str = ""      # "htf-trend-long" / "htf-range-short" / ...
    bias: int = 0            # effective working direction after if/then logic
    event: str = ""          # "sweep", "sweep+fvg", ...

    def to_dict(self) -> dict:
        return self.__dict__.copy()


# ---- Math helpers (shared with the other engines) ----

def _ema(series: list[float], length: int) -> list[float]:
    if length <= 0 or not series:
        return []
    alpha = 2.0 / (length + 1.0)
    out: list[float] = []
    value = series[0]
    for i, item in enumerate(series):
        value = item if i == 0 else item * alpha + value * (1.0 - alpha)
        out.append(value)
    return out


def _stdev(series: list[float]) -> float:
    if len(series) < 2:
        return 0.0
    mean = sum(series) / len(series)
    var = sum((x - mean) ** 2 for x in series) / len(series)
    return math.sqrt(var)


def _rsi(closes: list[float], length: int = RSI_LEN) -> Optional[float]:
    """Wilder RSI.  Returns None until `length+1` closes exist."""
    if len(closes) < length + 1:
        return None
    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, len(closes)):
        ch = closes[i] - closes[i - 1]
        gains.append(max(ch, 0.0))
        losses.append(max(-ch, 0.0))
    avg_gain = sum(gains[:length]) / length
    avg_loss = sum(losses[:length]) / length
    for i in range(length, len(gains)):
        avg_gain = (avg_gain * (length - 1) + gains[i]) / length
        avg_loss = (avg_loss * (length - 1) + losses[i]) / length
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


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


def _fractal(bars: list[Candle], index: int, left: int, side: str) -> Optional[float]:
    """Fractal with equal-price tolerance on the confirming side (allows
    the exact level to be retested without re-confirming a new pivot)."""
    if index < left or index + left >= len(bars):
        return None
    pivot = bars[index].low if side == "low" else bars[index].high
    for offset in range(1, left + 1):
        other = bars[index - offset].low if side == "low" else bars[index - offset].high
        other2 = bars[index + offset].low if side == "low" else bars[index + offset].high
        if side == "low":
            if other < pivot or other2 < pivot:
                return None
        else:
            if other > pivot or other2 > pivot:
                return None
    return pivot


# ---- The engine ----

class NateTradezEngine:
    """Stateful ICT engine: HTF sentiment + 15m MSS/OTE model."""

    def __init__(
        self,
        symbol: str = "",
        *,
        swing_left: int = SWING_LEFT,
        ote_min: float = OTE_MIN,
        ote_max: float = OTE_MAX,
        disp_atr: float = DISP_ATR,
        rsi_extreme: float = RSI_EXTREME,
        rsi_rebalance: float = RSI_REBALANCE,
        sd_target_mult: float = SD_TARGET_MULT,
        max_stop_atr: float = MAX_STOP_ATR,
        stop_atr_buffer: float = STOP_ATR_BUFFER,
        min_rr: float = MIN_RR,
        one_entry_per_day: bool = ONE_ENTRY_PER_DAY,
        require_sweep: bool = True,
    ):
        self.symbol = symbol
        self.swing_left = swing_left
        self.ote_min = ote_min
        self.ote_max = ote_max
        self.disp_atr = disp_atr
        self.rsi_extreme = rsi_extreme
        self.rsi_rebalance = rsi_rebalance
        self.sd_target_mult = sd_target_mult
        self.max_stop_atr = max_stop_atr
        self.stop_atr_buffer = stop_atr_buffer
        self.min_rr = min_rr
        self.one_entry_per_day = one_entry_per_day
        self.require_sweep = require_sweep

        # 15m state
        self.trend = 0                 # 1 up / -1 down / 0 flat (15m structure)
        self.last_swing_high: Optional[float] = None
        self.last_swing_low: Optional[float] = None
        self.last_swing_high_bar = 0
        self.last_swing_low_bar = 0
        self.prior_swing_high: Optional[float] = None
        self.prior_swing_low: Optional[float] = None
        self.last_sweep: Optional[tuple[int, str, float]] = None  # (bar, "high"/"low", level)
        self.mss: Optional[dict] = None   # last confirmed market structure shift
        self._active_fvgs: list[tuple[float, float, int, str]] = []  # (top, bottom, bar, "bull"/"bear")

        # HTF sentiment (60m)
        self.htf_trend = 0
        self.htf_swing_high: Optional[float] = None
        self.htf_swing_low: Optional[float] = None
        self.htf_range_high: Optional[float] = None
        self.htf_range_low: Optional[float] = None
        self._htf_bars: list[Candle] = []

        # OTE setup state
        self._setup: Optional[dict] = None   # armed OTE setup awaiting the rejection close
        self._rsi_extreme_hit = False        # RSI hit an extreme during the current leg
        self._rsi_extreme_side = 0           # +1 oversold (long setup) / -1 overbought (short)
        self._leg_rsi_min: Optional[float] = None
        self._leg_rsi_max: Optional[float] = None

        # Diagnostics / one-per-day
        self.last_signal: Optional[Signal] = None
        self.last_direction = 0
        self.last_event = ""
        self.last_gate = "warming up"
        self.last_pattern = ""
        self.last_entry_day = ""
        self._bars: list[Candle] = []
        self._trs: list[float] = []
        self._atr14 = 0.0
        self._closed: list[float] = []
        self._ema20 = 0.0
        self._ema50 = 0.0
        self._rsi_now: Optional[float] = None
        self._rsi_prev: Optional[float] = None
        self._score = 0.0
        self._grade = ""
        self._framework = ""
        self.last_bar_time = 0

    # ------------------------------------------------------------------
    # Swing / structure tracking (15m)
    # ------------------------------------------------------------------
    def _update_swings(self, index: int) -> None:
        # A pivot at bar p confirms only at p+left; scan the window of bars
        # that just became confirmable (same fix as the Dual MA engine).
        for p in range(max(0, index - self.swing_left), index + 1):
            pv_lo = _pivot_low(self._bars, p, self.swing_left)
            pv_hi = _pivot_high(self._bars, p, self.swing_left)
            if pv_lo is not None and (self.last_swing_low is None or pv_lo != self.last_swing_low):
                self.prior_swing_low = self.last_swing_low
                self.last_swing_low = pv_lo
                self.last_swing_low_bar = p
            if pv_hi is not None and (self.last_swing_high is None or pv_hi != self.last_swing_high):
                self.prior_swing_high = self.last_swing_high
                self.last_swing_high = pv_hi
                self.last_swing_high_bar = p

    def _update_trend(self, index: int) -> None:
        # Nate's definition, straight from the videos: an uptrend is higher
        # highs + higher lows; a downtrend is lower highs + lower lows.
        # Anything else (mixed structure) is a range / accumulation phase.
        if (self.prior_swing_high is not None and self.last_swing_high is not None
                and self.prior_swing_low is not None and self.last_swing_low is not None):
            hh = self.last_swing_high > self.prior_swing_high
            hl = self.last_swing_low > self.prior_swing_low
            lh = self.last_swing_high < self.prior_swing_high
            ll = self.last_swing_low < self.prior_swing_low
            if hh and hl:
                self.trend = 1
            elif lh and ll:
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
            kept.append((top, bottom, origin, kind))
        self._active_fvgs = kept

    def _recent_fvg(self, index: int, bullish: bool, max_age: int) -> Optional[tuple[float, float]]:
        """Most recent FVG on the setup side, within max_age bars."""
        best: Optional[tuple[int, tuple[float, float]]] = None
        for top, bottom, origin, kind in self._active_fvgs:
            if index - origin > max_age:
                continue
            if (bullish and kind == "bull") or (not bullish and kind == "bear"):
                if best is None or origin > best[0]:
                    best = (origin, (top, bottom))
        return best[1] if best else None

    # ------------------------------------------------------------------
    # HTF sentiment (60m) — trend vs range
    # ------------------------------------------------------------------
    def update_htf(self, htf_candles: list[Candle]) -> None:
        if not htf_candles:
            return
        self._htf_bars = htf_candles
        bars = self._htf_bars
        if len(bars) < HTF_SWING_LEFT * 2 + 1:
            return
        swing_highs: list[tuple[int, float]] = []
        swing_lows: list[tuple[int, float]] = []
        for p in range(HTF_SWING_LEFT, len(bars) - HTF_SWING_LEFT):
            pv_hi = _pivot_high(bars, p, HTF_SWING_LEFT)
            pv_lo = _pivot_low(bars, p, HTF_SWING_LEFT)
            if pv_hi is not None:
                swing_highs.append((p, pv_hi))
            if pv_lo is not None:
                swing_lows.append((p, pv_lo))
        if len(swing_highs) >= HTF_TREND_MIN_SWINGS and len(swing_lows) >= HTF_TREND_MIN_SWINGS:
            sh1, sh2 = swing_highs[-2][1], swing_highs[-1][1]
            sl1, sl2 = swing_lows[-2][1], swing_lows[-1][1]
            if sh2 > sh1 and sl2 > sl1:
                self.htf_trend = 1
            elif sh2 < sh1 and sl2 < sl1:
                self.htf_trend = -1
            else:
                self.htf_trend = 0
            self.htf_swing_high = sh2
            self.htf_swing_low = sl2
        if self.htf_trend != 0:
            self.htf_range_high = self.htf_swing_high
            self.htf_range_low = self.htf_swing_low
        else:
            # Range: bounding box of the recent 60m closes defines premium/discount.
            recent = [b.close for b in bars[-max(24, len(bars)):]]
            if recent:
                self.htf_range_high = max(recent)
                self.htf_range_low = min(recent)

    def _htf_ok_for(self, direction: str, entry: float) -> bool:
        """Nate's #1 rule — trade with the overall market sentiment.

        HTF trend up: longs only.  HTF trend down: shorts only.  HTF range:
        short premium (upper half), long discount (lower half).
        """
        if self.htf_trend == 1 and direction == "short":
            return False
        if self.htf_trend == -1 and direction == "long":
            return False
        if self.htf_trend == 0 and self.htf_range_high is not None and self.htf_range_low is not None:
            mid = (self.htf_range_high + self.htf_range_low) / 2.0
            if direction == "short" and entry < mid:
                return False
            if direction == "long" and entry > mid:
                return False
        return True

    # ------------------------------------------------------------------
    # MSS detection — the only trend-change confirmation
    # ------------------------------------------------------------------
    def _detect_mss(self, index: int) -> Optional[dict]:
        bar = self._bars[index]
        if self._atr14 <= 0:
            return None
        level_disp = self.disp_atr * self._atr14

        # Bullish MSS: in a downtrend (or flat), a displacement close ABOVE
        # the last swing high ends the downtrend.
        if self.trend != 1 and self.last_swing_high is not None:
            if bar.close > self.last_swing_high + level_disp and bar.close > bar.open:
                return {
                    "dir": 1, "level": self.last_swing_high,
                    "bar": index, "extreme": self.last_swing_low or bar.low,
                }
        # Bearish MSS: in an uptrend (or flat), a displacement close BELOW
        # the last swing low ends the uptrend.
        if self.trend != -1 and self.last_swing_low is not None:
            if bar.close < self.last_swing_low - level_disp and bar.close < bar.open:
                return {
                    "dir": -1, "level": self.last_swing_low,
                    "bar": index, "extreme": self.last_swing_high or bar.high,
                }
        return None

    # ------------------------------------------------------------------
    # OTE setup arming
    # ------------------------------------------------------------------
    def _arm_ote(self, index: int, mss_dir: int, mss_bar: int) -> None:
        bar = self._bars[index]
        if mss_dir == -1:
            # Bearish leg: swing high -> leg low.  OTE zone is the retrace
            # UP into 62–79% of the down-leg (measured from the low).
            leg_high = max(self.last_swing_high or bar.high, bar.high)
            leg_low = min(bar.low, self.mss["extreme"] if self.mss else bar.low)
        else:
            leg_low = min(self.last_swing_low or bar.low, bar.low)
            leg_high = max(bar.high, self.mss["extreme"] if self.mss else bar.high)
        if leg_high - leg_low <= 0:
            return
        if mss_dir == -1:
            zone_bottom = leg_low + self.ote_min * (leg_high - leg_low)
            zone_top = leg_low + self.ote_max * (leg_high - leg_low)
        else:
            zone_bottom = leg_high - self.ote_max * (leg_high - leg_low)
            zone_top = leg_high - self.ote_min * (leg_high - leg_low)
        self._setup = {
            "dir": mss_dir,
            "leg_high": leg_high,
            "leg_low": leg_low,
            "zone_top": zone_top,
            "zone_bottom": zone_bottom,
            "armed_bar": index,
            "mss_bar": mss_bar,
            "rsi_extreme_hit": self._rsi_extreme_hit,
            "rsi_extreme_side": self._rsi_extreme_side,
        }

    def _expire_setup(self, index: int) -> None:
        if self._setup and index - self._setup["armed_bar"] > SETUP_MAX_AGE:
            self._setup = None

    # ------------------------------------------------------------------
    # Entry evaluation on the current confirmed bar
    # ------------------------------------------------------------------
    def _evaluate_entry(self, index: int, candle: Candle) -> Optional[Signal]:
        if not self._setup or self._atr14 <= 0:
            return None
        setup = self._setup
        direction = "short" if setup["dir"] == -1 else "long"
        bullish = setup["dir"] == 1

        # Price must have TRADED INTO the OTE zone on this or the prior bar.
        prev = self._bars[index - 1] if index >= 1 else candle
        touched = (
            candle.high >= setup["zone_bottom"] and candle.low <= setup["zone_top"]
        ) or (
            prev.high >= setup["zone_bottom"] and prev.low <= setup["zone_top"]
        )
        if not touched:
            self.last_gate = "OTE zone not yet traded into"
            return None

        # The rejection close: for a short, price closes back DOWN through a
        # bearish FVG (or below the prior bar low) after trading into the zone.
        # For a long, closes back UP through a bullish FVG (or above the prior
        # bar high).  This is the "hard closure past the FVG" from the recap.
        fvg = self._recent_fvg(index, bullish=not bullish, max_age=EVENT_MAX_BARS)
        rejection = False
        if not bullish:  # short entry
            if fvg is not None and candle.close < fvg[1]:   # closed below bearish FVG bottom
                rejection = True
            elif candle.close < prev.low:                    # hard rejection candle
                rejection = True
            elif candle.close < candle.open and candle.close < setup["zone_top"]:
                rejection = True   # bearish body closed back OUT of the OTE zone
        else:             # long entry
            if fvg is not None and candle.close > fvg[0]:   # closed above bullish FVG top
                rejection = True
            elif candle.close > prev.high:
                rejection = True
            elif candle.close > candle.open and candle.close > setup["zone_bottom"]:
                rejection = True   # bullish body closed back OUT of the OTE zone
        if not rejection:
            self.last_gate = "no rejection close back through structure"
            return None

        # RSI rebalance confluence (his micro-model): the leg drove RSI to an
        # extreme, and price rebalanced into OTE; entry when RSI is no longer
        # pinned at the extreme.
        rsi_ok = True
        if self._rsi_now is not None:
            if not bullish and self._rsi_now > 100 - self.rsi_rebalance:
                rsi_ok = False    # still overbought after a bounce — not a clean short
            if bullish and self._rsi_now < self.rsi_rebalance:
                rsi_ok = False    # still oversold after a dip — not a clean long
        # RSI extreme must have been hit during the leg (rebalance premise).
        leg_extreme_ok = setup["rsi_extreme_hit"]
        if not rsi_ok or not leg_extreme_ok:
            self.last_gate = "RSI rebalance confluence missing"
            return None

        # EMA confluence: price TRADED beyond the EMA = overstretched.  The
        # touched price (the rejection bar's extreme) is what matters — the
        # rejection close itself often comes back through the EMA, which is
        # exactly the rebalance his micro-model describes.
        ema_ok = False
        if self._ema20 > 0:
            touched = max(candle.high, prev.high) if not bullish else min(candle.low, prev.low)
            if not bullish and touched > self._ema20:
                ema_ok = True
            if bullish and touched < self._ema20:
                ema_ok = True
        if not ema_ok:
            self.last_gate = "price not overstretched vs EMA"
            return None

        # HTF sentiment gate (Nate's rule #1).
        if not self._htf_ok_for(direction, candle.close):
            self.last_gate = "HTF sentiment opposes (trend/range premium-discount)"
            return None

        # Sweep requirement — manipulation before distribution.
        if self.require_sweep:
            if self.last_sweep is None or index - self.last_sweep[0] > EVENT_MAX_BARS:
                self.last_gate = "no recent liquidity sweep before the setup"
                return None
            sweep_side_ok = (not bullish and self.last_sweep[1] == "high") or \
                            (bullish and self.last_sweep[1] == "low")
            if not sweep_side_ok:
                self.last_gate = "sweep was on the wrong side of the setup"
                return None

        # Stop: tight, just beyond the bounce extreme / OTE zone — "my stop
        # being extremely short. No reason for price to come back up and
        # revisit this high."  The original leg extreme is only a fallback.
        if not bullish:
            bounce_high = max(b.high for b in self._bars[max(0, index - 3):index + 1])
            protected = max(bounce_high, setup["zone_top"])
            stop = protected + self.stop_atr_buffer * self._atr14
        else:
            bounce_low = min(b.low for b in self._bars[max(0, index - 3):index + 1])
            protected = min(bounce_low, setup["zone_bottom"])
            stop = protected - self.stop_atr_buffer * self._atr14
        entry = candle.close
        risk = abs(entry - stop)
        if risk <= 0 or risk > self.max_stop_atr * self._atr14:
            self.last_gate = "stop too wide (exceeds max_stop_atr)"
            return None
        if (not bullish and stop <= entry) or (bullish and stop >= entry):
            self.last_gate = "stop on wrong side of entry"
            return None

        # Target: SD-2 projection of the leg, aligned with the leg extreme
        # (his "standard deviation 2 to 2.5" take-profit).
        leg_len = max(2, index - setup["armed_bar"] + 1)
        closes = [b.close for b in self._bars[max(0, index - leg_len - 6):index + 1]]
        sd = _stdev(closes) if len(closes) >= 2 else self._atr14
        sd = max(sd, self._atr14 * 0.5)   # floor so the target is not degenerate
        if not bullish:
            target = entry - self.sd_target_mult * sd
            target = max(target, setup["leg_low"])   # at least the leg low
        else:
            target = entry + self.sd_target_mult * sd
            target = min(target, setup["leg_high"])
        reward = abs(target - entry)
        if reward / risk < self.min_rr:
            self.last_gate = "SD target below 1R"
            return None
        target2 = entry + 2 * risk if bullish else entry - 2 * risk

        # One trade per day (Nate's discipline).
        if self.one_entry_per_day:
            from datetime import datetime, timezone
            day = datetime.fromtimestamp(candle.time / 1000.0, tz=timezone.utc).strftime("%Y-%m-%d")
            if self.last_entry_day == day:
                self.last_gate = "one entry per day already taken"
                return None
            self.last_entry_day = day

        # Confluence score -> grade (his A+/A/A-/B grading).
        score = 0.0
        if setup["rsi_extreme_hit"]:
            score += 1.0
        if fvg is not None:
            score += 1.0
        if ema_ok:
            score += 1.0
        if self._htf_ok_for(direction, entry):
            score += 1.0
        if self.last_sweep is not None and index - self.last_sweep[0] <= EVENT_MAX_BARS:
            score += 1.0
        score = min(score / 5.0, 1.0)
        if score >= 0.8:
            grade = "A+"
        elif score >= 0.6:
            grade = "A"
        else:
            grade = "B"

        events = []
        if self.last_sweep is not None and index - self.last_sweep[0] <= EVENT_MAX_BARS:
            events.append("sweep")
        if fvg is not None:
            events.append("fvg")
        if setup["rsi_extreme_hit"]:
            events.append("rsi-rebalance")
        event_str = "+".join(events) or "none"

        framework = f"htf-{'trend' if self.htf_trend != 0 else 'range'}-{direction}"

        self._score = score
        self._grade = grade
        self._framework = framework
        self.last_direction = setup["dir"]
        self.last_event = event_str
        self.last_pattern = (
            f"{'OTE SHORT' if not bullish else 'OTE LONG'} · "
            f"{event_str} → rejection"
        )
        self.last_gate = "OTE entry confirmed"

        self.last_signal = Signal(
            symbol=self.symbol,
            direction=direction,
            entry=entry,
            stop=stop,
            target=target,
            target2=target2,
            atr=self._atr14,
            bar_time=candle.time,
            setup_key=f"{self.symbol}:{STRATEGY_NAME}:{direction}:{candle.time}",
            pattern=self.last_pattern,
            grade=grade,
            score=score,
            framework=framework,
            bias=setup["dir"],
            event=event_str,
        )
        return self.last_signal

    # ------------------------------------------------------------------
    # Bar processing
    # ------------------------------------------------------------------
    def _process_bar(self, candle: Candle, index: int) -> Optional[Signal]:
        previous_close = self._bars[-1].close if self._bars else None
        self._trs.append(_tr(candle, previous_close))
        atr = _rma(self._trs, 14) or 0.0
        self._atr14 = atr
        self._bars.append(candle)
        self._closed.append(candle.close)

        closes = self._closed
        if len(closes) >= 20:
            ema20 = _ema(closes, 20)
            self._ema20 = ema20[-1]
        if len(closes) >= 50:
            ema50 = _ema(closes, 50)
            self._ema50 = ema50[-1]
        self._rsi_prev = self._rsi_now
        self._rsi_now = _rsi(closes)

        self._update_swings(index)
        self._update_trend(index)
        self._update_sweeps(index)
        self._update_fvgs(index)

        # If/then bias: an MSS flips the working direction (never marry a bias).
        mss_now = self._detect_mss(index)
        if mss_now is not None:
            self.mss = mss_now
            self._arm_ote(index, mss_now["dir"], mss_now["bar"])
            if mss_now["dir"] == -1:
                self._leg_rsi_min = self._rsi_now
                self._leg_rsi_max = None
            else:
                self._leg_rsi_max = self._rsi_now
                self._leg_rsi_min = None
            self._rsi_extreme_hit = False
            self._rsi_extreme_side = 0

        # Track RSI extremes while a setup is armed (the displacement leg).
        if self._setup and self._rsi_now is not None:
            if self._setup["dir"] == -1:
                self._leg_rsi_min = min(self._leg_rsi_min, self._rsi_now) if self._leg_rsi_min is not None else self._rsi_now
                if self._leg_rsi_min <= self.rsi_extreme:
                    self._rsi_extreme_hit = True
                    self._rsi_extreme_side = -1
            else:
                self._leg_rsi_max = max(self._leg_rsi_max, self._rsi_now) if self._leg_rsi_max is not None else self._rsi_now
                if self._leg_rsi_max >= 100 - self.rsi_extreme:
                    self._rsi_extreme_hit = True
                    self._rsi_extreme_side = 1
            self._setup["rsi_extreme_hit"] = self._rsi_extreme_hit
            self._setup["rsi_extreme_side"] = self._rsi_extreme_side

        self._expire_setup(index)

        if self._setup is None:
            self.last_gate = "no OTE setup armed" if atr > 0 else "warming up"
            return None
        return self._evaluate_entry(index, candle)

    def process_candles(
        self,
        candles: list[Candle],
        htf_candles: Optional[list[Candle]] = None,
    ) -> Optional[Signal]:
        if len(candles) < 60:
            return None
        if htf_candles:
            self.update_htf(htf_candles)
        closed = candles[:-1]
        result: Optional[Signal] = None
        if not self.last_bar_time:
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
        # FAIL CLOSED on stale history: a signal only counts when it fired on
        # the LAST closed bar.  Warm-up is for state, not for entries — a flip
        # that happened twenty bars ago must never be restamped as fresh by the
        # scan loop and executed at today's price.
        if result is not None and result.bar_time != closed[-1].time:
            result = None
        return result

    # ------------------------------------------------------------------
    # State for the scanner / dashboard
    # ------------------------------------------------------------------
    def structure_state(self) -> dict:
        return {
            "trend": self.trend,
            "last_swing_high": self.last_swing_high,
            "last_swing_low": self.last_swing_low,
            "last_sweep": self.last_sweep,
            "mss": self.mss,
            "htf_trend": self.htf_trend,
            "htf_range_high": self.htf_range_high,
            "htf_range_low": self.htf_range_low,
        }

    def get_dashboard(self) -> dict:
        setup = self._setup or {}
        return {
            "strategy": STRATEGY_NAME,
            "pattern": self.last_signal.pattern if self.last_signal else "NONE",
            "phase": "ENTRY" if self.last_signal else "WATCHING",
            "direction": "BUY" if self.last_direction > 0 else "SELL" if self.last_direction < 0 else "NONE",
            "entry": self.last_signal.entry if self.last_signal else None,
            "stop": self.last_signal.stop if self.last_signal else None,
            "target_1r": self.last_signal.target if self.last_signal else None,
            "target_2r": self.last_signal.target2 if self.last_signal else None,
            "state": "ARMED" if setup else "WAITING",
            "trend": "UP" if self.trend == 1 else "DOWN" if self.trend == -1 else "FLAT",
            "htf_trend": "UP" if self.htf_trend == 1 else "DOWN" if self.htf_trend == -1 else "RANGE",
            "htf_range_high": self.htf_range_high,
            "htf_range_low": self.htf_range_low,
            "last_swing_high": self.last_swing_high,
            "last_swing_low": self.last_swing_low,
            "last_event": self.last_event,
            "gate": self.last_gate,
            "rsi": round(self._rsi_now, 2) if self._rsi_now is not None else None,
            "ema20": round(self._ema20, 2) if self._ema20 else None,
            "atr": round(self._atr14, 2) if self._atr14 else None,
            "ote_zone_top": setup.get("zone_top"),
            "ote_zone_bottom": setup.get("zone_bottom"),
            "grade": self._grade,
            "score": round(self._score, 2),
            "framework": self._framework,
            "timeframe": TIMEFRAME,
            "htf_timeframe": HTF_TIMEFRAME,
            "params": {
                "swing_left": self.swing_left,
                "ote_min": self.ote_min,
                "ote_max": self.ote_max,
                "disp_atr": self.disp_atr,
                "rsi_extreme": self.rsi_extreme,
                "rsi_rebalance": self.rsi_rebalance,
                "sd_target_mult": self.sd_target_mult,
                "max_stop_atr": self.max_stop_atr,
                "one_entry_per_day": self.one_entry_per_day,
                "require_sweep": self.require_sweep,
            },
        }
