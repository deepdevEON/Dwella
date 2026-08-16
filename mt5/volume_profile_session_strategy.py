#!/usr/bin/env python3
"""Research-only Session Volume Rotation (SVR) strategy.

SVR is deliberately separate from Dwella's live scanner.  It combines the
UTC session map (Asia 00–08, London 08–16, New York 13–21) with
volume-at-price profiles built from OHLCV candles:

* Asia/London profile migration supplies directional context.
* NY can fade a failed sweep of a prior session extreme after price is
  accepted back inside that session's value area.
* NY can continue a profile displacement after two closes outside the
  Asia+London composite value area with expanding volume.

This is a hypothesis for research, not a claim of novelty or profitability.
It uses only completed bars and never has access to future bars while making a
signal.  It is not imported by scanner_pullback.py and cannot place orders.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from statistics import median
from typing import Iterable, Optional

UTC = timezone.utc
ASIA = (0, 8)
LONDON = (8, 16)
NEW_YORK = (13, 21)


@dataclass(frozen=True)
class Bar:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class Profile:
    low: float
    high: float
    poc: float
    vah: float
    val: float
    total_volume: float
    buckets: tuple[tuple[float, float], ...]


@dataclass(frozen=True)
class Trade:
    day: str
    direction: str
    setup: str
    entry_time: int
    entry: float
    stop: float
    target: float
    exit_time: int
    exit_price: float
    result_r: float
    pnl_points: float
    bars_held: int
    reason: str


def _hour(timestamp: int) -> int:
    return datetime.fromtimestamp(timestamp, UTC).hour


def _day(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, UTC).date().isoformat()


def _in_session(timestamp: int, session: tuple[int, int]) -> bool:
    hour = datetime.fromtimestamp(timestamp, UTC).hour
    return session[0] <= hour < session[1]


def resample_bars(rows: Iterable[dict], seconds: int = 180) -> list[Bar]:
    """Aggregate lower-timeframe rows into completed fixed UTC bars.

    The source rows may contain a partial final bucket.  The caller's
    backtest excludes the final resulting bar to preserve closed-bar behavior.
    """
    ordered = sorted(
        (Bar(int(r["t"]), float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"]), float(r.get("v", 0))) for r in rows),
        key=lambda b: b.time,
    )
    grouped: dict[int, list[Bar]] = {}
    for bar in ordered:
        grouped.setdefault((bar.time // seconds) * seconds, []).append(bar)
    out: list[Bar] = []
    for bucket, items in sorted(grouped.items()):
        if not items:
            continue
        out.append(Bar(
            time=bucket,
            open=items[0].open,
            high=max(x.high for x in items),
            low=min(x.low for x in items),
            close=items[-1].close,
            volume=sum(x.volume for x in items),
        ))
    return out


def build_profile(bars: Iterable[Bar], bins: int = 24) -> Optional[Profile]:
    """Build a volume-at-price profile using each bar's typical price.

    OHLCV feeds do not expose aggressor-side volume.  Assigning volume to the
    typical price is explicit and conservative; it avoids pretending that a
    bid/ask delta is available.
    """
    source = list(bars)
    if not source:
        return None
    low = min(x.low for x in source)
    high = max(x.high for x in source)
    step = (high - low) / max(1, bins)
    if step <= 0:
        step = 1e-9
    volumes = [0.0] * (bins + 1)
    for bar in source:
        typical = (bar.high + bar.low + bar.close) / 3.0
        idx = min(bins, max(0, int((typical - low) / step)))
        volumes[idx] += max(0.0, bar.volume)
    max_index = max(range(len(volumes)), key=lambda i: volumes[i])
    poc = low + (max_index + 0.5) * step
    total = sum(volumes)
    target = total * 0.70
    lo_i = hi_i = max_index
    acc = volumes[max_index]
    while acc < target and (lo_i > 0 or hi_i < bins):
        left = volumes[lo_i - 1] if lo_i > 0 else -1.0
        right = volumes[hi_i + 1] if hi_i < bins else -1.0
        if right >= left and hi_i < bins:
            hi_i += 1
            acc += volumes[hi_i]
        elif lo_i > 0:
            lo_i -= 1
            acc += volumes[lo_i]
        else:
            break
    bucket_rows = tuple((low + (i + 0.5) * step, v) for i, v in enumerate(volumes))
    return Profile(
        low=low,
        high=high,
        poc=poc,
        vah=low + (hi_i + 1) * step,
        val=low + lo_i * step,
        total_volume=total,
        buckets=bucket_rows,
    )


def _atr(bars: list[Bar], index: int, length: int = 14) -> float:
    if index < 1:
        return 0.0
    start = max(1, index - length + 1)
    values = []
    for i in range(start, index + 1):
        prev = bars[i - 1].close
        values.append(max(bars[i].high - bars[i].low, abs(bars[i].high - prev), abs(bars[i].low - prev)))
    return sum(values) / len(values) if values else 0.0


def _median_volume(bars: list[Bar], index: int, length: int = 20) -> float:
    values = [x.volume for x in bars[max(0, index - length):index] if x.volume > 0]
    return median(values) if values else 0.0


def _session_stats(day_bars: list[Bar], session: tuple[int, int]) -> tuple[list[Bar], Optional[Profile], Optional[float], Optional[float]]:
    selected = [b for b in day_bars if _in_session(b.time, session)]
    profile = build_profile(selected)
    if not selected:
        return selected, profile, None, None
    return selected, profile, max(b.high for b in selected), min(b.low for b in selected)


def _same_side(a: float, b: float, direction: int, tolerance: float) -> bool:
    return (a >= b - tolerance) if direction > 0 else (a <= b + tolerance)


def backtest_day(bars: list[Bar], *, tick_size: float = 0.25, reward_r: float = 1.5, one_trade_per_day: bool = True) -> list[Trade]:
    """Backtest one UTC day using only prior/completed bars for each decision."""
    if len(bars) < 30:
        return []
    day = _day(bars[0].time)
    asia, asia_profile, asia_high, asia_low = _session_stats(bars, ASIA)
    london, london_profile, london_high, london_low = _session_stats(bars, LONDON)
    ny = [b for b in bars if _in_session(b.time, NEW_YORK)]
    if not asia or not london or not ny or not asia_profile or not london_profile:
        return []
    composite = build_profile(asia + london)
    if not composite:
        return []
    migration = london_profile.poc - asia_profile.poc
    migration_threshold = max(tick_size * 4, (asia_profile.high - asia_profile.low) * 0.08)
    context = 1 if migration > migration_threshold and london[-1].close >= london_profile.poc else -1 if migration < -migration_threshold and london[-1].close <= london_profile.poc else 0
    trades: list[Trade] = []
    # The first 30 NY minutes establish an opening range; entries begin only
    # after it, so the opening range itself cannot be used as future knowledge.
    ny_open = ny[0].time
    opening = [b for b in ny if b.time < ny_open + 30 * 60]
    if len(opening) < 3:
        return []
    opening_high = max(b.high for b in opening)
    opening_low = min(b.low for b in opening)
    last_signal_index = -1000
    for i, bar in enumerate(bars):
        if bar.time < ny_open + 30 * 60 or not _in_session(bar.time, NEW_YORK):
            continue
        if one_trade_per_day and trades:
            break
        if i < 2:
            continue
        atr = _atr(bars, i)
        if atr <= tick_size * 2:
            continue
        median_vol = _median_volume(bars, i)
        volume_expanding = median_vol > 0 and bar.volume >= median_vol * 1.15
        prev = bars[i - 1]
        direction: Optional[int] = None
        setup = ""
        swept_extreme: Optional[float] = None
        # Failed auction: a NY bar trades beyond a completed Asia/London
        # extreme and closes back inside that level and the corresponding VA.
        if asia_high is not None and bar.high > asia_high and bar.close < asia_high and bar.close <= asia_profile.vah:
            direction, setup, swept_extreme = -1, "NY_FADE_ASIA_HIGH", bar.high
        elif asia_low is not None and bar.low < asia_low and bar.close > asia_low and bar.close >= asia_profile.val:
            direction, setup, swept_extreme = 1, "NY_FADE_ASIA_LOW", bar.low
        elif london_high is not None and bar.high > london_high and bar.close < london_high and bar.close <= london_profile.vah:
            direction, setup, swept_extreme = -1, "NY_FADE_LONDON_HIGH", bar.high
        elif london_low is not None and bar.low < london_low and bar.close > london_low and bar.close >= london_profile.val:
            direction, setup, swept_extreme = 1, "NY_FADE_LONDON_LOW", bar.low
        # Profile displacement: two confirmed closes outside composite value,
        # the second with volume expansion and migration alignment.
        elif context and volume_expanding and _same_side(prev.close, composite.vah if context > 0 else composite.val, context, tick_size * 0.5) and _same_side(bar.close, composite.vah if context > 0 else composite.val, context, tick_size * 0.5):
            if context > 0 and bar.close > composite.vah and bar.close > opening_high:
                direction, setup = 1, "NY_CONTINUE_VALUE_HIGH"
            elif context < 0 and bar.close < composite.val and bar.close < opening_low:
                direction, setup = -1, "NY_CONTINUE_VALUE_LOW"
        if not direction or i <= last_signal_index:
            continue
        entry = bar.close
        if setup.startswith("NY_FADE") and swept_extreme is not None:
            stop = swept_extreme + tick_size if direction < 0 else swept_extreme - tick_size
        else:
            stop = min(bar.low, prev.low) - tick_size if direction > 0 else max(bar.high, prev.high) + tick_size
        risk = abs(entry - stop)
        if risk <= tick_size or risk > atr * 2.5:
            continue
        target = entry + direction * risk * reward_r
        exit_time = exit_price = 0.0
        reason = "TIME_EXIT"
        bars_held = 0
        for future in bars[i + 1:]:
            if not _in_session(future.time, NEW_YORK):
                continue
            bars_held += 1
            stop_hit = future.low <= stop if direction > 0 else future.high >= stop
            target_hit = future.high >= target if direction > 0 else future.low <= target
            # Conservative same-bar handling: stop wins if both are touched.
            if stop_hit:
                exit_time, exit_price, reason = future.time, stop, "STOP"
                break
            if target_hit:
                exit_time, exit_price, reason = future.time, target, "TARGET"
                break
        if not exit_time:
            final = ny[-1]
            exit_time, exit_price = final.time, final.close
        pnl_points = direction * (exit_price - entry)
        result_r = pnl_points / risk if risk else 0.0
        trades.append(Trade(day, "LONG" if direction > 0 else "SHORT", setup, bar.time, entry, stop, target, int(exit_time), exit_price, result_r, pnl_points, bars_held, reason))
        last_signal_index = i
    return trades


def backtest_month(rows: list[dict], *, tick_size: float = 0.25, reward_r: float = 1.5) -> dict:
    bars = resample_bars(rows)
    grouped: dict[str, list[Bar]] = {}
    for bar in bars:
        grouped.setdefault(_day(bar.time), []).append(bar)
    all_trades: list[Trade] = []
    daily = []
    for day in sorted(grouped):
        trades = backtest_day(grouped[day], tick_size=tick_size, reward_r=reward_r)
        all_trades.extend(trades)
        pnl = sum(t.result_r for t in trades)
        daily.append({"date": day, "trades": len(trades), "wins": sum(t.result_r > 0 for t in trades), "losses": sum(t.result_r <= 0 for t in trades), "r": round(pnl, 4)})
    wins = [t for t in all_trades if t.result_r > 0]
    losses = [t for t in all_trades if t.result_r <= 0]
    equity = 0.0
    peak = 0.0
    max_drawdown = 0.0
    for t in all_trades:
        equity += t.result_r
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
    return {
        "days": daily,
        "trades": [t.__dict__ for t in all_trades],
        "total_days": len(daily),
        "trading_days": sum(x["trades"] > 0 for x in daily),
        "total_trades": len(all_trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / len(all_trades), 4) if all_trades else 0.0,
        "total_r": round(sum(t.result_r for t in all_trades), 4),
        "avg_r": round(sum(t.result_r for t in all_trades) / len(all_trades), 4) if all_trades else 0.0,
        "max_drawdown_r": round(max_drawdown, 4),
        "profit_factor": round(sum(t.result_r for t in wins) / abs(sum(t.result_r for t in losses)), 4) if losses and sum(t.result_r for t in losses) else None,
    }
