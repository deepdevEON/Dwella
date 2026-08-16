import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from confluence_suite_strategy import Candle, ConfluenceSuiteEngine
import scanner_pullback as scanner


def _wave_bars(count=800):
    bars = []
    for i in range(count):
        close = 100 + 8 * math.sin(i / 18) + i * 0.003
        previous = 100 + 8 * math.sin((i - 1) / 18) + (i - 1) * 0.003
        bars.append(Candle(
            1_700_000_000 + i * 180,
            previous,
            max(previous, close) + 0.8,
            min(previous, close) - 0.8,
            close,
            100 + 20 * math.sin(i / 5),
        ))
    return bars


def test_engine_uses_confirmed_three_minute_bars_and_emits_buy_sell():
    bars = _wave_bars()
    engine = ConfluenceSuiteEngine("NQ")
    signals = []
    for i in range(60, len(bars)):
        signal = engine.process_candles(bars[:i + 1])
        if signal:
            signals.append(signal)
    assert signals
    assert {signal.direction for signal in signals} == {"long", "short"}
    assert all(signal.pattern in {"BUY", "SELL"} for signal in signals)
    # The final bar is deliberately treated as forming, so a signal never
    # reports the candle currently being built.
    assert engine.last_bar_time == bars[-2].time


def test_buy_and_sell_stops_are_on_the_protective_side():
    bars = _wave_bars()
    engine = ConfluenceSuiteEngine("NQ")
    seen = []
    for i in range(60, len(bars)):
        signal = engine.process_candles(bars[:i + 1])
        if signal:
            seen.append(signal)
    assert all(signal.stop < signal.entry for signal in seen if signal.direction == "long")
    assert all(signal.stop > signal.entry for signal in seen if signal.direction == "short")


def test_confluence_strategy_accepts_native_stop_without_inventing_tp():
    buy = scanner.Signal(strategy="CONFLUENCE_SUITE", symbol="NQ", direction="long", entry=100, stop=98)
    sell = scanner.Signal(strategy="CONFLUENCE_SUITE", symbol="NQ", direction="short", entry=100, stop=102)
    bad = scanner.Signal(strategy="CONFLUENCE_SUITE", symbol="NQ", direction="long", entry=100, stop=101)
    assert scanner.pine_levels_valid(buy)
    assert scanner.pine_levels_valid(sell)
    assert not scanner.pine_levels_valid(bad)
    assert scanner.account_entry_units(buy, {"balance": 100_000}) == 1
    assert scanner.account_entry_units(sell, {"balance": 100_000}) == 1


def test_native_stop_matching_respects_direction():
    long_position = [{"symbol": "CME_MINI:NQ1!", "type": 0, "volume": 1, "sl": 98}]
    short_position = [{"symbol": "CME_MINI:NQ1!", "type": 1, "volume": 1, "sl": 102}]
    assert scanner._native_stop_matches(long_position, "NQ", "long", 98)
    assert scanner._native_stop_matches(short_position, "NQ", "short", 102)
    assert not scanner._native_stop_matches(short_position, "NQ", "long", 102)


if __name__ == "__main__":
    test_engine_uses_confirmed_three_minute_bars_and_emits_buy_sell()
    test_buy_and_sell_stops_are_on_the_protective_side()
    test_confluence_strategy_accepts_native_stop_without_inventing_tp()
    test_native_stop_matching_respects_direction()
    print("Confluence Suite tests passed")
