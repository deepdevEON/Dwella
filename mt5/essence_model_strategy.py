#!/usr/bin/env python3
"""Essence Model — Bias, 7H profiles, protected entries.

This module is a conservative Python companion for the supplied Pine v6
indicator.  It intentionally models the entry authority (daily bias,
25%-break reversal, 7-hour framework gate, event-before-trigger rule, CISD,
and RC/EC/IRC signatures) rather than pretending Pine bytecode can execute in
Python.  It consumes closed candles only and fails closed when a protected
swing or qualifying event is unavailable.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

STRATEGY_NAME = "ESSENCE_MODEL"
TIMEFRAME = "3"
ET = ZoneInfo("America/New_York")


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
    direction: str = ""  # long = bullish protected entry; short = bearish
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0   # 1R projection from the trigger close
    target2: float = 0.0  # 2R projection from the trigger close
    target3: float = 0.0
    atr: float = 0.0
    confirmed: bool = True
    bar_time: int = 0
    setup_key: str = ""
    phase: str = "ENTRY"
    pattern: str = ""
    grade: str = "PS"
    score: float = 0.0
    framework: str = ""
    bias: int = 0
    event: str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _tr(candle: Candle, previous_close: Optional[float]) -> float:
    if previous_close is None:
        return max(0.0, candle.high - candle.low)
    return max(candle.high - candle.low, abs(candle.high - previous_close), abs(candle.low - previous_close))


def _rma(values: list[float], length: int) -> Optional[float]:
    if len(values) < length:
        return None
    value = sum(values[:length]) / length
    for item in values[length:]:
        value = (value * (length - 1) + item) / length
    return value


def _pivot_low(bars: list[Candle], index: int) -> Optional[float]:
    if index < 2 or index >= len(bars):
        return None
    return bars[index - 1].low if bars[index - 1].low < bars[index - 2].low and bars[index - 1].low < bars[index].low else None


def _pivot_high(bars: list[Candle], index: int) -> Optional[float]:
    if index < 2 or index >= len(bars):
        return None
    return bars[index - 1].high if bars[index - 1].high > bars[index - 2].high and bars[index - 1].high > bars[index].high else None


def _day_key(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, ET).date().isoformat()


def _local(timestamp: int) -> datetime:
    return datetime.fromtimestamp(timestamp, ET)


def _session_day(timestamp: int) -> str:
    """Return the 18:00-17:59 model day used by the 7H profiles."""
    local = _local(timestamp)
    if local.hour < 18:
        local -= timedelta(days=1)
    return local.date().isoformat()


def _in_window(timestamp: int, start: tuple[int, int], end: tuple[int, int]) -> bool:
    local = _local(timestamp)
    minutes = local.hour * 60 + local.minute
    return start[0] * 60 + start[1] <= minutes < end[0] * 60 + end[1]


class EssenceModelEngine:
    """Stateful implementation of the supplied Essence Model entry rules."""

    def __init__(
        self,
        symbol: str = "",
        *,
        use210: bool = True,
        overnight_only: bool = True,
        use_reversal: bool = True,
        show_frameworks: bool = True,
        framework_gate: str = "Block opposing",
        show_entry: bool = True,
        use_cisd: bool = True,
        use_signatures: bool = True,
        use_rc: bool = True,
        use_ec: bool = True,
        use_irc: bool = True,
        signature_event_gate: bool = True,
        first_only: bool = True,
        require_bias: bool = True,
        event_max_bars: int = 40,
        entry_window: bool = True,
        entry_start: tuple[int, int] = (9, 0),
        entry_end: tuple[int, int] = (10, 30),
        adr_guard: bool = True,
        adr_fraction: float = 0.75,
        max_entries: int = 20,
    ):
        self.symbol = symbol
        self.use210 = use210
        self.overnight_only = overnight_only
        self.use_reversal = use_reversal
        self.show_frameworks = show_frameworks
        self.framework_gate = framework_gate
        self.show_entry = show_entry
        self.use_cisd = use_cisd
        self.use_signatures = use_signatures
        self.use_rc = use_rc
        self.use_ec = use_ec
        self.use_irc = use_irc
        self.signature_event_gate = signature_event_gate
        self.first_only = first_only
        self.require_bias = require_bias
        self.event_max_bars = event_max_bars
        self.entry_window = entry_window
        self.entry_start = entry_start
        self.entry_end = entry_end
        self.adr_guard = adr_guard
        self.adr_fraction = adr_fraction
        self.max_entries = max_entries

        self.last_bar_time = 0
        self.last_signal: Optional[Signal] = None
        self.last_direction = 0
        self.last_event = ""
        self.last_trigger = ""
        self.last_gate = "warming up"
        self.last_score = 0.0
        self.last_stop = 0.0
        self.protected_swing: Optional[float] = None
        self.protected_direction = 0
        self.bias = 0
        self.invalid = False
        self.was_broken = False
        self.broke50 = False
        self.framework = ""
        self.framework_dir = 0
        self.framework_level: Optional[float] = None
        self.framework_failed = ""
        self.range_exhausted = False
        self.entry_done = False
        self.session_day = ""
        self.calendar_day = ""
        self.day_open: Optional[float] = None
        self.day_high: Optional[float] = None
        self.day_low: Optional[float] = None
        self.day_close: Optional[float] = None
        self.previous_day: Optional[tuple[float, float, float, float]] = None
        self._daily_ranges: list[float] = []
        self._bars: list[Candle] = []
        self._trs: list[float] = []
        self._atr14 = 0.0
        self._asia: Optional[dict] = None
        self._london: Optional[dict] = None
        self._new_york_seen = False
        self._run_dir = 0
        self._down_run_open: Optional[float] = None
        self._down_run_bar: Optional[int] = None
        self._down_low: Optional[float] = None
        self._down_low_bar: Optional[int] = None
        self._up_run_open: Optional[float] = None
        self._up_run_bar: Optional[int] = None
        self._up_high: Optional[float] = None
        self._up_high_bar: Optional[int] = None
        self._last_pivot_low: Optional[float] = None
        self._last_pivot_low_bar: Optional[int] = None
        self._last_pivot_high: Optional[float] = None
        self._last_pivot_high_bar: Optional[int] = None
        self._bull_fvgs: list[tuple[float, float, int]] = []
        self._bear_fvgs: list[tuple[float, float, int]] = []
        self._events: dict[str, tuple[int, str]] = {}
        self._last_210_bucket: Optional[int] = None
        self._bucket_210: Optional[dict] = None

    def _reset_calendar_day(self, candle: Candle) -> None:
        if self.day_open is not None and self.day_high is not None and self.day_low is not None and self.day_close is not None:
            self.previous_day = (self.day_open, self.day_high, self.day_low, self.day_close)
            self._daily_ranges.append(self.day_high - self.day_low)
            self._daily_ranges = self._daily_ranges[-30:]
        self.calendar_day = _day_key(candle.time)
        self.day_open = candle.open
        self.day_high = candle.high
        self.day_low = candle.low
        self.day_close = candle.close
        self.bias = self._previous_bias()
        self.invalid = False
        self.was_broken = False
        self.broke50 = False
        self.entry_done = False
        self.range_exhausted = False
        self.framework = ""
        self.framework_dir = 0
        self.framework_level = None
        self.framework_failed = ""
        self._new_york_seen = False

    def _previous_bias(self) -> int:
        if not self.previous_day:
            return 0
        po, _ph, _pl, pc = self.previous_day
        return 1 if pc > po else -1 if pc < po else 0

    def _levels(self) -> tuple[Optional[float], Optional[float]]:
        if not self.previous_day or not self.bias:
            return None, None
        _po, ph, pl, pc = self.previous_day
        if self.bias == -1:
            return pc + 0.25 * (ph - pc), pc + 0.50 * (ph - pc)
        return pc - 0.25 * (pc - pl), pc - 0.50 * (pc - pl)

    def _effective_direction(self) -> int:
        return -self.bias if self.invalid and self.use_reversal and self.bias else self.bias

    def _update_daily_range(self, candle: Candle) -> None:
        self.day_high = max(self.day_high if self.day_high is not None else candle.high, candle.high)
        self.day_low = min(self.day_low if self.day_low is not None else candle.low, candle.low)
        self.day_close = candle.close

    def _bucket_index(self, timestamp: int) -> int:
        local = _local(timestamp)
        anchor = local.replace(hour=18, minute=0, second=0, microsecond=0)
        if local < anchor:
            anchor -= timedelta(days=1)
        return int((local.timestamp() - anchor.timestamp()) // (210 * 60))

    def _close_210(self, bucket: Optional[dict]) -> None:
        if not bucket or not self.bias:
            return
        start_local = _local(bucket["start"])
        overnight = start_local.hour >= 18 or start_local.hour < 8
        if self.use210 and (not self.overnight_only or overnight):
            q25, q50 = self._levels()
            if q25 is None:
                return
            close = bucket["close"]
            beyond = close < q25 if self.bias == 1 else close > q25
            through50 = close < q50 if self.bias == 1 else close > q50
            self.broke50 = self.broke50 or through50
            if not self.invalid and beyond:
                self.invalid = True
                self.was_broken = True
            elif self.invalid and self.use_reversal and not beyond and not self.broke50:
                self.invalid = False

    def _update_210(self, candle: Candle) -> None:
        bucket = self._bucket_index(candle.time)
        if self._last_210_bucket is None:
            self._last_210_bucket = bucket
            self._bucket_210 = {"start": candle.time, "open": candle.open, "high": candle.high, "low": candle.low, "close": candle.close}
        elif bucket != self._last_210_bucket:
            self._close_210(self._bucket_210)
            local = _local(candle.time)
            anchor = local.replace(hour=18, minute=0, second=0, microsecond=0)
            if local < anchor:
                anchor -= timedelta(days=1)
            start = int((anchor + timedelta(minutes=210 * bucket)).timestamp())
            self._last_210_bucket = bucket
            self._bucket_210 = {"start": start, "open": candle.open, "high": candle.high, "low": candle.low, "close": candle.close}
        else:
            assert self._bucket_210 is not None
            self._bucket_210["high"] = max(self._bucket_210["high"], candle.high)
            self._bucket_210["low"] = min(self._bucket_210["low"], candle.low)
            self._bucket_210["close"] = candle.close

    def _session_update(self, candle: Candle) -> None:
        local = _local(candle.time)
        model_day = _session_day(candle.time)
        if model_day != self.session_day:
            self.session_day = model_day
            self._asia = None
            self._london = None
            self.framework = ""
            self.framework_dir = 0
            self.framework_level = None
            self.framework_failed = ""
            self._new_york_seen = False
        minutes = local.hour * 60 + local.minute
        if 18 * 60 <= minutes or minutes < 60:
            if self._asia is None:
                self._asia = {"open": candle.open, "high": candle.high, "low": candle.low, "close": candle.close}
            else:
                self._asia["high"] = max(self._asia["high"], candle.high)
                self._asia["low"] = min(self._asia["low"], candle.low)
                self._asia["close"] = candle.close
        elif 60 <= minutes < 8 * 60:
            if self._london is None:
                self._london = {"open": candle.open, "high": candle.high, "low": candle.low, "close": candle.close}
            else:
                self._london["high"] = max(self._london["high"], candle.high)
                self._london["low"] = min(self._london["low"], candle.low)
                self._london["close"] = candle.close
        elif 8 * 60 <= minutes < 15 * 60:
            if not self._new_york_seen:
                self._new_york_seen = True
                self._classify_london()
            self._evaluate_f4(candle)
            # Pine's ta.sma(range, 14) is NA until fourteen completed days
            # exist. Do not turn a short warm-up window into a false ADR
            # exhaustion block.
            if self.adr_guard and len(self._daily_ranges) >= 14 and self.day_high is not None and self.day_low is not None:
                adr = sum(self._daily_ranges[-14:]) / 14
                self.range_exhausted = adr > 0 and self.day_high - self.day_low >= self.adr_fraction * adr

    def _classify_london(self) -> None:
        if not self.show_frameworks or not self._asia or not self._london:
            return
        a, l = self._asia, self._london
        ar = max(a["high"] - a["low"], 0.0)
        lr = max(l["high"] - l["low"], 0.0)
        if not ar or not lr:
            return
        # F2: London sweeps an Asia extreme and closes back into the range.
        if l["low"] < a["low"] and l["close"] > a["low"] and l["close"] > l["open"]:
            self.framework, self.framework_dir, self.framework_level = "F2", 1, a["low"]
            return
        if l["high"] > a["high"] and l["close"] < a["high"] and l["close"] < l["open"]:
            self.framework, self.framework_dir, self.framework_level = "F2", -1, a["high"]
            return
        # F3: London protracts into a session extreme and closes near it.
        band = 0.25 * lr
        if l["close"] < l["open"] and l["close"] - l["low"] <= band:
            self.framework, self.framework_dir, self.framework_level = "F3", 1, l["low"]
            return
        if l["close"] > l["open"] and l["high"] - l["close"] <= band:
            self.framework, self.framework_dir, self.framework_level = "F3", -1, l["high"]
            return
        # P1/P1B continuation profiles.
        asia_dir = 1 if a["close"] > a["open"] else -1 if a["close"] < a["open"] else 0
        asia_trending = asia_dir and ar > 0 and abs(a["close"] - a["open"]) >= 0.5 * ar
        london_inside = l["high"] <= a["high"] and l["low"] >= a["low"]
        if asia_trending and london_inside:
            self.framework, self.framework_dir = "P1B", asia_dir
        elif asia_trending and ((asia_dir == 1 and l["close"] > l["open"] and l["high"] > a["high"]) or (asia_dir == -1 and l["close"] < l["open"] and l["low"] < a["low"])):
            self.framework, self.framework_dir = "P1", asia_dir

    def _evaluate_f4(self, candle: Candle) -> None:
        if not self.show_frameworks or not self._london or self.framework:
            return
        l = self._london
        swept_low = candle.low < l["low"]
        swept_high = candle.high > l["high"]
        if swept_low and not swept_high:
            self.framework_level = l["low"]
            self.framework = "F4"
            self.framework_dir = 1 if candle.close > l["low"] else -1
        elif swept_high and not swept_low:
            self.framework_level = l["high"]
            self.framework = "F4"
            self.framework_dir = -1 if candle.close < l["high"] else 1

    def _update_runs(self, candle: Candle, index: int) -> tuple[bool, bool, Optional[float], Optional[int]]:
        if self._run_dir == -1 and (self._down_low is None or candle.low < self._down_low):
            self._down_low, self._down_low_bar = candle.low, index
        if self._run_dir == 1 and (self._up_high is None or candle.high > self._up_high):
            self._up_high, self._up_high_bar = candle.high, index
        if candle.close < candle.open and self._run_dir != -1:
            self._run_dir = -1
            self._down_run_open, self._down_run_bar = candle.open, index
            self._down_low, self._down_low_bar = candle.low, index
        if candle.close > candle.open and self._run_dir != 1:
            self._run_dir = 1
            self._up_run_open, self._up_run_bar = candle.open, index
            self._up_high, self._up_high_bar = candle.high, index
        bull = self._down_run_open is not None and candle.close > self._down_run_open and not (self._bars[-2].close > self._down_run_open if len(self._bars) > 1 else False)
        bear = self._up_run_open is not None and candle.close < self._up_run_open and not (self._bars[-2].close < self._up_run_open if len(self._bars) > 1 else False)
        if bull:
            return True, False, self._down_low, self._down_low_bar
        if bear:
            return False, True, self._up_high, self._up_high_bar
        return False, False, None, None

    def _record_events(self, candle: Candle, index: int) -> None:
        if index >= 2:
            two_back, previous = self._bars[-3], self._bars[-2]
            if previous.low > two_back.high:
                self._bull_fvgs.append((previous.low, two_back.high, index - 1))
            if previous.high < two_back.low:
                self._bear_fvgs.append((two_back.low, previous.high, index - 1))
        if self._bull_fvgs:
            for top, bottom, origin in reversed(self._bull_fvgs):
                if candle.close < bottom:
                    self._bull_fvgs.remove((top, bottom, origin))
                elif candle.low <= top and candle.high >= bottom:
                    self._events["FVG"] = (index, "FVG")
                    break
        if self._bear_fvgs:
            for top, bottom, origin in reversed(self._bear_fvgs):
                if candle.close > top:
                    self._bear_fvgs.remove((top, bottom, origin))
                elif candle.high >= bottom and candle.low <= top:
                    self._events["FVG"] = (index, "FVG")
                    break
        pv_lo = _pivot_low(self._bars, index)
        pv_hi = _pivot_high(self._bars, index)
        if pv_lo is not None:
            self._last_pivot_low, self._last_pivot_low_bar = pv_lo, index - 1
        if pv_hi is not None:
            self._last_pivot_high, self._last_pivot_high_bar = pv_hi, index - 1
        previous = self._bars[-2] if len(self._bars) > 1 else None
        if self._last_pivot_low is not None and candle.low < self._last_pivot_low and (previous is None or previous.low >= self._last_pivot_low):
            self._events["LQ"] = (index, "LQ")
        if self._last_pivot_high is not None and candle.high > self._last_pivot_high and (previous is None or previous.high <= self._last_pivot_high):
            self._events["LQ"] = (index, "LQ")
        if previous is not None and len(self._bars) >= 3:
            mid = (previous.high + previous.low) / 2.0
            if previous.low < self._bars[-3].low and previous.close > self._bars[-3].low and previous.close > mid:
                self._events["C2"] = (index - 1, "C2")
            if previous.high > self._bars[-3].high and previous.close < self._bars[-3].high and previous.close < mid:
                self._events["C2"] = (index - 1, "C2")

    def _event_for_window(self, start_index: int, index: int) -> str:
        # Match the supplied Pine ordering exactly: its event stamps are
        # updated in the confirmed-bar block immediately before the entry
        # block, so an event stamped on the trigger bar is eligible too.
        candidates = [(bar, name) for bar, name in self._events.values() if start_index <= bar <= index and index - bar <= self.event_max_bars]
        if not candidates:
            return ""
        best_bar = max(bar for bar, _name in candidates)
        names = sorted({name for bar, name in candidates if bar == best_bar})
        return "+".join(names)

    def _signature(self, candle: Candle, index: int, bullish: bool) -> tuple[bool, str, float, int]:
        if len(self._bars) < 2:
            return False, "", candle.low if bullish else candle.high, index
        previous = self._bars[-2]
        mid = (previous.high + previous.low) / 2.0
        prev_opp = previous.close < previous.open if bullish else previous.close > previous.open
        ec = self.use_ec and prev_opp and (candle.low < previous.low and candle.close > previous.open and candle.close > mid and candle.close > candle.open if bullish else candle.high > previous.high and candle.close < previous.open and candle.close < mid and candle.close < candle.open)
        pv = self._last_pivot_low if bullish else self._last_pivot_high
        rc = self.use_rc and pv is not None and ((candle.low < pv and candle.close > pv and candle.close > candle.open) if bullish else (candle.high > pv and candle.close < pv and candle.close < candle.open))
        irc = self.use_irc and not ec and prev_opp and ((candle.close > mid and candle.close > candle.open) if bullish else (candle.close < mid and candle.close < candle.open))
        if ec:
            return True, "EC", candle.low if bullish else candle.high, index
        if rc:
            return True, "RC", candle.low if bullish else candle.high, index
        if irc:
            return True, "IRC", candle.low if bullish else candle.high, index
        return False, "", candle.low if bullish else candle.high, index

    def _framework_ok(self, direction: int) -> bool:
        if self.range_exhausted:
            return False
        if not self.show_frameworks or self.framework_gate == "Off":
            return True
        if self.framework_gate == "Require aligned":
            return self.framework_dir == direction
        return self.framework_dir in (0, direction)

    def _process_bar(self, candle: Candle, index: int) -> Optional[Signal]:
        if self.calendar_day != _day_key(candle.time):
            self._reset_calendar_day(candle)
        else:
            self._update_daily_range(candle)
        self._update_210(candle)
        self._session_update(candle)
        if self.entry_done and self.protected_swing is not None:
            closed_through = (self.protected_direction == 1 and candle.close < self.protected_swing) or (self.protected_direction == -1 and candle.close > self.protected_swing)
            if closed_through:
                self.entry_done = False
                self.protected_swing = None
                self.protected_direction = 0
        previous_close = self._bars[-1].close if self._bars else None
        self._trs.append(_tr(candle, previous_close))
        atr = _rma(self._trs, 14) or 0.0
        self._atr14 = atr
        self._bars.append(candle)
        self._record_events(candle, index)
        bull_cisd, bear_cisd, cisd_swing, cisd_swing_bar = self._update_runs(candle, index)
        if self.previous_day and self.bias:
            q25, q50 = self._levels()
            if q25 is not None and not self.use210:
                beyond = candle.close < q25 if self.bias == 1 else candle.close > q25
                if beyond and not self.invalid:
                    self.invalid, self.was_broken = True, True
                elif self.invalid and self.use_reversal and not beyond and not self.broke50:
                    self.invalid = False
            if q50 is not None and (candle.close < q50 if self.bias == 1 else candle.close > q50):
                self.broke50 = True
        if atr <= 0 or not self.show_entry or not self.previous_day:
            self.last_gate = "warming up" if not self.previous_day else "ATR unavailable"
            return None
        direction = self._effective_direction()
        bias_ok = bool(direction) and (not self.require_bias or (self.bias and (not self.invalid or self.use_reversal)))
        time_ok = not self.entry_window or _in_window(candle.time, self.entry_start, self.entry_end)
        framework_ok = self._framework_ok(direction)
        if not bias_ok:
            self.last_gate = "bias invalid or unavailable"
        elif not time_ok:
            self.last_gate = "outside 09:00–10:30 ET entry window"
        elif not framework_ok:
            self.last_gate = "7H framework/ADR gate"
        elif self.first_only and self.entry_done:
            self.last_gate = "one-entry-per-day already used"
        else:
            self.last_gate = "watching protected trigger"
        if not bias_ok or not time_ok or not framework_ok or (self.first_only and self.entry_done):
            return None
        cisd_fire = self.use_cisd and ((direction == 1 and bull_cisd) or (direction == -1 and bear_cisd)) and cisd_swing is not None
        sig_fire, sig_name, sig_swing, sig_swing_bar = self._signature(candle, index, direction == 1) if self.use_signatures else (False, "", candle.low if direction == 1 else candle.high, index)
        if not cisd_fire and not sig_fire:
            return None
        trigger_start = cisd_swing_bar if cisd_fire and cisd_swing_bar is not None else max(0, index - 20)
        trigger_start = max(trigger_start, index - self.event_max_bars)
        event = self._event_for_window(trigger_start, index)
        if (cisd_fire and not event) or (sig_fire and self.signature_event_gate and not event):
            self.last_gate = "trigger blocked: qualifying event must precede it"
            return None
        swing = cisd_swing if cisd_fire else sig_swing
        swing_bar = cisd_swing_bar if cisd_fire else sig_swing_bar
        if swing is None or swing <= 0:
            self.last_gate = "protected swing unavailable"
            return None
        entry = candle.close
        if direction == 1 and swing >= entry or direction == -1 and swing <= entry:
            self.last_gate = "protected swing is on the wrong side"
            return None
        risk = abs(entry - swing)
        target = entry + risk if direction == 1 else entry - risk
        target2 = entry + 2 * risk if direction == 1 else entry - 2 * risk
        trigger = "CISD" if cisd_fire else sig_name
        if cisd_fire and sig_fire:
            trigger += "+" + sig_name
        self.last_signal = Signal(
            symbol=self.symbol,
            direction="long" if direction == 1 else "short",
            entry=entry,
            stop=swing,
            target=target,
            target2=target2,
            atr=atr,
            bar_time=candle.time,
            setup_key=f"{self.symbol}:{STRATEGY_NAME}:{direction}:{candle.time}",
            pattern=f"PS · {event}→{trigger}",
            framework=self.framework,
            bias=self.bias,
            event=event,
        )
        self.last_direction = direction
        self.last_event = event
        self.last_trigger = trigger
        self.last_stop = swing
        self.protected_swing = swing
        self.protected_direction = direction
        self.last_score = 1.0
        self.entry_done = True
        self.last_gate = "protected entry confirmed"
        return self.last_signal

    def process_candles(self, candles: list[Candle]) -> Optional[Signal]:
        if len(candles) < 80:
            return None
        closed = candles[:-1]
        result: Optional[Signal] = None
        if not self.last_bar_time:
            for index, candle in enumerate(closed):
                signal = self._process_bar(candle, index)
                if index == len(closed) - 1:
                    result = signal
        else:
            for candle in closed:
                if candle.time > self.last_bar_time:
                    result = self._process_bar(candle, len(self._bars)) or result
        if closed:
            self.last_bar_time = closed[-1].time
        return result

    def get_dashboard(self) -> dict:
        q25, q50 = self._levels()
        return {
            "strategy": STRATEGY_NAME,
            "pattern": self.last_signal.pattern if self.last_signal else "NONE",
            "phase": "ENTRY" if self.last_signal else "WATCHING",
            "direction": "BUY" if self.last_direction > 0 else "SELL" if self.last_direction < 0 else "NONE",
            "entry": self.last_signal.entry if self.last_signal else None,
            "stop": self.last_stop or (self.last_signal.stop if self.last_signal else None),
            "target_1r": self.last_signal.target if self.last_signal else None,
            "target_2r": self.last_signal.target2 if self.last_signal else None,
            "bias": "BULL" if self.bias == 1 else "BEAR" if self.bias == -1 else "NONE",
            "effective_direction": "BULL" if self._effective_direction() == 1 else "BEAR" if self._effective_direction() == -1 else "NONE",
            "q25": q25,
            "q50": q50,
            "framework": self.framework or "NONE",
            "framework_direction": "BULL" if self.framework_dir == 1 else "BEAR" if self.framework_dir == -1 else "NONE",
            "last_event": self.last_event,
            "last_trigger": self.last_trigger,
            "gate": self.last_gate,
            "range_exhausted": self.range_exhausted,
            "timeframe": TIMEFRAME,
            "entry_window": "09:00–10:30 America/New_York" if self.entry_window else "any time",
            "params": {
                "use_210m": self.use210,
                "framework_gate": self.framework_gate,
                "require_bias": self.require_bias,
                "event_max_bars": self.event_max_bars,
                "first_only": self.first_only,
            },
        }
