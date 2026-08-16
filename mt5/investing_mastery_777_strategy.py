#!/usr/bin/env python3
"""Investing Mastery 777 — playlist-based, confirmed-bar strategy engine.

This module turns the observable rules in BOB's Investing Mastery lessons into
explicit, testable calculations rather than pretending that a discretionary
video supplies a magic formula:

* Lesson 27/28: red support and blue resistance are wick-derived levels.
* Lesson 29: a touch is not an entry; the bar must close back through the level
  (a reclaim close).
* Lesson 30: count the evidence (touches, wick overlap, and timeframe overlap)
  instead of calling one touch a probability edge.
* Lesson 31: read the higher-timeframe grain first, stack native timeframes,
  and wait when the higher frames conflict. "777" is exposed as a transparent
  three-part 0–7 score (level / stack / reclaim), not as a hard-coded price.

The engine evaluates only closed bars. It emits at most one signal from the
configured trigger timeframe; every other native timeframe contributes context
and level strength, so higher frames cannot create duplicate entries.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

STRATEGY_NAME = "INVESTING_MASTERY_777"
PLAYLIST_NAME = "BOB INVESTING MASTERY"
PLAYLIST_URL = "https://youtube.com/playlist?list=PLTUWdrcxy7pY"
TRIGGER_TIMEFRAME = "3"
# These are native TradingView resolutions, not relabelled trigger candles.
CONTEXT_TIMEFRAMES = ("1", "5", "15", "60", "240", "D")
HIGHER_TIMEFRAMES = ("15", "60", "240", "D")

PIVOT_LEFT = 2
PIVOT_RIGHT = 2
LEVEL_LOOKBACK = 180
ATR_LENGTH = 14
FAST_LENGTH = 8
SLOW_LENGTH = 21
LEVEL_TOLERANCE_ATR = 0.22
LEVEL_TOLERANCE_PCT = 0.0008
RECLAIM_BUFFER_ATR = 0.05
MIN_RR = 1.5
MIN_HIGHER_FRAMES = 2
SIGNAL_COOLDOWN_BARS = 1

# Higher frames carry more weight, but every available native frame is still
# visible in the dashboard and can add evidence to a level.
FRAME_WEIGHT = {
    "1": 0.75,
    "3": 1.0,
    "5": 1.0,
    "15": 1.5,
    "60": 2.0,
    "240": 2.5,
    "D": 3.0,
}


@dataclass
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class Level:
    price: float
    kind: str
    timeframe: str
    touches: int = 0
    wick_overlap: int = 0
    strength: float = 0.0
    last_index: int = 0
    timeframes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "price": round(float(self.price), 8),
            "kind": self.kind,
            "timeframe": self.timeframe,
            "touches": int(self.touches),
            "wick_overlap": int(self.wick_overlap),
            "strength": round(float(self.strength), 2),
            "last_index": int(self.last_index),
            "timeframes": list(self.timeframes or [self.timeframe]),
        }


@dataclass
class TimeframeRead:
    timeframe: str
    ready: bool = False
    bars: int = 0
    close: float = 0.0
    atr: float = 0.0
    bias: str = "NEUTRAL"
    red_line: Optional[Level] = None
    blue_line: Optional[Level] = None
    supports: list[Level] = field(default_factory=list)
    resistances: list[Level] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "timeframe": self.timeframe,
            "ready": self.ready,
            "bars": self.bars,
            "close": round(self.close, 8) if self.close else None,
            "atr": round(self.atr, 8) if self.atr else None,
            "bias": self.bias,
            "red_line": self.red_line.to_dict() if self.red_line else None,
            "blue_line": self.blue_line.to_dict() if self.blue_line else None,
            "supports": [x.to_dict() for x in self.supports[:6]],
            "resistances": [x.to_dict() for x in self.resistances[:6]],
        }


@dataclass
class Signal:
    strategy: str = STRATEGY_NAME
    symbol: str = ""
    direction: str = ""
    entry: float = 0.0
    stop: float = 0.0
    target: float = 0.0
    target2: float = 0.0
    target3: float = 0.0
    atr: float = 0.0
    confirmed: bool = True
    bar_time: int = 0
    setup_key: str = ""
    pattern: str = ""
    framework: str = ""
    area: str = ""
    completion: float = 0.0
    confluence: int = 0
    bean_count: int = 0
    timeframe_alignment: dict = field(default_factory=dict)
    alignment_count: int = 0
    timeframes_checked: int = 0
    seven_score: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _closed(candles: list[Candle]) -> list[Candle]:
    """Drop the live/forming tail, matching TradingView's confirmed-bar rule."""
    return list(candles[:-1]) if len(candles) >= 2 else []


