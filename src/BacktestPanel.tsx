import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Timeframe } from "./replay-engine";
import { BacktestEngine, BacktestResult, Strategy, StrategyParams, ParamSpec } from "./backtest/engine";
import { DataManager } from "./backtest/data";
import { MetricsCalculator, Metrics } from "./backtest/metrics";
import { BUILTIN_STRATEGIES, getStrategy } from "./backtest/strategies";
import { buildHTMLReport, tradesToCSV, equityToCSV, downloadReport, downloadCSV } from "./backtest/report";

const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M15", "H1", "H4", "D1"];
const SYMBOLS = ["NQ", "MNQ", "ES", "MES", "M2K", "GC", "MGC", "CL", "RTY", "YM", "EURUSD"];

const fmtUSD = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : Math.abs(n).toFixed(2)}`;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

interface OptRow {
  params: StrategyParams;
  net: number;
  sharpe: number;
  trades: number;
  winRate: number;
}

export default function BacktestPanel() {
  const [strategyId, setStrategyId] = useState(BUILTIN_STRATEGIES[0].id);
  const [symbol, setSymbol] = useState("NQ");
  const [base, setBase] = useState<Timeframe>("M15");
  const [extra, setExtra] = useState<Timeframe[]>(["H1"]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [initial, setInitial] = useState(50000);
  const [slippage, setSlippage] = useState(1);
  const [commission, setCommission] = useState(2);
  const [sizingMode, setSizingMode] = useState<"fixed" | "risk">("fixed");
  const [contracts, setContracts] = useState(1);
  const [riskPct, setRiskPct] = useState(1);
  const [synthetic, setSynthetic] = useState(false);
  const [params, setParams] = useState<StrategyParams>({});
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [optRows, setOptRows] = useState<OptRow[]>([]);
  const [optKey, setOptKey] = useState<"net" | "sharpe">("net");

  const strategy: Strategy = useMemo(() => getStrategy(strategyId)!, [strategyId]);

  useEffect(() => {
    const d = strategy.defaults ?? {};
    setParams({ ...d });
    setOptRows([]);
  }, [strategy]);

  const setParam = (key: string, v: number | string) =>
    setParams(p => ({ ...p, [key]: v }));

  const toggleExtra = (tf: Timeframe) =>
    setExtra(e => (e.includes(tf) ? e.filter(x => x !== tf) : [...e, tf]));

  const runOnce = async (useParams: StrategyParams): Promise<BacktestResult> => {
    const dm = new DataManager();
    const data = await dm.load(symbol, base, extra, {
      synthetic,
      startDate: startDate ? Math.floor(Date.parse(startDate) / 1000) : undefined,
      endDate: endDate ? Math.floor(Date.parse(endDate) / 1000) : undefined,
    });
    const engine = new BacktestEngine(
      BacktestEngine.withDefaults({
        symbol,
        baseTimeframe: base,
        initialCapital: initial,
        slippageTicks: slippage,
        commissionPerContract: commission,
        allowShort: true,
        sizing: sizingMode === "fixed" ? { mode: "fixed", contracts } : { mode: "risk", riskPct: riskPct / 100 },
        additionalTimeframes: extra,
      }),
    );
    return engine.run(strategy, data, useParams);
  };

  const runBacktest = async () => {
    setRunning(true);
    setStatus("Loading data…");
    try {
      const res = await runOnce(params);
      const m = MetricsCalculator.compute(res);
      setResult(res);
      setMetrics(m);
      setStatus(`${res.trades.length} trades · ${fmtPct(m.totalReturnPct)} · ${m.maxDrawdownPct.toFixed(1)}% DD`);
    } catch (e) {
      setResult(null);
      setMetrics(null);
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const runOptimization = async () => {
    setRunning(true);
    setStatus("Optimizing parameter grid…");
    setTimeout(async () => {
      try {
        const specs = (strategy.params ?? []).filter(s => s.min < s.max);
        const combos = buildCombos(specs);
        const rows: OptRow[] = [];
        for (const combo of combos) {
          try {
            const res = await runOnce({ ...params, ...combo });
            const m = MetricsCalculator.compute(res);
            rows.push({
              params: combo,
              net: m.trades.netProfit,
              sharpe: m.sharpe,
              trades: m.trades.total,
              winRate: m.trades.winRate,
            });
          } catch {
            /* skip invalid combo */
          }
        }
        rows.sort((a, b) => (optKey === "net" ? b.net - a.net : b.sharpe - a.sharpe));
        setOptRows(rows);
        setStatus(`Tested ${rows.length} parameter sets`);
        if (rows[0]) setParams({ ...params, ...rows[0].params });
      } catch (e) {
        setStatus(`Opt error: ${(e as Error).message}`);
      } finally {
        setRunning(false);
      }
    }, 10);
  };

  return (
    <div className="backtest">
      <section className="bt-controls glass">
        <div className="section-head"><h3>Backtest configuration</h3><span>{status || "Ready"}</span></div>

        <div className="bt-grid">
          <label>Strategy
            <select value={strategyId} onChange={e => setStrategyId(e.target.value)}>
              {BUILTIN_STRATEGIES.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Symbol
            <select value={symbol} onChange={e => setSymbol(e.target.value)}>
              {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Base timeframe
            <select value={base} onChange={e => setBase(e.target.value as Timeframe)}>
              {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </label>
          <label>Initial capital
            <input type="number" value={initial} min={1000} step={1000} onChange={e => setInitial(Number(e.target.value))} />
          </label>
          <label>Slippage (ticks)
            <input type="number" value={slippage} min={0} step={0.5} onChange={e => setSlippage(Number(e.target.value))} />
          </label>
          <label>Commission / contract
            <input type="number" value={commission} min={0} step={0.5} onChange={e => setCommission(Number(e.target.value))} />
          </label>
          <label>Sizing
            <select value={sizingMode} onChange={e => setSizingMode(e.target.value as "fixed" | "risk")}>
              <option value="fixed">Fixed contracts</option>
              <option value="risk">Risk % of equity</option>
            </select>
          </label>
          {sizingMode === "fixed" ? (
            <label>Contracts
              <input type="number" value={contracts} min={1} step={1} onChange={e => setContracts(Number(e.target.value))} />
            </label>
          ) : (
            <label>Risk %
              <input type="number" value={riskPct} min={0.1} step={0.1} onChange={e => setRiskPct(Number(e.target.value))} />
            </label>
          )}
          <label>Start date
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </label>
          <label>End date
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          </label>
          <label className="bt-check"><input type="checkbox" checked={synthetic} onChange={e => setSynthetic(e.target.checked)} /> Force synthetic data</label>
        </div>

        <div className="bt-tfs">
          <span>Higher timeframes:</span>
          {TIMEFRAMES.filter(tf => tf !== base).map(tf => (
            <button key={tf} type="button" className={extra.includes(tf) ? "active" : ""} onClick={() => toggleExtra(tf)}>{tf}</button>
          ))}
        </div>

        {strategy.params && strategy.params.length > 0 && (
          <div className="bt-params">
            {strategy.params.map(p => (
              <label key={p.key}>{p.label}
                <input type="number" value={Number(params[p.key] ?? 0)} step={p.step} min={p.min} max={p.max}
                  onChange={e => setParam(p.key, Number(e.target.value))} />
              </label>
            ))}
          </div>
        )}

        <div className="bt-actions">
          <button className="place-order" disabled={running} onClick={runBacktest}>{running ? "Running…" : "▶ Run backtest"}</button>
          {strategy.params && strategy.params.length > 0 && (
            <button className="bt-opt" disabled={running} onClick={runOptimization}>⚙ Optimize grid</button>
          )}
          {result && metrics && (
            <>
              <button className="bt-export" onClick={() => downloadReport(result, metrics)}>⬇ HTML report</button>
              <button className="bt-export" onClick={() => downloadCSV(result)}>⬇ Trades CSV</button>
              <button className="bt-export" onClick={() => downloadEquity(result)}>⬇ Equity CSV</button>
            </>
          )}
        </div>
        {strategy.description && <p className="bt-desc">{strategy.description}</p>}
      </section>

      {optRows.length > 0 && (
        <section className="glass bt-optresult">
          <div className="section-head">
            <h3>Optimization results</h3>
            <span>Rank by
              <select value={optKey} onChange={e => setOptKey(e.target.value as "net" | "sharpe")}>
                <option value="net">Net P&amp;L</option><option value="sharpe">Sharpe</option>
              </select>
            </span>
          </div>
          <div className="bt-opt-table">
            <div className="bt-opt-row head">
              <span>Rank</span><span>Net P&amp;L</span><span>Sharpe</span><span>Trades</span><span>Win%</span><span>Params</span>
            </div>
            {optRows.slice(0, 12).map((r, i) => (
              <div key={i} className="bt-opt-row" onDoubleClick={() => setParams({ ...params, ...r.params })}>
                <span>#{i + 1}</span>
                <span className={r.net >= 0 ? "pos" : "neg"}>{fmtUSD(r.net)}</span>
                <span>{r.sharpe.toFixed(2)}</span>
                <span>{r.trades}</span>
                <span>{r.winRate.toFixed(1)}%</span>
                <span className="bt-opt-params">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join("  ")}</span>
              </div>
            ))}
          </div>
          <small className="muted">Double-click a row to load its parameters.</small>
        </section>
      )}

      {result && metrics && (
        <motion.div className="bt-results" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <section className="glass bt-metrics">
            <Metric label="Total return" value={fmtPct(metrics.totalReturnPct)} tone={metrics.totalReturnPct >= 0 ? "pos" : "neg"} />
            <Metric label="CAGR" value={fmtPct(metrics.cagrPct)} tone={metrics.cagrPct >= 0 ? "pos" : "neg"} />
            <Metric label="Max drawdown" value={`${metrics.maxDrawdownPct.toFixed(2)}%`} tone="neg" />
            <Metric label="Sharpe" value={metrics.sharpe.toFixed(2)} tone={metrics.sharpe >= 1 ? "pos" : ""} />
            <Metric label="Sortino" value={metrics.sortino.toFixed(2)} />
            <Metric label="Calmar" value={metrics.calmar.toFixed(2)} />
            <Metric label="Volatility" value={`${metrics.volatilityPct.toFixed(1)}%`} />
            <Metric label="Win rate" value={`${metrics.trades.winRate.toFixed(1)}%`} />
            <Metric label="Profit factor" value={isFinite(metrics.trades.profitFactor) ? metrics.trades.profitFactor.toFixed(2) : "∞"} tone={metrics.trades.profitFactor >= 1 ? "pos" : "neg"} />
            <Metric label="Recovery" value={metrics.trades.recoveryFactor.toFixed(2)} />
            <Metric label="Net profit" value={fmtUSD(metrics.trades.netProfit)} tone={metrics.trades.netProfit >= 0 ? "pos" : "neg"} />
            <Metric label="Trades" value={`${metrics.trades.total}`} />
            <Metric label="Avg win" value={fmtUSD(metrics.trades.avgWin)} tone="pos" />
            <Metric label="Avg loss" value={fmtUSD(metrics.trades.avgLoss)} tone="neg" />
            <Metric label="Max win streak" value={`${metrics.trades.maxConsecutiveWins}`} />
            <Metric label="Max loss streak" value={`${metrics.trades.maxConsecutiveLosses}`} />
            <Metric label="Exposure" value={`${metrics.exposurePct.toFixed(0)}%`} />
          </section>

          <section className="glass bt-charts">
            <h4>Equity curve</h4>
            <EquityCurve curve={result.equityCurve} />
            <h4>Drawdown</h4>
            <DrawdownCurve curve={result.equityCurve} />
            <h4>Monthly returns</h4>
            <MonthlyBars rows={metrics.monthly} />
          </section>

          <section className="glass bt-trades">
            <div className="section-head"><h3>Trade log</h3><span>{result.trades.length} trades</span></div>
            <div className="bt-trade-table">
              <div className="bt-trade-row head">
                <span>Entry</span><span>Side</span><span>Qty</span><span>Entry</span><span>Exit</span><span>Net</span><span>Exit reason</span><span>Bars</span>
              </div>
              {result.trades.slice().reverse().slice(0, 120).map(t => (
                <div key={t.id} className="bt-trade-row">
                  <span>{new Date(t.entryTime * 1000).toISOString().slice(0, 10)}</span>
                  <span className={t.side === "long" ? "pos" : "neg"}>{t.side.toUpperCase()}</span>
                  <span>{t.qty}</span>
                  <span>{t.entryPrice}</span>
                  <span>{t.exitPrice}</span>
                  <span className={t.netPnl >= 0 ? "pos" : "neg"}>{fmtUSD(t.netPnl)}</span>
                  <span>{t.exitReason}</span>
                  <span>{t.barsHeld}</span>
                </div>
              ))}
            </div>
          </section>
        </motion.div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bt-metric">
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function EquityCurve({ curve }: { curve: BacktestResult["equityCurve"] }) {
  if (curve.length < 2) return <div className="chart-empty">No equity data</div>;
  const w = 820, h = 220, pad = 46;
  const lo = Math.min(...curve.map(p => p.equity));
  const hi = Math.max(...curve.map(p => p.equity));
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (curve.length - 1)) * (w - pad - 10);
  const y = (v: number) => 12 + (h - 24) * (1 - (v - lo) / span);
  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(" ");
  const area = `${line} L${x(curve.length - 1).toFixed(1)} ${h - 12} L${x(0).toFixed(1)} ${h - 12} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="bt-svg" preserveAspectRatio="none">
      <defs><linearGradient id="eqg" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#8c75ff" stopOpacity=".35" /><stop offset="1" stopColor="#8c75ff" stopOpacity="0" />
      </linearGradient></defs>
      {[0, 0.5, 1].map(t => {
        const v = lo + span * t;
        return <text key={t} x={w - 6} y={y(v) + 3} fill="#7c7a82" fontSize={9} textAnchor="end">{fmtUSD(v)}</text>;
      })}
      <path d={area} fill="url(#eqg)" />
      <path d={line} fill="none" stroke="#8c75ff" strokeWidth={1.6} />
    </svg>
  );
}

