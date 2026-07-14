/**
 * StrategyBuilder — the page-level UI for the visual strategy builder.
 *
 * Wires together:
 *   - <StrategyEditor> (canvas) for building the block graph,
 *   - a properties panel for the selected block,
 *   - validation + computational-cost feedback,
 *   - a strategy library (localStorage) plus import/export,
 *   - a Preview / Backtest button that compiles the graph into a Strategy and
 *     runs it through the existing BacktestEngine.
 */

import { useMemo, useState, useCallback } from "react";
import { StrategyEditor, createSampleGraph, createEmptyGraph } from "./strategy-builder/editor";
import {
  IndicatorLibrary,
} from "./strategy-builder/indicators";
import {
  serializeStrategy,
  downloadStrategy,
  pickStrategyFile,
} from "./strategy-builder/serializer";
import { validateStrategy, starterGraph } from "./strategy-builder/validator";
import type {
  StrategyGraph,
  StrategyBlock,
  IndicatorId,
  Operand,
  PriceField,
  PriceActionPattern,
  TimeConfig,
  SlTpMode,
  ModifyLeg,
} from "./strategy-builder/types";
import { BLOCK_META, COMPARISONS, COMPARISON_LABELS, PRICE_FIELDS, PATTERNS, SLTP_MODES } from "./strategy-builder/editor";
import { compileGraph } from "./strategy-builder/editor";
import { DataManager } from "./backtest/data";
import { BacktestEngine, type Strategy, type StrategyParams } from "./backtest/engine";
import { MetricsCalculator, type Metrics } from "./backtest/metrics";
import type { Timeframe } from "./replay-engine";

const LIB_KEY = "dwella.strategyLibrary";
const TFS: Timeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const SYMBOLS = ["NQ", "ES", "GC", "MES", "MNQ", "MGC", "CL", "RTY"];

type Lib = Record<string, StrategyGraph>;

