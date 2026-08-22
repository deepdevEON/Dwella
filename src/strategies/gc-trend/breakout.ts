import type { Bar, Strategy, BarContext, StrategyParams, ParamSpec } from "../../backtest/engine";
import { sma, atr } from "../../backtest/strategies";
import { GC_POINT_VALUE, GC_TICK_SIZE, GC_MIN_STOP_DOLLARS } from "./config";

const ASIAN_START_HOUR = 0;
const ASIAN_END_HOUR = 8;

function getDayKey(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function isAsianSession(unixSeconds: number): boolean {
  const d = new Date(unixSeconds * 1000);
  const h = d.getUTCHours();
  return h >= ASIAN_START_HOUR && h < ASIAN_END_HOUR;
}

function isNewsEvent(unixSeconds: number): boolean {
  const d = new Date(unixSeconds * 1000);
  const day = d.getUTCDate();
  const weekday = d.getUTCDay();
  if (weekday === 5 && day <= 7) return true;
  if (day >= 10 && day <= 17 && weekday >= 2 && weekday <= 4) return true;
  if (day === 1 || day === 2) return true;
  return false;
}

export function createGCBreakoutStrategy(): Strategy {
  const asianRanges: Map<number, { high: number; low: number; range: number }> = new Map();
  let currentDayKey: number | null = null;

  return {
    id: "gc-breakout",
    name: "GC Asian Breakout",
    description: "Asian session range breakout with volume confirmation. Targets 1x range, stops at 0.5x range.",
    warmupBars: 60,
    params: [
      { key: "volPeriod", label: "Volume MA", min: 10, max: 30, step: 5 },
      { key: "volMult", label: "Volume ×", min: 1, max: 3, step: 0.5 },
      { key: "atrPeriod", label: "ATR Period", min: 10, max: 20, step: 1 },
    ],
    defaults: { volPeriod: 20, volMult: 1.2, atrPeriod: 14 },
    onBar(ctx: BarContext) {
      const { bars, index, params, position } = ctx;
      const volPeriod = Number(params.volPeriod);
      const volMult = Number(params.volMult);
      const atrPeriod = Number(params.atrPeriod);

      if (index < volPeriod + 2) return;

      const bar = bars[index];
      const dayKey = getDayKey(bar.time);
      const asian = isAsianSession(bar.time);

      if (currentDayKey !== dayKey) {
        currentDayKey = dayKey;
      }

      if (asian) {
        if (!asianRanges.has(dayKey)) {
          asianRanges.set(dayKey, { high: bar.high, low: bar.low, range: 0 });
        }
        const cached = asianRanges.get(dayKey)!;
        cached.high = Math.max(cached.high, bar.high);
        cached.low = Math.min(cached.low, bar.low);
        cached.range = cached.high - cached.low;
        return;
      }

      const cached = asianRanges.get(dayKey);
      if (!cached || cached.range <= 0) return;

      let volumeSum = 0;
      for (let i = index - volPeriod + 1; i <= index; i++) volumeSum += bars[i].volume;
      const volAvg = volumeSum / volPeriod;
      if (volAvg <= 0) return;

      const a = atr(bars, atrPeriod, index) ?? 0;
      if (a <= 0) return;

      const volConfirm = bar.volume > volAvg * volMult;
      if (!volConfirm) return;

      if (position) return;
      if (isNewsEvent(bar.time)) return;

      const breakUp = bar.high > cached.high && bar.close > cached.high;
      const breakDn = bar.low < cached.low && bar.close < cached.low;

      const targetDist = cached.range;
      const stopDist = Math.max(cached.range * 0.5, GC_MIN_STOP_DOLLARS / GC_POINT_VALUE);

      if (breakUp) {
        ctx.buy({
          sl: bar.close - stopDist,
          tp: bar.close + targetDist,
        });
      } else if (breakDn) {
        ctx.sell({
          sl: bar.close + stopDist,
          tp: bar.close - targetDist,
        });
      }
    },
  };
}

export const GCBreakoutStrategy = createGCBreakoutStrategy();
