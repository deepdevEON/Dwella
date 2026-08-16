#!/usr/bin/env python3
"""End-to-end setup flow: sweep -> MSS -> OTE -> rejection -> SHORT signal."""
from __future__ import annotations

import math
import unittest

from nate_tradez_strategy import NateTradezEngine, Candle, Signal


def _candle_list(prices, t0=1_700_000_000_000, step=900_000):
    out = []
    for i, (o, h, l, c) in enumerate(prices):
        out.append(Candle(time=t0 + i * step, open=o, high=h, low=l, close=c, volume=2000))
    return out


def build_bearish_scenario():
    """Construct the exact sequence Nate describes in the 7/15 recap:
    1) an established range/uptrend with a swing high (sweep magnet),
    2) a liquidity sweep of that high (ES-style manipulation),
    3) a displacement leg DOWN leaving a bearish FVG (MSS),
    4) RSI driven to an extreme (oversold),
    5) a bounce into the OTE zone (62-79% retrace),
    6) a hard rejection close back through structure -> SHORT."""
    bars = []
    price = 100.0

    # Phase 1 — up leg with pullbacks so swing highs/lows confirm.
    # Build HH/HL structure with clean zigzags (swing ~2.0).
    def push(o, h, l, c):
        bars.append((o, h, l, c))
        return c

    # warm-up small drift
    for _ in range(30):
        price = push(price, price + 0.5, price - 0.4, price + 0.2)
    # zigzag up: 4 waves, each ~2.2 points, tilt up
    for w in range(5):
        up = w % 2 == 0
        leg = 2.2 if up else 1.8
        for _ in range(3):
            price = push(price, price + 0.8, price - 0.4, price + leg / 3.0) if up else \
                    push(price, price + 0.4, price - 0.8, price - leg / 3.0)
        # turn bar
        if up:
            price = push(price, price + 0.7, price - 0.5, price + 0.2)
        else:
            price = push(price, price + 0.5, price - 0.7, price - 0.2)
    swing_high_zone = price + 0.9  # approx recent swing high area

    # Phase 2 — sweep of the swing high (poke above, close back below).
    price = push(price, price + 1.4, price - 0.6, price + 0.1)
    price = push(price, price + 0.6, price - 1.0, price - 0.5)
    price = push(price, price + 0.3, price - 0.4, price - 0.2)

    # Phase 3 — displacement leg DOWN (5 strong bars, big bodies).
    for _ in range(6):
        o = price
        c = price - 2.4
        price = push(o, o + 0.5, c - 0.6, c)
    leg_low = price

    # Phase 4 — bounce into OTE zone (62-79% of the leg measured from low).
    leg_top = max(h for _, h, _, _ in bars)  # includes the sweep poke
    leg_range = leg_top - leg_low
    zone_bottom = leg_low + 0.62 * leg_range
    zone_top = leg_low + 0.79 * leg_range
    target = (zone_bottom + zone_top) / 2.0
    steps = 8
    for i in range(steps):
        o = price
        c = price + (target - price) / (steps - i) * 1.6
        price = push(o, max(o, c) + 0.5, min(o, c) - 0.4, c)
    # final push inside zone
    price = push(price, price + 0.4, price - 0.3, price + 0.2)

    # Phase 5 — rejection: hard bearish close below prior bar's low.
    price = push(price, price + 0.6, price - 0.4, price - 2.6)
    price = push(price, price + 0.2, price - 0.5, price - 0.4)
    return bars


class TestFullSetupFlow(unittest.TestCase):
    def test_bearish_ote_signal(self):
        eng = NateTradezEngine(symbol="NQ", require_sweep=False, one_entry_per_day=True)
        bars = _candle_list(build_bearish_scenario())
        signal = eng.process_candles(bars)
        # Debug the gate if no signal.
        if signal is None:
            self.fail(f"no signal; gate={eng.last_gate} trend={eng.trend} "
                      f"swings=({eng.last_swing_low},{eng.last_swing_high}) "
                      f"rsi={eng._rsi_now} setup={'yes' if eng._setup else 'no'}")
        self.assertEqual(signal.direction, "short")
        self.assertTrue(signal.stop > signal.entry > signal.target)
        self.assertGreater(eng.last_entry_day, "")

    def test_short_levels_sane(self):
        eng = NateTradezEngine(symbol="NQ", require_sweep=False, one_entry_per_day=False)
        bars = _candle_list(build_bearish_scenario())
        signal = eng.process_candles(bars)
        if signal is None:
            self.skipTest("no signal in this run")
        risk = abs(signal.entry - signal.stop)
        reward = abs(signal.entry - signal.target)
        self.assertGreater(reward / risk, 1.0)
        # SD-2 target must sit beyond the entry on the correct side.
        self.assertLess(signal.target, signal.entry)
        self.assertLess(signal.target2, signal.target)

    def test_stale_history_signal_is_suppressed(self):
        """A signal that fired mid-history (not on the last closed bar) must
        NOT be returned: the scan loop would otherwise restamp it as fresh and
        execute at today's price.  Warm-up builds state; only the newest
        confirmed bar may produce an entry."""
        eng = NateTradezEngine(symbol="NQ", require_sweep=False, one_entry_per_day=False)
        bars = _candle_list(build_bearish_scenario())
        # Append bars AFTER the rejection so the signal's bar is no longer the
        # last closed bar — the engine must refuse to emit it.
        last_close = bars[-1].close
        for i in range(3):
            t = bars[-1].time + 900_000 * (i + 1)
            bars.append(Candle(time=t, open=last_close, high=last_close + 0.5,
                               low=last_close - 0.5, close=last_close + 0.1, volume=1000))
        signal = eng.process_candles(bars)
        self.assertIsNone(signal)
        self.assertNotEqual(eng.last_gate, "OTE entry confirmed")


if __name__ == "__main__":
    unittest.main()
