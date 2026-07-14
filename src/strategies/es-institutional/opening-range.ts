import type { Strategy, BarContext } from "../../backtest/engine";
import { ES_TICK, isRTH } from "../institutional/config";

interface OrState {
  sessionKey: string;
  orHigh: number;
  orLow: number;
  orComplete: boolean;
  inTrade: boolean;
  orVolumeSum: number;
  orBarCount: number;
}

const orStateMap = new Map<string, OrState>();
const sessionKeyFn = (bar: { time: number }): string => {
  const d = new Date(bar.time * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
};

function inferTfMinutes(bars: { time: number }[], index: number): number {
  if (index < 1) return 5;
  const diff = bars[index].time - bars[index - 1].time;
  const mins = Math.round(diff / 60);
  if ([1, 5, 15, 30, 60, 240, 1440].includes(mins)) return mins;
  const approx = mins > 0 ? mins : 5;
  return Math.max(1, approx);
}

const esOpeningRange: Strategy = {
  id: "es-opening-range",
  name: "ES Opening Range Breakout",
  description: "First 15/30 min range breakout with volume surge confirmation. RTH only.",
  warmupBars: 60,
  params: [
    { key: "rangeMin", label: "Range (minutes)", min: 15, max: 30, step: 15 },
    { key: "volSurgeMult", label: "Volume Surge ×", min: 1.5, max: 5, step: 0.5 },
  ],
  defaults: { rangeMin: 15, volSurgeMult: 2 },
  onBar(ctx: BarContext) {
    const { bars, index, params, position, symbol } = ctx;
    if (index < 5) return;
    const bar = bars[index];
    if (!isRTH(bar)) {
      if (position) ctx.close("rth-close");
      return;
    }
    const sym = symbol;
    const sk = sessionKeyFn(bar);
    let state = orStateMap.get(sym);
    if (!state || state.sessionKey !== sk) {
      if (state) orStateMap.delete(sym);
      state = {
        sessionKey: sk,
        orHigh: -Infinity,
        orLow: Infinity,
        orComplete: false,
        inTrade: false,
        orVolumeSum: 0,
        orBarCount: 0,
      };
      orStateMap.set(sym, state);
    }
    const rangeBars = Number(params.rangeMin);
    const tfMins = inferTfMinutes(bars, index);
    const orBarsNeeded = Math.max(1, Math.ceil(rangeBars / tfMins));
    if (!state.orComplete) {
      state.orHigh = Math.max(state.orHigh, bar.high);
      state.orLow = Math.min(state.orLow, bar.low);
      state.orVolumeSum += bar.volume;
      state.orBarCount++;
      if (state.orBarCount >= orBarsNeeded) {
        state.orComplete = true;
      }
      return;
    }
    if (state.inTrade) return;
    if (position) {
      state.inTrade = true;
      return;
    }
    const avgVol = state.orVolumeSum / state.orBarCount;
    const volOk = bar.volume > avgVol * Number(params.volSurgeMult);
    if (!volOk) return;
    const range = state.orHigh - state.orLow;
    if (range <= 0) return;
    const target = range;
    const stop = 0.5 * range;
    if (bar.close > state.orHigh) {
      state.inTrade = true;
      ctx.buy({
        sl: bar.close - stop,
        tp: bar.close + target,
        label: "or-long",
      });
    } else if (bar.close < state.orLow) {
      state.inTrade = true;
      ctx.sell({
        sl: bar.close + stop,
        tp: bar.close - target,
        label: "or-short",
      });
    }
  },
};

export { esOpeningRange as ESOpeningRangeStrategy };