def _true_ranges(candles: list[Candle]) -> list[float]:
    out: list[float] = []
    for i, candle in enumerate(candles):
        if i == 0:
            out.append(max(0.0, candle.high - candle.low))
        else:
            out.append(max(
                candle.high - candle.low,
                abs(candle.high - candles[i - 1].close),
                abs(candle.low - candles[i - 1].close),
            ))
    return out


def atr_value(candles: list[Candle], length: int = ATR_LENGTH) -> float:
    if not candles:
        return 0.0
    tr = _true_ranges(candles)
    if len(tr) < length:
        return sum(tr) / len(tr) if tr else 0.0
    # A Wilder seed followed by Wilder smoothing. The latest value is all the
    # level detector needs, and this remains deterministic in tests.
    value = sum(tr[:length]) / length
    for item in tr[length:]:
        value = (value * (length - 1) + item) / length
    return value


def ema_last(values: list[float], length: int) -> Optional[float]:
    if len(values) < length:
        return None
    value = sum(values[:length]) / length
    alpha = 2.0 / (length + 1.0)
    for item in values[length:]:
        value = item * alpha + value * (1.0 - alpha)
    return value


def _pivots(candles: list[Candle], high: bool) -> list[tuple[float, int]]:
    points: list[tuple[float, int]] = []
    if len(candles) < PIVOT_LEFT + PIVOT_RIGHT + 1:
        return points
    for index in range(PIVOT_LEFT, len(candles) - PIVOT_RIGHT):
        value = candles[index].high if high else candles[index].low
        window = candles[index - PIVOT_LEFT:index + PIVOT_RIGHT + 1]
        values = [x.high if high else x.low for x in window]
        # The pivot is only visible after the right-side confirmation bars
        # have closed, so no current-bar look-ahead leaks into a level.
        if value == (max(values) if high else min(values)):
            points.append((float(value), index))
    return points


def _cluster_pivots(
    candles: list[Candle], points: list[tuple[float, int]], kind: str,
    timeframe: str, atr: float,
) -> list[Level]:
    if not points:
        return []
    current = candles[-1].close if candles else 0.0
    tolerance = max(atr * LEVEL_TOLERANCE_ATR, abs(current) * LEVEL_TOLERANCE_PCT, 1e-9)
    clusters: list[list[tuple[float, int]]] = []
    for price, index in sorted(points, key=lambda x: x[0]):
        if not clusters or abs(price - sum(x[0] for x in clusters[-1]) / len(clusters[-1])) > tolerance:
            clusters.append([(price, index)])
        else:
            clusters[-1].append((price, index))

    levels: list[Level] = []
    for cluster in clusters:
        # Recent/repeated wick prints get a small recency preference without
        # making one fresh touch stronger than a genuine multi-touch overlap.
        price = sum(item[0] for item in cluster) / len(cluster)
        last_index = max(item[1] for item in cluster)
        wick_overlap = 0
        for candle in candles:
            if kind == "support":
                if abs(candle.low - price) <= tolerance:
                    wick_overlap += 1
            elif abs(candle.high - price) <= tolerance:
                wick_overlap += 1
        touches = len(cluster)
        strength = (
            FRAME_WEIGHT.get(timeframe, 1.0)
            + min(3.0, touches * 1.25)
            + min(2.0, max(0, wick_overlap - touches) * 0.25)
        )
        levels.append(Level(
            price=price,
            kind=kind,
            timeframe=timeframe,
            touches=touches,
            wick_overlap=wick_overlap,
            strength=min(7.0, strength),
            last_index=last_index,
            timeframes=[timeframe],
        ))
    # The line nearest the current auction is more useful than an old remote
    # line when strength is otherwise similar.
    levels.sort(key=lambda level: (
        -level.strength,
        abs(level.price - current),
        -level.last_index,
    ))
    return levels


