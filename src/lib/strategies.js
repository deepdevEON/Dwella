// strategies.js
// Dwella strategy engine — implements Scott Pulcini's named setups from the video:
//   BARK — Blind → ATR → Retest → Confirm (works anywhere; event-driven)
//   IZZY — Inflection zone trade (balance area tops/bottoms, HVNs, tails)
//   PICK — Volume profile composite top/bottom ("70% of trade occurred")
//   SLUG — Lwig support/resistance levels
//   SNIPER — EMA pullback (ported from the Helios "Sniper Pullback" / sp worker)
// Each strategy: wait for a stop/iceberg event at an important area, then
// confirm with a full 5-min ATR (+15%) move away before entering.
// Pure functions — no dependencies.

import { confirmationDistance } from './indicators.js';

// ------------------------------------------------------------------
// EMA helpers (used by the SNIPER strategy — Helios' fast/slow EMA pair)
// ------------------------------------------------------------------
export function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// SMA of the last `period` closes — the "slow EMA" anchor when EMA data is thin
export function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

// ------------------------------------------------------------------
// Strategy definitions (metadata for UI)
// ------------------------------------------------------------------
export const STRATEGIES = [
  {
    id: 'bark',
    name: 'BARK',
    full: 'Blind · ATR · Retest · Confirm',
    description:
      'The event trade. An iceberg or stop run fires anywhere (Blind), price pushes a full ATR (+15%) away, retests the zone, and confirms — then you join the trapped-traders side. Scalp in/out, very defined.',
    color: '#ff4d79',
    filter: 'EMA aligned in trade direction',
  },
  {
    id: 'izzy',
    name: 'IZZY',
    full: 'Inflection Zone Trade',
    description:
      'Tops & bottoms of balance areas, high volume nodes, and buying/selling tails. These are where traders place bets — a stop/iceberg event here plus an ATR confirm is a high-probability inflection trade.',
    color: '#a78bfa',
    filter: 'Event at inflection zone',
  },
  {
    id: 'pick',
    name: 'PICK',
    full: 'Profile Composite Top / Bottom',
    description:
      'Named after "Profiles in Courage". Waits for a stop/iceberg event at the top or bottom of a market-profile composite — the level where 70% of multi-day volume traded. Very powerful areas.',
    color: '#fbbf24',
    filter: 'Event at 70% value-area edge',
  },
  {
    id: 'slug',
    name: 'SLUG',
    full: 'Lwig Support / Resistance',
    description:
      'Trade the red/blue Lwig levels. The market comes up to a strong support/resistance print, you get a sell iceberg or stop run into it — that is the area. Take the trade, defend with ATR.',
    color: '#34d399',
    filter: 'Event at Lwig level',
  },
  {
    id: 'sniper',
    name: 'SNIPER',
    full: 'EMA Pullback · Helios sp',
    description:
      'Ported from your Helios autotrader (NautilusTrader "Sniper Pullback" / sp on NQ+GC). Trend is fast EMA over slow EMA; you wait for a pullback into the slow EMA and enter on the reclaim — the sniper shot. ATR stop, 2R target.',
    color: '#f6c9d3',
    filter: 'Pullback to slow EMA in trend direction',
  },
];

