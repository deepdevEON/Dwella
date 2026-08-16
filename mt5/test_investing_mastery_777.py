"""Focused tests for the BOB Investing Mastery 777 implementation."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import investing_mastery_777_strategy as mastery
import scanner_pullback as scanner


def _bar(index: int, close: float, *, low: float | None = None,
         high: float | None = None, volume: float = 100.0) -> mastery.Candle:
    return mastery.Candle(
        time=1_700_000_000 + index * 180,
        open=close - 0.08,
        high=high if high is not None else close + 0.22,
        low=low if low is not None else close - 0.22,
        close=close,
        volume=volume,
    )


def _rising_series(count: int = 130, start: float = 100.0) -> list[mastery.Candle]:
    """Rising context with repeated wick prints around a red support line."""
    rows = []
    for i in range(count):
        close = start + i * 0.045
        low = close - 0.20
        high = close + 0.22
        # Repeated, confirmed swing lows: the wick overlap is intentional.
        if i in {18, 36, 54, 72}:
            low = start - 0.25
            close = start + 0.14
            high = close + 0.30
        rows.append(_bar(i, close, low=low, high=high))
    return rows


def _playlist_ladder() -> tuple[list[mastery.Candle], dict[str, list[mastery.Candle]]]:
    trigger = _rising_series()
    # The last closed bar touches the red support and closes back above it;
    # the final row is the still-forming candle and must be ignored.
    reclaim_index = len(trigger)
    trigger.append(_bar(reclaim_index, 100.75, low=99.65, high=101.05, volume=180))
    trigger.append(_bar(reclaim_index + 1, 100.80, low=100.60, high=101.00, volume=120))
    ladder = {
        tf: _rising_series(start=100.0 + (0.02 if tf in {"60", "240", "D"} else 0.0))
        for tf in mastery.CONTEXT_TIMEFRAMES
    }
    # Keep all context feeds fresh but still forming on their last row.
    for tf, rows in ladder.items():
        rows.append(_bar(len(rows), rows[-1].close + 0.05, low=rows[-1].close - 0.10,
                         high=rows[-1].close + 0.18))
    ladder["3"] = trigger
    return trigger, ladder


def test_timeframe_bias_excludes_forming_bar_and_exposes_wick_lines():
    rows = _rising_series()
    rows.append(_bar(len(rows), 80.0, low=79.0, high=81.0))
    read = mastery.timeframe_bias(rows, fast_length=8, slow_length=21)
    assert read["ready"] is True
    assert read["bars"] == len(rows) - 1
    assert read["bias"] == "BULLISH"
    assert read["red_line"] is not None
    assert read["red_line"]["kind"] == "support"


def test_instant_touch_does_not_create_signal():
    trigger, ladder = _playlist_ladder()
    # Replace the confirmed bar with a touch that closes below the red line.
    ladder["3"][-2] = _bar(len(trigger) - 2, 99.55, low=99.45, high=100.65)
    engine = mastery.InvestingMastery777Engine("NQ")
    assert engine.process_candles(trigger, timeframe_candles=ladder) is None
    dashboard = engine.get_dashboard()
    assert dashboard["red_line"] is not None
    assert "blue_line" in dashboard
    assert dashboard["timeframes_checked"] >= mastery.MIN_HIGHER_FRAMES
    assert dashboard["seven_score"]["level"] > 0
    assert dashboard["gate"] in {
        "WAITING_FOR_RECLAIM_CLOSE", "WAITING_FOR_RR", "WAITING_FOR_777_CONFLUENCE",
    }


def test_reclaim_close_uses_higher_timeframes_and_emits_one_signal():
    trigger, ladder = _playlist_ladder()
    engine = mastery.InvestingMastery777Engine("NQ")
    signal = engine.process_candles(trigger, timeframe_candles=ladder)
    assert signal is not None, engine.get_dashboard()
    assert signal.strategy == "INVESTING_MASTERY_777"
    assert signal.direction == "long"
    assert signal.confirmed is True
    assert signal.entry > signal.stop < signal.target < signal.target2
    assert signal.pattern == "777 Bull Reclaim"
    assert signal.seven_score["reclaim"] == 7
    assert signal.bean_count > 0
    # Replaying the same live scan cannot emit the same bar twice.
    assert engine.process_candles(trigger, timeframe_candles=ladder) is None


def test_conflicting_higher_frames_wait_instead_of_firing():
    trigger, ladder = _playlist_ladder()
    # A falling series supplies a confirmed bearish daily context while the
    # 15m/1H/4H feeds remain bullish. Lesson 31 says wait on that conflict.
    falling = []
    for i in range(130):
        close = 108.0 - i * 0.045
        falling.append(_bar(i, close, low=close - 0.22, high=close + 0.22))
    falling.append(_bar(130, falling[-1].close - 0.05))
    ladder["D"] = falling
    engine = mastery.InvestingMastery777Engine("NQ")
    assert engine.process_candles(trigger, timeframe_candles=ladder) is None
    assert engine.get_dashboard()["gate"] == "HIGHER_TIMEFRAME_CONFLICT"


def test_scanner_defaults_to_playlist_engine_and_preserves_signal_shape():
    scanner._engines.clear()
    try:
        assert scanner.STRATEGY_NAME == "INVESTING_MASTERY_777"
        engine = scanner.get_engine("NQ", "paper")
        assert isinstance(engine, mastery.InvestingMastery777Engine)
        dashboard = engine.get_dashboard()
        assert dashboard["playlist"] == "BOB INVESTING MASTERY"
        assert dashboard["framework"].endswith("· 777")
        state = scanner.ScannerState()
        snapshot = state.snapshot()
        assert snapshot["analysis_mode"] == "PASSIVE"
        assert snapshot["timeframe_ladder"] == ["3", *mastery.CONTEXT_TIMEFRAMES]
    finally:
        scanner._engines.clear()


def test_passive_diagnostics_cover_every_native_frame_without_arming(monkeypatch):
    trigger, ladder = _playlist_ladder()

    def as_dict(candle):
        return {
            "time": candle.time,
            "open": candle.open,
            "high": candle.high,
            "low": candle.low,
            "close": candle.close,
            "volume": candle.volume,
        }

    rows = {tf: [as_dict(candle) for candle in values] for tf, values in ladder.items()}
    monkeypatch.setattr(scanner, "fetch_candles", lambda symbol, timeframe=None: rows[timeframe or "3"])
    monkeypatch.setattr(
        scanner,
        "fetch_context_candles",
        lambda symbol: {tf: rows[tf] for tf in mastery.CONTEXT_TIMEFRAMES},
    )
    scanner._engines.clear()
    state = scanner.ScannerState(running=True, armed=False)
    try:
        scanner.refresh_playbook_diagnostics(state)
        snapshot = state.snapshot()
        dashboard = snapshot["dashboards"]["NQ"]
        assert snapshot["armed"] is False
        assert snapshot["analysis_mode"] == "PASSIVE"
        assert dashboard["analysis_mode"] == "PASSIVE"
        assert dashboard["timeframe_ladder"] == ["3", *mastery.CONTEXT_TIMEFRAMES]
        assert dashboard["timeframes_checked"] == 7
        assert all(dashboard["timeframes"][tf]["ready"] for tf in dashboard["timeframe_ladder"])
    finally:
        scanner._engines.clear()


def test_scanner_level_validation_accepts_playlist_geometry():
    signal = scanner.Signal(
        strategy="INVESTING_MASTERY_777",
        symbol="ES",
        direction="long",
        entry=100.0,
        stop=97.0,
        target=103.0,
        target2=106.0,
    )
    assert scanner.pine_levels_valid(signal)


def test_scanner_does_not_count_aggregates_as_native_context(monkeypatch):
    rows = [{"time": 1, "open": 1, "high": 1, "low": 1, "close": 1}]
    monkeypatch.setattr(scanner, "_get", lambda url: {
        "candles": rows,
        "source_timeframe": "3",
    })
    assert scanner.fetch_candles("NQ", "15") == []

    monkeypatch.setattr(scanner, "_get", lambda url: {
        "candles": rows,
        "source_timeframe": "15",
    })
    assert scanner.fetch_candles("NQ", "15") == rows


if __name__ == "__main__":
    test_timeframe_bias_excludes_forming_bar_and_exposes_wick_lines()
    test_instant_touch_does_not_create_signal()
    test_reclaim_close_uses_higher_timeframes_and_emits_one_signal()
    test_conflicting_higher_frames_wait_instead_of_firing()
    test_scanner_defaults_to_playlist_engine_and_preserves_signal_shape()
    test_scanner_level_validation_accepts_playlist_geometry()
    print("Investing Mastery 777 tests passed")
