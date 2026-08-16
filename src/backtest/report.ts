/**
 * BacktestReport — builds professional, self-contained HTML reports (inline SVG
 * charts: equity curve, drawdown, monthly returns, trade-P&L distribution) plus
 * CSV trade exports. Pure string generation; `download*` helpers are browser-only.
 */

import type { BacktestResult, Trade } from "./engine";
import type { Metrics } from "./metrics";

const VIOLET = "#8c75ff";
const GOLD = "#e7a64f";
const GREEN = "#6fd8aa";
const RED = "#f18489";

function fmtUSD(n: number): string {
  const v = Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
  return `${n < 0 ? "-" : ""}$${v}`;
}
function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function equityChart(curve: { time: number; equity: number }[], w = 760, h = 240): string {
  if (curve.length < 2) return "";
  const pad = 44;
  const lo = Math.min(...curve.map(p => p.equity));
  const hi = Math.max(...curve.map(p => p.equity));
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (curve.length - 1)) * (w - pad - 10);
  const y = (v: number) => 12 + (h - 24) * (1 - (v - lo) / span);
  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(" ");
  const area = `${line} L${x(curve.length - 1).toFixed(1)} ${h - 12} L${x(0).toFixed(1)} ${h - 12} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const v = lo + span * t;
    return `<line x1="${pad}" x2="${w - 10}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,.07)"/>
      <text x="${w - 6}" y="${(y(v) + 3).toFixed(1)}" fill="#7c7a82" font-size="9" text-anchor="end">${fmtUSD(v)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none"><defs><linearGradient id="eq" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${VIOLET}" stop-opacity=".35"/><stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#eq)"/><path d="${line}" fill="none" stroke="${VIOLET}" stroke-width="1.6"/></svg>`;
}

function drawdownChart(curve: { time: number; drawdown: number }[], w = 760, h = 150): string {
  if (curve.length < 2) return "";
  const pad = 44;
  const lo = Math.min(0, ...curve.map(p => p.drawdown));
  const hi = 0;
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (curve.length - 1)) * (w - pad - 10);
  const y = (v: number) => 10 + (h - 20) * (1 - (v - lo) / span);
  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.drawdown).toFixed(1)}`).join(" ");
  const area = `${line} L${x(curve.length - 1).toFixed(1)} ${y(lo).toFixed(1)} L${x(0).toFixed(1)} ${y(lo).toFixed(1)} Z`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none"><defs><linearGradient id="dd" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${RED}" stop-opacity="0"/><stop offset="1" stop-color="${RED}" stop-opacity=".4"/></linearGradient></defs><path d="${area}" fill="url(#dd)"/><path d="${line}" fill="none" stroke="${RED}" stroke-width="1.3"/></svg>`;
}

function monthlyBars(monthly: { label: string; returnPct: number }[], w = 760, h = 150): string {
  if (!monthly.length) return "<p class='muted'>No calendar data.</p>";
  const pad = 30;
  const vals = monthly.map(m => m.returnPct);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const bw = (w - pad - 10) / monthly.length;
  const zero = 10 + (h - 20) * (1 - (0 - lo) / span);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none">` +
    monthly.map((m, i) => {
      const x = pad + i * bw;
      const yv = 10 + (h - 20) * (1 - (m.returnPct - lo) / span);
      const top = Math.min(yv, zero);
      const hgt = Math.abs(yv - zero) || 1;
      const col = m.returnPct >= 0 ? GREEN : RED;
      return `<rect x="${x + 1}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${hgt.toFixed(1)}" fill="${col}" opacity=".8"/>` +
        (i % Math.ceil(monthly.length / 14) === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 2}" fill="#7c7a82" font-size="8" text-anchor="middle">${m.label.slice(2)}</text>` : "");
    }).join("") + `</svg>`;
}

