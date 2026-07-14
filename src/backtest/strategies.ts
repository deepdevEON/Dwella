/**
 * Built-in demo strategies + lightweight indicator helpers for the backtest engine.
 * These give the Backtest panel runnable, parameterized strategies out of the box and
 * demonstrate multi-timeframe usage (higher-TF trend filter + base-TF entry timing).
 */

import type { Bar } from "../replay-engine";
import type { Strategy, BarContext } from "./engine";

export function sma(bars: Bar[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += bars[i].close;
  return sum / period;
}

export function ema(bars: Bar[], period: number, endIndex: number): number | null {
  if (endIndex + 1 < period) return null;
  const k = 2 / (period + 1);
  let e = bars[endIndex - period + 1].close;
  for (let i = endIndex - period + 2; i <= endIndex; i++) e = bars[i].close * k + e * (1 - k);
  return e;
}

export function rsi(bars: Bar[], period: number, endIndex: number): number | null {
  if (endIndex < period) return null;
  let gain = 0, loss = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  const avgGain = gain / period, avgLoss = loss / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(bars: Bar[], period: number, endIndex: number): number | null {
  if (endIndex < period) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

/** SMA crossover with ATR-based stop/target. Simple, robust demo strategy. */
const smaCross: Strategy = {
  id: "sma-cross",
  name: "SMA Crossover",
  description: "Long when fast SMA crosses above slow SMA, short on the reverse. ATR stop + target.",
  warmupBars: 210,
  params: [
    { key: "fast", label: "Fast SMA", min: 5, max: 50, step: 5 },
    { key: "slow", label: "Slow SMA", min: 20, max: 200, step: 10 },
    { key: "atrMult", label: "ATR stop ×", min: 1, max: 5, step: 0.5 },
    { key: "rr", label: "Reward:Risk", min: 1, max: 4, step: 0.5 },
  ],
  defaults: { fast: 20, slow: 50, atrMult: 2, rr: 2 },
  onBar(ctx: BarContext) {
    const { bars, index, params } = ctx;
    const fastP = Number(params.fast), slowP = Number(params.slow);
    if (index < slowP + 1) return;
    const fastNow = sma(bars, fastP, index);
    const slowNow = sma(bars, slowP, index);
    const fastPrev = sma(bars, fastP, index - 1);
    const slowPrev = sma(bars, slowP, index - 1);
    if (fastNow === null || slowNow === null || fastPrev === null || slowPrev === null) return;
    const a = atr(bars, 14, index) ?? 0;
    const price = bars[index].close;
    const crossUp = fastPrev <= slowPrev && fastNow > slowNow;
    const crossDn = fastPrev >= slowPrev && fastNow < slowNow;

    if (ctx.position) {
      if (ctx.position.side === "long" && crossDn) ctx.close("cross");
      else if (ctx.position.side === "short" && crossUp) ctx.close("cross");
      return;
    }
    const stopDist = a * Number(params.atrMult);
    if (stopDist <= 0) return;
    const rr = Number(params.rr);
    if (crossUp) ctx.buy({ sl: price - stopDist, tp: price + stopDist * rr });
    else if (crossDn) ctx.sell({ sl: price + stopDist, tp: price - stopDist * rr });
  },
};

/** RSI mean reversion. Buys oversold, sells overbought; exits at neutral. */
const rsiReversion: Strategy = {
  id: "rsi-reversion",
  name: "RSI Mean Reversion",
  description: "Buy when RSI < oversold, short when RSI > overbought. Exit toward 50.",
  warmupBars: 60,
  params: [
    { key: "period", label: "RSI period", min: 5, max: 30, step: 1 },
    { key: "oversold", label: "Oversold", min: 10, max: 40, step: 5 },
    { key: "overbought", label: "Overbought", min: 60, max: 90, step: 5 },
    { key: "atrMult", label: "ATR stop ×", min: 1, max: 5, step: 0.5 },
  ],
  defaults: { period: 14, oversold: 30, overbought: 70, atrMult: 2.5 },
  onBar(ctx: BarContext) {
    const { bars, index, params } = ctx;
    const p = Number(params.period);
    if (index < p + 2) return;
    const r = rsi(bars, p, index);
    if (r === null) return;
    const a = atr(bars, 14, index) ?? 0;
    const price = bars[index].close;
    if (ctx.position) {
      if (ctx.position.side === "long" && r >= 50) ctx.close("neutral");
      else if (ctx.position.side === "short" && r <= 50) ctx.close("neutral");
      return;
    }
    const stop = a * Number(params.atrMult);
    if (stop <= 0) return;
    if (r < Number(params.oversold)) ctx.buy({ sl: price - stop, tp: price + stop });
    else if (r > Number(params.overbought)) ctx.sell({ sl: price + stop, tp: price - stop });
  },
};

/** Multi-timeframe momentum: higher-TF trend filter (EMA) + base-TF breakout. */
const mtfMomentum: Strategy = {
  id: "mtf-momentum",
  name: "MTF Momentum Breakout",
  description: "Trades base-TF N-bar breakouts only in the direction of the higher-TF EMA trend.",
  warmupBars: 60,
  params: [
    { key: "lookback", label: "Breakout bars", min: 10, max: 60, step: 5 },
    { key: "trendEma", label: "HTF EMA", min: 20, max: 100, step: 10 },
    { key: "atrMult", label: "ATR stop ×", min: 1, max: 5, step: 0.5 },
    { key: "rr", label: "Reward:Risk", min: 1, max: 4, step: 0.5 },
  ],
  defaults: { lookback: 20, trendEma: 50, atrMult: 2, rr: 2 },
  onBar(ctx: BarContext) {
    const { bars, index, params, tf } = ctx;
    const lb = Number(params.lookback);
    if (index < lb + 2) return;
    let hh = -Infinity, ll = Infinity;
    for (let i = index - lb; i < index; i++) {
      hh = Math.max(hh, bars[i].high);
      ll = Math.min(ll, bars[i].low);
    }
    const a = atr(bars, 14, index) ?? 0;
    const price = bars[index].close;

    // higher timeframe trend filter — use first available aligned TF, else base EMA
    let trendUp = true, trendDn = true;
    const htfKeys = Object.keys(tf);
    const htfBar = htfKeys.length ? tf[htfKeys[0]] : null;
    if (htfBar) {
      const baseEma = ema(bars, Number(params.trendEma), index);
      if (baseEma !== null) {
        trendUp = htfBar.close >= baseEma;
        trendDn = htfBar.close <= baseEma;
      }
    } else {
      const e = ema(bars, Number(params.trendEma), index);
      if (e !== null) { trendUp = price >= e; trendDn = price <= e; }
    }

    if (ctx.position) return;
    const stop = a * Number(params.atrMult);
    if (stop <= 0) return;
    const rr = Number(params.rr);
    if (price > hh && trendUp) ctx.buy({ sl: price - stop, tp: price + stop * rr });
    else if (price < ll && trendDn) ctx.sell({ sl: price + stop, tp: price - stop * rr });
  },
};

export const BUILTIN_STRATEGIES: Strategy[] = [smaCross, rsiReversion, mtfMomentum];

export function getStrategy(id: string): Strategy | undefined {
  return BUILTIN_STRATEGIES.find(s => s.id === id);
}