function loadLib(): Lib {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveLib(l: Lib) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

/* ── small field helpers ──────────────────────────────────────────────── */

function Num({ label, value, step = 1, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="sb-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="sb-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function IndicatorParamsEditor({ indicator, params, onChange }: { indicator: IndicatorId; params: Record<string, number>; onChange: (p: Record<string, number>) => void }) {
  const def = IndicatorLibrary.get(indicator);
  return (
    <>
      {def.params.map((spec) => (
        <Num
          key={spec.key}
          label={spec.label}
          value={params[spec.key] ?? spec.min}
          step={spec.step}
          min={spec.min}
          max={spec.max}
          onChange={(v) => onChange({ ...params, [spec.key]: v })}
        />
      ))}
    </>
  );
}

/* ── properties panel ─────────────────────────────────────────────────── */

function BlockProperties({ block, onPatch }: { block: StrategyBlock; onPatch: (p: Partial<StrategyBlock>) => void }) {
  const meta = BLOCK_META[block.type];
  return (
    <div className="sb-props">
      <div className="sb-props-head" style={{ color: meta.accent }}>
        {meta.label}
      </div>
      <p className="sb-props-hint">{meta.hint}</p>

      {block.type === "indicator" && (
        <>
          <Select<IndicatorId>
            label="Indicator"
            value={block.indicator || "RSI"}
            options={IndicatorLibrary.list().map((d) => ({ value: d.id, label: d.name }))}
            onChange={(v) => {
              const def = IndicatorLibrary.get(v);
              onPatch({ indicator: v, indicatorParams: IndicatorLibrary.defaultParams(v), indicatorSeries: def.series[0] });
            }}
          />
          {block.indicator && (
            <IndicatorParamsEditor
              indicator={block.indicator}
              params={block.indicatorParams || {}}
              onChange={(p) => onPatch({ indicatorParams: p })}
            />
          )}
          {block.indicator && IndicatorLibrary.get(block.indicator).series.length > 1 && (
            <Select
              label="Series"
              value={block.indicatorSeries || "value"}
              options={IndicatorLibrary.get(block.indicator).series.map((s) => ({ value: s, label: s }))}
              onChange={(v) => onPatch({ indicatorSeries: v })}
            />
          )}
          <Select<(typeof COMPARISONS)[number]>
            label="Comparison"
            value={block.comparison || ">"}
            options={COMPARISONS.map((c) => ({ value: c, label: COMPARISON_LABELS[c] }))}
            onChange={(v) => onPatch({ comparison: v })}
          />
          <OperandEditor operand={block.operand} onChange={(o) => onPatch({ operand: o })} />
        </>
      )}

      {block.type === "priceAction" && (
        <Select<PriceActionPattern>
          label="Pattern"
          value={block.pattern || "bullishEngulfing"}
          options={PATTERNS}
          onChange={(v) => onPatch({ pattern: v })}
        />
      )}

      {block.type === "time" && <TimeEditor cfg={block.time} onChange={(t) => onPatch({ time: t })} />}

      {block.type === "custom" && (
        <label className="sb-field col">
          <span>Expression (boolean)</span>
          <textarea
            rows={4}
            value={block.customExpr || ""}
            onChange={(e) => onPatch({ customExpr: e.target.value })}
            placeholder="rsi(14) < 30 && close > sma(50)"
          />
        </label>
      )}

      {(block.type === "buy" || block.type === "sell") && (
        <>
          <Num label="Quantity (contracts)" value={block.qty ?? 1} min={1} step={1} onChange={(v) => onPatch({ qty: v })} />
          <Select<"market" | "limit" | "stop">
            label="Order type"
            value={block.orderType || "market"}
            options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }, { value: "stop", label: "Stop" }]}
            onChange={(v) => onPatch({ orderType: v })}
          />
          {(block.orderType === "limit" || block.orderType === "stop") && (
            <Num
              label={block.orderType === "limit" ? "Limit offset (points)" : "Stop offset (points)"}
              value={block.limitOffset ?? 0}
              step={0.25}
              onChange={(v) => onPatch({ limitOffset: v })}
            />
          )}
          <SlTpEditor title="Stop loss (SL)" mode={block.slMode} value={block.slValue} onMode={(m) => onPatch({ slMode: m })} onValue={(v) => onPatch({ slValue: v })} />
          <SlTpEditor title="Take profit (TP)" mode={block.tpMode} value={block.tpValue} onMode={(m) => onPatch({ tpMode: m })} onValue={(v) => onPatch({ tpValue: v })} />
        </>
      )}

      {block.type === "modifySLTP" && (
        <>
          <div className="sb-subhead">Stop loss</div>
          <ModifyLegEditor
            leg={block.modify?.sl || { mode: "none", value: 0 }}
            onChange={(l) => onPatch({ modify: { ...block.modify, sl: l } })}
          />
          <div className="sb-subhead">Take profit</div>
          <ModifyLegEditor
            leg={block.modify?.tp || { mode: "none", value: 0 }}
            onChange={(l) => onPatch({ modify: { ...block.modify, tp: l } })}
          />
        </>
      )}

      {block.type === "close" && <p className="sb-props-hint">Closes the open position at the next bar's open when triggered.</p>}
      {block.type === "and" && <p className="sb-props-hint">Fires when every connected input is true.</p>}
      {block.type === "or" && <p className="sb-props-hint">Fires when any connected input is true.</p>}
      {block.type === "not" && <p className="sb-props-hint">Fires when its single input is false.</p>}
    </div>
  );
}

function OperandEditor({ operand, onChange }: { operand: Operand | undefined; onChange: (o: Operand) => void }) {
  const o: Operand = operand || { kind: "const", value: 0 };
  return (
    <div className="sb-group">
      <div className="sb-subhead">Compare against</div>
      <Select<"const" | "price" | "indicator">
        label="Type"
        value={o.kind}
        options={[
          { value: "const", label: "Constant" },
          { value: "price", label: "Price field" },
          { value: "indicator", label: "Another indicator" },
        ]}
        onChange={(k) => {
          if (k === "const") onChange({ kind: "const", value: 0 });
          else if (k === "price") onChange({ kind: "price", field: "close" });
          else onChange({ kind: "indicator", indicator: "SMA", params: { period: 50 }, series: "value" });
        }}
      />
      {o.kind === "const" && <Num label="Value" value={(o as { value: number }).value} onChange={(v) => onChange({ kind: "const", value: v })} />}
      {o.kind === "price" && (
        <Select<PriceField>
          label="Field"
          value={(o as { field: PriceField }).field}
          options={PRICE_FIELDS}
          onChange={(f) => onChange({ kind: "price", field: f })}
        />
      )}
      {o.kind === "indicator" && (
        <>
          <Select<IndicatorId>
            label="Indicator"
            value={(o as { indicator: IndicatorId }).indicator}
            options={IndicatorLibrary.list().map((d) => ({ value: d.id, label: d.name }))}
            onChange={(v) => {
              const def = IndicatorLibrary.get(v);
              onChange({ kind: "indicator", indicator: v, params: IndicatorLibrary.defaultParams(v), series: def.series[0] });
            }}
          />
          <IndicatorParamsEditor
            indicator={(o as { indicator: IndicatorId }).indicator}
            params={(o as { params: Record<string, number> }).params}
            onChange={(p) => onChange({ kind: "indicator", indicator: o.indicator, params: p, series: o.series })}
          />
          {(o as { indicator: IndicatorId }).indicator &&
            IndicatorLibrary.get((o as { indicator: IndicatorId }).indicator).series.length > 1 && (
              <Select
                label="Series"
                value={(o as { series: string }).series}
                options={IndicatorLibrary.get((o as { indicator: IndicatorId }).indicator).series.map((s) => ({ value: s, label: s }))}
                onChange={(s) => onChange({ kind: "indicator", indicator: o.indicator, params: o.params, series: s })}
              />
            )}
        </>
      )}
    </div>
  );
}

function TimeEditor({ cfg, onChange }: { cfg: TimeConfig | undefined; onChange: (t: TimeConfig) => void }) {
  const t: TimeConfig = cfg || { mode: "range", rangeStart: "09:30", rangeEnd: "16:00" };
  return (
    <div className="sb-group">
      <Select<"hour" | "weekday" | "range">
        label="Mode"
        value={t.mode}
        options={[
          { value: "hour", label: "Specific hour" },
          { value: "weekday", label: "Specific weekday" },
          { value: "range", label: "Time range" },
        ]}
        onChange={(m) => onChange({ ...t, mode: m })}
      />
      {t.mode === "hour" && <Num label="Hour (UTC)" value={t.hour ?? 0} min={0} max={23} onChange={(v) => onChange({ ...t, hour: v })} />}
      {t.mode === "weekday" && (
        <Select<"0" | "1" | "2" | "3" | "4" | "5" | "6">
          label="Weekday (UTC)"
          value={String(t.weekday ?? 1) as "1"}
          options={["0", "1", "2", "3", "4", "5", "6"].map((d) => ({ value: d as "1", label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(d)] }))}
          onChange={(v) => onChange({ ...t, weekday: Number(v) })}
        />
      )}
      {t.mode === "range" && (
        <>
          <label className="sb-field">
            <span>Start (HH:MM UTC)</span>
            <input type="time" value={t.rangeStart || "09:30"} onChange={(e) => onChange({ ...t, rangeStart: e.target.value })} />
          </label>
          <label className="sb-field">
            <span>End (HH:MM UTC)</span>
            <input type="time" value={t.rangeEnd || "16:00"} onChange={(e) => onChange({ ...t, rangeEnd: e.target.value })} />
          </label>
          <div className="sb-subhead">Trading days</div>
          <div className="sb-days">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => {
              const day = (i + 1) % 7; // Mon=1..Sun=0
              const sel = (t.days ?? []).includes(day);
              return (
                <button
                  key={d}
                  type="button"
                  className={sel ? "on" : ""}
                  onClick={() => {
                    const days = new Set(t.days ?? []);
                    if (days.has(day)) days.delete(day);
                    else days.add(day);
                    onChange({ ...t, days: [...days] });
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function SlTpEditor({ title, mode, value, onMode, onValue }: { title: string; mode: SlTpMode | undefined; value: number | undefined; onMode: (m: SlTpMode) => void; onValue: (v: number) => void }) {
  const m = mode || "none";
  return (
    <div className="sb-group">
      <div className="sb-subhead">{title}</div>
      <Select<SlTpMode> label="Mode" value={m} options={SLTP_MODES} onChange={onMode} />
      {m !== "none" && m !== "rr" && <Num label="Value" value={value ?? 0} step={m === "price" ? 0.25 : 0.5} onChange={onValue} />}
      {m === "rr" && <Num label="Reward : Risk" value={value ?? 2} step={0.25} onChange={onValue} />}
    </div>
  );
}

function ModifyLegEditor({ leg, onChange }: { leg: ModifyLeg; onChange: (l: ModifyLeg) => void }) {
  return (
    <div className="sb-group">
      <Select<"none" | "atr" | "ticks" | "price">
        label="Mode"
        value={leg.mode}
        options={[
          { value: "none", label: "Off" },
          { value: "atr", label: "ATR ×" },
          { value: "ticks", label: "Points" },
          { value: "price", label: "Price" },
        ]}
        onChange={(mode) => onChange({ ...leg, mode })}
      />
      {leg.mode !== "none" && (
        <Num label="Value" value={leg.value} step={leg.mode === "price" ? 0.25 : 0.5} onChange={(v) => onChange({ ...leg, value: v })} />
      )}
    </div>
  );
}

/* ── backtest result sparkline ────────────────────────────────────────── */

function EquitySpark({ points }: { points: { equity: number }[] }) {
  if (points.length < 2) return <div className="sb-spark-empty">Not enough data for a curve.</div>;
  const min = Math.min(...points.map((p) => p.equity));
  const max = Math.max(...points.map((p) => p.equity));
  const range = max - min || 1;
  const w = 300;
  const h = 70;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.equity - min) / range) * h;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1].equity >= points[0].equity;
  return (
    <svg className="sb-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke={up ? "#6fd8aa" : "#f18489"} strokeWidth="2" />
    </svg>
  );
}

/* ── main panel ────────────────────────────────────────────────────────── */

export default function StrategyBuilder() {
  const [graph, setGraph] = useState<StrategyGraph>(() => createEmptyGraph());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lib, setLib] = useState<Lib>(() => loadLib());
  const [toast, setToast] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [backtest, setBacktest] = useState<{ metrics: Metrics; strategyName: string; curve: { equity: number }[] } | null>(null);
  const [status, setStatus] = useState<string>("");

  const validation = useMemo(() => validateStrategy(graph), [graph]);
  const selected = graph.blocks.find((b) => b.id === selectedId) || null;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const patchSelected = useCallback(
    (patch: Partial<StrategyBlock>) => {
      if (!selectedId) return;
      setGraph((g) => ({
        ...g,
        blocks: g.blocks.map((b) => (b.id === selectedId ? { ...b, ...patch } : b)),
      }));
    },
    [selectedId],
  );

  const setMeta = useCallback((patch: Partial<StrategyGraph>) => {
    setGraph((g) => ({ ...g, ...patch }));
  }, []);

  const handleNew = () => {
    setGraph(createEmptyGraph());
    setSelectedId(null);
    setBacktest(null);
  };
  const handleSample = () => {
    setGraph(createSampleGraph());
    setSelectedId(null);
    setBacktest(null);
  };

  const saveToLib = () => {
    const name = graph.name.trim() || "Untitled Strategy";
    const next = { ...loadLib(), [name]: graph };
    saveLib(next);
    setLib(next);
    flash(`Saved "${name}" to library`);
  };
  const loadFromLib = (name: string) => {
    const g = lib[name];
    if (g) {
      setGraph(g);
      setSelectedId(null);
      setBacktest(null);
      flash(`Loaded "${name}"`);
    }
  };
  const deleteFromLib = (name: string) => {
    const next = { ...lib };
    delete next[name];
    saveLib(next);
    setLib(next);
  };

  const handleImport = async () => {
    const g = await pickStrategyFile();
    if (g) {
      setGraph(g);
      setSelectedId(null);
      setBacktest(null);
      flash("Imported strategy file");
    } else {
      flash("Import cancelled");
    }
  };
  const handleExport = () => {
    downloadStrategy(graph);
    flash("Exported strategy file");
  };

  const runBacktest = async () => {
    const { strategy, errors } = compileGraph(graph);
    if (!strategy || errors.length) {
      flash("Cannot backtest: " + (errors[0] || "compile failed"));
      return;
    }
    setRunning(true);
    setStatus("Loading market data…");
    try {
      const symbol = graph.symbol || "NQ";
      const base = (graph.timeframe || "M5") as Timeframe;
      const dm = new DataManager();
      const data = await dm.load(symbol, base, []);
      const engine = new BacktestEngine(
        BacktestEngine.withDefaults({
          symbol,
          baseTimeframe: base,
          initialCapital: 25000,
          allowShort: true,
          sizing: { mode: "fixed", contracts: 1 },
        }),
      );
      const params: StrategyParams = {};
      const result = engine.run(strategy as Strategy, data, params);
      const metrics = MetricsCalculator.compute(result);
      setBacktest({ metrics, strategyName: strategy.name, curve: result.equityCurve });
      setStatus(
        `${result.trades.length} trades · ${metrics.totalReturnPct >= 0 ? "+" : ""}${metrics.totalReturnPct.toFixed(1)}% · ${metrics.maxDrawdownPct.toFixed(1)}% DD`,
      );
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      flash("Backtest failed: " + (e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="sb-page">
      <div className="sb-toolbar">
        <input className="sb-name" value={graph.name} onChange={(e) => setMeta({ name: e.target.value })} placeholder="Strategy name" />
        <div className="sb-toolbar-group">
          <select value={graph.symbol || "NQ"} onChange={(e) => setMeta({ symbol: e.target.value })}>
            {SYMBOLS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={graph.timeframe || "M5"} onChange={(e) => setMeta({ timeframe: e.target.value as Timeframe })}>
            {TFS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="sb-toolbar-group">
          <button type="button" onClick={handleNew}>New</button>
          <button type="button" onClick={handleSample}>Template</button>
          <button type="button" onClick={saveToLib}>Save</button>
          <button type="button" onClick={handleImport}>Import</button>
          <button type="button" onClick={handleExport}>Export</button>
        </div>
        <div className="sb-toolbar-group right">
          <button type="button" className="primary" disabled={running} onClick={runBacktest}>
            {running ? "Running…" : "▶ Preview / Backtest"}
          </button>
        </div>
      </div>

      {status && <div className="sb-status">{status}</div>}

      <div className="sb-body">
        <StrategyEditor graph={graph} onChange={setGraph} selectedId={selectedId} onSelect={setSelectedId} />

        <aside className="sb-side">
          {selected ? (
            <BlockProperties block={selected} onPatch={patchSelected} />
          ) : (
            <>
              <div className="sb-panel-title">Validation</div>
              <div className={`sb-valid-pill ${validation.valid ? "ok" : "bad"}`}>
                {validation.valid ? "✓ Ready to run" : `${validation.errors.length} error(s)`}
              </div>
              <div className="sb-stat-row">
                <span>Conditions</span><b>{validation.conditionCount}</b>
                <span>Actions</span><b>{validation.reachableActions}/{validation.actionCount}</b>
              </div>
              <div className="sb-stat-row">
                <span>Warmup bars</span><b>{validation.warmupBars}</b>
                <span>Cost</span><b className={`cost-${validation.cost.rating}`}>{validation.cost.rating}</b>
              </div>
              <p className="sb-cost-note">{validation.cost.note}</p>

              {validation.errors.length > 0 && (
                <div className="sb-issues">
                  {validation.errors.map((e, i) => (
                    <div key={i} className="sb-issue err" onClick={() => e.blockId && setSelectedId(e.blockId)}>{e.message}</div>
                  ))}
                </div>
              )}
              {validation.warnings.length > 0 && (
                <div className="sb-issues">
                  {validation.warnings.map((w, i) => (
                    <div key={i} className="sb-issue warn" onClick={() => w.blockId && setSelectedId(w.blockId)}>{w.message}</div>
                  ))}
                </div>
              )}

              {backtest && (
                <div className="sb-result">
                  <div className="sb-panel-title">Backtest · {backtest.strategyName}</div>
                  <EquitySpark points={backtest.curve} />
                  <div className="sb-stat-row">
                    <span>Return</span><b className={backtest.metrics.totalReturnPct >= 0 ? "pos" : "neg"}>{backtest.metrics.totalReturnPct >= 0 ? "+" : ""}{backtest.metrics.totalReturnPct.toFixed(1)}%</b>
                    <span>Trades</span><b>{backtest.metrics.trades.total}</b>
                  </div>
                  <div className="sb-stat-row">
                    <span>Win rate</span><b>{backtest.metrics.trades.winRate.toFixed(0)}%</b>
                    <span>Max DD</span><b className="neg">{backtest.metrics.maxDrawdownPct.toFixed(1)}%</b>
                  </div>
                  <div className="sb-stat-row">
                    <span>Profit factor</span><b>{backtest.metrics.trades.profitFactor}</b>
                    <span>Sharpe</span><b>{backtest.metrics.sharpe}</b>
                  </div>
                </div>
              )}

              <div className="sb-panel-title">Library</div>
              <div className="sb-lib">
                {Object.keys(lib).length === 0 && <p className="sb-props-hint">No saved strategies yet. Build one and hit Save.</p>}
                {Object.keys(lib).map((name) => (
                  <div key={name} className="sb-lib-item">
                    <button type="button" className="link" onClick={() => loadFromLib(name)}>{name}</button>
                    <button type="button" className="x" onClick={() => deleteFromLib(name)}>×</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>

      {toast && <div className="toast">{toast}<span>Dismiss</span></div>}
    </div>
  );
}
