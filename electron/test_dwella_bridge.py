"""Unit tests for the futures contract pipeline in dwella_bridge.py.

MT5 is not available in the test environment, so a lightweight fake
`MetaTrader5` module is injected into sys.modules before importing the
bridge. This lets us unit-test the pure logic (expiration math, contract
parsing, chain sizing, and the continuous roll stitch) without a live
terminal.
"""

import sys
import types
import unittest
from datetime import date, datetime


# ── Fake MetaTrader5 ──────────────────────────────────────────────────────────

class _FakeSymbol:
    def __init__(self, name, tick=0.25):
        self.name = name
        self.trade_tick_size = tick


class _FakeInfo:
    def __init__(self, tick):
        self.trade_tick_size = tick


class _FakeMT5(types.ModuleType):
    def __init__(self, name):
        super().__init__(name)
        self.TIMEFRAME_M5 = 5
        self._symbols = []
        self._bars = {}
        self._tick = 0.25

    def initialize(self, *a, **k):
        return True

    def symbols_get(self):
        return [_FakeSymbol(n, self._tick) for n in self._symbols]

    def symbol_info(self, name):
        return _FakeInfo(self._tick)

    def copy_rates_from_pos(self, symbol, tf, pos, count):
        return self._bars.get(symbol)


def _ts(y, m, d, h=12):
    return int(datetime(y, m, d, h).timestamp())


def _mk_bars(closes):
    """Build chronological bar dicts. closes: list of (timestamp, close)."""
    out = []
    for t, c in closes:
        out.append({"time": t, "open": c, "high": c, "low": c,
                    "close": c, "tick_volume": 1})
    return out


# Inject the fake module before importing the bridge.
_fake = _FakeMT5("MetaTrader5")
sys.modules["MetaTrader5"] = _fake

import dwella_bridge as bridge  # noqa: E402


class ContractExpirationTests(unittest.TestCase):
    def test_equity_index_third_friday(self):
        # NQ/ES expire on the third Friday of the contract month.
        self.assertEqual(bridge.contract_expiration("NQ", 2025, 3), date(2025, 3, 21))
        self.assertEqual(bridge.contract_expiration("ES", 2025, 1), date(2025, 1, 17))

    def test_micro_uses_equity_index_rule(self):
        self.assertEqual(bridge.contract_expiration("MNQ", 2025, 6), date(2025, 6, 20))
        self.assertEqual(bridge.contract_expiration("MES", 2025, 12), date(2025, 12, 19))

    def test_metals_third_last_business_day(self):
        # GC/MGC expire on the third last business day of the month.
        # March 2025: last business day is Fri 3/31, third-last is Thu 3/27.
        self.assertEqual(bridge.contract_expiration("GC", 2025, 3), date(2025, 3, 27))
        self.assertEqual(bridge.contract_expiration("MGC", 2025, 2), date(2025, 2, 26))


class ParseContractTests(unittest.TestCase):
    def test_parse_front_month(self):
        self.assertEqual(bridge.parse_contract("NQH25"), ("NQ", 2025, 3, "H"))
        self.assertEqual(bridge.parse_contract("MNQZ25"), ("MNQ", 2025, 12, "Z"))

    def test_parse_invalid(self):
        self.assertIsNone(bridge.parse_contract("NQ"))
        self.assertIsNone(bridge.parse_contract("NOTASYMBOL"))
        self.assertIsNone(bridge.parse_contract("NQH2025"))


class FuturesChainTests(unittest.TestCase):
    def setUp(self):
        _fake._tick = 0.25
        _fake._symbols = ["NQH25", "NQJ25", "MNQH25", "MNQJ25"]

    def test_macro_contract_size(self):
        chain = bridge.futures_chain("NQ")
        self.assertTrue(chain["ok"])
        nq = next(c for c in chain["contracts"] if c["symbol"] == "NQH25")
        self.assertFalse(nq["micro"])
        self.assertEqual(nq["contract_size"], 20)

    def test_micro_contract_size(self):
        chain = bridge.futures_chain("NQ")
        self.assertTrue(chain["ok"])
        mnq = next(c for c in chain["contracts"] if c["symbol"] == "MNQH25")
        self.assertTrue(mnq["micro"])
        self.assertEqual(mnq["contract_size"], 2)
        # micro point value stays micro-adjusted
        self.assertEqual(mnq["point_value"], 2.0)

    def test_gc_micro_contract_size(self):
        _fake._symbols = ["GCH25", "MGCZ25"]
        chain = bridge.futures_chain("GC")
        gc = next(c for c in chain["contracts"] if c["symbol"] == "GCH25")
        mgc = next(c for c in chain["contracts"] if c["symbol"] == "MGCZ25")
        self.assertEqual(gc["contract_size"], 100)
        self.assertEqual(mgc["contract_size"], 10)


