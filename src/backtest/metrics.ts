/**
 * MetricsCalculator — turns a BacktestResult into a professional performance summary:
 * returns, drawdown, risk-adjusted ratios (Sharpe / Sortino / Calmar), trade statistics
 * and calendar (monthly / yearly) return breakdowns.
 */

import { Timeframe, timeframeSeconds } from "../replay-engine";
import type { BacktestResult, Trade, EquityPoint } from "./engine";

export interface TradeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  avgTrade: number;
  expectancy: number;
  largestWin: number;
  largestLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgBarsHeld: number;
  avgWinBarsHeld: number;
  avgLossBarsHeld: number;
  recoveryFactor: number;
}

export interface PeriodReturn {
  key: string;
  label: string;
  returnPct: number;
  startEquity: number;
  endEquity: number;
}

export interface Metrics {
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  maxDrawdownValue: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  volatilityPct: number; // annualized
  trades: TradeStats;
  monthly: PeriodReturn[];
  yearly: PeriodReturn[];
  exposurePct: number;
  averageWinPct: number;
  averageLossPct: number;
}

/** Bars-per-year used for annualizing ratios; ~23h futures session assumption. */
function periodsPerYear(tf: Timeframe): number {
  const sec = timeframeSeconds(tf);
  if (sec >= 86400) {
    if (tf === "W1") return 52;
    if (tf === "MN") return 12;
    return 252;
  }
  const minutesPerDay = 1380; // ~23h electronic session
  return Math.round((minutesPerDay * 252) / (sec / 60));
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[], m = mean(xs)): number {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function round2(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function computeTradeStats(trades: Trade[], _initialCapital: number): TradeStats {
  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const netProfit = grossProfit - grossLoss;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const largestWin = wins.length ? Math.max(...wins.map(t => t.netPnl)) : 0;
  const largestLoss = losses.length ? Math.min(...losses.map(t => t.netPnl)) : 0;

  let maxW = 0, maxL = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.netPnl > 0) { curW++; curL = 0; maxW = Math.max(maxW, curW); }
    else { curL++; curW = 0; maxL = Math.max(maxL, curL); }
  }

  const barsHeld = trades.map(t => t.barsHeld);
  const winBars = wins.map(t => t.barsHeld);
  const lossBars = losses.map(t => t.barsHeld);

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    netProfit: round2(netProfit),
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
    avgWin: round2(avgWin),
    avgLoss: round2(avgLoss),
    avgTrade: trades.length ? round2(netProfit / trades.length) : 0,
    expectancy: trades.length ? round2(netProfit / trades.length) : 0,
    largestWin: round2(largestWin),
    largestLoss: round2(largestLoss),
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    avgBarsHeld: round2(mean(barsHeld)),
    avgWinBarsHeld: round2(mean(winBars)),
    avgLossBarsHeld: round2(mean(lossBars)),
    recoveryFactor: 0, // set after maxDD known
  };
}

export class MetricsCalculator {
  static compute(result: BacktestResult): Metrics {
    const { equityCurve, trades, initialCapital, timeframe } = result;
    const finalEquity = result.finalEquity;
    const ppy = periodsPerYear(timeframe);

    const rets: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      if (prev > 0) rets.push(equityCurve[i].equity / prev - 1);
    }
    const m = mean(rets);
    const sd = stddev(rets, m);
    const rfPeriod = (result.config.riskFreeRate ?? 0.02) / ppy;

    const sharpe = sd > 0 ? round2((m - rfPeriod) / sd * Math.sqrt(ppy)) : 0;
    const downside = rets.filter(r => r < rfPeriod);
    const dd = downside.length ? stddev(downside, rfPeriod) : 0;
    const sortino = dd > 0 ? round2((m - rfPeriod) / dd * Math.sqrt(ppy)) : 0;

    const maxDD = equityCurve.reduce((mx, p) => Math.min(mx, p.drawdown), 0);
    const maxDrawdownPct = round2(Math.abs(maxDD));
    let peak = initialCapital, maxDDval = 0;
    for (const p of equityCurve) { peak = Math.max(peak, p.equity); maxDDval = Math.max(maxDDval, peak - p.equity); }
    const maxDrawdownValue = round2(maxDDval);

    const totalReturnPct = round2(((finalEquity - initialCapital) / initialCapital) * 100);
    const days = Math.max(1, (result.endDate - result.startDate) / 86400);
    const years = days / 365;
    const cagrPct = years > 0 && initialCapital > 0
      ? round2((Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100)
      : 0;
    const calmar = maxDrawdownPct > 0 ? round2(cagrPct / maxDrawdownPct) : 0;
    const volatilityPct = round2(sd * Math.sqrt(ppy) * 100);

    const tradeStats = computeTradeStats(trades, initialCapital);
    tradeStats.recoveryFactor = maxDrawdownValue > 0 ? round2(tradeStats.netProfit / maxDrawdownValue) : 0;

    const exposurePct = equityCurve.length
      ? round2((trades.reduce((a, t) => a + t.barsHeld, 0) / equityCurve.length) * 100)
      : 0;

    const winPcts = trades.filter(t => t.netPnl > 0).map(t => t.netPnlPct);
    const lossPcts = trades.filter(t => t.netPnl <= 0).map(t => t.netPnlPct);

    return {
      initialCapital,
      finalEquity: round2(finalEquity),
      totalReturnPct,
      cagrPct,
      maxDrawdownPct,
      maxDrawdownValue,
      sharpe,
      sortino,
      calmar,
      volatilityPct,
      trades: tradeStats,
      monthly: periodReturns(equityCurve, "month"),
      yearly: periodReturns(equityCurve, "year"),
      exposurePct,
      averageWinPct: round2(winPcts.length ? mean(winPcts) : 0),
      averageLossPct: round2(lossPcts.length ? mean(lossPcts) : 0),
    };
  }
}

function periodReturns(curve: EquityPoint[], kind: "month" | "year"): PeriodReturn[] {
  if (curve.length < 2) return [];
  const buckets = new Map<string, { start: number; end: number; startEq: number }>();
  for (const p of curve) {
    const d = new Date(p.time * 1000);
    const key = kind === "month" ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` : `${d.getUTCFullYear()}`;
    const cur = buckets.get(key);
    if (!cur) buckets.set(key, { start: p.time, end: p.time, startEq: p.equity });
    else cur.end = p.time;
  }
  const out: PeriodReturn[] = [];
  let prevEndEq: number | null = null;
  for (const [key, b] of [...buckets.entries()].sort()) {
    const startEquity: number = b.startEq;
    const endEquity: number = curve.find(p => p.time === b.end)?.equity ?? startEquity;
    const returnPct = startEquity > 0 ? round2(((endEquity - startEquity) / startEquity) * 100) : 0;
    out.push({ key, label: key, returnPct, startEquity: round2(startEquity), endEquity: round2(endEquity) });
    prevEndEq = endEquity;
  }
  return out;
}
