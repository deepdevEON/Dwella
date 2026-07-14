import type { Strategy, BarContext } from "../../backtest/engine";
import {
  ES_TICK, isRTH, buildVolumeProfile, computeValueArea,
  vwap, vwapStdDev, rsi, ema, stdDev, detectDivergence,
} from "../institutional/config";

interface DayState {
  key: string;
  poc: number;
  vah: number;
  val: number;
  totalVol: number;
}

const stateMap = new Map<string, DayState>();
const todayBarsMap = new Map<string, { time: number }[]>();
const todayKeyMap = new Map<string, string>();

function dayKey(bar: { time: number }): string {
  const d = new Date(bar.time * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

const esInstitutional: Strategy = {
  id: "es-institutional",
  name: "ES Institutional Flow (POC)",
  description: "Returns to previous day POC with volume profile + institutional absorption. RTH only.",
  warmupBars: 200,
  params: [
    { key: "pocTolerance", label: "POC Tolerance (ticks)", min: 1, max: 8, step: 1 },
    { key: "volMult", label: "Volume Multiplier", min: 1, max: 4, step: 0.5 },
    { key: "targetMult", label: "Target × Value Area", min: 1, max: 3, step: 0.25 },
    { key: "stopMult", label: "Stop × Value Area", min: 0.25, max: 2, step: 0.25 },
  ],
  defaults: { pocTolerance: 2, volMult: 1.5, targetMult: 1.5, stopMult: 0.5 },
  onBar(ctx: BarContext) {
    const { bars, index, params, position, symbol } = ctx;
    if (index < 2) return;
    const bar = bars[index];
    if (!isRTH(bar)) {
      if (position) ctx.close("rth-close");
      return;
    }
    const sym = symbol;
    const dk = dayKey(bar);
    const prevKey = todayKeyMap.get(sym);
    if (prevKey !== dk) {
      if (prevKey && todayBarsMap.has(sym)) {
        const dayBars = todayBarsMap.get(sym)!;
        const rthBars = dayBars.map(t => bars[bars.findIndex(b => b.time === t.time)]).filter((b): b is { time: number; open: number; high: number; low: number; close: number; volume: number } => b !== undefined && isRTH(b));
        if (rthBars.length > 0) {
          const nodes = buildVolumeProfile(rthBars);
          const va = computeValueArea(nodes);
          if (va) {
            stateMap.set(sym, { key: prevKey, poc: va.poc, vah: va.vah, val: va.val, totalVol: va.totalVolume });
          }
        }
      }
      todayKeyMap.set(sym, dk);
      todayBarsMap.set(sym, []);
    }
    const todayArr = todayBarsMap.get(sym) ?? [];
    todayArr.push({ time: bar.time });
    todayBarsMap.set(sym, todayArr);
    const state = stateMap.get(sym);
    if (!state) return;
    if (ctx.position) {
      const width = state.vah - state.val;
      if (width <= 0) return;
      const targetMult = Number(params.targetMult);
      const stopMult = Number(params.stopMult);
      if (ctx.position.side === "long") {
        const target = state.poc + targetMult * width;
        const stop = state.poc - stopMult * width;
        if (bar.close >= target) ctx.close("target");
        else if (bar.close <= stop) ctx.close("stop");
      } else {
        const target = state.poc - targetMult * width;
        const stop = state.poc + stopMult * width;
        if (bar.close <= target) ctx.close("target");
        else if (bar.close >= stop) ctx.close("stop");
      }
      return;
    }
    const tolerance = Number(params.pocTolerance) * ES_TICK;
    const nearPoc = Math.abs(bar.close - state.poc) <= tolerance;
    if (!nearPoc) return;
    const avgVol = state.totalVol / Math.max(1, todayArr.length);
    const volOk = bar.volume > avgVol * Number(params.volMult);
    if (!volOk) return;
    const bodySize = Math.abs(bar.close - bar.open);
    const rangeSize = Math.max(bar.high - bar.low, ES_TICK);
    const absorption = bodySize / rangeSize < 0.5;
    if (!absorption) return;
    const width = state.vah - state.val;
    if (width <= 0) return;
    const targetMult = Number(params.targetMult);
    const stopMult = Number(params.stopMult);
    if (bar.close > state.poc) {
      ctx.buy({
        sl: state.poc - stopMult * width,
        tp: state.poc + targetMult * width,
        label: "poc-long",
      });
    } else if (bar.close < state.poc) {
      ctx.sell({
        sl: state.poc + stopMult * width,
        tp: state.poc - targetMult * width,
        label: "poc-short",
      });
    }
  },
};

export { esInstitutional as ESInstitutionalStrategy };
