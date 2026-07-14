/**
 * DataManager — loads historical OHLCV bars from the MT5 bridge (or synthetic fallback),
 * handles multiple timeframes simultaneously, aligns higher timeframes to the base
 * series, and fills calendar gaps (weekends / sessions) so the engine never sees a hole.
 */

import { Bar, Timeframe, timeframeSeconds, generateSyntheticBars } from "../replay-engine";

export interface MultiTimeframeData {
  symbol: string;
  base: Timeframe;
  /** Raw (gap-filled) per-timeframe series, keyed by timeframe. */
  series: Partial<Record<Timeframe, Bar[]>>;
  /** For each base bar index, the active bar of each higher timeframe (or null). */
  aligned: Partial<Record<Timeframe, (Bar | null)[]>>;
  gapsFilled: number;
}

export interface LoadOptions {
  /** Number of base-timeframe bars to request when no date window is given. */
  count?: number;
  startDate?: number;
  endDate?: number;
  /** Force synthetic data instead of querying the bridge. */
  synthetic?: boolean;
}

export type BarsProvider = (
  symbol: string,
  tf: Timeframe,
  opts: { count: number; startDate?: number; endDate?: number },
) => Promise<Bar[]>;

/** Bridge provider — maps MT5 MarketBar (ms timestamps) into our seconds-based Bar. */
function bridgeProvider(
  symbol: string,
  tf: Timeframe,
  opts: { count: number; startDate?: number; endDate?: number },
): Promise<Bar[]> {
  if (typeof window === "undefined" || !(window as { dwella?: unknown }).dwella) {
    return Promise.resolve([]);
  }
  const w = window as unknown as {
    dwella?: {
      getMarketBars?: (
        s: string,
        t: string,
        c?: number,
      ) => Promise<{ ok?: boolean; bars?: { t: number; o: number; h: number; l: number; c: number; v: number }[] }>;
    };
  };
  const getBars = w.dwella?.getMarketBars;
  if (!getBars) return Promise.resolve([]);
  return getBars(symbol, tf, opts.count).then(res => {
    if (!res?.ok || !res.bars) return [];
    return res.bars
      .map(b => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
      .sort((a, b) => a.time - b.time);
  });
}

export class DataManager {
  private provider: BarsProvider;

  constructor(provider?: BarsProvider) {
    this.provider = provider ?? bridgeProvider;
  }

  /**
   * Load base + additional timeframes, gap-fill each, and align the higher TFs to the
   * base series. Falls back to deterministic synthetic data when the bridge returns
   * nothing (so the UI + reports always have something to show in offline/dev mode).
   */
  async load(symbol: string, base: Timeframe, additional: Timeframe[] = [], opts: LoadOptions = {}): Promise<MultiTimeframeData> {
    const timeframes = [base, ...additional.filter(tf => tf !== base)];
    const count = opts.count ?? this.defaultCount(base);

    const raw: Partial<Record<Timeframe, Bar[]>> = {};
    await Promise.all(
      timeframes.map(async tf => {
        let bars = await this.provider(symbol, tf, { count, startDate: opts.startDate, endDate: opts.endDate });
        if (opts.synthetic || !bars.length) {
          bars = generateSyntheticBars(symbol, count, tf);
        }
        const filled = DataManager.gapFill(bars, tf);
        raw[tf] = filled.bars;
      }),
    );

    const baseBars = raw[base] ?? [];
    if (!baseBars.length) {
      throw new Error(`No data available for ${symbol} ${base} (bridge offline and synthetic fallback empty).`);
    }

    const aligned: Partial<Record<Timeframe, (Bar | null)[]>> = {};
    let gapsFilled = 0;
    for (const tf of timeframes) {
      const series = raw[tf];
      if (!series) continue;
      const { bars, filled } = DataManager.gapFill(series, tf);
      raw[tf] = bars;
      gapsFilled += filled;
      if (tf !== base) aligned[tf] = DataManager.alignToBase(baseBars, bars);
    }

    if (opts.startDate !== undefined || opts.endDate !== undefined) {
      for (const tf of timeframes) {
        const s = raw[tf];
        if (s) raw[tf] = s.filter(b => (opts.startDate === undefined || b.time >= opts.startDate) && (opts.endDate === undefined || b.time <= opts.endDate));
      }
      // re-align after date filter
      for (const tf of timeframes) {
        if (tf === base) continue;
        const s = raw[tf];
        if (s) aligned[tf] = DataManager.alignToBase(raw[base] ?? [], s);
      }
    }

    return { symbol, base, series: raw, aligned, gapsFilled };
  }

  /** Reasonable default lookback (bars) per timeframe. */
  defaultCount(base: Timeframe): number {
    switch (base) {
      case "M1": return 20000;
      case "M5": return 8000;
      case "M15": return 4000;
      case "H1": return 1500;
      case "H4": return 1200;
      case "D1": return 750;
      default: return 2000;
    }
  }

  /**
   * Insert synthetic flat bars where the series jumps by more than one period. Used to
   * bridge weekends / sessions so indicator math and alignment stay continuous.
   */
  static gapFill(bars: Bar[], tf: Timeframe): { bars: Bar[]; filled: number } {
    if (bars.length < 2) return { bars, filled: 0 };
    const interval = timeframeSeconds(tf);
    const out: Bar[] = [bars[0]];
    let filled = 0;
    for (let i = 1; i < bars.length; i++) {
      const prev = out[out.length - 1];
      const gap = Math.round((bars[i].time - prev.time) / interval);
      if (gap > 1) {
        for (let k = 1; k < gap; k++) {
          const t = prev.time + k * interval;
          out.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0 });
          filled++;
        }
      }
      out.push(bars[i]);
    }
    return { bars: out, filled };
  }

  /** For each base bar, find the latest higher-TF bar whose time <= base bar time. */
  static alignToBase(baseBars: Bar[], higherBars: Bar[]): (Bar | null)[] {
    const out: (Bar | null)[] = new Array(baseBars.length).fill(null);
    let hi = 0;
    for (let i = 0; i < baseBars.length; i++) {
      const bt = baseBars[i].time;
      while (hi < higherBars.length && higherBars[hi].time <= bt) hi++;
      out[i] = hi > 0 ? higherBars[hi - 1] : null;
    }
    return out;
  }
}