function DrawdownCurve({ curve }: { curve: BacktestResult["equityCurve"] }) {
  if (curve.length < 2) return <div className="chart-empty">No data</div>;
  const w = 820, h = 130, pad = 46;
  const lo = Math.min(0, ...curve.map(p => p.drawdown));
  const span = 0 - lo || 1;
  const x = (i: number) => pad + (i / (curve.length - 1)) * (w - pad - 10);
  const y = (v: number) => 10 + (h - 20) * (1 - (v - lo) / span);
  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.drawdown).toFixed(1)}`).join(" ");
  const area = `${line} L${x(curve.length - 1).toFixed(1)} ${y(lo).toFixed(1)} L${x(0).toFixed(1)} ${y(lo).toFixed(1)} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="bt-svg" preserveAspectRatio="none">
      <defs><linearGradient id="ddg" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="#f18489" stopOpacity="0" /><stop offset="1" stopColor="#f18489" stopOpacity=".4" />
      </linearGradient></defs>
      <path d={area} fill="url(#ddg)" />
      <path d={line} fill="none" stroke="#f18489" strokeWidth={1.3} />
    </svg>
  );
}

function MonthlyBars({ rows }: { rows: Metrics["monthly"] }) {
  if (!rows.length) return <div className="chart-empty">No calendar data</div>;
  const w = 820, h = 130, pad = 28;
  const vals = rows.map(r => r.returnPct);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const bw = (w - pad - 10) / rows.length;
  const zero = 10 + (h - 20) * (1 - (0 - lo) / span);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="bt-svg" preserveAspectRatio="none">
      {rows.map((r, i) => {
        const yv = 10 + (h - 20) * (1 - (r.returnPct - lo) / span);
        const top = Math.min(yv, zero);
        const bh = Math.abs(yv - zero) || 1;
        const col = r.returnPct >= 0 ? "#6fd8aa" : "#f18489";
        return <rect key={r.key} x={(pad + i * bw + 1).toFixed(1)} y={top.toFixed(1)} width={Math.max(1, bw - 2).toFixed(1)} height={bh.toFixed(1)} fill={col} opacity={0.8} />;
      })}
      <line x1={pad} x2={w - 10} y1={zero} y2={zero} stroke="rgba(255,255,255,.15)" />
    </svg>
  );
}

function downloadEquity(result: BacktestResult) {
  if (typeof document === "undefined") return;
  const csv = equityToCSV(result);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dwella-equity-${result.symbol}-${Date.now()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build the cartesian product of parameter ranges, capped to keep runtime sane. */
function buildCombos(specs: ParamSpec[]): StrategyParams[] {
  const MAX = 240;
  let lists = specs.map(s => {
    const vals: number[] = [];
    for (let v = s.min; v <= s.max + 1e-9; v += s.step) vals.push(Math.round(v * 1000) / 1000);
    return vals;
  });
  let product = lists.reduce((a, b) => a * b.length, 1);
  if (product > MAX) {
    const factor = Math.ceil(Math.pow(product / MAX, 1 / lists.length));
    lists = lists.map(l => l.filter((_, i) => i % factor === 0));
  }
  let combos: StrategyParams[] = [{}];
  for (let i = 0; i < specs.length; i++) {
    const next: StrategyParams[] = [];
    for (const c of combos) for (const v of lists[i]) next.push({ ...c, [specs[i].key]: v });
    combos = next;
  }
  return combos;
}