def _structure_bias(candles: list[Candle], fast: Optional[float], slow: Optional[float]) -> str:
    if fast is None or slow is None:
        return "NEUTRAL"
    bias = "BULLISH" if fast > slow else "BEARISH" if fast < slow else "NEUTRAL"
    highs = _pivots(candles, True)
    lows = _pivots(candles, False)
    if len(highs) >= 2 and len(lows) >= 2:
        higher_structure = highs[-1][0] > highs[-2][0] and lows[-1][0] > lows[-2][0]
        lower_structure = highs[-1][0] < highs[-2][0] and lows[-1][0] < lows[-2][0]
        if higher_structure:
            return "BULLISH"
        if lower_structure:
            return "BEARISH"
    return bias


def analyze_timeframe(candles: list[Candle], timeframe: str) -> TimeframeRead:
    closed = _closed(candles)
    read = TimeframeRead(timeframe=timeframe, bars=len(closed))
    if not closed:
        return read
    read.close = float(closed[-1].close)
    read.atr = atr_value(closed)
    closes = [float(x.close) for x in closed]
    fast = ema_last(closes, FAST_LENGTH)
    slow = ema_last(closes, SLOW_LENGTH)
    read.bias = _structure_bias(closed, fast, slow)
    read.ready = len(closed) >= max(SLOW_LENGTH, PIVOT_LEFT + PIVOT_RIGHT + 1)
    window = closed[-LEVEL_LOOKBACK:]
    window_atr = atr_value(window) or read.atr
    supports = _cluster_pivots(window, _pivots(window, False), "support", timeframe, window_atr)
    resistances = _cluster_pivots(window, _pivots(window, True), "resistance", timeframe, window_atr)
    # Keep a useful set of nearby lines per frame. The full multi-timeframe
    # stack is aggregated by the engine below.
    read.supports = supports[:12]
    read.resistances = resistances[:12]
    read.red_line = read.supports[0] if read.supports else None
    read.blue_line = read.resistances[0] if read.resistances else None
    return read


def timeframe_bias(candles: list[Candle], fast_length: int = FAST_LENGTH,
                   slow_length: int = SLOW_LENGTH) -> dict:
    """Compatibility helper used by Dwella's context dashboard."""
    closed = _closed(candles)
    result = analyze_timeframe(candles, "context")
    # Preserve the previous helper's configurable EMA lengths for callers that
    # use it directly in tests or diagnostics.
    closes = [float(x.close) for x in closed]
    fast = ema_last(closes, fast_length)
    slow = ema_last(closes, slow_length)
    if fast is None or slow is None:
        result.bias = "NEUTRAL"
        result.ready = False
    else:
        result.bias = "BULLISH" if fast > slow else "BEARISH" if fast < slow else "NEUTRAL"
        result.ready = True
    data = result.to_dict()
    data["fast"] = round(float(fast), 8) if fast is not None else None
    data["slow"] = round(float(slow), 8) if slow is not None else None
    return data


