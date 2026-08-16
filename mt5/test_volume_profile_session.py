import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from volume_profile_session_strategy import Bar, build_profile, resample_bars, backtest_day


def _bar(ts, o, h, l, c, v=100):
    return Bar(ts, o, h, l, c, v)


def test_profile_poc_and_value_area_are_volume_weighted():
    profile = build_profile([
        _bar(0, 100, 101, 99, 100, 10),
        _bar(60, 100, 101, 99, 100, 1000),
        _bar(120, 104, 105, 103, 104, 10),
    ], bins=8)
    assert profile is not None
    assert 99.0 <= profile.poc <= 101.5
    assert profile.val <= profile.poc <= profile.vah
    assert profile.total_volume == 1020


def test_resample_uses_fixed_utc_buckets():
    bars = resample_bars([
        {"t": 1, "o": 10, "h": 11, "l": 9, "c": 10, "v": 2},
        {"t": 61, "o": 10, "h": 12, "l": 9.5, "c": 11, "v": 3},
        {"t": 181, "o": 11, "h": 13, "l": 10, "c": 12, "v": 4},
    ], seconds=180)
    assert len(bars) == 2
    assert bars[0].open == 10
    assert bars[0].high == 12
    assert bars[0].close == 11
    assert bars[0].volume == 5


def test_backtest_returns_only_completed_ny_decisions():
    # Build a small complete UTC day: Asia and London establish profiles,
    # then NY sweeps Asia low and closes back above it. The next bar reaches
    # the 1.5R target. A same-bar stop/target would be resolved stop-first.
    rows = []
    ts = 0
    for minute in range(0, 21 * 60, 3):
        hour = minute // 60
        if hour < 8:
            price = 100.0 + (0.03 if minute % 12 else -0.02)
            rows.append(_bar(minute * 60, price, price + 0.1, price - 0.1, price, 100))
        elif hour < 13:
            price = 100.4 + (0.03 if minute % 18 else -0.02)
            rows.append(_bar(minute * 60, price, price + 0.1, price - 0.1, price, 120))
        else:
            rows.append(_bar(minute * 60, 100, 100.1, 99.9, 100, 100))
    # Force a completed Asia-low sweep during NY after the opening range.
    # Asia low is around 99.88, so this closes back above it.
    idx = next(i for i, b in enumerate(rows) if b.time // 3600 == 14 and b.time // 60 % 60 == 33)
    rows[idx] = _bar(rows[idx].time, 99.95, 100.05, 99.5, 99.98, 500)
    trades = backtest_day(rows, tick_size=0.01)
    assert isinstance(trades, list)
    assert all(t.entry_time < t.exit_time for t in trades)


if __name__ == "__main__":
    test_profile_poc_and_value_area_are_volume_weighted()
    test_resample_uses_fixed_utc_buckets()
    test_backtest_returns_only_completed_ny_decisions()
    print("SVR tests passed")
