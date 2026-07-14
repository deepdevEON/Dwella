/**
 * IndicatorLibrary — built-in technical indicators for the visual strategy builder.
 *
 * Pure TypeScript, no DOM. Each indicator exposes:
 *   - a parameter schema (ParamSpec) used by the properties panel,
 *   - a `compute` that returns a named record of series (e.g. MACD returns
 *     { macd, signal, hist }) evaluated at a given bar index,
 *   - a `minWarmup` estimate so the validator/backtest can skip cold bars.
 *
 * Results are cached per (indicator + params + bars-reference + index) via a
 * lightweight IndicatorCache to avoid recomputing identical series many times
 * within a single bar evaluation (e.g. when two blocks reference RSI 14).
 */

import type { Bar } from "../replay-engine";
import type { ParamSpec } from "../backtest/engine";

export type IndicatorId =
  | "SMA"
  | "EMA"
  | "RSI"
  | "MACD"
  | "BOLL"
  | "ATR"
  | "VOL"
  | "VWAP";

export type SeriesValues = Record<string, number | null>;

export interface IndicatorDef {
  id: IndicatorId;
  name: string;
  category: "trend" | "momentum" | "volatility" | "volume";
  description: string;
  params: ParamSpec[];
  /** Output series names (first is the "primary" series for single-value comparisons). */
  series: string[];
  /** Minimum bars required before the indicator produces a non-null value. */
  minWarmup(params: Record<string, number>): number;
  compute(bars: Bar[], params: Record<string, number>, index: number): SeriesValues;
}