// ------------------------------------------------------------------
// Scanner — takes an engine snapshot and produces live setup signals
// ------------------------------------------------------------------
export function scanStrategies(snap) {
  const signals = [];
  if (!snap || !snap.candles || snap.candles.length < 5) return signals;

  const atr = snap.atr5 || 0;
  const confirm = confirmationDistance(atr);
  const price = snap.price;
  const events = snap.events || [];
  const recentEvents = events.slice(-8);

  const profile = snap.profile || [];
  const va = snap.valueArea || null;

  // Important areas derived from profile + balance
  const balance = snap.balanceAreas && snap.balanceAreas[0];
  const areas = [];
  if (balance) {
    areas.push({ price: balance.high, label: 'Balance Top', kind: 'izzy' });
    areas.push({ price: balance.low, label: 'Balance Bottom', kind: 'izzy' });
    areas.push({ price: balance.mid, label: 'HVN (Balance Mid)', kind: 'izzy' });
  }
  if (va) {
    areas.push({ price: va.high, label: 'Value Area High (PICK)', kind: 'pick' });
    areas.push({ price: va.low, label: 'Value Area Low (PICK)', kind: 'pick' });
    areas.push({ price: va.poc, label: 'POC', kind: 'pick' });
  }
  // Lwig-style levels: nearby gamma levels act as the support/resistance prints
  const gamma = snap.gammaLevels || [];
  for (const g of gamma.slice(0, 4)) {
    areas.push({ price: g.price, label: `Lwig ${g.type}`, kind: 'slug' });
  }

  // For each recent event, check whether it occurred at an important area
  for (const ev of recentEvents) {
    const evPrice = ev.price ?? ev.sweptFrom ?? price;
    // Find nearest important area within 1.5 ATR
    let best = null;
    let bestDist = Infinity;
    for (const a of areas) {
      const d = Math.abs(a.price - evPrice);
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    const inZone = best && bestDist <= Math.max(confirm * 0.6, atr * 0.8);
    if (!inZone || !best) continue;

    const kind = best.kind;
    // Direction logic: 
    //  - stop-run up / buy iceberg at support → long setup
    //  - stop-run down / sell iceberg at resistance → short setup
    let dir = null;
    if (ev.type === 'iceberg') dir = ev.dir === 'bid' ? 'long' : 'short';
    else if (ev.type === 'stop-run') dir = ev.dir === 'up' ? 'long' : 'short';
    if (!dir) continue;

    // Simple confirmation: recent candle momentum in the setup direction
    const lastCandle = snap.candles[snap.candles.length - 1];
    const candles = snap.candles;
    const momentum =
      candles.length >= 3
        ? candles[candles.length - 1].close - candles[candles.length - 3].close
        : 0;
    const confirmed = dir === 'long' ? momentum > 0 : momentum < 0;

    // Choose which strategy this maps to
    let strategyId = 'bark';
    if (kind === 'izzy') strategyId = 'izzy';
    else if (kind === 'pick') strategyId = 'pick';
    else if (kind === 'slug') strategyId = 'slug';

    const stopDistance = confirm * 1.0;
    const targetDistance = confirm * 2.0; // 2R initial target, trailing to next event
    signals.push({
      id: `${strategyId}-${ev.id}-${Date.now()}`,
      strategyId,
      dir,
      entry: price,
      area: best.label,
      areaPrice: best.price,
      eventType: ev.type,
      eventPrice: evPrice,
      stop: dir === 'long' ? price - stopDistance : price + stopDistance,
      target: dir === 'long' ? price + targetDistance : price - targetDistance,
      stopDistance,
      targetDistance,
      rMultiplier: 2,
      confirmed,
      atr,
      time: Date.now(),
    });
  }

  // ------------------------------------------------------------------
  // SNIPER — Helios EMA pullback (fast/slow EMA pair on real candles)
  // Trend: fast EMA > slow EMA. Setup: price pulls back toward the slow
  // EMA (within ~0.5 ATR) and reclaims it (closes back on the trend side).
  // ------------------------------------------------------------------
  const closes = snap.candles.map((c) => c.close);
  const fast = ema(closes, 8);
  const slow = ema(closes, 21);
  if (fast != null && slow != null && atr > 0) {
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const trendUp = fast > slow;
    const distToSlow = trendUp ? last - slow : slow - last;
    const pulledIn = distToSlow <= Math.max(atr * 0.6, confirm * 0.4);
    // reclaim: previous close was on the wrong side of the slow EMA, last close flipped back
    const reclaimedUp = trendUp && prev <= slow && last > slow;
    const reclaimedDn = !trendUp && prev >= slow && last < slow;
    const momentum = last - (closes[closes.length - 3] ?? last);
    const confirmed = trendUp ? momentum > 0 : momentum < 0;
    if (pulledIn && (reclaimedUp || reclaimedDn) && confirmed) {
      const dir = trendUp ? 'long' : 'short';
      const stopDistance = Math.max(confirm, atr * 0.9);
      const targetDistance = stopDistance * 2;
      signals.push({
        id: `sniper-${Date.now()}`,
        strategyId: 'sniper',
        dir,
        entry: price,
        area: `Slow EMA ${slow.toFixed(2)}`,
        areaPrice: slow,
        eventType: 'pullback',
        eventPrice: slow,
        stop: dir === 'long' ? price - stopDistance : price + stopDistance,
        target: dir === 'long' ? price + targetDistance : price - targetDistance,
        stopDistance,
        targetDistance,
        rMultiplier: 2,
        confirmed,
        atr,
        time: Date.now(),
      });
    }
  }

  // Dedupe by (strategyId, dir) keeping latest
  const seen = new Set();
  return signals.filter((s) => {
    const key = `${s.strategyId}-${s.dir}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ------------------------------------------------------------------
// Session / risk rules (from the video):
//  - daily loss limit ~6-8% of account
//  - never trade bigger than sizing rule
//  - trade like an algo: fixed entry, exit, size
// ------------------------------------------------------------------
export function dailyLossLimit(accountBalance, pct = 0.07) {
  return accountBalance * pct;
}

export function checkDailyLimit({ accountBalance, dayPL, pct = 0.07 }) {
  const limit = dailyLossLimit(accountBalance, pct);
  return {
    limit,
    remaining: Math.max(0, limit - Math.max(0, -dayPL)),
    breached: dayPL <= -limit,
    pct,
  };
}
