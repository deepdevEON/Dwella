import type { Bar } from "../../replay-engine";

export const ES_TICK = 0.25;

const RTH_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function isRTH(bar: Bar): boolean {
  const parts = RTH_FORMAT.formatToParts(new Date(bar.time * 1000));
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") m = Number(p.value);
  }
  const mins = h * 60 + m;
  // ES futures regular trading hours: 9:30 AM - 4:00 PM CT (DST-aware via tz).
  return mins >= 570 && mins < 960;
}

export function sameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate();
}

export interface VolumeNode {
  price: number;
  volume: number;
}

export interface ValueArea {
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
}

export function buildVolumeProfile(bars: Bar[]): VolumeNode[] {
  const map = new Map<number, number>();
  for (const b of bars) {
    const p = Math.round(b.close / ES_TICK) * ES_TICK;
    const v = map.get(p) ?? 0;
    map.set(p, v + b.volume);
  }
  return Array.from(map.entries())
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => a.price - b.price);
}

export function computeValueArea(nodes: VolumeNode[]): ValueArea | null {
  if (nodes.length === 0) return null;
  const totalVolume = nodes.reduce((s, n) => s + n.volume, 0);
  const target = totalVolume * 0.7;
  let maxNode = nodes[0];
  for (const n of nodes) {
    if (n.volume > maxNode.volume) maxNode = n;
  }
  let idx = nodes.findIndex(n => n.price === maxNode.price);
  if (idx === -1) return null;
  let lo = idx, hi = idx, sum = maxNode.volume;
  while (sum < target && (lo > 0 || hi < nodes.length - 1)) {
    const nextLo = lo > 0 ? nodes[lo - 1] : null;
    const nextHi = hi < nodes.length - 1 ? nodes[hi + 1] : null;
    if (nextHi === null || (nextLo !== null && nextLo.volume >= nextHi.volume)) {
      lo--;
      sum += nodes[lo].volume;
    } else {
      hi++;
      sum += nodes[hi].volume;
    }
  }
  return {
    poc: maxNode.price,
    vah: nodes[hi].price,
    val: nodes[lo].price,
    totalVolume,
  };
}

export function vwap(bars: Bar[], endIndex: number): number | null {
  if (endIndex < 0) return null;
  let sumPV = 0, sumV = 0;
  for (let i = 0; i <= endIndex; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    sumPV += tp * bars[i].volume;
    sumV += bars[i].volume;
  }
  if (sumV === 0) return null;
  return sumPV / sumV;
}

export function vwapStdDev(bars: Bar[], endIndex: number, vwapVal: number): number | null {
  if (endIndex < 0) return null;
  let sumPV2 = 0, sumV = 0;
  for (let i = 0; i <= endIndex; i++) {
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
    const diff = tp - vwapVal;
    sumPV2 += bars[i].volume * diff * diff;
    sumV += bars[i].volume;
  }
  if (sumV === 0) return null;
  return Math.sqrt(sumPV2 / sumV);
}

export function rsi(bars: Bar[], period: number, endIndex: number): number | null {
  if (endIndex < period) return null;
  let gain = 0, loss = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  const avgGain = gain / period, avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function ema(bars: Bar[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period) return null;
  const k = 2 / (period + 1);
  let e = bars[endIndex - period + 1].close;
  for (let i = endIndex - period + 2; i <= endIndex; i++) {
    e = bars[i].close * k + e * (1 - k);
  }
  return e;
}

export function stdDev(bars: Bar[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period) return null;
  const slice = bars.slice(endIndex - period + 1, endIndex + 1);
  const mean = slice.reduce((s, b) => s + b.close, 0) / slice.length;
  const variance = slice.reduce((s, b) => s + (b.close - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function findExtrema(bars: Bar[], from: number, to: number, type: "low" | "high"): number[] {
  const res: number[] = [];
  if (to - from < 2) return res;
  for (let i = from; i <= to; i++) {
    const v = type === "low" ? bars[i].low : bars[i].high;
    const prev = type === "low" ? bars[i - 1].low : bars[i - 1].high;
    const next = type === "low" ? bars[i + 1].low : bars[i + 1].high;
    if (v <= prev && v <= next) res.push(i);
  }
  return res;
}

export function detectDivergence(
  bars: Bar[],
  lookback: number,
  endIndex: number,
  rsiPeriod = 14,
): "bullish" | "bearish" | null {
  if (endIndex < lookback + rsiPeriod + 1) return null;
  const start = Math.max(rsiPeriod + 1, endIndex - lookback);
  // Bullish divergence: price makes a lower low while RSI makes a higher low.
  const lows = findExtrema(bars, start, endIndex, "low");
  if (lows.length >= 2) {
    const a = lows[lows.length - 2];
    const b = lows[lows.length - 1];
    const rsiA = rsi(bars, rsiPeriod, a);
    const rsiB = rsi(bars, rsiPeriod, b);
    if (
      rsiA !== null && rsiB !== null &&
      bars[b].low < bars[a].low &&
      rsiB > rsiA
    ) {
      return "bullish";
    }
  }
  // Bearish divergence: price makes a higher high while RSI makes a lower high.
  const highs = findExtrema(bars, start, endIndex, "high");
  if (highs.length >= 2) {
    const a = highs[highs.length - 2];
    const b = highs[highs.length - 1];
    const rsiA = rsi(bars, rsiPeriod, a);
    const rsiB = rsi(bars, rsiPeriod, b);
    if (
      rsiA !== null && rsiB !== null &&
      bars[b].high > bars[a].high &&
      rsiB < rsiA
    ) {
      return "bearish";
    }
  }
  return null;
}

export function isRegularTradingHours(bar: Bar): boolean {
  return isRTH(bar);
}
