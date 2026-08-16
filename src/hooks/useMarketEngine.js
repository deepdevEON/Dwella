// useMarketEngine.js
// LIVE-ONLY market derivation hook.
//
// Consumes REAL TradingView data from the sidecar (M3 candles,
// tick tape, L2 depth, account, positions) and derives every analytic from
// it: ATR, volume profile / value area, gamma-style levels from the real
// profile, balance areas, session bias, candle-derived iceberg/stop-run
// events, strategy signals, and REAL cumulative delta from tick aggressor
// flags. There is NO simulation anywhere in this file — if the feed is
// offline, `snap.live` is false and views render a disconnected state.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useMT5, tapeDelta } from './useMT5Live.jsx';
import { scanStrategies } from '../lib/strategies.js';
import {
  computeATR,
  buildVolumeProfile,
  valueArea,
  detectBalanceAreas,
  detectGammaLevels,
  sessionBias,
  deriveCandleEvents,
} from '../lib/indicators.js';

// Real symbols served by the sidecar + their contract facts (used for sizing).
export const LIVE_MARKETS = {
  ENQ: { name: 'E-Mini Nasdaq', code: 'ENQ', tick: 0.25, pointValue: 20, decimals: 2 },
  MES: { name: 'Micro E-Mini S&P', code: 'MES', tick: 0.25, pointValue: 5, decimals: 2 },
  GCE: { name: 'Micro Gold', code: 'GCE', tick: 0.1, pointValue: 10, decimals: 1 },
  YM: { name: 'Dow Jones', code: 'YM', tick: 1, pointValue: 5, decimals: 0 },
  ES: { name: 'E-mini S&P', code: 'ES', tick: 0.25, pointValue: 50, decimals: 2 },
  RTY: { name: 'Russell 2000', code: 'RTY', tick: 0.1, pointValue: 50, decimals: 1 },
  CL: { name: 'Crude Oil', code: 'CL', tick: 0.01, pointValue: 1000, decimals: 2 },
  SI: { name: 'Silver', code: 'SI', tick: 0.005, pointValue: 5000, decimals: 3 },
  NQ: { name: 'E-mini Nasdaq', code: 'NQ', tick: 0.25, pointValue: 20, decimals: 2 },
};

export function useMarketEngine({ symbol = 'ENQ', livePrice = null } = {}) {
  const live = useMT5();
  const cfg = LIVE_MARKETS[symbol] || LIVE_MARKETS.ENQ;

  const candles = live.candles[symbol] || [];
  const tape = live.tape[symbol] || [];
  const book = live.book[symbol] || { bids: [], asks: [] };
  const tick = live.ticks[symbol] || {};
  const price = livePrice ?? tick.last ?? tick.bid ?? (candles.length ? candles[candles.length - 1].close : null);

  // Derive everything from REAL data every poll (and on each new candle set).
  const derived = useMemo(() => {
    const base = {
      atr: 0,
      profile: [],
      va: null,
      balanceAreas: [],
      gammaLevels: [],
      bias: { bias: 'Neutral', confidence: 50 },
      events: [],
      signals: [],
      cumDelta: 0,
      deltaHistory: [],
      buyVol: 0,
      sellVol: 0,
      book,
      cfg,
      live: live.isLive,
    };
    if (!candles || candles.length < 5 || !live.isLive) return base;

    const atr = computeATR(candles, 14) || 0;
    const profile = buildVolumeProfile(candles.slice(-60));
    const va = valueArea(profile, 0.7);
    const balanceAreas = detectBalanceAreas(candles.slice(-40));
    const gammaLevels = detectGammaLevels(profile, price ?? candles[candles.length - 1].close);
    const bias = sessionBias(candles);
    const events = deriveCandleEvents(candles);
    const signals = scanStrategies({
      candles,
      price: price ?? candles[candles.length - 1].close,
      atr5: atr,
      profile,
      valueArea: va,
      balanceAreas,
      gammaLevels,
      events,
    });
    const delta = tapeDelta(tape);

    return {
      atr,
      profile,
      va,
      balanceAreas,
      gammaLevels,
      bias,
      events,
      signals,
      cumDelta: delta.sum,
      deltaHistory: delta.bars.map((b) => b.d).slice(-120),
      buyVol: delta.buyVol,
      sellVol: delta.sellVol,
      book,
      cfg,
      live: true,
    };
  }, [candles, tape, book, price, live.isLive, symbol, cfg]);

  // Day P/L from the REAL account (floating profit) + open positions.
  const dayPL = live.isLive ? Number((live.account.profit || 0) + (live.positions || []).reduce((s, p) => s + (p.profit || 0), 0)) : 0;

  const snap = useMemo(
    () => ({
      symbol,
      cfg,
      price,
      atr5: derived.atr,
      candles,
      profile: derived.profile,
      poc: derived.va?.poc ?? null,
      balanceAreas: derived.balanceAreas,
      gammaLevels: derived.gammaLevels,
      events: derived.events,
      icebergs: derived.events.filter((e) => e.type === 'iceberg'),
      stopRuns: derived.events.filter((e) => e.type === 'stop-run'),
      cumDelta: derived.cumDelta,
      gex: null, // not available via REST API — shown as —, never simulated
      hero: null, // not available via REST API — shown as —, never simulated
      deltaHistory: derived.deltaHistory,
      book,
      live: live.isLive,
    }),
    [symbol, cfg, price, candles, derived, book, live.isLive]
  );

  const reset = useCallback(() => {
    // With live data there is nothing to reseed; this is a no-op kept for
    // API compatibility with view components.
  }, []);

  return { snap, derived, dayPL, reset, live, symbol };
}
