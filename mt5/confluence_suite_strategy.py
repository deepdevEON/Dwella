#!/usr/bin/env python3
"""Confluence Suite signal engine.

This is the execution companion for the supplied Pine ``Confluence Suite``
indicator.  It evaluates only closed 3-minute bars and emits a signal when
Adaptive Supertrend state changes:

    BUY  -> long entry, or close short and reverse long
    SELL -> short entry, or close long and reverse short

The Pine source is an indicator, not an order strategy.  It does not define a
fixed profit target; the adaptive trailing-stop value is therefore used as the
native protective stop and the opposite confirmed signal is the strategy exit.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

STRATEGY_NAME = "CONFLUENCE_SUITE"
TIMEFRAME = "3"


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
    direction: str = ""  # long = Pine BUY, short = Pine SELL
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0
    target2: float = 0.0
    target3: float = 0.0
    atr: float = 0.0
    confirmed: bool = True
    bar_time: int = 0
    setup_key: str = ""
    phase: str = "FIRED"
    pattern: str = "BUY"
    grade: str = ""
    score: float = 0.0
    exit_marker: bool = False

    def to_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class _Factor:
    factor: float
    upper: float = 0.0
    lower: float = 0.0
    output: float = 0.0
    perf: float = 0.0
    trend: int = 0
    initialized: bool = False


@dataclass
class _Neo:
    upper: float = 0.0
    lower: float = 0.0
    os: int = 0
    mx: float = 0.0
    mn: float = 0.0
    initialized: bool = False


def _ema(values: list[float], length: int) -> list[Optional[float]]:
    out: list[Optional[float]] = [None] * len(values)
    if not values or length <= 0:
        return out
    alpha = 2.0 / (length + 1.0)
    prev: Optional[float] = None
    for i, value in enumerate(values):
        if prev is None:
            if i + 1 < length:
                continue
            prev = sum(values[:length]) / length
            out[i] = prev
        else:
            prev = value * alpha + prev * (1.0 - alpha)
            out[i] = prev
    return out


def _rma(values: list[float], length: int) -> list[Optional[float]]:
    out: list[Optional[float]] = [None] * len(values)
    if len(values) < length:
        return out
    prev = sum(values[:length]) / length
    out[length - 1] = prev
    for i in range(length, len(values)):
        prev = (prev * (length - 1) + values[i]) / length
        out[i] = prev
    return out


def _sma(values: list[float], length: int, index: int) -> Optional[float]:
    if index + 1 < length:
        return None
    return sum(values[index - length + 1:index + 1]) / length


def _stdev(values: list[float], length: int, index: int) -> float:
    if index + 1 < length:
        return 0.0
    window = values[index - length + 1:index + 1]
    mean = sum(window) / length
    return math.sqrt(sum((x - mean) ** 2 for x in window) / length)


def _wma(values: list[float], length: int, index: int) -> Optional[float]:
    if length <= 0 or index + 1 < length:
        return None
    window = values[index - length + 1:index + 1]
    denom = length * (length + 1) / 2
    return sum(value * (j + 1) for j, value in enumerate(window)) / denom


def _vwma(candles: list[Candle], length: int, index: int) -> Optional[float]:
    if index + 1 < length:
        return None
    window = candles[index - length + 1:index + 1]
    volume = sum(max(0.0, c.volume) for c in window)
    return sum(c.close * max(0.0, c.volume) for c in window) / volume if volume else sum(c.close for c in window) / length


def _true_ranges(candles: list[Candle]) -> list[float]:
    out = []
    for i, candle in enumerate(candles):
        if i == 0:
            out.append(candle.high - candle.low)
        else:
            prev = candles[i - 1].close
            out.append(max(candle.high - candle.low, abs(candle.high - prev), abs(candle.low - prev)))
    return out


def _atr(candles: list[Candle], length: int) -> list[Optional[float]]:
    return _rma(_true_ranges(candles), length)


def _percentile(values: list[float], percent: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100.0
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _sign(value: float) -> float:
    return 1.0 if value > 0 else -1.0 if value < 0 else 0.0


def _tanh(value: float) -> float:
    return math.tanh(value)


def _alma(values: list[float], length: int, offset: float, sigma: float, index: int) -> Optional[float]:
    if index + 1 < length:
        return None
    m = offset * (length - 1)
    s = length / sigma
    weights = [math.exp(-((j - m) ** 2) / (2 * s * s)) for j in range(length)]
    total = sum(weights)
    window = values[index - length + 1:index + 1]
    return sum(value * weights[j] for j, value in enumerate(window)) / total


def _rsi(values: list[float], length: int) -> list[Optional[float]]:
    gains = [0.0]
    losses = [0.0]
    for i in range(1, len(values)):
        delta = values[i] - values[i - 1]
        gains.append(max(delta, 0.0))
        losses.append(max(-delta, 0.0))
    avg_gain = _rma(gains, length)
    avg_loss = _rma(losses, length)
    out: list[Optional[float]] = [None] * len(values)
    for i in range(len(values)):
        if avg_gain[i] is None or avg_loss[i] is None:
            continue
        if avg_loss[i] == 0:
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + avg_gain[i] / avg_loss[i])
    return out


def _cross_up(a: list[Optional[float]], b: list[Optional[float]], index: int) -> bool:
    return index > 0 and a[index] is not None and b[index] is not None and a[index - 1] is not None and b[index - 1] is not None and a[index] > b[index] and a[index - 1] <= b[index - 1]


def _cross_down(a: list[Optional[float]], b: list[Optional[float]], index: int) -> bool:
    return index > 0 and a[index] is not None and b[index] is not None and a[index - 1] is not None and b[index - 1] is not None and a[index] < b[index] and a[index - 1] >= b[index - 1]


class ConfluenceSuiteEngine:
    """Stateful closed-bar implementation of the supplied Pine signals."""

    def __init__(self, symbol: str = "", preset: str = "None"):
        self.symbol = symbol
        self.preset = preset
        self.last_bar_time = 0
        self.last_signal: Optional[Signal] = None
        self.last_direction = 0
        self.last_os = 0
        self.last_ts = 0.0
        self.last_atr = 0.0
        self.last_score = 0.0
        self.last_grade = ""
        self._factors: list[_Factor] = []
        self._upper_ts = 0.0
        self._lower_ts = 0.0
        self._ts_initialized = False
        self._target_factor: Optional[float] = None
        self._perf_ama: Optional[float] = None
        self._neo_tenkan = _Neo()
        self._neo_kijun = _Neo()
        self._neo_spanb = _Neo()
        self._uv = 0.0
        self._dv = 0.0
        self._ss: list[float] = []
        self._closes: list[float] = []
        self._highs: list[float] = []
        self._lows: list[float] = []
        self._volumes: list[float] = []
        self._trs: list[float] = []
        self._atr14: list[Optional[float]] = []
        self._atr_st: list[Optional[float]] = []
        self._ema_abs10: list[Optional[float]] = []
        self._factor_signature = ""

    def _settings(self) -> tuple[float, float]:
        # These are the Pine defaults. The source checks "Short Term" while
        # its input option is "Short-Term"; use the visible option spelling
        # so the preset actually works when selected in Dwella.
        if self.preset == "Short-Term":
            return 1.0, 4.0
        if self.preset == "Mid-Term":
            return 5.0, 10.0
        if self.preset == "Long-Term":
            return 8.0, 13.0
        if self.preset == "Scalper [Preset]":
            sensitivity = 4.0
        elif self.preset == "Swing Trader [Preset]":
            sensitivity = 18.0
        else:
            sensitivity = 5.0
        return max(sensitivity - 4.0, 1.0), min(sensitivity, 26.0)

    def _ensure_factors(self) -> None:
        low, high = self._settings()
        signature = f"{low}:{high}"
        if signature == self._factor_signature:
            return
        self._factor_signature = signature
        self._factors = [_Factor(round(low + j * 0.5, 10)) for j in range(int(round((high - low) / 0.5)) + 1)]
        self._upper_ts = self._lower_ts = 0.0
        self._ts_initialized = False
        self._target_factor = None

    def _trend_flow(self, index: int) -> Optional[float]:
        # f_calcTrendFlowLine() with the Pine constants (length 24).
        hma_len = 4
        wma_half = _wma(self._closes, 2, index)
        wma_full = _wma(self._closes, hma_len, index)
        hma_raw = None
        if wma_half is not None and wma_full is not None:
            hma_raw = 2 * wma_half - wma_full
        # HMA's final WMA(2) over the raw HMA series is calculated from the
        # available history to avoid smoothing a missing warm-up value.
        hma_series: list[float] = []
        for j in range(index + 1):
            a = _wma(self._closes, 2, j)
            b = _wma(self._closes, hma_len, j)
            hma_series.append(2 * a - b if a is not None and b is not None else 0.0)
        hma = _wma(hma_series, 2, index) if hma_raw is not None else None
        w1 = 8
        w2 = 5
        inner: list[float] = []
        for j in range(index + 1):
            first = _wma(self._closes, w2, j)
            inner.append(first if first is not None else 0.0)
        dwma = _wma(inner, w1, index)
        if hma is None or dwma is None:
            return None
        return (hma + dwma + hma) / 3.0

    def _super_smoother(self, index: int) -> float:
        length = 50.0
        a1 = math.exp(-math.sqrt(2) * math.pi / length)
        b1 = 2 * a1 * math.cos(math.sqrt(2) * math.pi / length)
        c3 = -(a1 ** 2)
        c2 = b1
        c1 = 1 - c2 - c3
        prev1 = self._ss[-1] if self._ss else self._closes[max(0, index - 1)]
        prev2 = self._ss[-2] if len(self._ss) > 1 else self._closes[max(0, index - 1)]
        value = c1 * self._closes[index] + c2 * prev1 + c3 * prev2
        self._ss.append(value)
        return value

    def _neo_step(self, state: _Neo, source: float, length: int, multiplier: float, index: int, atrs: list[Optional[float]]) -> float:
        atr = atrs[index] if index < len(atrs) and atrs[index] is not None else 0.0
        up = (self._highs[index] + self._lows[index]) / 2 + atr * multiplier
        down = (self._highs[index] + self._lows[index]) / 2 - atr * multiplier
        if not state.initialized:
            state.upper, state.lower = up, down
            state.os = 0
            state.mx, state.mn = up, down
            state.initialized = True
        else:
            state.upper = min(up, state.upper) if self._closes[index - 1] < state.upper else up
            state.lower = max(down, state.lower) if self._closes[index - 1] > state.lower else down
            state.os = 1 if source > state.upper else 0 if source < state.lower else state.os
            spt = state.lower if state.os == 1 else state.upper
            crossed = (source >= spt and self._closes[index - 1] < spt) or (source <= spt and self._closes[index - 1] > spt)
            state.mx = max(source, state.mx) if crossed or state.os == 1 else spt
            state.mn = min(source, state.mn) if crossed or state.os == 0 else spt
        return (state.mx + state.mn) / 2

    def _neo_filter_bull(self, index: int, atrs: list[Optional[float]]) -> bool:
        # The filter is rarely selected; this keeps the same recursive
        # avg_neo structure and compares int(senkouA+senkouB) to its 2-bar SMA.
        tenkan = self._neo_step(self._neo_tenkan, self._closes[index], 365, 3, index, atrs)
        kijun = self._neo_step(self._neo_kijun, self._closes[index], 365, 7, index, atrs)
        spanb = self._neo_step(self._neo_spanb, self._closes[index], 365, 15, index, atrs)
        current = int((tenkan + kijun) + (kijun + spanb))
        previous = getattr(self, "_neo_previous", current)
        self._neo_previous = current
        return current >= (previous + current) / 2

    def _calc_volume(self, candle: Candle) -> None:
        # Mirrors the first matching branch of the Pine switch and its
        # cumulative fallback branches.
        up = down = 0.0
        volume = candle.volume or 0.0
        if candle.close - candle.low > candle.high - candle.close:
            up = volume
        elif candle.close - candle.low < candle.high - candle.close:
            down = -volume
        elif candle.close > candle.open:
            up = volume
        elif candle.close < candle.open:
            down = -volume
        elif len(self._closes) > 1 and candle.close > self._closes[-2]:
            up = volume
        elif len(self._closes) > 1 and candle.close < self._closes[-2]:
            down = -volume
        elif self._uv > 0:
            up = self._uv + volume
        elif self._dv < 0:
            down = self._dv - volume
        self._uv, self._dv = up, down

    def _cluster_target_factor(self) -> Optional[float]:
        if not self._factors:
            return None
        data = [factor.perf for factor in self._factors]
        factors = [factor.factor for factor in self._factors]
        centroids = [_percentile(data, 25), _percentile(data, 50), _percentile(data, 75)]
        clusters: list[list[int]] = [[], [], []]
        for _ in range(251):
            clusters = [[], [], []]
            for i, value in enumerate(data):
                idx = min(range(3), key=lambda j: abs(value - centroids[j]))
                clusters[idx].append(i)
            new = [sum(data[i] for i in group) / len(group) if group else centroids[j] for j, group in enumerate(clusters)]
            if all(abs(new[j] - centroids[j]) < 1e-12 for j in range(3)):
                centroids = new
                break
            centroids = new
        best = clusters[2]  # fromCluster = 'Best'
        if not best:
            return self._target_factor
        return sum(factors[i] for i in best) / len(best)

    def _signal_score(self, index: int, is_buy: bool, trend_flow: Optional[float], trend_catcher: float, atr: float) -> tuple[float, str]:
        closes = self._closes
        def dema(length: int) -> Optional[float]:
            first = _ema(closes, length)
            valid = [x if x is not None else 0.0 for x in first]
            second = _ema(valid, length)
            return None if first[index] is None or second[index] is None else 2 * first[index] - second[index]
        atr14 = self._atr14[index] or 0.0
        fast = dema(7) or closes[index]
        line_series: list[float] = []
        for j in range(index + 1):
            a = dema(7) if j == index else None
            # The exact current values matter for a signal; use DEMA history
            # from EMA arrays for the preceding bars.
            e1 = _ema(closes, 7)[j]
            e2 = _ema([x if x is not None else 0.0 for x in _ema(closes, 7)], 7)[j]
            line_series.append((2 * e1 - e2) if e1 is not None and e2 is not None else 0.0)
        n = 1.5 * (closes[index] - fast) / atr14 if atr14 > 0 else 0.0
        n_series = [1.5 * (closes[j] - line_series[j]) / (self._atr14[j] or 1.0) for j in range(index + 1)]
        n100 = [x * 100 for x in n_series]
        line = _sma(n100, 10, index) or 0.0
        line_prev = _sma(n100, 10, index - 1) or line
        sig_values = _ema([_sma(n100, 10, j) or 0.0 for j in range(index + 1)], 10)
        sig = sig_values[index] or 0.0
        sig_prev = sig_values[index - 1] or sig
        cross = 1.0 if line > sig and line_prev <= sig_prev else -1.0 if line < sig and line_prev >= sig_prev else 0.0
        amf = (1.0 if (cross > 0 or line > sig) else -0.6 if line < sig else 0.0) if is_buy else (1.0 if (cross < 0 or line < sig) else -0.6 if line > sig else 0.0)
        alma_fast = _alma(closes, 20, 0.85, 6.0, index)
        alma_slow = _alma(closes, 20, 0.77, 6.0, index)
        gap = abs((alma_fast or closes[index]) - (alma_slow or closes[index])) / max(atr14, 1e-9)
        alma = (0.5 if alma_fast and alma_slow and alma_fast > alma_slow else -0.8 if gap > 0.1 else -0.2) if is_buy else (0.5 if alma_fast and alma_slow and alma_fast < alma_slow else -0.8 if gap > 0.1 else -0.2)
        ph = max(self._highs[index - 19:index + 1]) if index >= 19 else None
        pl = min(self._lows[index - 19:index + 1]) if index >= 19 else None
        prev_ph = max(self._highs[index - 39:index - 19]) if index >= 39 else None
        prev_pl = min(self._lows[index - 39:index - 19]) if index >= 39 else None
        bull = ph is not None and pl is not None and prev_ph is not None and prev_pl is not None and ph > prev_ph and pl > prev_pl
        bear = ph is not None and pl is not None and prev_ph is not None and prev_pl is not None and ph < prev_ph and pl < prev_pl
        swing = (0.6 if bull else -0.7 if bear else -0.1) if is_buy else (0.6 if bear else -0.7 if bull else -0.1)
        volume = self._uv + abs(self._dv)
        ratio = (self._uv - abs(self._dv)) / volume if volume else 0.0
        vol = ratio if is_buy else -ratio
        raw = 1.2 * amf + 0.4 * alma + 0.4 * swing + 0.8 * vol + 0.10
        raw += 1.4 * amf + 0.3 * alma + 0.3 * swing + 0.6 * vol + 0.05
        raw += 1.6 * amf + 0.4 * alma + 0.5 * swing + 1.0 * vol + 0.15
        score = 1.0 / (1.0 + math.exp(-(_tanh(raw * 0.4) * 1.2)))
        grade = "A+" if score >= 0.80 else "A" if score >= 0.76 else "B" if score >= 0.65 else "C" if score >= 0.37 else "D" if score >= 0.28 else "F"
        return score, grade

    def _process_bar(self, candle: Candle, index: int) -> Optional[Signal]:
        self._ensure_factors()
        self._closes.append(candle.close)
        self._highs.append(candle.high)
        self._candles_for_metrics = getattr(self, "_candles_for_metrics", [])
        self._candles_for_metrics.append(candle)
        self._lows.append(candle.low)
        self._volumes.append(candle.volume)
        self._trs.append(max(candle.high - candle.low, abs(candle.high - self._closes[-2]) if len(self._closes) > 1 else candle.high - candle.low, abs(candle.low - self._closes[-2]) if len(self._closes) > 1 else candle.high - candle.low))
        self._atr14 = _rma(self._trs, 14)
        self._atr_st = _rma(self._trs, 10)
        self._ema_abs10 = _ema([abs(self._closes[i] - self._closes[i - 1]) if i else 0.0 for i in range(len(self._closes))], 10)
        atr = self._atr_st[-1] or 0.0
        if atr <= 0:
            self.last_bar_time = candle.time
            return None
        self._calc_volume(candle)
        prev_close = self._closes[-2] if len(self._closes) > 1 else candle.close
        hl2 = (candle.high + candle.low) / 2
        for factor in self._factors:
            up = hl2 + atr * factor.factor
            down = hl2 - atr * factor.factor
            if not factor.initialized:
                factor.upper, factor.lower = up, down
                factor.trend = 0
                factor.output = factor.upper
                factor.initialized = True
            else:
                factor.trend = 1 if candle.close > factor.upper else 0 if candle.close < factor.lower else factor.trend
                factor.upper = min(up, factor.upper) if prev_close < factor.upper else up
                factor.lower = max(down, factor.lower) if prev_close > factor.lower else down
                diff = _sign(prev_close - factor.output)
                factor.perf += 2 / 11 * ((candle.close - prev_close) * diff - factor.perf)
                factor.output = factor.lower if factor.trend else factor.upper
        self._target_factor = self._cluster_target_factor()
        if self._target_factor is None:
            self.last_bar_time = candle.time
            return None
        up_ts = hl2 + atr * self._target_factor
        down_ts = hl2 - atr * self._target_factor
        prev_os = self.last_os
        if not self._ts_initialized:
            self._upper_ts, self._lower_ts = up_ts, down_ts
            self._ts_initialized = True
        else:
            self._upper_ts = min(up_ts, self._upper_ts) if prev_close < self._upper_ts else up_ts
            self._lower_ts = max(down_ts, self._lower_ts) if prev_close > self._lower_ts else down_ts
        self.last_os = 1 if candle.close > self._upper_ts else 0 if candle.close < self._lower_ts else self.last_os
        ts = self._lower_ts if self.last_os else self._upper_ts
        self.last_ts = ts
        self.last_atr = atr
        tfl = self._trend_flow(index)
        if tfl is None:
            self.last_bar_time = candle.time
            return None
        if index >= 9:
            prior_tfl = self._trend_flow(index - 9)
            bull_trail = prior_tfl is not None and tfl > prior_tfl
        else:
            bull_trail = False
        # Trend Catcher and other filters are evaluated for the selected
        # preset. With preset None, Pine has no additional signal filter.
        ss = self._super_smoother(index)
        catcher_bull = len(self._ss) > 1 and ss > self._ss[-2]
        transition_buy = self.last_os > prev_os
        transition_sell = self.last_os < prev_os
        if not (transition_buy or transition_sell):
            self.last_bar_time = candle.time
            return None
        is_buy = transition_buy
        passes = True
        if self.preset == "Smart Trail [Filter]":
            passes = bull_trail == is_buy
        if self.preset == "Trend Catcher [Filter]":
            passes = catcher_bull == is_buy
        if self.preset == "Trend Strength [Filter]":
            vwma = _vwma(self._candles_for_metrics, 14, index) if hasattr(self, "_candles_for_metrics") else None
            strength_atr = self._atr14[index] or atr
            strength = max(-2.0, min(2.0, (candle.close - (vwma or candle.close)) / max(strength_atr, 1e-9))) * 50.0
            passes = abs(strength) > 30.0
        if self.preset == "Trend Tracer [Filter]":
            mid = (max(self._highs[max(0, index - 19):index + 1]) + min(self._lows[max(0, index - 19):index + 1])) / 2
            passes = (candle.close >= mid) == is_buy
        if self.preset == "Neo Cloud [Filter]":
            passes = self._neo_filter_bull(index, self._atr14) == is_buy
        if not passes:
            self.last_bar_time = candle.time
            return None
        score, grade = self._signal_score(index, is_buy, tfl, ss, atr)
        direction = "long" if is_buy else "short"
        # Pine has no fixed TP. The stop is the adaptive trailing level when
        # it is on the protective side; ATR is a conservative warm-up fallback.
        stop = ts if (ts < candle.close if is_buy else ts > candle.close) else (candle.close - atr if is_buy else candle.close + atr)
        signal = Signal(
            symbol=self.symbol, direction=direction, entry=candle.close,
            stop=stop, atr=atr, bar_time=candle.time,
            setup_key=f"{self.symbol}:CONFLUENCE_SUITE:{direction}:{candle.time}",
            pattern="BUY" if is_buy else "SELL", score=score, grade=grade,
        )
        self.last_signal = signal
        self.last_direction = 1 if is_buy else -1
        self.last_score, self.last_grade = score, grade
        self.last_bar_time = candle.time
        return signal

    def process_candles(self, candles: list[Candle]) -> Optional[Signal]:
        if len(candles) < 60:
            return None
        # The final candle is treated as forming; process only the most recent
        # confirmed bar, matching barstate.isconfirmed execution.
        closed = candles[:-1]
        result = None
        if self.last_bar_time == 0:
            for i, candle in enumerate(closed):
                signal = self._process_bar(candle, i)
                # Historical bars warm the state but cannot create a live
                # order on startup. Only the newest confirmed bar is eligible.
                if i == len(closed) - 1:
                    result = signal
        else:
            for candle in closed:
                if candle.time > self.last_bar_time:
                    result = self._process_bar(candle, len(self._closes)) or result
        return result

    def get_dashboard(self) -> dict:
        return {
            "strategy": STRATEGY_NAME,
            "pattern": self.last_signal.pattern if self.last_signal else "NONE",
            "phase": "FIRED" if self.last_signal else "WATCHING",
            "direction": "BUY" if self.last_direction > 0 else "SELL" if self.last_direction < 0 else "NONE",
            "entry": self.last_signal.entry if self.last_signal else None,
            "stop": self.last_signal.stop if self.last_signal else None,
            "score": round(self.last_score, 4),
            "grade": self.last_grade,
            "trailing_stop": self.last_ts,
            "target_factor": self._target_factor,
            "timeframe": TIMEFRAME,
            "params": {"preset": self.preset, "sensitivity": 5, "atr_length": 10, "signal_mode": "Confirmation + Exits"},
        }
