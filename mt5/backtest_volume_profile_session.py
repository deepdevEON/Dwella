#!/usr/bin/env python3
"""Run the research-only SVR backtest on captured OHLCV JSON files.

Examples:
  python3 mt5/backtest_volume_profile_session.py \
    --data packaging/tradingview-mcp/data/mt5_1m_timeframe.json \
    --month 2026-07 --out /tmp/svr-july.json
"""
from __future__ import annotations

import argparse
import json
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from volume_profile_session_strategy import backtest_month


def _month_days(month: str) -> list[str]:
    year, mon = (int(x) for x in month.split("-", 1))
    start = date(year, mon, 1)
    return [(start + timedelta(days=i)).isoformat() for i in range(monthrange(year, mon)[1])]


def _load(path: Path) -> dict[str, list[dict]]:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError(f"expected a symbol->rows object in {path}")
    return payload


def run(path: Path, month: str, symbols: list[str], tick_size: float) -> dict:
    payload = _load(path)
    results = {}
    for symbol in symbols or sorted(payload):
        rows = payload.get(symbol, [])
        month_rows = [r for r in rows if datetime.fromtimestamp(int(r["t"]), timezone.utc).strftime("%Y-%m") == month]
        result = backtest_month(month_rows, tick_size=tick_size)
        by_day = {d["date"]: d for d in result["days"]}
        result["calendar_days"] = [by_day.get(day, {"date": day, "trades": 0, "wins": 0, "losses": 0, "r": 0.0, "data": False}) | ({"data": True} if day in by_day else {}) for day in _month_days(month)]
        result["symbol"] = symbol
        result["month"] = month
        result["source"] = str(path)
        results[symbol] = result
    return {"month": month, "source": str(path), "symbols": results}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--month", required=True, help="UTC month YYYY-MM")
    parser.add_argument("--symbols", default="", help="comma-separated source symbols; default all")
    parser.add_argument("--tick-size", type=float, default=0.25)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    symbols = [x.strip() for x in args.symbols.split(",") if x.strip()]
    report = run(args.data, args.month, symbols, args.tick_size)
    encoded = json.dumps(report, indent=2)
    if args.out:
        args.out.write_text(encoded + "\n")
    print(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
