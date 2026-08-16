"""Focused tests for Dwella's market-data freshness guard."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import tv_sidecar as sidecar


def _rows(last_time: int, count: int = 3) -> list[dict]:
    return [
        {
            "time": last_time - (count - index - 1) * 180,
            "open": 100.0 + index,
            "high": 101.0 + index,
            "low": 99.0 + index,
            "close": 100.5 + index,
            "volume": 10.0,
        }
        for index in range(count)
    ]


def test_freshness_uses_the_bar_timestamp_not_a_non_empty_response():
    now = 1_700_000_000.0
    fresh = _rows(int(now - 120))
    stale = _rows(int(now - 900))
    assert not sidecar.candles_are_stale(fresh, "3", now)
    assert sidecar.candles_are_stale(stale, "3", now)
    assert sidecar.candle_age_seconds(stale, "3", now) == 900.0


def test_daily_alias_is_normalized_without_relabeling_one_minute_data():
    now = 1_700_000_000.0
    rows = _rows(int(now - 86_400), count=2)
    assert not sidecar.candles_are_stale(rows, "1440", now)
    assert sidecar._normalize_timeframe("1440") == "D"
    assert sidecar._normalize_timeframe("1") == "1"


def test_commit_rejects_an_older_recovery_series():
    state = sidecar.State()
    alerts = sidecar.AlertManager()
    newer = _rows(1_700_001_000)
    older = _rows(1_700_000_000)
    sidecar._commit_candles(state, alerts, "NQ", newer, "3", "tvdatafeed")
    sidecar._commit_candles(state, alerts, "NQ", older, "3", "desktop")
    assert state.candles["NQ"][-1]["time"] == newer[-1]["time"]
    assert state.candle_sources["NQ"]["3"] == "tvdatafeed"


def test_snapshot_exposes_stale_symbols_and_source():
    state = sidecar.State()
    alerts = sidecar.AlertManager()
    sidecar._commit_candles(
        state,
        alerts,
        "NQ",
        _rows(1_700_000_000),
        "3",
        "desktop",
    )
    snapshot = state.snapshot()
    assert "NQ" in snapshot["market_data_stale_symbols"]
    assert snapshot["market_data_fresh"] is False
    assert snapshot["candle_sources"]["NQ"]["3"] == "desktop"
    assert snapshot["candle_ages_by_timeframe"]["NQ"]["3"] is not None


if __name__ == "__main__":
    test_freshness_uses_the_bar_timestamp_not_a_non_empty_response()
    test_daily_alias_is_normalized_without_relabeling_one_minute_data()
    test_commit_rejects_an_older_recovery_series()
    test_snapshot_exposes_stale_symbols_and_source()
    print("tv_sidecar freshness tests passed")
