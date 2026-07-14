import type { Strategy, BarContext } from "../../backtest/engine";
import { ES_TICK, isRTH, vwap, vwapStdDev, detectDivergence } from "../institutional/config";

function sessionKey(bar: { time: number }): string {
  const d = new Date(bar.time * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

const sessionMap = new Map<string, string>();

const esMeanReversion: Strategy = {
  id: "es-mean-reversion",
  name: "ES VWAP Mean Reversion",
  description: "Intraday mean reversion to VWAP with RSI divergence confirmation at 2σ extremes.",
  warmupBars: 60,
  params: [
    { key: "stdMult", label: "Std Dev Multiplier", min: 1, max: 4, step: 0.25 },
    { key: "stopMult", label: "Stop × Std Dev", min: 0.25, max: 2, step: 0.25 },
    { key: "rsiPeriod", label: "RSI Period", min: 7, max: 21, step: 1 },
    { key: "divLookback", label: "Divergence Lookback", min: 5, max: 20, step: 1 },
  ],
  defaults: { stdMult: 2, stopMult: 0.5, rsiPeriod: 14, divLookback: 10 },
  onBar(ctx: BarContext) {
    const { bars, index, params, position, symbol } = ctx;
    if (index < 20) return;
    const bar = bars[index];
    if (!isRTH(bar)) {
      if (position) ctx.close("rth-close");
      return;
    }
    const sym = symbol;
    const sk = sessionKey(bar);
    if (sessionMap.get(sym) !== sk) sessionMap.set(sym, sk);
    const sessionBars: typeof bars = [];
    for (let i = index; i >= 0; i--) {
      if (sessionKey(bars[i]) !== sk) break;
      sessionBars.unshift(bars[i]);
    }
    if (sessionBars.length < 10) return;
    const vwapVal = vwap(sessionBars, sessionBars.length - 1);
    if (vwapVal === null) return;
    const stdVal = vwapStdDev(sessionBars, sessionBars.length - 1, vwapVal);
    if (stdVal === null || stdVal <= 0) return;
    const stdMult = Number(params.stdMult);
    const upper = vwapVal + stdMult * stdVal;
    const lower = vwapVal - stdMult * stdVal;
    const stopMult = Number(params.stopMult);
    const div = detectDivergence(bars, Number(params.divLookback), index);
    if (ctx.position) {
      if (ctx.position.side === "long" && bar.close >= vwapVal) ctx.close("vwap-return");
      else if (ctx.position.side === "short" && bar.close <= vwapVal) ctx.close("vwap-return");
      return;
    }
    if (bar.close < lower && div === "bullish") {
      const stop = bar.close - stopMult * stdVal;
      ctx.buy({ sl: stop, tp: vwapVal, label: "vwap-long" });
    } else if (bar.close > upper && div === "bearish") {
      const stop = bar.close + stopMult * stdVal;
      ctx.sell({ sl: stop, tp: vwapVal, label: "vwap-short" });
    }
  },
};

export { esMeanReversion as ESMeanReversionStrategy };
