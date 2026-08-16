import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from essence_model_strategy import Candle, EssenceModelEngine, ET
import scanner_pullback as scanner


def _ts(year, month, day, hour, minute=0):
    return int(datetime(year, month, day, hour, minute, tzinfo=ET).timestamp())


def _bars_for_entry():
    bars = []
    # A complete bullish previous day establishes the daily bias. The range
    # is deliberately modest so the test does not depend on ADR history.
    start = _ts(2026, 1, 5, 0)
    price = 100.0
    for i in range(480):
        close = price + 0.02
        bars.append(Candle(start + i * 180, price, price + 0.08, price - 0.04, close, 100))
        price = close

    # Current day: keep the bias intact, then create a down run and a bullish
    # CISD. Entry/event gating is disabled only in this unit test so the
    # protected-trigger direction can be isolated deterministically.
    day_start = _ts(2026, 1, 6, 0)
    for i in range(120):
        t = day_start + i * 180
        if i < 118:
            close = price + 0.01
            bars.append(Candle(t, price, price + 0.05, price - 0.03, close, 100))
            price = close
        elif i == 118:
            bars.append(Candle(t, 110.0, 110.2, 108.0, 108.5, 100))
        else:
            bars.append(Candle(t, 108.5, 111.0, 108.2, 110.5, 100))
    # The final bar is forming and must not be eligible for the signal.
    bars.append(Candle(day_start + 120 * 180, 110.5, 110.7, 110.3, 110.4, 100))
    return bars


def test_essence_emits_only_on_confirmed_bar_with_protected_stop():
    engine = EssenceModelEngine(
        "NQ",
        use210=False,
        show_frameworks=False,
        entry_window=False,
        adr_guard=False,
        signature_event_gate=False,
    )
    signal = engine.process_candles(_bars_for_entry())
    assert signal is not None
    assert signal.direction == "long"
    assert signal.entry == 110.5
    assert signal.stop < signal.entry
    assert signal.target == signal.entry + (signal.entry - signal.stop)
    assert signal.target2 == signal.entry + 2 * (signal.entry - signal.stop)
    assert signal.bar_time < _bars_for_entry()[-1].time
    assert signal.pattern.startswith("PS ·")


def test_essence_rearms_after_protected_swing_closes_through():
    bars = _bars_for_entry()
    engine = EssenceModelEngine(
        "NQ",
        use210=False,
        show_frameworks=False,
        entry_window=False,
        adr_guard=False,
        signature_event_gate=False,
    )
    first = engine.process_candles(bars)
    assert first is not None
    # Feed a confirmed bar below the protected swing, then verify the daily
    # entry latch is released exactly as the Pine invalidation rule states.
    t = bars[-1].time + 180
    engine.process_candles(bars + [Candle(t, 110.4, 110.5, 107.5, 107.8, 100), Candle(t + 180, 107.8, 108, 107.6, 107.7, 100)])
    assert engine.entry_done is False


def test_essence_risk_levels_and_direction_are_fail_closed():
    long_signal = scanner.Signal(strategy="ESSENCE_MODEL", symbol="NQ", direction="long", entry=100, stop=98, target=102, target2=104)
    short_signal = scanner.Signal(strategy="ESSENCE_MODEL", symbol="NQ", direction="short", entry=100, stop=102, target=98, target2=96)
    invalid = scanner.Signal(strategy="ESSENCE_MODEL", symbol="NQ", direction="long", entry=100, stop=101, target=102, target2=104)
    assert scanner.pine_levels_valid(long_signal)
    assert scanner.pine_levels_valid(short_signal)
    assert not scanner.pine_levels_valid(invalid)
    assert scanner.account_entry_units(long_signal, {"balance": 100_000}) == 1
    assert scanner.account_entry_units(short_signal, {"balance": 100_000}) == 1


if __name__ == "__main__":
    test_essence_emits_only_on_confirmed_bar_with_protected_stop()
    test_essence_rearms_after_protected_swing_closes_through()
    test_essence_risk_levels_and_direction_are_fail_closed()
    print("Essence Model tests passed")
