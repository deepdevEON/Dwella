// indicators.js
// Dwella indicator & analysis helpers implementing the video's methodology:
//   - 5-min ATR (+15% buffer) as the confirmation metric
//   - Volume profile composites (HVN / LVN / POC / 70% value area)
//   - Balance areas (tops & bottoms, high volume nodes)
//   - Gamma / GEX levels (dealer positioning)
//   - Fail balance breakout detection
// Pure functions — no dependencies.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------
// ATR — Wilder's average true range over `period` candles
// ------------------------------------------------------------------
export function computeATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const start = Math.max(0, candles.length - period - 1);
  const trs = [];
  for (let i = start + 1; i < candles.length; i++) {
    const c = candles[i];
    const prevC = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevC), Math.abs(c.low - prevC)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// Confirmation threshold from the video: ATR + 15%
export function confirmationDistance(atr) {
  return atr * 1.15;
}

// ------------------------------------------------------------------
// Volume profile — builds price buckets from candle volume
// ------------------------------------------------------------------
export function buildVolumeProfile(candles, { bucketSteps = 12 } = {}) {
  const buckets = {};
  for (const c of candles) {
    const range = c.high - c.low || 0.0001;
    for (let s = 0; s <= bucketSteps; s++) {
      const px = Number((c.low + (range * s) / bucketSteps).toFixed(4));
      buckets[px] = (buckets[px] || 0) + c.volume / (bucketSteps + 1);
    }
  }
  return Object.entries(buckets)
    .map(([price, volume]) => ({ price: Number(price), volume }))
    .sort((a, b) => a.price - b.price);
}

// Value area: the range containing 70% of volume around the POC (video: "70% of trade occurred")
export function valueArea(profile, pct = 0.7) {
  if (!profile.length) return { poc: 0, high: 0, low: 0 };
  const total = profile.reduce((a, b) => a + b.volume, 0);
  const poc = profile.reduce((a, b) => (b.volume > a.volume ? b : a));
  // Expand outward from POC until we capture pct of volume
  let idx = profile.findIndex((p) => p.price === poc.price);
  if (idx === -1) idx = 0;
  let lo = idx;
  let hi = idx;
  let acc = poc.volume;
  const target = total * pct;
  while (acc < target && (lo > 0 || hi < profile.length - 1)) {
    const volLo = lo > 0 ? profile[lo - 1].volume : -1;
    const volHi = hi < profile.length - 1 ? profile[hi + 1].volume : -1;
    if (volLo >= volHi && lo > 0) {
      lo--;
      acc += profile[lo].volume;
    } else if (hi < profile.length - 1) {
      hi++;
      acc += profile[hi].volume;
    } else if (lo > 0) {
      lo--;
      acc += profile[lo].volume;
    } else break;
  }
  return {
    poc: poc.price,
    high: profile[hi].price,
    low: profile[lo].price,
    valueAreaVolume: acc,
    totalVolume: total,
  };
}

// High volume nodes: prices with volume >= 1.5x the average bucket
export function highVolumeNodes(profile) {
  if (!profile.length) return [];
  const avg = profile.reduce((a, b) => a + b.volume, 0) / profile.length;
  return profile.filter((p) => p.volume >= avg * 1.5).map((p) => p.price);
}

// ------------------------------------------------------------------
// Balance areas — detect recent consolidation (top & bottom)
// ------------------------------------------------------------------
export function detectBalanceAreas(candles, window = 20, rangePct = 0.25) {
  if (candles.length < window) return [];
  const areas = [];
  const last = candles.length;
  const range = candles.slice(-window);
  const hi = Math.max(...range.map((c) => c.high));
  const lo = Math.min(...range.map((c) => c.low));
  const mid = (hi + lo) / 2;
  const pct = ((hi - lo) / mid) * 100;
  if (pct <= rangePct) {
    areas.push({
      high: hi,
      low: lo,
      mid,
      pct,
      end: last,
      type: 'balance',
    });
  }
  return areas;
}

// ------------------------------------------------------------------
// Gamma levels (GEX) — dealer hedging magnets
// ------------------------------------------------------------------
export function detectGammaLevels(profile, price, count = 5) {
  if (!profile.length) return [];
  const poc = profile.reduce((a, b) => (b.volume > a.volume ? b : a)).price;
  const step = Math.max((profile[profile.length - 1].price - profile[0].price) / 14, 0.0001);
  const levels = [];
  for (let i = 1; i <= count; i++) {
    levels.push({ price: poc + i * step, type: 'resistance', strength: 1 + (i % 3) * 0.3 });
    levels.push({ price: poc - i * step, type: 'support', strength: 1 + (i % 3) * 0.3 });
  }
  // sort by proximity to price
  return levels
    .map((l) => ({ ...l, dist: Math.abs(l.price - price) }))
    .sort((a, b) => a.dist - b.dist)
    .map(({ dist, ...l }) => l)
    .slice(0, count * 2);
}

