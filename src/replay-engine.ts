/** Market replay engine — manages step/play/seek playback of historical OHLCV bars. */

export interface Bar {
  time: number;     // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ReplaySpeed = 1 | 2 | 5 | 10 | 50;
export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN";

/** Where the bars came from. Never read in production UI, just diagnostic. */
export type SourceKind = "synthetic" | "mt5";

export interface ReplayState {
  bars: Bar[];
  currentIndex: number;
  isPlaying: boolean;
  speed: ReplaySpeed;
  startedAt: number | null;   // real timestamp when play began
  baseBarTime: number | null; // bar time when play began
  selectedSymbol: string;
  selectedTimeframe: Timeframe;
  sourceKind: SourceKind;
}

/** Build a ReplayState from a pre-fetched bar array (e.g. from MT5). */
export function createReplayFromBars(
  bars: Bar[],
  symbol: string,
  timeframe: Timeframe,
  sourceKind: SourceKind,
): ReplayState {
  return {
    bars,
    currentIndex: 0,
    isPlaying: false,
    speed: 1,
    startedAt: null,
    baseBarTime: null,
    selectedSymbol: symbol,
    selectedTimeframe: timeframe,
    sourceKind,
  };
}

export function currentBar(state: ReplayState): Bar | null {
  return state.bars[state.currentIndex] ?? null;
}

/** Bars from 0 up to currentIndex (for chart rendering of historical progress). */
export function visibleBars(state: ReplayState): Bar[] {
  return state.bars.slice(0, state.currentIndex + 1);
}

/** Real ms between bar advances at the given speed × timeframe. */
export function barIntervalMs(speed: ReplaySpeed, timeframe: Timeframe): number {
  return (timeframeSeconds(timeframe) * 1000) / speed;
}

/** Seconds per bar for a given timeframe. */
export function timeframeSeconds(tf: Timeframe): number {
  switch (tf) {
    case "M1": return 60;
    case "M5": return 300;
    case "M15": return 900;
    case "M30": return 1800;
    case "H1": return 3600;
    case "H4": return 14400;
    case "D1": return 86400;
    case "W1": return 604800;
    case "MN": return 2592000;
  }
}

export function stepForward(state: ReplayState): ReplayState {
  if (state.currentIndex >= state.bars.length - 1) {
    return { ...state, isPlaying: false, startedAt: null, baseBarTime: null };
  }
  return { ...state, currentIndex: state.currentIndex + 1 };
}

export function stepBack(state: ReplayState): ReplayState {
  return { ...state, currentIndex: Math.max(0, state.currentIndex - 1) };
}

export function seekTo(state: ReplayState, index: number): ReplayState {
  return { ...state, currentIndex: Math.max(0, Math.min(index, state.bars.length - 1)) };
}

export function startPlay(state: ReplayState): ReplayState {
  if (state.currentIndex >= state.bars.length - 1) {
    return { ...state, currentIndex: 0, isPlaying: true, startedAt: Date.now(), baseBarTime: null };
  }
  return {
    ...state,
    isPlaying: true,
    startedAt: Date.now(),
    baseBarTime: state.bars[state.currentIndex]?.time ?? null,
  };
}

export function pausePlay(state: ReplayState): ReplayState {
  return { ...state, isPlaying: false, startedAt: null, baseBarTime: null };
}

export function setSpeed(state: ReplayState, speed: ReplaySpeed): ReplayState {
  return { ...state, speed };
}

export function restart(state: ReplayState): ReplayState {
  return { ...state, currentIndex: 0, isPlaying: false, startedAt: null, baseBarTime: null };
}

/**
 * Deterministic synthetic bars — used when the MT5 bridge is offline so the
 * Replay panel still demonstrates the playback + paper-trading flow. Spacing
 * respects `timeframeSeconds(tf)` so the chart isn't lying about gap minutes.
 */
export function generateSyntheticBars(symbol: string, count: number, tf: Timeframe): Bar[] {
  const seconds = timeframeSeconds(tf);
  const mul = tf === "M1" || tf === "M5" ? 1 : tf === "H1" ? 1 : 1;
  const mean =
    symbol === "NQ" ? 18500 :
    symbol === "ES" ? 5390 :
    symbol === "GC" ? 2350 :
    symbol === "EURUSD" ? 1.0854 :
    100;
  const sigma =
    symbol === "NQ" ? 4 :
    symbol === "ES" ? 0.9 :
    symbol === "GC" ? 1.4 :
    symbol === "EURUSD" ? 0.0009 :
    1;

  // Deterministic LCG so dev runs are reproducible.
  let seed = [...`${symbol}|${tf}`].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) / 0xffffff; };

  const bars: Bar[] = [];
  let price = mean;
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * seconds;
  for (let i = 0; i < count; i++) {
    const drift = (mean - price) * 0.003;
    const shock = (rnd() - 0.5) * 2 * sigma * mul;
    const o = price;
    const c = o + drift + shock;
    const h = Math.max(o, c) + Math.abs(rnd() - 0.5) * 1.6 * sigma * mul;
    const l = Math.min(o, c) - Math.abs(rnd() - 0.5) * 1.6 * sigma * mul;
    price = Math.max(c, mean - 400 * mul);
    bars.push({
      time: start + i * seconds,
      open: round(o),
      high: round(h),
      low: round(l),
      close: round(c),
      volume: Math.floor(rnd() * 800 + 200),
    });
  }
  return bars;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