function pnlHistogram(trades: Trade[], w = 380, h = 150): string {
  if (trades.length < 2) return "<p class='muted'>Need 2+ trades.</p>";
  const p = trades.map(t => t.netPnl);
  const lo = Math.min(...p), hi = Math.max(...p);
  const buckets = 12;
  const span = hi - lo || 1;
  const counts = new Array(buckets).fill(0);
  for (const v of p) {
    let idx = Math.floor(((v - lo) / span) * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  const maxC = Math.max(...counts);
  const bw = w / buckets;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none">` +
    counts.map((c, i) => {
      const bh = (c / maxC) * (h - 20);
      const col = (lo + (i + 0.5) * (span / buckets)) >= 0 ? GREEN : RED;
      return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - 10 - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" opacity=".75"/>`;
    }).join("") +
    `<line x1="0" x2="${w}" y1="${h - 10}" y2="${h - 10}" stroke="rgba(255,255,255,.15)"/>` +
    `<text x="2" y="${h - 1}" fill="#7c7a82" font-size="8">${fmtUSD(lo)}</text><text x="${w - 2}" y="${h - 1}" fill="#7c7a82" font-size="8" text-anchor="end">${fmtUSD(hi)}</text>` +
    `</svg>`;
}

function statCard(label: string, value: string, tone = ""): string {
  return `<div class="stat"><span>${label}</span><b class="${tone}">${value}</b></div>`;
}

export function buildHTMLReport(result: BacktestResult, metrics: Metrics): string {
  const d = new Date(result.startDate * 1000);
  const e = new Date(result.endDate * 1000);
  const range = `${d.toISOString().slice(0, 10)} → ${e.toISOString().slice(0, 10)}`;
  const t = metrics.trades;

  const metricGrid = [
    statCard("Total return", fmtPct(metrics.totalReturnPct), metrics.totalReturnPct >= 0 ? "pos" : "neg"),
    statCard("CAGR", fmtPct(metrics.cagrPct), metrics.cagrPct >= 0 ? "pos" : "neg"),
    statCard("Max drawdown", `${metrics.maxDrawdownPct.toFixed(2)}%`, "neg"),
    statCard("Sharpe", metrics.sharpe.toFixed(2), metrics.sharpe >= 1 ? "pos" : ""),
    statCard("Sortino", metrics.sortino.toFixed(2)),
    statCard("Calmar", metrics.calmar.toFixed(2)),
    statCard("Win rate", `${t.winRate.toFixed(1)}%`),
    statCard("Profit factor", isFinite(t.profitFactor) ? t.profitFactor.toFixed(2) : "∞", t.profitFactor >= 1 ? "pos" : "neg"),
    statCard("Recovery factor", metrics.trades.recoveryFactor.toFixed(2)),
    statCard("Net profit", fmtUSD(t.netProfit), t.netProfit >= 0 ? "pos" : "neg"),
    statCard("Trades", `${t.total}`),
    statCard("Volatility (ann.)", `${metrics.volatilityPct.toFixed(1)}%`),
  ].join("");

  const tradeRows = result.trades.slice().reverse().slice(0, 60).map(tr => {
    const cls = tr.netPnl >= 0 ? "pos" : "neg";
    return `<tr><td>${new Date(tr.entryTime * 1000).toISOString().slice(0, 10)}</td><td>${tr.side.toUpperCase()}</td><td>${tr.qty}</td><td>${tr.entryPrice}</td><td>${tr.exitPrice}</td><td class="${cls}">${fmtUSD(tr.netPnl)}</td><td>${tr.exitReason}</td><td>${tr.barsHeld}</td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Dwella Backtest · ${result.symbol} ${result.timeframe}</title>
<style>
  *{box-sizing:border-box}body{margin:0;background:#06060a;color:#e8e6ef;font:14px/1.5 Barlow,system-ui,sans-serif;padding:26px}
  h1{font:italic 34px 'Instrument Serif';margin:0}header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:14px;margin-bottom:18px}
  .tag{color:#9d8cff}small,.muted{color:#7c7a82;font-size:12px}
  .panel{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:16px 18px;margin-bottom:16px}
  .panel h3{margin:0 0 10px;font-weight:500;font-size:14px;color:#cfcbe0}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:11px 13px}.stat span{display:block;font-size:10px;color:#8a878f;letter-spacing:.4px;text-transform:uppercase}.stat b{font:italic 24px 'Instrument Serif'}
  .pos{color:${GREEN}}.neg{color:${RED}}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:6px 8px;border-top:1px solid rgba(255,255,255,.06);font-variant-numeric:tabular-nums}th{color:#7c7a82;font-weight:500;text-transform:uppercase;font-size:10px}
  .chart{margin-top:4px}
  .legend{display:flex;gap:16px;font-size:11px;color:#a39fb0;margin-top:6px}
  @media(max-width:720px){.stats{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}}
</style></head><body>
<header><div><h1>Dwella Backtest Report</h1><div class="tag">${result.symbol} · ${result.timeframe} · ${result.strategyName}</div></div>
<div style="text-align:right"><small>${range}</small><br><b>${result.barsProcessed} bars</b> · ${result.dataGapsFilled} gaps filled</div></header>

<div class="panel"><h3>Performance summary</h3><div class="stats">${metricGrid}</div></div>

<div class="panel"><h3>Equity curve</h3><div class="chart">${equityChart(result.equityCurve)}</div>
<div class="legend"><span>Start ${fmtUSD(metrics.initialCapital)}</span><span>End ${fmtUSD(metrics.finalEquity)}</span></div></div>

<div class="panel"><h3>Drawdown</h3><div class="chart">${drawdownChart(result.equityCurve)}</div></div>

<div class="grid2">
  <div class="panel"><h3>Monthly returns</h3><div class="chart">${monthlyBars(metrics.monthly)}</div></div>
  <div class="panel"><h3>Trade P&amp;L distribution</h3><div class="chart">${pnlHistogram(result.trades)}</div></div>
</div>

<div class="panel"><h3>Trade log (last ${Math.min(60, result.trades.length)})</h3>
<table><thead><tr><th>Entry</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Net P&amp;L</th><th>Exit</th><th>Bars</th></tr></thead><tbody>${tradeRows}</tbody></table></div>

<div class="panel"><h3>Run configuration</h3><pre style="white-space:pre-wrap;color:#a39fb0;font:11px ui-monospace,monospace">${JSON.stringify({ ...result.config, params: result.params }, null, 2)}</pre></div>
<footer class="muted" style="text-align:center;margin-top:20px">Generated by Dwella Backtest Engine · slippage ${result.config.slippageTicks ?? 1} tick · commission ${result.config.commissionPerContract ?? 0}/contract/side</footer>
</body></html>`;
}

export function tradesToCSV(result: BacktestResult): string {
  const header = "id,symbol,side,qty,entry_time,entry_price,exit_time,exit_price,sl,tp,exit_reason,gross_pnl,commission,net_pnl,net_pnl_pct,bars_held,mfe,mae";
  const rows = result.trades.map(t =>
    [t.id, t.symbol, t.side, t.qty, new Date(t.entryTime * 1000).toISOString(), t.entryPrice, new Date(t.exitTime * 1000).toISOString(), t.exitPrice, t.sl ?? "", t.tp ?? "", t.exitReason, t.grossPnl, t.commission, t.netPnl, t.netPnlPct, t.barsHeld, t.mfe, t.mae].join(","),
  );
  return [header, ...rows].join("\n");
}

export function equityToCSV(result: BacktestResult): string {
  const rows = result.equityCurve.map(p => `${new Date(p.time * 1000).toISOString()},${p.equity},${p.drawdown},${p.price}`);
  return ["timestamp,equity,drawdown_pct,price", ...rows].join("\n");
}

/** Browser-only: trigger a file download for the HTML report. */
export function downloadReport(result: BacktestResult, metrics: Metrics, filename?: string): void {
  const html = buildHTMLReport(result, metrics);
  triggerDownload(filename ?? `dwella-backtest-${result.symbol}-${result.timeframe}-${Date.now()}.html`, "text/html", html);
}
export function downloadCSV(result: BacktestResult, filename?: string): void {
  triggerDownload(filename ?? `dwella-trades-${result.symbol}-${Date.now()}.csv`, "text/csv", tradesToCSV(result));
}
function triggerDownload(name: string, mime: string, content: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