// ------------------------------------------------------------------
// Fail balance breakout — the "best position trade in trading"
// ------------------------------------------------------------------
export function detectFailBreakout(candles, balanceAreas) {
  if (!balanceAreas.length || candles.length < 3) return null;
  const area = balanceAreas[balanceAreas.length - 1];
  const recent = candles.slice(-3);
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];
  // Broke above the balance high, then closed back inside → fail breakout (bearish)
  if (prev.high > area.high && last.close < area.high && last.close < area.mid) {
    return { dir: 'short', area, price: last.close, reason: 'Fail balance breakout (bearish)' };
  }
  if (prev.low < area.low && last.close > area.low && last.close > area.mid) {
    return { dir: 'long', area, price: last.close, reason: 'Fail balance breakout (bullish)' };
  }
  return null;
}

// ------------------------------------------------------------------
// Session bias — simple trend read for the bias panel
// ------------------------------------------------------------------
export function sessionBias(candles) {
  if (candles.length < 24) return { bias: 'Neutral', confidence: 50 };
  const emaFast = ema(candles.map((c) => c.close), 8);
  const emaSlow = ema(candles.map((c) => c.close), 21);
  const lastFast = emaFast[emaFast.length - 1];
  const lastSlow = emaSlow[emaSlow.length - 1];
  const delta = candles.slice(-24).reduce((a, c) => a + c.delta, 0);
  if (lastFast > lastSlow && delta > 0) return { bias: 'Bullish', confidence: Math.min(92, 55 + Math.abs(delta) * 0.4) };
  if (lastFast < lastSlow && delta < 0) return { bias: 'Bearish', confidence: Math.min(92, 55 + Math.abs(delta) * 0.4) };
  return { bias: 'Neutral', confidence: 50 };
}

// ------------------------------------------------------------------
// EMA
// ------------------------------------------------------------------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// ------------------------------------------------------------------
// Candle-based event detection for LIVE TradingView feeds (no level-2 depth).
// Approximates the video's iceberg/stop-run edge from real M5 candles:
//   - a wick that sweeps beyond the recent range extreme = stop run
//   - a large-range candle that closes back near its open = iceberg-style absorption
// Returns events shaped like the engine's ({ type, dir, price, ... }).
// ------------------------------------------------------------------
export function deriveCandleEvents(candles, lookback = 12, scanN = 4) {
  if (!candles || candles.length < lookback + scanN + 1) return [];
  const events = [];
  const n = candles.length;
  // Scan the most recent few M5 candles — each is judged against its OWN
  // prior window so the live radar has real recent sweeps, not just the
  // very last bar.
  for (let i = n - scanN; i < n; i++) {
    const last = candles[i];
    const prior = candles.slice(Math.max(0, i - lookback), i);
    if (prior.length < 5) continue;
    const hi = Math.max(...prior.map((c) => c.high));
    const lo = Math.min(...prior.map((c) => c.low));
    const body = Math.abs(last.close - last.open) || 0.0001;
    const range = last.high - last.low || 0.0001;
    const time = (last.time ?? Date.now() / 1000) * 1000;
    const id = last.time ?? Math.floor(time);

    // Swept above the recent high and closed off the high → retail stops above got hit
    if (last.high > hi && last.close < last.high - body * 0.2) {
      events.push({
        type: 'stop-run',
        dir: 'up',
        price: last.high,
        sweptFrom: hi,
        size: Number((last.high - lo).toFixed(2)),
        time,
        id: `live-up-${id}`,
      });
    }
    // Swept below the recent low and closed off the low → retail stops below got hit
    if (last.low < lo && last.close > last.low + body * 0.2) {
      events.push({
        type: 'stop-run',
        dir: 'down',
        price: last.low,
        sweptFrom: lo,
        size: Number((hi - last.low).toFixed(2)),
        time,
        id: `live-dn-${id}`,
      });
    }
    // Large-range candle that absorbed and closed flat → iceberg-style resting size
    if (range >= (hi - lo) * 0.6 && body <= range * 0.25) {
      const dir = last.close >= last.open ? 'bid' : 'ask';
      const vol = last.volume || 0;
      events.push({
        type: 'iceberg',
        dir,
        price: last.close,
        displayed: Math.round(vol * 0.1),
        revealed: Math.round(vol * 0.25),
        total: Math.round(vol * 0.35),
        time,
        id: `live-ice-${id}`,
      });
    }
  }
  return events;
}