def _aggregate_levels(reads: dict[str, TimeframeRead], kind: str,
                      atr: float, current: float) -> list[Level]:
    source: list[Level] = []
    for read in reads.values():
        source.extend(read.supports if kind == "support" else read.resistances)
    if not source:
        return []
    tolerance = max(atr * LEVEL_TOLERANCE_ATR, abs(current) * LEVEL_TOLERANCE_PCT, 1e-9)
    clusters: list[list[Level]] = []
    for level in sorted(source, key=lambda x: x.price):
        if not clusters or abs(level.price - sum(x.price for x in clusters[-1]) / len(clusters[-1])) > tolerance:
            clusters.append([level])
        else:
            clusters[-1].append(level)
    out: list[Level] = []
    for cluster in clusters:
        weight = sum(max(0.25, FRAME_WEIGHT.get(x.timeframe, 1.0)) for x in cluster)
        price = sum(x.price * max(0.25, FRAME_WEIGHT.get(x.timeframe, 1.0)) for x in cluster) / weight
        frames = sorted({x.timeframe for x in cluster}, key=lambda x: FRAME_WEIGHT.get(x, 1.0))
        out.append(Level(
            price=price,
            kind=kind,
            timeframe="stack",
            touches=sum(x.touches for x in cluster),
            wick_overlap=sum(x.wick_overlap for x in cluster),
            strength=min(7.0, sum(x.strength for x in cluster)),
            last_index=max(x.last_index for x in cluster),
            timeframes=frames,
        ))
    out.sort(key=lambda x: (-x.strength, abs(x.price - current), -x.last_index))
    return out


def _nearest_support(levels: list[Level], price: float, atr: float) -> Optional[Level]:
    eligible = [x for x in levels if x.price <= price + atr * 0.5]
    return max(eligible, key=lambda x: (x.price, x.strength)) if eligible else None


def _nearest_resistance(levels: list[Level], price: float, atr: float) -> Optional[Level]:
    eligible = [x for x in levels if x.price >= price - atr * 0.5]
    return min(eligible, key=lambda x: (x.price, -x.strength)) if eligible else None


def _next_resistance(levels: list[Level], price: float) -> Optional[Level]:
    eligible = [x for x in levels if x.price > price]
    return min(eligible, key=lambda x: x.price) if eligible else None


def _next_support(levels: list[Level], price: float) -> Optional[Level]:
    eligible = [x for x in levels if x.price < price]
    return max(eligible, key=lambda x: x.price) if eligible else None


def _level_tolerance(level: Level, atr: float, price: float) -> float:
    return max(atr * LEVEL_TOLERANCE_ATR, abs(price) * LEVEL_TOLERANCE_PCT, 1e-9)


def _seven_score(level: Level, aligned_frames: list[str], reclaim: bool,
                 room: bool) -> dict:
    """Return the transparent three-part 777 diagnostic.

    The lesson's 777 idea is kept as a confluence label, not a mysterious
    fixed price. Each leg is capped at seven: wick/level evidence, timeframe
    stack evidence, and reclaim/room confirmation.
    """
    level_score = min(7, int(round(
        min(3.0, level.touches * 1.25)
        + min(2.0, max(0, level.wick_overlap - level.touches) * 0.25)
        + min(2.0, len(level.timeframes) * 0.75)
    )))
    stack_score = min(7, int(round(sum(FRAME_WEIGHT.get(tf, 1.0) for tf in aligned_frames))))
    reclaim_score = 7 if reclaim and room else 5 if reclaim else 0
    return {
        "level": level_score,
        "stack": stack_score,
        "reclaim": reclaim_score,
        "label": f"{level_score}{stack_score}{reclaim_score}",
        "ready": bool(reclaim and room and level_score >= 3 and stack_score >= 3),
    }


