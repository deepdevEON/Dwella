import type { Bar, Strategy, BarContext, StrategyParams, ParamSpec } from "../../backtest/engine";
import { sma, rsi, atr } from "../../backtest/strategies";
import { NQ_POINT_VALUE, NQ_MIN_STOP_DOLLARS, MODE_CONFIGS, resolveModeParams, type StrategyMode } from "./config";

export function bollingerBands(bars: Bar[], period: number, mult: number, endIndex: number): { mid: number; upper: number; lower: number } | null {
  if (endIndex + 1 < period) return null;
  const mid = sma(bars, period, endIndex);
  if (mid === null) return null;
  let sumSq = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const diff = bars[i].close - mid;
    sumSq += diff * diff;
  }
  const std = Math.sqrt(sumSq / period);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  return { mid, upper, lower };
}

export function createNQOptimizedStrategy(mode?: StrategyMode): Strategy {
  const defaults = resolveModeParams(mode, {});

  return {
    id: "nq-optimized",
    name: "NQ Bollinger Mean Reversion",
    description: "Mean-reversion variant for ranging NQ markets. Bollinger Bands (20,2) + RSI confirmation.",
    warmupBars: 250,
    params: [
      { key: "bbPeriod", label: "BB Period", min: 10, max: 40, step: 5 },
      { key: "bbStd", label: "BB Std Dev ×", min: 1, max: 3, step: 0.25 },
      { key: "rsiPeriod", label: "RSI Period", min: 7, max: 21, step: 1 },
      { key: "rsiLong", label: "RSI Long Entry", min: 15, max: 40, step: 5 },
      { key: "rsiShort", label: "RSI Short Entry", min: 60, max: 85, step: 5 },
      { key: "atrMultSl", label: "SL ATR ×", min: 1, max: 4, step: 0.25 },
      { key: "atrMultTrail", label: "Trail ATR ×", min: 1, max: 4, step: 0.5 },
      { key: "atrMinMultiplier", label: "ATR Min ×", min: 1, max: 5, step: 0.5 },
    ],
    defaults: {
      ...defaults,
      bbPeriod: 20,
      bbStd: 2.0,
      rsiPeriod: 14,
      rsiLong: 30,
      rsiShort: 70,
    },
    onBar(ctx: BarContext) {
      const { bars, index, params, position } = ctx;
      const bbPeriod = Number(params.bbPeriod) || 20;
      const bbStd = Number(params.bbStd) || 2.0;
      const rsiPeriod = Number(params.rsiPeriod) || 14;
      const rsiLong = Number(params.rsiLong) ?? 30;
      const rsiShort = Number(params.rsiShort) ?? 70;
      const atrMultSl = Number(params.atrMultSl) ?? 2;
      const atrMultTrail = Number(params.atrMultTrail) ?? 2;
      const atrMinMult = Number(params.atrMinMultiplier) ?? 2;

      if (index < bbPeriod + rsiPeriod + 1) return;

      const bb = bollingerBands(bars, bbPeriod, bbStd, index);
      if (!bb) return;

      const a = atr(bars, 14, index) ?? 0;
      if (a <= 0) return;

      const minStop = NQ_MIN_STOP_DOLLARS / NQ_POINT_VALUE;
      const slDist = Math.max(a * atrMultSl, minStop * atrMinMult);
      const price = bars[index].close;
      const r = rsi(bars, rsiPeriod, index);
      if (r === null) return;

      if (position) {
        const trailDist = a * atrMultTrail;
        const posSide = position.side;

        if (posSide === "long") {
          let peak = position.entryPrice;
          for (let i = position.entryBar; i <= index; i++) {
            peak = Math.max(peak, bars[i].high);
          }
          const trailStop = peak - trailDist;
          if (trailStop > position.entryPrice && bars[index].low <= trailStop) {
            ctx.close("trailing-stop");
            return;
          }
          if (price >= bb.mid) {
            ctx.close("mid-band");
            return;
          }
          if (r > 50) {
            ctx.close("rsi-mid");
            return;
          }
        } else {
          let trough = position.entryPrice;
          for (let i = position.entryBar; i <= index; i++) {
            trough = Math.min(trough, bars[i].low);
          }
          const trailStop = trough + trailDist;
          if (trailStop < position.entryPrice && bars[index].high >= trailStop) {
            ctx.close("trailing-stop");
            return;
          }
          if (price <= bb.mid) {
            ctx.close("mid-band");
            return;
          }
          if (r < 50) {
            ctx.close("rsi-mid");
            return;
          }
        }
        return;
      }

      if (price <= bb.lower && r < rsiLong) {
        ctx.buy({
          sl: price - slDist,
          tp: bb.mid,
        });
      } else if (price >= bb.upper && r > rsiShort) {
        ctx.sell({
          sl: price + slDist,
          tp: bb.mid,
        });
      }
    },
  };
}

export const NQOptimizedStrategy = createNQOptimizedStrategy();
