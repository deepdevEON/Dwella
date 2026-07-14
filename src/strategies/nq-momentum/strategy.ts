import type { Strategy, BarContext, StrategyParams, ParamSpec } from "../../backtest/engine";
import { sma, rsi, atr } from "../../backtest/strategies";
import {
  NQ_POINT_VALUE,
  NQ_TICK_SIZE,
  NQ_MIN_STOP_DOLLARS,
  NQ_SMA_TREND_PERIOD,
  MODE_CONFIGS,
  resolveModeParams,
  type StrategyMode,
} from "./config";

function getDayKey(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function createNQMomentumStrategy(mode?: StrategyMode): Strategy {
  const defaults = resolveModeParams(mode, {});

  return {
    id: "nq-momentum",
    name: "NQ Momentum Breakout",
    description: "Multi-timeframe momentum/breakout for NQ E-mini. H1 trend filter + M15 RSI + prev-day breakout.",
    warmupBars: 250,
    params: [
      { key: "smaTrendPeriod", label: "SMA Trend (200)", min: 150, max: 250, step: 10 },
      { key: "rsiPeriod", label: "RSI Period", min: 7, max: 21, step: 1 },
      { key: "atrPeriod", label: "ATR Period", min: 10, max: 20, step: 1 },
      { key: "atrMultSl", label: "SL ATR ×", min: 1, max: 4, step: 0.25 },
      { key: "atrMultTrail", label: "Trail ATR ×", min: 1.5, max: 5, step: 0.5 },
      { key: "atrMinMultiplier", label: "ATR Min ×", min: 1, max: 5, step: 0.5 },
      { key: "rsiThreshold", label: "RSI Threshold", min: 45, max: 60, step: 1 },
      { key: "maxHoldBars", label: "Max Hold (bars)", min: 4, max: 48, step: 4 },
      { key: "timeExitEnabled", label: "Time Exit", min: 0, max: 1, step: 1 },
    ],
    defaults: {
      ...defaults,
      smaTrendPeriod: NQ_SMA_TREND_PERIOD,
      rsiPeriod: 14,
      atrPeriod: 14,
    },
    onBar(ctx: BarContext) {
      const { bars, index, params, tf, position } = ctx;
      const smaPeriod = Number(params.smaTrendPeriod) || 200;
      const rsiPeriod = Number(params.rsiPeriod) || 14;
      const atrPeriod = Number(params.atrPeriod) || 14;
      const atrMultSl = Number(params.atrMultSl) ?? 2;
      const atrMultTrail = Number(params.atrMultTrail) ?? 3;
      const atrMinMult = Number(params.atrMinMultiplier) ?? 2;
      const rsiThreshold = Number(params.rsiThreshold) ?? 55;
      const maxHoldBars = Number(params.maxHoldBars) ?? 24;
      const timeExitEnabled = Boolean(Number(params.timeExitEnabled));

      if (index < smaPeriod + 1) return;

      const a = atr(bars, atrPeriod, index) ?? 0;
      if (a <= 0) return;

      const minStop = NQ_MIN_STOP_DOLLARS / NQ_POINT_VALUE;
      const slDist = Math.max(a * atrMultSl, minStop * atrMinMult);
      const price = bars[index].close;

      const h1Bar = tf["H1"] ?? null;
      const m15Bar = tf["M15"] ?? null;

      const h1Sma = h1Bar ? sma([h1Bar], 1, 0) : null;
      const baseRsi = rsi(bars, rsiPeriod, index);

      let trendUp = false;
      let trendDn = false;
      if (h1Sma !== null && h1Bar) {
        trendUp = h1Bar.close > h1Sma;
        trendDn = h1Bar.close < h1Sma;
      } else {
        const baseSma = sma(bars, smaPeriod, index);
        if (baseSma !== null) {
          trendUp = price > baseSma;
          trendDn = price < baseSma;
        }
      }

      const rsiOkLong = baseRsi !== null ? baseRsi > rsiThreshold : trendUp;
      const rsiOkShort = baseRsi !== null ? baseRsi < (100 - rsiThreshold) : trendDn;
      const m15Confirm = (trendUp && rsiOkLong) || (trendDn && rsiOkShort);

      if (!trendUp && !trendDn) return;
      if (!m15Confirm) return;

      if (position) {
        const entryBar = position.entryBar;
        const barsHeld = index - entryBar;
        const exitDueTime =
          timeExitEnabled && barsHeld >= maxHoldBars;

        if (exitDueTime) {
          ctx.close("time-exit");
          return;
        }

        const trailDist = a * atrMultTrail;
        const posSide = position.side;

        if (posSide === "long") {
          let peak = position.entryPrice;
          for (let i = entryBar; i <= index; i++) {
            peak = Math.max(peak, bars[i].high);
          }
          const trailStop = peak - trailDist;
          if (trailStop > position.entryPrice && bars[index].low <= trailStop) {
            ctx.close("trailing-stop");
            return;
          }
          if (!trendUp) {
            ctx.close("trend-reversal");
            return;
          }
        } else {
          let trough = position.entryPrice;
          for (let i = entryBar; i <= index; i++) {
            trough = Math.min(trough, bars[i].low);
          }
          const trailStop = trough + trailDist;
          if (trailStop < position.entryPrice && bars[index].high >= trailStop) {
            ctx.close("trailing-stop");
            return;
          }
          if (!trendDn) {
            ctx.close("trend-reversal");
            return;
          }
        }
        return;
      }

      const dayKey = getDayKey(bars[index].time);
      const currentDayRanges: Map<number, { high: number; low: number }> = new Map();
      for (let i = index; i >= 0; i--) {
        const dk = getDayKey(bars[i].time);
        if (!currentDayRanges.has(dk)) {
          currentDayRanges.set(dk, {
            high: bars[i].high,
            low: bars[i].low,
          });
        } else {
          const r = currentDayRanges.get(dk)!;
          r.high = Math.max(r.high, bars[i].high);
          r.low = Math.min(r.low, bars[i].low);
        }
        if (dk < dayKey) break;
      }

      const todayRange = currentDayRanges.get(dayKey);
      const prevDayKey = dayKey - 1;
      const prevRange = currentDayRanges.get(prevDayKey);

      if (!prevRange || prevRange.high <= prevRange.low) return;

      const breakOutUp = price > prevRange.high && bars[index].high > prevRange.high;
      const breakOutDn = price < prevRange.low && bars[index].low < prevRange.low;

      if (breakOutUp && trendUp && m15Confirm) {
        ctx.buy({
          sl: price - slDist,
          tp: price + slDist * 2.5,
        });
      } else if (breakOutDn && trendDn && m15Confirm) {
        ctx.sell({
          sl: price + slDist,
          tp: price - slDist * 2.5,
        });
      }
    },
  };
}

export const NQMomentumStrategy = createNQMomentumStrategy();