class InvestingMastery777Engine:
    """Confirmed-bar multi-timeframe implementation of the playlist rules."""

    def __init__(self, symbol: str = ""):
        self.symbol = symbol
        self.last_bar_time = 0
        self.last_price = 0.0
        self.last_atr = 0.0
        self.last_signal_side = 0
        self.last_signal_pattern = ""
        self.last_signal: Optional[Signal] = None
        self.last_candidate: dict = {}
        self.last_timeframes: dict[str, dict] = {}
        self.last_gate = "WAITING_FOR_CLOSED_BARS"
        self.last_higher_conflict = False
        self._last_signal_key = ""
        self._last_signal_index: Optional[int] = None
        self._last_confirmed_bar_time = 0

    def _read_ladder(self, trigger: list[Candle], timeframe_candles: Optional[dict[str, list[Candle]]]) -> tuple[dict[str, TimeframeRead], list[Candle]]:
        rows = {str(k).upper(): list(v) for k, v in (timeframe_candles or {}).items() if v}
        rows.setdefault(TRIGGER_TIMEFRAME, list(trigger))
        # Also keep a chart-timeframe alias when an older caller passes only a
        # trigger series; it is diagnostic, never a second signal source.
        reads: dict[str, TimeframeRead] = {}
        for tf, series in rows.items():
            reads[tf] = analyze_timeframe(series, tf)
        trigger_rows = rows.get(TRIGGER_TIMEFRAME, trigger)
        return reads, trigger_rows

    def process_candles(self, candles: list[Candle],
                        timeframe_candles: Optional[dict[str, list[Candle]]] = None,
                        htf_candles: Optional[list[Candle]] = None) -> Optional[Signal]:
        """Evaluate one trigger bar using every supplied native timeframe."""
        if len(candles) < 3:
            self.last_gate = "WAITING_FOR_CLOSED_BARS"
            return None
        ladder = dict(timeframe_candles or {})
        if htf_candles and "60" not in ladder:
            ladder["60"] = htf_candles
        reads, trigger_rows = self._read_ladder(candles, ladder)
        closed_trigger = _closed(trigger_rows)
        if not closed_trigger:
            self.last_gate = "WAITING_FOR_CLOSED_BARS"
            return None
        bar = closed_trigger[-1]
        bar_time = int(bar.time)
        self._last_confirmed_bar_time = bar_time
        self.last_price = float(bar.close)
        self.last_atr = atr_value(closed_trigger)
        self.last_timeframes = {tf: read.to_dict() for tf, read in reads.items()}
        if bar_time <= self.last_bar_time:
            self.last_gate = "BAR_ALREADY_EVALUATED"
            return None
        self.last_bar_time = bar_time

        ready_higher = [tf for tf in HIGHER_TIMEFRAMES if tf in reads and reads[tf].ready]
        bull_frames = [tf for tf in ready_higher if reads[tf].bias == "BULLISH"]
        bear_frames = [tf for tf in ready_higher if reads[tf].bias == "BEARISH"]
        self.last_higher_conflict = bool(bull_frames and bear_frames)
        aggregate_atr = self.last_atr or max((reads[tf].atr for tf in reads), default=0.0)
        supports = _aggregate_levels(reads, "support", aggregate_atr, bar.close)
        resistances = _aggregate_levels(reads, "resistance", aggregate_atr, bar.close)
        support = _nearest_support(supports, bar.close, aggregate_atr)
        resistance = _nearest_resistance(resistances, bar.close, aggregate_atr)
        self.last_candidate = {
            "red_line": support.to_dict() if support else None,
            "blue_line": resistance.to_dict() if resistance else None,
            "supports": [x.to_dict() for x in supports[:8]],
            "resistances": [x.to_dict() for x in resistances[:8]],
        }

        if len(ready_higher) < MIN_HIGHER_FRAMES:
            self.last_gate = "WAITING_FOR_HIGHER_TIMEFRAMES"
            return None
        if self.last_higher_conflict:
            self.last_gate = "HIGHER_TIMEFRAME_CONFLICT"
            return None
        context_direction = "long" if bull_frames else "short" if bear_frames else ""
        if not context_direction:
            self.last_gate = "WAITING_FOR_DIRECTION"
            return None
        if aggregate_atr <= 0:
            self.last_gate = "WAITING_FOR_ATR"
            return None

        tolerance_support = _level_tolerance(support, aggregate_atr, bar.close) if support else aggregate_atr * LEVEL_TOLERANCE_ATR
        tolerance_resistance = _level_tolerance(resistance, aggregate_atr, bar.close) if resistance else aggregate_atr * LEVEL_TOLERANCE_ATR
        reclaim_buffer = aggregate_atr * RECLAIM_BUFFER_ATR
        long_touch = bool(support and bar.low <= support.price + tolerance_support)
        short_touch = bool(resistance and bar.high >= resistance.price - tolerance_resistance)
        long_reclaim = bool(long_touch and bar.close > support.price + reclaim_buffer) if support else False
        short_reclaim = bool(short_touch and bar.close < resistance.price - reclaim_buffer) if resistance else False

        # Keep the watch-state diagnostics useful even before a signal exists.
        # A trader should be able to see the level/stack evidence that is
        # building, not only the final 777 label after every gate passes.
        diagnostic_direction = (
            "long" if bull_frames and not bear_frames
            else "short" if bear_frames and not bull_frames
            else ""
        )
        diagnostic_level = (
            support if diagnostic_direction == "long"
            else resistance if diagnostic_direction == "short"
            else None
        )
        diagnostic_reclaim = (
            long_reclaim if diagnostic_direction == "long"
            else short_reclaim if diagnostic_direction == "short"
            else False
        )
        diagnostic_room = bool(
            diagnostic_level and (
                _next_resistance(resistances, bar.close)
                if diagnostic_direction == "long"
                else _next_support(supports, bar.close)
            )
        )
        if diagnostic_level:
            diagnostic_seven = _seven_score(
                diagnostic_level,
                bull_frames if diagnostic_direction == "long" else bear_frames,
                diagnostic_reclaim,
                diagnostic_room,
            )
            self.last_candidate.update({
                "direction": diagnostic_direction,
                "seven_score": diagnostic_seven,
                "bean_count": min(7, int(
                    diagnostic_level.touches
                    + len(diagnostic_level.timeframes)
                    + len(bull_frames if diagnostic_direction == "long" else bear_frames)
                )),
                "alignment_count": len(bull_frames if diagnostic_direction == "long" else bear_frames),
                "timeframes_checked": len(ready_higher),
            })
        else:
            self.last_candidate.update({
                "direction": "",
                "seven_score": {"level": 0, "stack": 0, "reclaim": 0, "label": "000", "ready": False},
                "bean_count": 0,
                "alignment_count": 0,
                "timeframes_checked": len(ready_higher),
            })

        direction = context_direction
        reclaim = long_reclaim if direction == "long" else short_reclaim
        active_level = support if direction == "long" else resistance
        if not active_level or not reclaim:
            self.last_gate = "WAITING_FOR_RECLAIM_CLOSE"
            return None

        target_level = _next_resistance(resistances, bar.close) if direction == "long" else _next_support(supports, bar.close)
        if direction == "long":
            stop = min(active_level.price, bar.low) - max(aggregate_atr * 0.20, tolerance_support * 0.25)
            risk = bar.close - stop
            target2 = target_level.price if target_level and target_level.price > bar.close else bar.close + risk * 2.0
            if target2 <= bar.close:
                self.last_gate = "WAITING_FOR_ROOM"
                return None
            target = bar.close + (target2 - bar.close) * 0.5
            rr_value = (target2 - bar.close) / risk if risk > 0 else 0.0
        else:
            stop = max(active_level.price, bar.high) + max(aggregate_atr * 0.20, tolerance_resistance * 0.25)
            risk = stop - bar.close
            target2 = target_level.price if target_level and target_level.price < bar.close else bar.close - risk * 2.0
            if target2 >= bar.close:
                self.last_gate = "WAITING_FOR_ROOM"
                return None
            target = bar.close - (bar.close - target2) * 0.5
            rr_value = (bar.close - target2) / risk if risk > 0 else 0.0
        if risk <= 0 or rr_value < MIN_RR:
            self.last_gate = "WAITING_FOR_RR"
            return None

        aligned_frames = bull_frames if direction == "long" else bear_frames
        seven = _seven_score(active_level, aligned_frames, reclaim, True)
        if not seven["ready"]:
            self.last_gate = "WAITING_FOR_777_CONFLUENCE"
            return None
        key = f"{self.symbol}:{direction}:{bar_time}:{active_level.kind}:{active_level.price:.8f}"
        if key == self._last_signal_key:
            self.last_gate = "SIGNAL_ALREADY_EMITTED"
            return None
        if self._last_signal_index is not None and bar_time <= self._last_signal_index:
            self.last_gate = "SIGNAL_COOLDOWN"
            return None

        bean_count = min(7, int(active_level.touches + len(active_level.timeframes) + len(aligned_frames)))
        quality = round((seven["level"] + seven["stack"] + seven["reclaim"]) / 21.0 * 100.0, 1)
        pattern = "777 Bull Reclaim" if direction == "long" else "777 Bear Reclaim"
        signal = Signal(
            strategy=STRATEGY_NAME,
            symbol=self.symbol,
            direction=direction,
            entry=float(bar.close),
            stop=float(stop),
            target=float(target),
            target2=float(target2),
            target3=float(target2),
            atr=float(aggregate_atr),
            confirmed=True,
            bar_time=bar_time,
            setup_key=key,
            pattern=pattern,
            framework="Red/Blue Wick Stack · Reclaim Close",
            area=(f"Red support {active_level.price:.4f}" if direction == "long" else f"Blue resistance {active_level.price:.4f}"),
            completion=quality,
            confluence=min(10, int(round((seven["level"] + seven["stack"]) / 2.0))),
            bean_count=bean_count,
            timeframe_alignment=self.last_timeframes,
            alignment_count=len(aligned_frames),
            timeframes_checked=len(ready_higher),
            seven_score=seven,
        )
        self.last_signal = signal
        self.last_signal_side = 1 if direction == "long" else -1
        self.last_signal_pattern = pattern
        self._last_signal_key = key
        self._last_signal_index = bar_time
        self.last_gate = "SIGNAL_CONFIRMED"
        return signal

    def process_candle(self, candles: list[Candle],
                       timeframe_candles: Optional[dict[str, list[Candle]]] = None) -> Optional[Signal]:
        return self.process_candles(candles, timeframe_candles=timeframe_candles)

    def get_dashboard(self) -> dict:
        signal = self.last_signal
        candidate = self.last_candidate
        return {
            "strategy": STRATEGY_NAME,
            "framework": f"{PLAYLIST_NAME} · 777",
            "playlist": PLAYLIST_NAME,
            "playlist_url": PLAYLIST_URL,
            "trigger_timeframe": TRIGGER_TIMEFRAME,
            "phase": "SIGNAL" if signal else "WATCHING",
            "gate": self.last_gate,
            "pattern": self.last_signal_pattern or "NONE",
            "last_signal": "LONG" if self.last_signal_side == 1 else "SHORT" if self.last_signal_side == -1 else "NONE",
            "entry": round(signal.entry, 8) if signal else None,
            "stop": round(signal.stop, 8) if signal else None,
            "tp1": round(signal.target, 8) if signal else None,
            "tp2": round(signal.target2, 8) if signal else None,
            "red_line": candidate.get("red_line"),
            "blue_line": candidate.get("blue_line"),
            "support": candidate.get("red_line"),
            "resistance": candidate.get("blue_line"),
            "bean_count": signal.bean_count if signal else candidate.get("bean_count", 0),
            "quality": signal.completion if signal else 0,
            "confluence": signal.confluence if signal else candidate.get("seven_score", {}).get("stack", 0),
            "alignment_count": signal.alignment_count if signal else candidate.get("alignment_count", 0),
            "seven_score": signal.seven_score if signal else candidate.get("seven_score", {"level": 0, "stack": 0, "reclaim": 0, "label": "000", "ready": False}),
            "higher_timeframe_conflict": self.last_higher_conflict,
            "timeframes": self.last_timeframes,
            "timeframes_checked": signal.timeframes_checked if signal else candidate.get("timeframes_checked", sum(1 for x in self.last_timeframes.values() if x.get("ready"))),
            "params": {
                "level_rule": "wick overlap / repeated swing prints",
                "entry_rule": "reclaim close; never instant touch",
                "higher_timeframes_first": True,
                "min_higher_timeframes": MIN_HIGHER_FRAMES,
                "min_rr": MIN_RR,
                "score": "777 = level / stack / reclaim, each 0–7",
            },
        }


# Clear public compatibility names for callers migrating from the old scanner
# interface. The active scanner imports InvestingMastery777Engine directly.
PullbackSniperEngine = InvestingMastery777Engine
