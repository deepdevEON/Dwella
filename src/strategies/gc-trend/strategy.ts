import type { Bar, Strategy, BarContext, StrategyParams, ParamSpec } from "../../backtest/engine";
import { ema, sma, atr } from "../../backtest/strategies";
import { GC_POINT_VALUE, GC_TICK_SIZE, GC_ADX_PERIOD, GC_ADX_THRESHOLD, GC_MIN_STOP_DOLLARS } from "./config";

function createAdxComputer(period: number) {
  let smoothTr = 0;
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  let initialized = false;
  const dxValues: number[] = [];
  let lastAdx: number | null = null;
  let lastIndex = -1;

  return function compute(bars: Bar[], endIndex: number): number | null {
    if (endIndex < 2 * period) return null;

    const start = initialized ? lastIndex + 1 : period + 1;

    for (let i = start; i <= endIndex; i++) {
      if (!initialized) {
        for (let j = 1; j <= period; j++) {
          smoothTr += Math.max(
            bars[j].high - bars[j].low,
            Math.abs(bars[j].high - bars[j - 1].close),
            Math.abs(bars[j].low - bars[j - 1].close),
          );
          const upMove = bars[j].high - bars[j - 1].high;
          const downMove = bars[j - 1].low - bars[j].low;
          smoothPlusDm += upMove > downMove && upMove > 0 ? upMove : 0;
          smoothMinusDm += downMove > upMove && downMove > 0 ? downMove : 0;
        }
        initialized = true;
      }

      const tr = Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close),
      );
      const upMove = bars[i].high - bars[i - 1].high;
      const downMove = bars[i - 1].low - bars[i].low;
      const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

      smoothTr = smoothTr - smoothTr / period + tr;
      smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDm;
      smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDm;

      if (smoothTr === 0) {
        dxValues.push(0);
      } else {
        const plusDi = 100 * smoothPlusDm / smoothTr;
        const minusDi = 100 * smoothMinusDm / smoothTr;
        const dx = plusDi + minusDi === 0 ? 0 : 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi);
        dxValues.push(dx);
      }
    }

    lastIndex = endIndex;

    if (dxValues.length < period) return null;

    if (lastAdx === null) {
      let sum = 0;
      for (let i = 0; i < period; i++) sum += dxValues[i];
      lastAdx = sum / period;
    }

    for (let i = period; i < dxValues.length; i++) {
      lastAdx = lastAdx + (dxValues[i] - lastAdx) / period;
    }

    return lastAdx;
  };
}

export function createGCTrendStrategy(): Strategy {
  let adxPeriod = 14;
  let adxComputer = createAdxComputer(adxPeriod);

  return {
    id: "gc-trend",
    name: "GC Trend Following",
    description: "EMA crossover trend following with ADX filter and ATR-based trailing stop. Optimized for gold futures.",
    warmupBars: 220,
    params: [
      { key: "emaFast", label: "Fast EMA", min: 10, max: 30, step: 5 },
      { key: "emaSlow", label: "Slow EMA", min: 40, max: 60, step: 5 },
      { key: "smaTrend", label: "Trend SMA", min: 150, max: 250, step: 10 },
      { key: "atrMultSl", label: "SL ATR ×", min: 1, max: 3, step: 0.5 },
      { key: "atrMultTrail", label: "Trail ATR ×", min: 2, max: 5, step: 0.5 },
      { key: "adxPeriod", label: "ADX Period", min: 10, max: 20, step: 1 },
      { key: "adxThreshold", label: "ADX Min", min: 20, max: 40, step: 5 },
    ],
    defaults: { emaFast: 20, emaSlow: 50, smaTrend: 200, atrMultSl: 2, atrMultTrail: 3, adxPeriod: 14, adxThreshold: 25 },
    onBar(ctx: BarContext) {
      const { bars, index, params, position } = ctx;
      const emaFastP = Number(params.emaFast);
      const emaSlowP = Number(params.emaSlow);
      const smaTrendP = Number(params.smaTrend);
      const atrMultSl = Number(params.atrMultSl);
      const atrMultTrail = Number(params.atrMultTrail);
      const currentAdxPeriod = Number(params.adxPeriod) || 14;
      const adxThreshold = Number(params.adxThreshold) || 25;

      if (currentAdxPeriod !== adxPeriod) {
        adxPeriod = currentAdxPeriod;
        adxComputer = createAdxComputer(adxPeriod);
      }

      if (index < smaTrendP + 1) return;

      const emaFastNow = ema(bars, emaFastP, index);
      const emaSlowNow = ema(bars, emaSlowP, index);
      const emaFastPrev = ema(bars, emaFastP, index - 1);
      const emaSlowPrev = ema(bars, emaSlowP, index - 1);

      if (emaFastNow === null || emaSlowNow === null || emaFastPrev === null || emaSlowPrev === null) return;

      const smaNow = sma(bars, smaTrendP, index);
      if (smaNow === null) return;

      const a = atr(bars, 14, index) ?? 0;
      if (a <= 0) return;

      const adxVal = adxComputer(bars, index);
      if (adxVal === null || adxVal < adxThreshold) return;

      const crossUp = emaFastPrev <= emaSlowPrev && emaFastNow > emaSlowNow;
      const crossDn = emaFastPrev >= emaSlowPrev && emaFastNow < emaSlowNow;
      const price = bars[index].close;
      const trendUp = price > smaNow;
      const trendDn = price < smaNow;

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
          if (crossDn || !trendUp) {
            ctx.close("ema-cross");
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
          if (crossUp || !trendDn) {
            ctx.close("ema-cross");
            return;
          }
        }
        return;
      }

      const slDist = Math.max(a * atrMultSl, GC_MIN_STOP_DOLLARS / GC_POINT_VALUE);

      if (crossUp && trendUp) {
        ctx.buy({ sl: price - slDist, tp: price + slDist * 2 });
      } else if (crossDn && trendDn) {
        ctx.sell({ sl: price + slDist, tp: price - slDist * 2 });
      }
    },
  };
}

export const GCTrendStrategy = createGCTrendStrategy();
