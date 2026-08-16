# Nate Tradez (YouTube @NLTradez) — Strategy Notes
> Extracted from public videos: "TRADE RECAP 7/15/2026", "5 Things Quietly Killing Your Trading System", "Give Me 7 Minutes to Change Your Trading Forever", shorts. Strategy is ICT-based, traded on NQ futures, NY AM session focus.

## Core philosophy
- **Three-timeframe alignment** (the "anatomy of an A+ trade"):
  1. HTF (1H/4H): clear trend / market sentiment — decides *direction*
  2. MTF (15m): model — order buildup, sweep, market structure shift — decides *where price is going*
  3. LTF (1m/5m): entry model — OTE + FVG + EMA + RSI rebalance — decides *precise entry*
- If no HTF trend (consolidation): play range — short premium, long discount, reversals only with MTF confirmation.
- Event-based (pumping/dumping with strong volume): only trade WITH the volume, no reversals.
- Slow uptrend: equilibrium (EQ) taps / rebalances, PO3 is the best strategy.
- "One trade a day max" — that's when everything changed for him. Grade setups A+ / A- / B.

## MTF model (15m)
- **Order buildup / re-accumulation**: consolidation where retail positions build, then gets swept (manipulation → distribution).
- **Sweep** of external/internal highs/lows (liquidity). SMT (ES vs NQ divergence) makes it stronger — the "stronger" asset does the dirty work (sweeps), the other confirms.
- **Market Structure Shift (MSS)** — the ONLY trend-change confirmation:
  - Uptrend = higher highs + higher lows only. A **lower low** (or a break of the level that made the last high) ruins the equation → trend change.
  - MSS level = the level that made the last high (in uptrend) / last low (in downtrend).
  - **Requires displacement** past the MSS level — a deep close through it, not a wick.

## LTF entry model (1m/5m)
- After a big displacement leg (leaves inefficiency / FVG + oversold RSI), price rebalances into:
  - **OTE** — Optimal Trade Entry (fib retracement zone of the displacement leg, ~62–79%)
  - aligned with a **FVG** (fair value gap) and above/below **EMA**
  - after **RSI rebalance** (RSI <~25-30 after a dump → expect bounce into OTE to rebalance)
- Entry trigger: **hard closure past the FVG** (e.g., close back through the bullish FVG = bearish entry) + EMA breach + weak volume + price failing the level.
- **Stop**: tight — just beyond the swept high/low (the protected point). OTE entry lets you tighten the stop (1:1.8 → 1:4 RR).
- **Target**: **Standard Deviation 2–2.5** projection of the range (consequent encroachment 2–2.5σ), often aligned with HTF low/high or next liquidity level.

## If/Then scenario (adaptive bias)
- Enter the day with a bias + a narrative, but define invalidation: "if price displaces past X with no reversal → switch bias". Don't get stuck on a bias.

## Implementation mapping for the app
- HTF sentiment: detect trend vs range on the 15m (or aggregated) series via HH/HL/LH/LL + ADX-ish slope.
- MTF: 15m swings, accumulation range, sweep detection, MSS + displacement.
- LTF: 3m (or 5m) OTE zones, FVG detection, RSI rebalance, EMA confluence.
- Entry: MSS confirmed + price returns into OTE/FVG zone → enter on close back through the FVG.
- Stop: beyond the protected swing (swept extreme).
- Target: SD-2 projection (2σ of the range from the MSS leg).
- Trading every day: no narrow time window; trade whatever session presents the model.
