#!/usr/bin/env python3
"""Tests for the Dual MA SD Oscillator SMC strategy engine."""
from __future__ import annotations

import math
import unittest

from dual_ma_sd_strategy import (
    Candle,
    DualMaSdEngine,
    Signal,
    _ema,
    _pivot_high,
    _pivot_low,
    _stdev,
)

CLOSE_ONLY = True


def make_candle(index: int, close: float, high: float | None = None,
                low: float | None = None, open_: float | None = None,
                volume: float = 1000.0, base: int = 1_700_000_000) -> Candle:
    high = high if high is not None else close
    low = low if low is not None else close
    open_ = open_ if open_ is not None else close
    return Candle(time=base + index * 180, open=open_, high=high, low=low,
                  close=close, volume=volume)


def run_engine(closes: list[float]) -> tuple[DualMaSdEngine, list[Signal]]:
    candles = [make_candle(i, c) for i, c in enumerate(closes)]
    engine = DualMaSdEngine(symbol="NQ", event_gate=False)
    signals: list[Signal] = []
    # Feed progressively, exactly like the scanner (closed bars only).
    for i in range(len(candles)):
        signal = engine.process_candles(candles[: i + 1])
        if signal:
            signals.append(signal)
    return engine, signals


class TestIndicatorMath(unittest.TestCase):
    def test_ema_matches_definition(self):
        series = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        out = _ema(series, 3)
        self.assertEqual(len(out), len(series))
        alpha = 2.0 / 4.0
        expected = [1.0]
        for i in range(1, len(series)):
            expected.append(series[i] * alpha + expected[-1] * (1 - alpha))
        for got, want in zip(out, expected):
            self.assertAlmostEqual(got, want, places=9)

    def test_stdev_population(self):
        self.assertAlmostEqual(_stdev([2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0]), 2.0, places=9)
        self.assertEqual(_stdev([5.0, 5.0, 5.0]), 0.0)
        self.assertEqual(_stdev([]), 0.0)

    def test_pivots(self):
        # V-shaped lows: bar 2 is a local low -> pivot low.
        lows = [make_candle(i, c) for i, c in enumerate([10, 9, 8, 9, 10])]
        self.assertIsNotNone(_pivot_low(lows, 2, 1))
        # Inverted-V highs: bar 2 is a local high -> pivot high.
        highs = [make_candle(i, c) for i, c in enumerate([8, 9, 10, 9, 8])]
        self.assertIsNotNone(_pivot_high(highs, 2, 1))
        # Monotonic series have no pivots.
        mono = [make_candle(i, c) for i, c in enumerate([10, 9, 8, 7, 6])]
        self.assertIsNone(_pivot_low(mono, 2, 1))
        self.assertIsNone(_pivot_high(mono, 2, 1))


class TestOscillatorStates(unittest.TestCase):
    def test_flat_series_no_signal(self):
        closes = [100.0] * 120
        engine, signals = run_engine(closes)
        self.assertEqual(signals, [])
        self.assertEqual(engine.state, 0)

    def test_trend_shift_flips_state(self):
        # A slow steady rise must push smoothed above the upper band.
        closes = [100.0 + i * 0.05 for i in range(200)]
        engine, signals = run_engine(closes)
        self.assertEqual(engine.state, 1)
        self.assertTrue(any(s.direction == "long" for s in signals))

    def test_downtrend_flips_bear(self):
        closes = [100.0 - i * 0.05 for i in range(200)]
        engine, signals = run_engine(closes)
        self.assertEqual(engine.state, -1)
        self.assertTrue(any(s.direction == "short" for s in signals))

    def test_signal_levels_are_side_correct(self):
        closes = [100.0 + i * 0.05 for i in range(200)]
        engine, signals = run_engine(closes)
        signal = signals[-1]
        self.assertEqual(signal.direction, "long")
        self.assertLess(signal.stop, signal.entry)
        self.assertGreater(signal.target, signal.entry)
        self.assertGreater(signal.target2, signal.target)
        self.assertGreater(signal.atr, 0.0)


class TestSMCStructure(unittest.TestCase):
    def test_stop_below_swing_for_long(self):
        # Chop then trend up: the stop must sit below a real swing low.
        closes = [100.0] * 60 + [100.0 + i * 0.1 for i in range(140)]
        engine, signals = run_engine(closes)
        signal = signals[-1]
        self.assertEqual(signal.direction, "long")
        self.assertLess(signal.stop, signal.entry)

    def test_event_gate_blocks_empty_flip(self):
        # A pure linear rise has no sweep/fvg: with the gate on, no signal.
        closes = [100.0 + i * 0.05 for i in range(220)]
        candles = [make_candle(i, c) for i, c in enumerate(closes)]
        engine = DualMaSdEngine(symbol="NQ", event_gate=True)
        signals = []
        for i in range(len(candles)):
            sig = engine.process_candles(candles[: i + 1])
            if sig:
                signals.append(sig)
        self.assertEqual(signals, [])

    def test_swing_tracking(self):
        closes = []
        for i in range(80):
            closes.append(100.0 + (math.sin(i / 5.0) * 3.0))
        candles = [make_candle(i, c, high=c + 0.5, low=c - 0.5) for i, c in enumerate(closes)]
        engine = DualMaSdEngine(symbol="NQ", event_gate=False)
        for i in range(len(candles)):
            engine.process_candles(candles[: i + 1])
        state = engine.structure_state()
        self.assertIn("last_swing_high", state)
        self.assertIn("last_swing_low", state)

    def test_swing_detected_after_confirmation_window(self):
        # Regression: a pivot at bar p is only confirmable from bar p+left
        # onward.  The engine must detect it once the window closes instead
        # of checking only the current bar (which misses every pivot).
        # The engine needs >=40 bars to warm up, so repeat the swing pattern
        # for 80 bars (warm-up) then 15 bars of V-shaped structure.
        lows = [10, 12, 9, 13, 11, 8, 14, 12, 15, 10, 16, 13, 9, 17, 12]
        closes = [100.0] * 80 + lows
        candles = [make_candle(i, c, high=c + 2, low=c) for i, c in enumerate(closes)]
        engine = DualMaSdEngine(symbol="NQ", event_gate=False, swing_left=1)
        for i in range(len(candles)):
            engine.process_candles(candles[: i + 1])
        state = engine.structure_state()
        self.assertIsNotNone(state["last_swing_low"], "a confirmed swing low must be recorded")
        self.assertIsNotNone(state["last_swing_high"], "a confirmed swing high must be recorded")


class TestConfirmedBarBehavior(unittest.TestCase):
    def test_no_signal_with_insufficient_bars(self):
        closes = [100.0 + i * 0.05 for i in range(20)]
        candles = [make_candle(i, c) for i, c in enumerate(closes)]
        engine = DualMaSdEngine(symbol="NQ", event_gate=False)
        self.assertIsNone(engine.process_candles(candles))

    def test_same_bar_does_not_repeat(self):
        closes = [100.0 + i * 0.05 for i in range(220)]
        candles = [make_candle(i, c) for i, c in enumerate(closes)]
        engine = DualMaSdEngine(symbol="NQ", event_gate=False)
        engine.process_candles(candles)
        second = engine.process_candles(candles)  # identical input
        self.assertIsNone(second)


if __name__ == "__main__":
    unittest.main()
