#!/usr/bin/env python3
"""Walk-forward research harness for BOB's Investing Mastery 777 method.

This is deliberately separate from the older broad course approximation.  It
uses the existing confirmed-bar 777 engine and tests the observable rules:

* red/blue wick-derived levels;
* reclaim close instead of instant-touch entry;
* native higher-timeframe context, with conflict = wait;
* farther target / risk-reward gate;
* optional US cash-hours and long-only hypotheses.

Important research controls:

* M3 is aggregated from the pulled MT5 M1 candles because this terminal export
  does not contain a native M3 file.  M5/M15/H1/D1 are native exports; H4 is
  causally aggregated from H1.
* At every M3 close, each context timeframe is sliced using only bars that
  were already closed by that timestamp.  A forming bar is appended only so
  the engine's live-bar guard can remove it.
* Entries fill at the confirmed M3 close.  Ambiguous bars (both stop and target
  touched) are resolved stop-first, conservatively.
* The research reports full-target and 50/50 partial-target accounting.  The
  partial result explicitly credits TP1; it is not the scale-out bug in the
  legacy backtester.

Usage (from this directory):
    python3 backtest_investing_mastery_777.py
    python3 backtest_investing_mastery_777.py --symbols MNQ MES --quick

Educational research only; not financial advice.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Iterable, Optional
from zoneinfo import ZoneInfo

from investing_mastery_777_strategy import Candle, InvestingMastery777Engine

ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT / "tradingview-mcp" / "data"
LEARNING_DIR = ROOT / "tradingview-mcp" / "learning"
MEMORY_PATH = LEARNING_DIR / "im_777_reasoningbank_memory.json"
REPORT_PATH = LEARNING_DIR / "IM_777_RESEARCH_REPORT.md"
INSTINCT_DIR = LEARNING_DIR / "instincts"
RUN_DIR = LEARNING_DIR / "im_777_runs"
NY = ZoneInfo("America/New_York")

TF_SECONDS = {"3": 180, "5": 300, "15": 900, "60": 3600, "240": 14400, "D": 86400}


@dataclass
class Position:
    direction: str
    entry_index: int
    entry_time: int
    entry: float
    stop: float
    target1: float
    target2: float
    risk: float
    partial: bool = False
    realized_r: float = 0.0
    score: str = "000"


@dataclass
class ClosedTrade:
    direction: str
    entry_index: int
    exit_index: int
    entry_time: int
    exit_time: int
    entry: float
    stop: float
    target1: float
    target2: float
    exit: float
    result: str
    r: float
    duration_bars: int
    session: str
    ambiguous: bool
    score: str


@dataclass
class Variant:
    name: str
    rule: str
    session: str = "all"
    directions: str = "both"
    min_alignment: int = 2
    min_level_score: int = 3
    min_rr: float = 1.5
    exit_mode: str = "full_target2"
    max_entries_per_day: Optional[int] = None


VARIANTS = [
    Variant("777_baseline", "native stack + reclaim + 1.5R", min_rr=1.5),
    Variant("777_us_cash", "baseline + 09:30-16:00 New York", session="us_cash"),
    Variant("777_us_cash_long", "US cash + long-only", session="us_cash", directions="long"),
    Variant("777_strict_grain", "US cash + long-only + 3 aligned HTFs + 2R", session="us_cash", directions="long", min_alignment=3, min_rr=2.0),
    Variant("777_strict_partial", "strict grain + 50/50 TP1/TP2", session="us_cash", directions="long", min_alignment=3, min_rr=2.0, exit_mode="half_tp1_half_tp2"),
    Variant("777_one_per_day", "US cash + long-only + max one entry per NY day", session="us_cash", directions="long", max_entries_per_day=1),
    Variant("777_strict_one_per_day", "strict grain + max one entry per NY day", session="us_cash", directions="long", min_alignment=3, min_rr=2.0, max_entries_per_day=1),
    Variant("777_strict_level4", "strict grain + stronger 777 level score", session="us_cash", directions="long", min_alignment=3, min_level_score=4, min_rr=2.0),
]


def as_candles(rows: Iterable[dict]) -> list[Candle]:
    return [Candle(int(x["t"]), float(x["o"]), float(x["h"]), float(x["l"]), float(x["c"]), float(x.get("v", 0))) for x in rows]


def load_symbol(filename: str, symbol: str) -> list[Candle]:
    with open(DATA_DIR / filename) as f:
        data = json.load(f)
    if symbol not in data:
        raise KeyError(f"{symbol} is not in {filename}; available={sorted(data)}")
    return as_candles(data[symbol])


def aggregate(rows: list[Candle], seconds: int, base_seconds: int, minimum: int) -> list[Candle]:
    """Aggregate completed fixed buckets without bridging missing bars."""
    buckets: dict[int, list[Candle]] = defaultdict(list)
    for row in rows:
        buckets[(row.time // seconds) * seconds].append(row)
    out: list[Candle] = []
    for bucket, group in sorted(buckets.items()):
        group.sort(key=lambda x: x.time)
        if len(group) < minimum:
            continue
        # Do not make a synthetic bar over a data hole.  A small tolerance is
        # allowed because some MT5 feeds omit a zero-volume minute.
        if group[-1].time - group[0].time > (minimum - 1) * base_seconds + base_seconds:
            continue
        out.append(Candle(
            time=bucket,
            open=group[0].open,
            high=max(x.high for x in group),
            low=min(x.low for x in group),
            close=group[-1].close,
            volume=sum(x.volume for x in group),
        ))
    return out


def load_ladder(symbol: str) -> dict[str, list[Candle]]:
    """Build the causal native ladder used by the 777 engine."""
    m1 = load_symbol("mt5_full_m1.json", symbol)
    m5 = load_symbol("mt5_full_m5.json", symbol)
    m15 = load_symbol("mt5_full_m15.json", symbol)
    h1 = load_symbol("mt5_full_h1.json", symbol)
    d1 = load_symbol("mt5_full_d1.json", symbol)
    return {
        "3": aggregate(m1, 180, 60, 3),
        "5": m5,
        "15": m15,
        "60": h1,
        "240": aggregate(h1, 14400, 3600, 4),
        "D": d1,
    }


_ROW_TIME_CACHE: dict[int, list[int]] = {}


def causal_window(rows: list[Candle], trigger_end: int, tf_seconds: int, keep: int = 300) -> list[Candle]:
    """Return completed context bars plus one forming bar, never future data.

    The cached timestamp index keeps the walk-forward loop linear rather than
    rescanning the entire trigger history for every bar.
    """
    key = id(rows)
    starts = _ROW_TIME_CACHE.setdefault(key, [row.time for row in rows])
    completed_count = bisect_right(starts, trigger_end - tf_seconds)
    first_forming = rows[completed_count] if completed_count < len(rows) else None
    result = rows[max(0, completed_count - keep):completed_count]
    if first_forming is not None:
        result = [*result, first_forming]
    elif result:
        # The MT5 D1 snapshot ends before the latest intraday bars. Add a
        # value-identical placeholder so the engine drops the placeholder,
        # not the latest genuinely completed daily bar.
        last = result[-1]
        result = [*result, Candle(last.time + tf_seconds, last.open, last.high, last.low, last.close, last.volume)]
    return result


def session_name(timestamp: int) -> str:
    dt = datetime.fromtimestamp(timestamp, timezone.utc).astimezone(NY)
    if dt.weekday() >= 5:
        return "weekend"
    local = dt.time()
    if time(9, 30) <= local < time(16, 0):
        return "us_cash"
    if time(4, 0) <= local < time(9, 30):
        return "pre_us"
    if time(16, 0) <= local < time(20, 0):
        return "after_us"
    return "overnight"


def allowed_entry(variant: Variant, signal, bar: Candle) -> bool:
    if variant.directions == "long" and signal.direction != "long":
        return False
    if variant.directions == "short" and signal.direction != "short":
        return False
    if variant.session == "us_cash" and session_name(bar.time) != "us_cash":
        return False
    if signal.alignment_count < variant.min_alignment:
        return False
    if signal.seven_score.get("level", 0) < variant.min_level_score:
        return False
    risk = abs(signal.entry - signal.stop)
    if risk <= 0:
        return False
    planned_rr = abs(signal.target2 - signal.entry) / risk
    return planned_rr >= variant.min_rr


def finish_position(position: Position, index: int, bar: Candle, result: str, exit_price: float, ambiguous: bool, score: str) -> ClosedTrade:
    if position.direction == "long":
        raw_r = (exit_price - position.entry) / position.risk
    else:
        raw_r = (position.entry - exit_price) / position.risk
    total_r = position.realized_r + (0.5 * raw_r if position.partial else raw_r)
    return ClosedTrade(
        direction=position.direction,
        entry_index=position.entry_index,
        exit_index=index,
        entry_time=position.entry_time,
        exit_time=bar.time,
        entry=position.entry,
        stop=position.stop,
        target1=position.target1,
        target2=position.target2,
        exit=exit_price,
        result=result,
        r=total_r,
        duration_bars=index - position.entry_index,
        session=session_name(position.entry_time),
        ambiguous=ambiguous,
        score=score,
    )


def manage(position: Position, index: int, bar: Candle, exit_mode: str, score: str) -> Optional[ClosedTrade]:
    """Conservative stop-first intrabar execution with explicit TP1 credit."""
    long = position.direction == "long"
    hit_stop = bar.low <= position.stop if long else bar.high >= position.stop
    current_target = position.target2
    hit_target = bar.high >= current_target if long else bar.low <= current_target
    ambiguous = hit_stop and hit_target
    if ambiguous:
        return finish_position(position, index, bar, "SL_AMBIGUOUS", position.stop, True, score)
    if hit_stop:
        return finish_position(position, index, bar, "SL", position.stop, False, score)

    if exit_mode == "half_tp1_half_tp2" and not position.partial:
        hit_tp1 = bar.high >= position.target1 if long else bar.low <= position.target1
        if hit_tp1:
            tp1_r = abs(position.target1 - position.entry) / position.risk
            position.partial = True
            position.realized_r = 0.5 * tp1_r
            # A single bar cannot also hit the final target under this branch
            # without an ordering assumption; target2 is handled next bar.
            return None
    if hit_target:
        return finish_position(position, index, bar, "TP2", current_target, False, score)
    return None


def collect_signals(symbol: str, ladder: dict[str, list[Candle]]) -> dict[int, object]:
    """Run the expensive confirmed-bar analysis once per symbol.

    Session, direction, alignment, and RR hypotheses are applied afterward to
    this immutable signal stream. This prevents five profiles from repeating
    the same multi-timeframe calculation and keeps their comparison paired.
    """
    trigger = ladder["3"]
    signals: dict[int, object] = {}
    if len(trigger) < 500:
        return signals
    engine = InvestingMastery777Engine(symbol)
    for i in range(350, len(trigger) - 1):
        current = trigger[i]
        trigger_end = current.time + TF_SECONDS["3"]
        trigger_slice = causal_window(trigger, trigger_end, TF_SECONDS["3"])
        context = {
            tf: causal_window(rows, trigger_end, TF_SECONDS[tf])
            for tf, rows in ladder.items() if tf != "3"
        }
        signal = engine.process_candles(trigger_slice, timeframe_candles={"3": trigger_slice, **context})
        if signal is not None:
            signals[i] = signal
    return signals


def run_variant(symbol: str, ladder: dict[str, list[Candle]], variant: Variant, signals: dict[int, object]) -> list[ClosedTrade]:
    trigger = ladder["3"]
    if len(trigger) < 500:
        return []
    position: Optional[Position] = None
    trades: list[ClosedTrade] = []
    entries_by_day: dict[str, int] = defaultdict(int)
    # Signals were generated in one causal pass; only execution hypotheses are
    # varied here. The loop stops before the final bar so every signal has a
    # possible next bar.
    for i in range(350, len(trigger) - 1):
        current = trigger[i]
        exited_this_bar = False
        if position is not None and i > position.entry_index:
            closed = manage(position, i, current, variant.exit_mode, position.score)
            if closed is not None:
                trades.append(closed)
                position = None
                exited_this_bar = True

        signal = signals.get(i)
        if position is not None or exited_this_bar or signal is None:
            continue
        if not allowed_entry(variant, signal, current):
            continue
        entry_day = str(datetime.fromtimestamp(current.time, timezone.utc).astimezone(NY).date())
        if variant.max_entries_per_day is not None and entries_by_day[entry_day] >= variant.max_entries_per_day:
            continue
        entries_by_day[entry_day] += 1
        position = Position(
            direction=signal.direction,
            entry_index=i,
            entry_time=current.time,
            entry=signal.entry,
            stop=signal.stop,
            target1=signal.target,
            target2=signal.target2,
            risk=abs(signal.entry - signal.stop),
            score=signal.seven_score.get("label", "000"),
        )

    if position is not None:
        final = trigger[-1]
        trades.append(finish_position(position, len(trigger) - 1, final, "CLOSE", final.close, False, position.score))
    return trades


def trade_metrics(trades: list[ClosedTrade]) -> dict:
    r = [x.r for x in trades]
    wins = [x for x in r if x > 0]
    losses = [x for x in r if x < 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    cumulative = 0.0
    peak = 0.0
    max_dd = 0.0
    for item in r:
        cumulative += item
        peak = max(peak, cumulative)
        max_dd = max(max_dd, peak - cumulative)
    return {
        "trades": len(r),
        "wins": len(wins),
        "losses": len(losses),
        "gross_win_r": round(gross_win, 4),
        "gross_loss_r": round(gross_loss, 4),
        "net_r": round(sum(r), 4),
        "avg_r": round(statistics.mean(r), 4) if r else 0.0,
        "win_rate": round(len(wins) / len(r), 4) if r else 0.0,
        "profit_factor": round(gross_win / gross_loss, 4) if gross_loss else (999.0 if gross_win else 0.0),
        "max_dd_r": round(max_dd, 4),
        "ambiguous_bars": sum(1 for x in trades if x.ambiguous),
        "avg_duration_bars": round(statistics.mean(x.duration_bars for x in trades), 2) if trades else 0.0,
        "sessions": {k: sum(1 for x in trades if x.session == k) for k in sorted({x.session for x in trades})},
    }


def window_metrics(trades: list[ClosedTrade], trigger: list[Candle], windows: int = 4) -> list[dict]:
    if not trigger:
        return []
    n = len(trigger)
    out = []
    for window in range(windows):
        lo = window * n // windows
        hi = (window + 1) * n // windows
        subset = [x for x in trades if lo <= x.entry_index < hi]
        m = trade_metrics(subset)
        m["window"] = f"W{window + 1}"
        m["bar_start"] = lo
        m["bar_end"] = hi
        out.append(m)
    return out


def memory_experience(symbol: str, variant: Variant, metrics: dict, windows: list[dict], data_note: str) -> dict:
    return {
        "task": "investing_mastery_777_mt5_walkforward",
        "symbol": symbol,
        "timeframe": "M3_aggregated_from_M1",
        "data_source": data_note,
        "approach": {
            "name": variant.name,
            "family": "investing_mastery_777",
            "rule": variant.rule,
            "session": variant.session,
            "directions": variant.directions,
            "min_alignment": variant.min_alignment,
            "min_level_score": variant.min_level_score,
            "min_rr": variant.min_rr,
            "exit_mode": variant.exit_mode,
            "max_entries_per_day": variant.max_entries_per_day,
        },
        "validation": metrics,
        "walk_forward_windows": windows,
        "score": metrics["avg_r"] * math.sqrt(min(metrics["trades"], 30) / 30.0) if metrics["trades"] else 0.0,
    }


def write_memory(experiences: list[dict]) -> None:
    LEARNING_DIR.mkdir(parents=True, exist_ok=True)
    existing: list[dict] = []
    if MEMORY_PATH.exists():
        try:
            existing = json.loads(MEMORY_PATH.read_text()).get("experiences", [])
        except (OSError, ValueError):
            existing = []
    def key(e: dict) -> tuple:
        return (e["symbol"], e["approach"]["name"])
    merged = {key(x): x for x in existing}
    merged.update({key(x): x for x in experiences})
    payload = {
        "version": 1,
        "task": "investing_mastery_777_mt5_walkforward",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_experiences": len(merged),
        "experiences": list(merged.values()),
    }
    MEMORY_PATH.write_text(json.dumps(payload, indent=2))


def write_instincts(experiences: list[dict]) -> None:
    INSTINCT_DIR.mkdir(parents=True, exist_ok=True)
    by_variant: dict[str, list[dict]] = defaultdict(list)
    for e in experiences:
        by_variant[e["approach"]["name"]].append(e)
    rows = []
    for name, group in by_variant.items():
        total = sum(x["validation"]["trades"] for x in group)
        net = sum(x["validation"]["net_r"] for x in group)
        oos = [w for x in group for w in x["walk_forward_windows"] if w["window"] in {"W3", "W4"} and w["trades"]]
        oos_net = sum(w["net_r"] for w in oos)
        oos_pos = sum(1 for w in oos if w["net_r"] > 0)
        rows.append((name, total, net, len(oos), oos_pos, oos_net))
    # Only write a positive-action instinct when the later windows have at
    # least 10 trades and are positive. Negative/uncertain lessons are still
    # retained in the memory/report instead of being promoted as a strategy.
    best = max(rows, key=lambda x: (x[5], x[4], x[1]), default=None)
    if best and best[3] >= 2 and best[1] >= 10 and best[5] > 0 and best[4] >= 2:
        name, total, net, n_oos, pos, oos_net = best
        path = INSTINCT_DIR / "im-777-walkforward-candidate.yaml"
        path.write_text(
            "---\n"
            f"id: im-777-walkforward-candidate\n"
            f"trigger: \"when selecting the Investing Mastery 777 entry profile\"\n"
            f"confidence: 0.5\n"
            "domain: \"strategy-optimization\"\n"
            "source: \"mt5-walk-forward-experience\"\n"
            "scope: project\n"
            "project_id: \"investing-mastery-mt5\"\n"
            "---\n\n"
            f"# Candidate profile: {name}\n\n"
            "## Action\n"
            f"Keep {name} as a research candidate, not a live-trading promotion, until a fresh unseen MT5 period confirms it.\n\n"
            "## Evidence\n"
            f"- Later walk-forward windows: {pos}/{n_oos} positive, net {oos_net:+.2f}R.\n"
            f"- Total sample across symbols: {total} trades, net {net:+.2f}R.\n"
            "- Promotion remains blocked by the minimum-sample rule and the absence of a future unseen period.\n"
        )


def aggregate_metrics(rows: list[dict]) -> dict:
    trades = sum(x.get("trades", 0) for x in rows)
    wins = sum(x.get("wins", round(x.get("win_rate", 0) * x.get("trades", 0))) for x in rows)
    losses = sum(x.get("losses", max(0, x.get("trades", 0) - round(x.get("win_rate", 0) * x.get("trades", 0)))) for x in rows)
    gross_win = sum(x.get("gross_win_r", 0.0) for x in rows)
    gross_loss = sum(x.get("gross_loss_r", 0.0) for x in rows)
    net = sum(x.get("net_r", 0.0) for x in rows)
    return {
        "trades": trades,
        "wins": wins,
        "losses": losses,
        "net_r": round(net, 4),
        "avg_r": round(net / trades, 4) if trades else 0.0,
        "win_rate": round(wins / trades, 4) if trades else 0.0,
        "profit_factor": round(gross_win / gross_loss, 4) if gross_loss else (999.0 if gross_win else 0.0),
        "ambiguous_bars": sum(x.get("ambiguous_bars", 0) for x in rows),
    }


def write_run_artifact(symbol: str, results: list[dict]) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    serializable = [
        {"symbol": row["symbol"], "variant": row["variant"], "metrics": row["metrics"], "windows": row["windows"]}
        for row in results
    ]
    (RUN_DIR / f"{symbol}.json").write_text(json.dumps(serializable, indent=2))


def make_report(results: list[dict], data_note: str) -> str:
    lines = [
        "# Investing Mastery 777 — MT5 Walk-Forward Research",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        "",
        "## Source and method boundary",
        "",
        "The public playlist confirms the observable concepts used here: reclaim-close timing (L29), multi-timeframe 777/grain stacking (L31), farther-target risk/reward (L32), and US-hours/DST context (L75). This is not a claim that the videos' audio was transcribed in full. The 777 implementation is therefore a testable interpretation of the public lesson titles and the existing channel-side engine, not a claim about private discretion.",
        "",
        f"Data: {data_note}",
        "",
        "## Aggregate result by profile",
        "",
        "| Profile | Symbols | Trades | Net R | Avg R | WR | PF | W3/W4 net R |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in results:
        grouped[row["variant"]].append(row)
    for variant, rows in grouped.items():
        m = aggregate_metrics([row["metrics"] for row in rows])
        later = [w for row in rows for w in row["windows"] if w["window"] in {"W3", "W4"}]
        lines.append(f"| {variant} | {len(rows)} | {m['trades']} | {m['net_r']:+.2f} | {m['avg_r']:+.3f} | {m['win_rate']:.0%} | {m['profit_factor']:.2f} | {sum(x['net_r'] for x in later):+.2f} |")
    lines += [
        "",
        "## Per-symbol and walk-forward windows",
        "",
        "| Symbol | Profile | W1 | W2 | W3 | W4 | Trades | Ambiguous |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in results:
        by_window = {x["window"]: x["net_r"] for x in row["windows"]}
        lines.append(f"| {row['symbol']} | {row['variant']} | {by_window.get('W1', 0):+.2f} | {by_window.get('W2', 0):+.2f} | {by_window.get('W3', 0):+.2f} | {by_window.get('W4', 0):+.2f} | {row['metrics']['trades']} | {row['metrics']['ambiguous_bars']} |")
    lines += [
        "",
        "## Interpretation rules",
        "",
        "- W1/W2 are the earlier half; W3/W4 are the later half. A profile is not promoted because it wins only in W1/W2.",
        "- A same-bar stop/target collision is scored as a loss. This avoids optimistic OHLC-bar ordering.",
        "- The M3 trigger is aggregated from M1, so results should not be presented as native-M3 execution evidence.",
        "- The correct output can be **wait / no verified edge**. A positive total with a small or unstable later-window sample is not a trading claim.",
        "",
        "## Trade decision encoded",
        "",
        "The engine may show a candidate level and a 777 score, but it emits a trade only after a closed-bar reclaim, usable room to the next level, risk/reward minimum, and non-conflicting higher-timeframe context. The research layer additionally tests whether US cash hours, long-only direction, and stronger alignment improve later windows without being selected on those same windows.",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbols", nargs="+", default=["MNQ", "MES", "GC", "ENQ"])
    parser.add_argument("--quick", action="store_true", help="use the first 30%% of each trigger series")
    parser.add_argument("--report-only", action="store_true", help="regenerate the combined report from per-symbol run artifacts")
    args = parser.parse_args()

    if args.report_only:
        results = []
        for symbol in args.symbols:
            path = RUN_DIR / f"{symbol}.json"
            if path.exists():
                results.extend(json.loads(path.read_text()))
        if not results:
            print(f"No run artifacts in {RUN_DIR}; run one or more symbols first", file=sys.stderr)
            return 2
        REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        REPORT_PATH.write_text(make_report(results, "MT5 full exports from 2026-08-14; M3 from M1 and H4 from H1"))
        print(f"Report: {REPORT_PATH}")
        return 0

    results: list[dict] = []
    experiences: list[dict] = []
    for symbol in args.symbols:
        ladder = load_ladder(symbol)
        if args.quick:
            cut = max(600, len(ladder["3"]) // 3)
            ladder = {tf: rows for tf, rows in ladder.items()}
            ladder["3"] = ladder["3"][:cut]
        data_note = "MT5 mt5_full_m1/m5/m15/h1/d1 exports pulled 2026-08-14; M3/H4 derived causally"
        print(f"{symbol}: trigger={len(ladder['3']):,} M3 bars; context=" + ", ".join(f"{tf}:{len(v):,}" for tf, v in ladder.items() if tf != "3"))
        signals = collect_signals(symbol, ladder)
        print(f"  confirmed 777 signals before execution filters: {len(signals)}")
        symbol_results: list[dict] = []
        for variant in VARIANTS:
            trades = run_variant(symbol, ladder, variant, signals)
            m = trade_metrics(trades)
            windows = window_metrics(trades, ladder["3"])
            print(f"  {variant.name:22s} trades={m['trades']:3d} net={m['net_r']:+7.2f}R avg={m['avg_r']:+.3f} PF={m['profit_factor']:.2f} W3+W4={sum(x['net_r'] for x in windows if x['window'] in {'W3','W4'}):+.2f}R")
            row = {"symbol": symbol, "variant": variant.name, "metrics": m, "windows": windows, "trades_obj": trades}
            results.append(row)
            symbol_results.append(row)
            experiences.append(memory_experience(symbol, variant, m, windows, data_note))
        write_run_artifact(symbol, symbol_results)

    write_memory(experiences)
    write_instincts(experiences)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(make_report(results, "MT5 full exports from 2026-08-14; M3 from M1 and H4 from H1"))
    print(f"Report: {REPORT_PATH}")
    print(f"Memory: {MEMORY_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