function p(params: Record<string, number>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

function smaSeries(bars: Bar[], period: number, index: number): number | null {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += bars[i].close;
  return sum / period;
}

function emaSeries(bars: Bar[], period: number, index: number): number | null {
  if (index + 1 < period) return null;
  const k = 2 / (period + 1);
  let e = bars[index - period + 1].close;
  for (let i = index - period + 2; i <= index; i++) e = bars[i].close * k + e * (1 - k);
  return e;
}

function rsiSeries(bars: Bar[], period: number, index: number): number | null {
  if (index < period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  const avgGain = gain / period;
  const avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atrSeries(bars: Bar[], period: number, index: number): number | null {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

function vwapCumulative(bars: Bar[], index: number): number | null {
  if (index < 0) return null;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i <= index; i++) {
    const b = bars[i];
    const v = b.volume > 0 ? b.volume : 1;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

const INDICATORS: Record<IndicatorId, IndicatorDef> = {
  SMA: {
    id: "SMA",
    name: "Simple Moving Average",
    category: "trend",
    description: "Average of close price over a fixed window.",
    params: [{ key: "period", label: "Period", min: 2, max: 400, step: 1 }],
    series: ["value"],
    minWarmup: (pr) => Math.ceil(p(pr, "period", 20)),
    compute: (bars, pr, i) => ({ value: smaSeries(bars, Math.round(p(pr, "period", 20)), i) }),
  },
  EMA: {
    id: "EMA",
    name: "Exponential Moving Average",
    category: "trend",
    description: "Weighted average that reacts faster than SMA.",
    params: [{ key: "period", label: "Period", min: 2, max: 400, step: 1 }],
    series: ["value"],
    minWarmup: (pr) => Math.ceil(p(pr, "period", 20)),
    compute: (bars, pr, i) => ({ value: emaSeries(bars, Math.round(p(pr, "period", 20)), i) }),
  },
  RSI: {
    id: "RSI",
    name: "Relative Strength Index",
    category: "momentum",
    description: "Momentum oscillator (0–100). Overbought > 70, oversold < 30.",
    params: [{ key: "period", label: "Period", min: 2, max: 100, step: 1 }],
    series: ["value"],
    minWarmup: (pr) => Math.ceil(p(pr, "period", 14)) + 1,
    compute: (bars, pr, i) => ({ value: rsiSeries(bars, Math.round(p(pr, "period", 14)), i) }),
  },
  MACD: {
    id: "MACD",
    name: "MACD",
    category: "momentum",
    description: "Difference of fast/slow EMAs plus a signal line.",
    params: [
      { key: "fast", label: "Fast EMA", min: 2, max: 100, step: 1 },
      { key: "slow", label: "Slow EMA", min: 5, max: 200, step: 1 },
      { key: "signal", label: "Signal", min: 2, max: 100, step: 1 },
    ],
    series: ["macd", "signal", "hist"],
    minWarmup: (pr) => Math.ceil(Math.max(p(pr, "fast", 12), p(pr, "slow", 26))),
    compute: (bars, pr, i) => {
      const fast = Math.round(p(pr, "fast", 12));
      const slow = Math.round(p(pr, "slow", 26));
      const sig = Math.round(p(pr, "signal", 9));
      const ef = emaSeries(bars, fast, i);
      const es = emaSeries(bars, slow, i);
      if (ef === null || es === null) return { macd: null, signal: null, hist: null };
      const macd = ef - es;
      const k = 2 / (sig + 1);
      let emaSig: number | null = null;
      let started = false;
      for (let j = 0; j <= i; j++) {
        const af = emaSeries(bars, fast, j);
        const as = emaSeries(bars, slow, j);
        if (af === null || as === null) continue;
        const m = af - as;
        if (!started) {
          emaSig = m;
          started = true;
        } else {
          emaSig = m * k + (emaSig as number) * (1 - k);
        }
      }
      return {
        macd,
        signal: emaSig,
        hist: emaSig !== null ? macd - emaSig : null,
      };
    },
  },
  BOLL: {
    id: "BOLL",
    name: "Bollinger Bands",
    category: "volatility",
    description: "SMA band ± N standard deviations.",
    params: [
      { key: "period", label: "Period", min: 2, max: 200, step: 1 },
      { key: "mult", label: "StdDev ×", min: 1, max: 5, step: 0.5 },
    ],
    series: ["upper", "middle", "lower"],
    minWarmup: (pr) => Math.ceil(p(pr, "period", 20)),
    compute: (bars, pr, i) => {
      const period = Math.round(p(pr, "period", 20));
      const mult = p(pr, "mult", 2);
      const mid = smaSeries(bars, period, i);
      if (mid === null) return { upper: null, middle: null, lower: null };
      let variance = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = bars[j].close - mid;
        variance += d * d;
      }
      const sd = Math.sqrt(variance / period);
      return { upper: mid + mult * sd, middle: mid, lower: mid - mult * sd };
    },
  },
  ATR: {
    id: "ATR",
    name: "Average True Range",
    category: "volatility",
    description: "Volatility measure of the typical range.",
    params: [{ key: "period", label: "Period", min: 2, max: 100, step: 1 }],
    series: ["value"],
    minWarmup: (pr) => Math.ceil(p(pr, "period", 14)),
    compute: (bars, pr, i) => ({ value: atrSeries(bars, Math.round(p(pr, "period", 14)), i) }),
  },
  VOL: {
    id: "VOL",
    name: "Volume",
    category: "volume",
    description: "Current bar volume vs its SMA baseline.",
    params: [{ key: "period", label: "Avg Period", min: 2, max: 200, step: 1 }],
    series: ["value", "avg"],
    minWarmup: (pr) => Math.ceil(p(pr, "period", 20)),
    compute: (bars, pr, i) => {
      const period = Math.round(p(pr, "period", 20));
      const value = bars[i].volume;
      if (i + 1 >= period) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += bars[j].volume;
        return { value, avg: sum / period };
      }
      return { value, avg: null };
    },
  },
  VWAP: {
    id: "VWAP",
    name: "Volume Weighted Avg Price",
    category: "volume",
    description: "Cumulative volume-weighted average price.",
    params: [],
    series: ["value"],
    minWarmup: () => 1,
    compute: (bars, _pr, i) => ({ value: vwapCumulative(bars, i) }),
  },
};

export const IndicatorLibrary = {
  defs: INDICATORS,
  list(): IndicatorDef[] {
    return Object.values(INDICATORS);
  },
  get(id: IndicatorId): IndicatorDef {
    return INDICATORS[id];
  },
  defaultParams(id: IndicatorId): Record<string, number> {
    const out: Record<string, number> = {};
    for (const spec of INDICATORS[id].params) out[spec.key] = spec.min;
    return out;
  },
  /** Compute an indicator, optionally using a per-evaluation cache. */
  compute(
    id: IndicatorId,
    params: Record<string, number>,
    bars: Bar[],
    index: number,
    cache?: IndicatorCache,
  ): SeriesValues {
    const sig = `${id}|${JSON.stringify(params)}`;
    if (cache) {
      const hit = cache.get(sig, index, bars);
      if (hit) return hit;
      const val = INDICATORS[id].compute(bars, params, index);
      cache.set(sig, index, bars, val);
      return val;
    }
    return INDICATORS[id].compute(bars, params, index);
  },
};

/**
 * IndicatorCache — bounds per-bar recomputation. Keyed by indicator signature and
 * bar index, scoped to a single bars array (the reference is part of the key).
 * The same Map instance should be created fresh for each bar evaluation.
 */
export class IndicatorCache {
  private store = new Map<string, SeriesValues>();
  private barsRef: Bar[];
  private size = 0;
  private static readonly MAX = 2048;

  constructor(bars: Bar[]) {
    this.barsRef = bars;
  }

  get(sig: string, index: number, bars: Bar[]): SeriesValues | null {
    if (bars !== this.barsRef) return null; // different dataset; never reuse
    return this.store.get(`${sig}#${index}`) ?? null;
  }

  set(sig: string, index: number, bars: Bar[], value: SeriesValues): void {
    if (bars !== this.barsRef) return;
    const key = `${sig}#${index}`;
    if (!this.store.has(key)) {
      this.size++;
      if (this.size > IndicatorCache.MAX) {
        const first = this.store.keys().next().value;
        if (first !== undefined) this.store.delete(first as string);
        this.size--;
      }
    }
    this.store.set(key, value);
  }
}