class FuturesContinuousTests(unittest.TestCase):
    """Verify the roll stitch keeps the reported symbol consistent with the
    bars actually contributed, and that pre/post-roll prices stay continuous."""

    def _setup_roll(self, symbols, bars):
        _fake._tick = 0.25
        _fake._symbols = symbols
        _fake._bars = bars

    def _fix_today(self, d):
        class _FixedDate(date):
            @classmethod
            def today(cls):
                return date(d.year, d.month, d.day)
        bridge.date = _FixedDate

    def test_rolled_reports_next_contract_with_its_bars(self):
        # Fix "today" so the front contract (NQH25, exp 2025-03-21) is within
        # ROLL_DAYS_BEFORE of expiration -> rolled=True, next = NQJ25.
        orig_date = bridge.date
        self._fix_today(date(2025, 3, 20))
        try:
            t_pre = _ts(2025, 3, 19)
            t_roll = _ts(2025, 3, 20)
            t_post = _ts(2025, 3, 21)
            # c0/NQH25 closes: 100, 110, 120 ; c1/NQJ25 closes: 95, 105, 115
            bars = {
                "NQH25": _mk_bars([(t_pre, 100), (t_roll, 110), (t_post, 120)]),
                "NQJ25": _mk_bars([(t_pre, 95), (t_roll, 105), (t_post, 115)]),
            }
            self._setup_roll(["NQH25", "NQJ25"], bars)

            res = bridge.futures_continuous("NQ", "M5", 180)
            self.assertTrue(res["ok"])
            self.assertTrue(res["rolled"])
            # active symbol must be the contract that contributes the recent bars
            self.assertEqual(res["symbol"], "NQJ25")
            self.assertEqual(res["front"], "NQH25")
            self.assertEqual(res["next"], "NQJ25")

            closes = [b["c"] for b in res["bars"]]
            # pre-roll bar comes from c0
            self.assertIn(100.0, closes)
            # post-roll bars come from c1, adjusted to be continuous with c0.
            # diff at roll boundary = 110 - 105 = 5, so c1@t_post -> 115 + 5 = 120
            self.assertIn(120.0, closes)
            # continuity: the latest bar must be a genuine c1-derived value
            self.assertEqual(closes[-1], 120.0)
            # the stitched boundary bar (c1 adjusted) must equal c0's close there
            self.assertIn(110.0, closes)
        finally:
            bridge.date = orig_date

    def test_not_rolled_reports_front_contract_only(self):
        # "today" well before the roll window -> rolled=False, uses c0 only.
        orig_date = bridge.date
        self._fix_today(date(2025, 3, 5))
        try:
            t_pre = _ts(2025, 3, 4)
            t_mid = _ts(2025, 3, 12)
            bars = {
                "NQH25": _mk_bars([(t_pre, 100), (t_mid, 110)]),
                # c1 bars should NOT appear in the output when not rolled
                "NQJ25": _mk_bars([(t_pre, 999), (t_mid, 888)]),
            }
            self._setup_roll(["NQH25", "NQJ25"], bars)

            res = bridge.futures_continuous("NQ", "M5", 180)
            self.assertTrue(res["ok"])
            self.assertFalse(res["rolled"])
            self.assertEqual(res["symbol"], "NQH25")
            closes = [b["c"] for b in res["bars"]]
            self.assertIn(100.0, closes)
            self.assertIn(110.0, closes)
            self.assertNotIn(999.0, closes)
            self.assertNotIn(888.0, closes)
        finally:
            bridge.date = orig_date


if __name__ == "__main__":
    unittest.main()
