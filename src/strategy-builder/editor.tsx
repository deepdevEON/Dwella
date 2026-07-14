/**
 * StrategyEditor — the visual, block-based strategy editor.
 *
 * This module owns:
 *   - the block model (default configs, metadata, summaries),
 *   - a compiler that turns a StrategyGraph into a runnable `Strategy`
 *     (so the visual strategy can be backtested with BacktestEngine),
 *   - the React <StrategyEditor> canvas: draggable blocks, port-to-port
 *     connections, palette and selection.
 *
 * The UI is intentionally TradingView-flavoured: conditions feed logic gates
 * that feed actions (conditions -> logic -> actions).
 */

import { useCallback, useRef, useState } from "react";
import type { Bar } from "../replay-engine";
import type {
  Strategy,
  BarContext,
  OrderRequest,
  Position,
  Side,
} from "../backtest/engine";
import { IndicatorLibrary, IndicatorCache } from "./indicators";
import type {
  StrategyBlock,
  StrategyGraph,
  BlockType,
  IndicatorId,
  ComparisonOp,
  Operand,
  PriceField,
  PriceActionPattern,
  TimeConfig,
  SlTpMode,
} from "./types";

export * from "./types";

/* ── Block metadata ─────────────────────────────────────────────────────── */

export type BlockGroup = "condition" | "logic" | "action";

export interface BlockMeta {
  type: BlockType;
  label: string;
  group: BlockGroup;
  accent: string;
  hint: string;
}

export const BLOCK_LIBRARY: BlockMeta[] = [
  { type: "indicator", label: "Indicator", group: "condition", accent: "#9d8cff", hint: "Compare an indicator to a value" },
  { type: "priceAction", label: "Price Action", group: "condition", accent: "#9d8cff", hint: "Candle pattern / price relation" },
  { type: "time", label: "Time", group: "condition", accent: "#9d8cff", hint: "Trade only during a time window" },
  { type: "custom", label: "Custom", group: "condition", accent: "#9d8cff", hint: "Free-form boolean expression" },
  { type: "and", label: "AND", group: "logic", accent: "#5cc8d8", hint: "All inputs true" },
  { type: "or", label: "OR", group: "logic", accent: "#5cc8d8", hint: "Any input true" },
  { type: "not", label: "NOT", group: "logic", accent: "#5cc8d8", hint: "Invert a single input" },
  { type: "buy", label: "Buy", group: "action", accent: "#6fd8aa", hint: "Open a long position" },
  { type: "sell", label: "Sell", group: "action", accent: "#f18489", hint: "Open a short position" },
  { type: "close", label: "Close", group: "action", accent: "#e7a64f", hint: "Flatten the open position" },
  { type: "modifySLTP", label: "Modify SL/TP", group: "action", accent: "#7487ff", hint: "Adjust stop / target on open trade" },
];

export const BLOCK_META: Record<BlockType, BlockMeta> = Object.fromEntries(
  BLOCK_LIBRARY.map((b) => [b.type, b]),
) as Record<BlockType, BlockMeta>;

export const isCondition = (t: BlockType) =>
  t === "indicator" || t === "priceAction" || t === "time" || t === "custom";
export const isLogic = (t: BlockType) => t === "and" || t === "or" || t === "not";
export const isAction = (t: BlockType) =>
  t === "buy" || t === "sell" || t === "close" || t === "modifySLTP";

const COMPARISONS: ComparisonOp[] = [
  ">",
  "<",
  ">=",
  "<=",
  "==",
  "crossAbove",
  "crossBelow",
];
export const COMPARISON_LABELS: Record<ComparisonOp, string> = {
  ">": ">",
  "<": "<",
  ">=": "≥",
  "<=": "≤",
  "==": "=",
  crossAbove: "crosses ↑",
  crossBelow: "crosses ↓",
};
export { COMPARISONS };

export const PRICE_FIELDS: { value: PriceField; label: string }[] = [
  { value: "close", label: "Close" },
  { value: "open", label: "Open" },
  { value: "high", label: "High" },
  { value: "low", label: "Low" },
  { value: "hl2", label: "(H+L)/2" },
  { value: "ohlc4", label: "(O+H+L+C)/4" },
  { value: "volume", label: "Volume" },
];

export const PATTERNS: { value: PriceActionPattern; label: string }[] = [
  { value: "bullishEngulfing", label: "Bullish Engulfing" },
  { value: "bearishEngulfing", label: "Bearish Engulfing" },
  { value: "hammer", label: "Hammer" },
  { value: "shootingStar", label: "Shooting Star" },
  { value: "doji", label: "Doji" },
  { value: "higherHigh", label: "Higher High" },
  { value: "lowerLow", label: "Lower Low" },
  { value: "insideBar", label: "Inside Bar" },
  { value: "outsideBar", label: "Outside Bar" },
];

export const SLTP_MODES: { value: SlTpMode; label: string }[] = [
  { value: "none", label: "Off" },
  { value: "atr", label: "ATR ×" },
  { value: "ticks", label: "Points" },
  { value: "rr", label: "R:R" },
  { value: "price", label: "Price" },
];

/* ── Block creation / defaults ─────────────────────────────────────────── */

let idSeq = 0;
export function newId(prefix = "b"): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36)}${idSeq}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function createBlock(type: BlockType, x: number, y: number): StrategyBlock {
  const base: StrategyBlock = { id: newId(), type, x, y };
  switch (type) {
    case "indicator":
      return {
        ...base,
        indicator: "RSI",
        indicatorParams: { period: 14 },
        indicatorSeries: "value",
        comparison: "<",
        operand: { kind: "const", value: 30 },
      };
    case "priceAction":
      return { ...base, pattern: "bullishEngulfing" };
    case "time":
      return {
        ...base,
        time: { mode: "range", rangeStart: "09:30", rangeEnd: "16:00", days: [1, 2, 3, 4, 5] },
      };
    case "custom":
      return { ...base, customExpr: "rsi(14) < 30 && close > close[1]" };
    case "and":
    case "or":
    case "not":
      return base;
    case "buy":
    case "sell":
      return {
        ...base,
        qty: 1,
        orderType: "market",
        limitOffset: 0,
        slMode: "atr",
        slValue: 2,
        tpMode: "rr",
        tpValue: 2,
      };
    case "close":
      return base;
    case "modifySLTP":
      return {
        ...base,
        modify: { sl: { mode: "atr", value: 2 }, tp: { mode: "atr", value: 3 } },
      };
  }
}

/* ── Human-readable summaries ──────────────────────────────────────────── */

export function indicatorLabel(b: StrategyBlock): string {
  const def = b.indicator ? IndicatorLibrary.get(b.indicator) : null;
  if (!def) return "Indicator";
  const ps = Object.entries(b.indicatorParams || {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `${def.id}(${ps})`;
}

function operandLabel(o?: Operand): string {
  if (!o) return "?";
  if (o.kind === "const") return String(o.value);
  if (o.kind === "price") return PRICE_FIELDS.find((f) => f.value === o.field)?.label ?? o.field;
  return `${o.indicator}(${Object.values(o.params).join(",")})`;
}

export function blockSummary(b: StrategyBlock): string {
  switch (b.type) {
    case "indicator":
      return `${indicatorLabel(b)} ${COMPARISON_LABELS[b.comparison ?? ">"]} ${operandLabel(b.operand)}`;
    case "priceAction":
      return PATTERNS.find((p) => p.value === b.pattern)?.label ?? "Price Action";
    case "time": {
      const t = b.time;
      if (!t) return "Time";
      if (t.mode === "hour") return `Hour = ${t.hour ?? 0}`;
      if (t.mode === "weekday") return `Weekday = ${t.weekday ?? 0}`;
      return `${t.rangeStart}–${t.rangeEnd}`;
    }
    case "custom":
      return b.customExpr || "custom";
    case "and":
      return "AND";
    case "or":
      return "OR";
    case "not":
      return "NOT";
    case "buy":
      return `Buy ${b.qty ?? 1}`;
    case "sell":
      return `Sell ${b.qty ?? 1}`;
    case "close":
      return "Close position";
    case "modifySLTP":
      return "Modify SL / TP";
  }
}

/* ── Compiler: StrategyGraph -> runnable Strategy ───────────────────────── */

function priceField(bar: Bar, field: PriceField): number {
  switch (field) {
    case "open": return bar.open;
    case "high": return bar.high;
    case "low": return bar.low;
    case "close": return bar.close;
    case "volume": return bar.volume;
    case "hl2": return (bar.high + bar.low) / 2;
    case "ohlc4": return (bar.open + bar.high + bar.low + bar.close) / 4;
  }
}

function operandValue(o: Operand, bars: Bar[], index: number, cache: IndicatorCache): number | null {
  switch (o.kind) {
    case "const": return o.value;
    case "price": return priceField(bars[index], o.field);
    case "indicator": {
      const v = IndicatorLibrary.compute(o.indicator, o.params, bars, index, cache)[o.series];
      return typeof v === "number" ? v : null;
    }
  }
}

function evalIndicator(b: StrategyBlock, bars: Bar[], index: number, cache: IndicatorCache): boolean {
  if (!b.indicator || !b.comparison || !b.operand) return false;
  const def = IndicatorLibrary.get(b.indicator);
  const series = b.indicatorSeries || def.series[0];
  const subjNow = IndicatorLibrary.compute(b.indicator, b.indicatorParams || {}, bars, index, cache)[series];
  const subjPrev = index >= 1 ? IndicatorLibrary.compute(b.indicator, b.indicatorParams || {}, bars, index - 1, cache)[series] : null;
  const op = b.comparison;
  if (op === "crossAbove" || op === "crossBelow") {
    if (index < 1) return false;
    const objNow = operandValue(b.operand, bars, index, cache);
    const objPrev = operandValue(b.operand, bars, index - 1, cache);
    if (subjNow == null || objNow == null || subjPrev == null || subjPrev === objNow && subjPrev == null) {
      // fallthrough handled by null checks below
    }
    if (subjNow == null || objNow == null || subjPrev == null || objPrev == null) return false;
    return op === "crossAbove"
      ? subjNow > objNow && (subjPrev as number) <= (objPrev as number)
      : subjNow < objNow && (subjPrev as number) >= (objPrev as number);
  }
  const objNow = operandValue(b.operand, bars, index, cache);
  if (subjNow == null || objNow == null) return false;
  switch (op) {
    case ">": return subjNow > objNow;
    case "<": return subjNow < objNow;
    case ">=": return subjNow >= objNow;
    case "<=": return subjNow <= objNow;
    case "==": return subjNow === objNow;
  }
  return false;
}

function evalPattern(pattern: PriceActionPattern | undefined, bars: Bar[], index: number): boolean {
  if (!pattern || index < 1) return false;
  const c = bars[index];
  const prev = bars[index - 1];
  const body = Math.abs(c.close - c.open);
  const rng = c.high - c.low;
  switch (pattern) {
    case "bullishEngulfing":
      return c.close > c.open && prev.close < prev.open && c.close >= prev.open && c.open <= prev.close;
    case "bearishEngulfing":
      return c.close < c.open && prev.close > prev.open && c.open >= prev.close && c.close <= prev.open;
    case "doji":
      return rng > 0 && body / rng < 0.15;
    case "hammer": {
      if (!(c.close > c.open)) return false;
      const upper = c.high - Math.max(c.open, c.close);
      const lower = Math.min(c.open, c.close) - c.low;
      return lower > 2 * upper && upper < 0.3 * rng;
    }
    case "shootingStar": {
      if (!(c.close < c.open)) return false;
      const lower = Math.min(c.open, c.close) - c.low;
      const upper = c.high - Math.max(c.open, c.close);
      return upper > 2 * lower && lower < 0.3 * rng;
    }
    case "higherHigh": return c.high > prev.high;
    case "lowerLow": return c.low < prev.low;
    case "insideBar": return c.high < prev.high && c.low > prev.low;
    case "outsideBar": return c.high > prev.high && c.low < prev.low;
  }
  return false;
}

function parseHM(s?: string): [number, number] {
  if (!s) return [0, 0];
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return [h || 0, m || 0];
}

function evalTime(cfg: TimeConfig | undefined, bar: Bar): boolean {
  if (!cfg) return false;
  const d = new Date(bar.time * 1000);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  const wd = d.getUTCDay();
  switch (cfg.mode) {
    case "hour":
      return cfg.hour !== undefined && Math.round(hour) === cfg.hour;
    case "weekday":
      return cfg.weekday !== undefined && wd === cfg.weekday;
    case "range": {
      if (cfg.days && cfg.days.length && !cfg.days.includes(wd)) return false;
      if (!cfg.rangeStart || !cfg.rangeEnd) return true;
      const [sh, sm] = parseHM(cfg.rangeStart);
      const [eh, em] = parseHM(cfg.rangeEnd);
      const start = sh + sm / 60;
      const end = eh + em / 60;
      if (start <= end) return hour >= start && hour <= end;
      return hour >= start || hour <= end;
    }
  }
  return false;
}

/** Compile a custom expression into a safe boolean evaluator. Returns null on syntax error. */
function compileCustom(
  expr: string,
): ((bars: Bar[], index: number, cache: IndicatorCache) => boolean) | null {
  try {
    const fn = new Function(
      "bars",
      "index",
      "cache",
      "ind",
      "Math",
      `
      const bar = bars[index] || {open:0,high:0,low:0,close:0,volume:0,time:0};
      const open=bar.open, high=bar.high, low=bar.low, close=bar.close, volume=bar.volume;
      const hl2=(high+low)/2, ohlc4=(open+high+low+close)/4;
      const sma=(p)=>ind('SMA',{period:p}).value;
      const ema=(p)=>ind('EMA',{period:p}).value;
      const rsi=(p)=>ind('RSI',{period:p}).value;
      const atr=(p)=>ind('ATR',{period:p}).value;
      const macd=()=>ind('MACD',{fast:12,slow:26,signal:9}).macd;
      const boll=(m)=>ind('BOLL',{period:20,mult:m}).middle;
      const vwap=()=>ind('VWAP',{}).value;
      const vol=(p)=>ind('VOL',{period:p}).value;
      try { return !!(${expr}); } catch(e){ return false; }
      `,
    ) as (bars: Bar[], index: number, cache: IndicatorCache, ind: unknown, m: Math) => boolean;
    return (bars, index, cache) => {
      const ind = (id: IndicatorId, params: Record<string, number>) =>
        IndicatorLibrary.compute(id, params, bars, index, cache);
      try {
        return !!fn(bars, index, cache, ind, Math);
      } catch {
        return false;
      }
    };
  } catch {
    return null;
  }
}

function estimateWarmup(graph: StrategyGraph): number {
  let w = 2;
  for (const b of graph.blocks) {
    if (b.type === "indicator" && b.indicator) {
      w = Math.max(w, IndicatorLibrary.get(b.indicator).minWarmup(b.indicatorParams || {}));
    }
    if (b.type === "priceAction") w = Math.max(w, 2);
  }
  return w + 3;
}

export interface CompileResult {
  strategy?: Strategy;
  errors: string[];
}

export function compileGraph(graph: StrategyGraph): CompileResult {
  const errors: string[] = [];
  const actionBlocks = graph.blocks.filter((b) => isAction(b.type));
  if (actionBlocks.length === 0) {
    errors.push("Add at least one action block (Buy / Sell / Close / Modify SL·TP).");
  }

  const byId = new Map(graph.blocks.map((b) => [b.id, b]));
  const incoming = (id: string) => graph.connections.filter((c) => c.to === id);
  const customFns = new Map<string, (bars: Bar[], index: number, cache: IndicatorCache) => boolean>();

  for (const b of graph.blocks) {
    if (b.type === "custom") {
      const fn = compileCustom(b.customExpr || "false");
      if (!fn) errors.push(`Custom block "${b.id.slice(0, 8)}": invalid expression syntax.`);
      customFns.set(b.id, fn ?? (() => false));
    }
  }

  const evalNode = (
    id: string,
    bars: Bar[],
    index: number,
    cache: IndicatorCache,
    visiting: Set<string>,
  ): boolean => {
    if (visiting.has(id)) return false; // cycle guard
    const b = byId.get(id);
    if (!b) return false;
    visiting.add(id);
    let result = false;
    switch (b.type) {
      case "indicator":
        result = evalIndicator(b, bars, index, cache);
        break;
      case "priceAction":
        result = evalPattern(b.pattern, bars, index);
        break;
      case "time":
        result = evalTime(b.time, bars[index]);
        break;
      case "custom":
        result = customFns.get(id) ? customFns.get(id)!(bars, index, cache) : false;
        break;
      case "and":
        result = incoming(id).length > 0 && incoming(id).every((c) => evalNode(c.from, bars, index, cache, visiting));
        break;
      case "or":
        result = incoming(id).some((c) => evalNode(c.from, bars, index, cache, visiting));
        break;
      case "not": {
        const ins = incoming(id);
        result = ins.length > 0 ? !evalNode(ins[0].from, bars, index, cache, visiting) : false;
        break;
      }
      default:
        result = false;
    }
    visiting.delete(id);
    return result;
  };

  const getAtr = (bars: Bar[], index: number, cache: IndicatorCache): number =>
    IndicatorLibrary.compute("ATR", { period: 14 }, bars, index, cache).value ?? 0;

  const computeSlTp = (
    b: StrategyBlock,
    side: Side,
    bars: Bar[],
    index: number,
    cache: IndicatorCache,
    price: number,
  ): { sl?: number; tp?: number } => {
    const dir = side === "long" ? 1 : -1;
    const a = getAtr(bars, index, cache);
    let sl: number | undefined;
    if (b.slMode === "atr") sl = price - dir * a * (b.slValue ?? 0);
    else if (b.slMode === "ticks") sl = price - dir * (b.slValue ?? 0);
    else if (b.slMode === "price") sl = b.slValue;
    let tp: number | undefined;
    if (b.tpMode === "atr") tp = price + dir * a * (b.tpValue ?? 0);
    else if (b.tpMode === "ticks") tp = price + dir * (b.tpValue ?? 0);
    else if (b.tpMode === "rr" && b.slMode && b.slMode !== "none" && b.slValue) {
      const slDist = b.slMode === "atr" ? a * b.slValue : b.slValue;
      tp = price + dir * slDist * (b.tpValue ?? 0);
    } else if (b.tpMode === "price") tp = b.tpValue;
    return { sl, tp };
  };

  const executeAction = (b: StrategyBlock, ctx: BarContext, cache: IndicatorCache): void => {
    const { bars, index } = ctx;
    const bar = bars[index];
    const price = bar.close;
    const qty = b.qty && b.qty > 0 ? Math.floor(b.qty) : 1;
    const side: Side = b.type === "sell" ? "short" : "long";

    if (b.type === "close") {
      ctx.close(b.id);
      return;
    }
    if (b.type === "buy" || b.type === "sell") {
      if (ctx.position) return;
      const { sl, tp } = computeSlTp(b, side, bars, index, cache, price);
      const req: Partial<OrderRequest> = { qty, sl, tp, label: b.id };
      if (b.orderType === "limit") {
        req.type = "limit";
        req.limitPrice = side === "long" ? price - (b.limitOffset ?? 0) : price + (b.limitOffset ?? 0);
      } else if (b.orderType === "stop") {
        req.type = "stop";
        req.stopPrice = side === "long" ? price + (b.limitOffset ?? 0) : price - (b.limitOffset ?? 0);
      }
      if (side === "long") ctx.buy(req);
      else ctx.sell(req);
      return;
    }
    if (b.type === "modifySLTP") {
      if (!ctx.position) return;
      const pos: Position = ctx.position;
      const dir = pos.side === "long" ? 1 : -1;
      const entry = pos.entryPrice;
      const a = getAtr(bars, index, cache);
      if (b.modify?.sl && b.modify.sl.mode !== "none") {
        const off =
          b.modify.sl.mode === "atr" ? a * b.modify.sl.value : b.modify.sl.mode === "ticks" ? b.modify.sl.value : 0;
        pos.sl = b.modify.sl.mode === "price" ? b.modify.sl.value : entry - dir * off;
      }
      if (b.modify?.tp && b.modify.tp.mode !== "none") {
        const off =
          b.modify.tp.mode === "atr" ? a * b.modify.tp.value : b.modify.tp.mode === "ticks" ? b.modify.tp.value : 0;
        pos.tp = b.modify.tp.mode === "price" ? b.modify.tp.value : entry + dir * off;
      }
    }
  };

  const warmup = estimateWarmup(graph);
  const slug = (graph.name || "visual")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "visual";

  const strategy: Strategy = {
    id: `visual-${slug}-${Date.now().toString(36)}`,
    name: graph.name || "Visual Strategy",
    description: graph.description || "Built with the visual strategy builder.",
    warmupBars: warmup,
    onBar(ctx: BarContext) {
      const { bars, index } = ctx;
      const cache = new IndicatorCache(bars);
      for (const action of actionBlocks) {
        const ins = incoming(action.id);
        if (ins.length === 0) continue; // not wired -> never fires
        let fire = true;
        for (const conn of ins) {
          if (!evalNode(conn.from, bars, index, cache, new Set())) {
            fire = false;
            break;
          }
        }
        if (fire) executeAction(action, ctx, cache);
      }
    },
  };

  return { strategy, errors };
}

/* ── Sample graph (template) ───────────────────────────────────────────── */

export function createSampleGraph(): StrategyGraph {
  const rsiBuy = createBlock("indicator", 60, 80);
  rsiBuy.indicator = "RSI";
  rsiBuy.indicatorParams = { period: 14 };
  rsiBuy.comparison = "<";
  rsiBuy.operand = { kind: "const", value: 30 };

  const rsiSell = createBlock("indicator", 60, 260);
  rsiSell.indicator = "RSI";
  rsiSell.indicatorParams = { period: 14 };
  rsiSell.comparison = ">";
  rsiSell.operand = { kind: "const", value: 70 };

  const buy = createBlock("buy", 420, 120);
  const sell = createBlock("sell", 420, 300);

  return {
    version: 1,
    name: "RSI Mean Reversion",
    description: "Buy when RSI(14) < 30, sell when RSI(14) > 70. ATR-based stop, 2:1 target.",
    symbol: "NQ",
    timeframe: "M5",
    blocks: [rsiBuy, rsiSell, buy, sell],
    connections: [
      { id: newId("c"), from: rsiBuy.id, to: buy.id },
      { id: newId("c"), from: rsiSell.id, to: sell.id },
    ],
  };
}

export function createEmptyGraph(): StrategyGraph {
  return {
    version: 1,
    name: "Untitled Strategy",
    description: "",
    symbol: "NQ",
    timeframe: "M5",
    blocks: [],
    connections: [],
  };
}

/* ── React canvas component ────────────────────────────────────────────── */

const BLOCK_W = 196;
const HEADER_H = 30;

export interface StrategyEditorProps {
  graph: StrategyGraph;
  onChange: (g: StrategyGraph) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function StrategyEditor({ graph, onChange, selectedId, onSelect }: StrategyEditorProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const placeRef = useRef(0);

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return {
      x: clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0),
      y: clientY - rect.top + (canvasRef.current?.scrollTop ?? 0),
    };
  }, []);

  const updateBlock = useCallback(
    (id: string, patch: Partial<StrategyBlock>) => {
      onChange({
        ...graph,
        blocks: graph.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      });
    },
    [graph, onChange],
  );

  const addBlock = useCallback(
    (type: BlockType) => {
      placeRef.current = (placeRef.current + 1) % 6;
      const x = 80 + placeRef.current * 26;
      const y = 80 + placeRef.current * 26;
      const b = createBlock(type, x, y);
      onChange({ ...graph, blocks: [...graph.blocks, b] });
      onSelect(b.id);
    },
    [graph, onChange, onSelect],
  );

  const deleteBlock = useCallback(
    (id: string) => {
      onChange({
        ...graph,
        blocks: graph.blocks.filter((b) => b.id !== id),
        connections: graph.connections.filter((c) => c.from !== id && c.to !== id),
      });
      if (selectedId === id) onSelect(null);
    },
    [graph, onChange, onSelect, selectedId],
  );

  const deleteConnection = useCallback(
    (id: string) => {
      onChange({ ...graph, connections: graph.connections.filter((c) => c.id !== id) });
    },
    [graph, onChange],
  );

  /* drag blocks */
  const onBlockPointerDown = (e: React.PointerEvent, b: StrategyBlock) => {
    if ((e.target as HTMLElement).dataset.port) return; // port click handled separately
    e.stopPropagation();
    onSelect(b.id);
    const pos = toCanvas(e.clientX, e.clientY);
    dragRef.current = { id: b.id, dx: pos.x - b.x, dy: pos.y - b.y };
    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const p = toCanvas(ev.clientX, ev.clientY);
      updateBlock(dragRef.current.id, { x: p.x - dragRef.current.dx, y: p.y - dragRef.current.dy });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /* create connection via output port */
  const onPortDown = (e: React.PointerEvent, fromId: string) => {
    e.stopPropagation();
    const pos = toCanvas(e.clientX, e.clientY);
    setLinking({ from: fromId, x: pos.x, y: pos.y });
    const move = (ev: PointerEvent) => {
      const p = toCanvas(ev.clientX, ev.clientY);
      setLinking((l) => (l ? { ...l, x: p.x, y: p.y } : l));
    };
    const up = (ev: PointerEvent) => {
      const target = (ev.target as HTMLElement).dataset.portIn;
      if (target && target !== fromId) {
        const existing = graph.connections.filter((c) => c.to === target);
        const next = graph.connections.filter((c) => c.to !== target);
        next.push({ id: newId("c"), from: fromId, to: target });
        onChange({ ...graph, connections: next });
      }
      setLinking(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const portPos = (b: StrategyBlock, side: "in" | "out") => ({
    x: b.x + (side === "in" ? 0 : BLOCK_W),
    y: b.y + HEADER_H,
  });

  const byId = new Map(graph.blocks.map((b) => [b.id, b]));
  const pathBetween = (a: StrategyBlock, b: StrategyBlock) => {
    const p1 = portPos(a, "out");
    const p2 = portPos(b, "in");
    const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
    return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
  };

  return (
    <div className="sb-editor">
      <div className="sb-palette">
        {(["condition", "logic", "action"] as BlockGroup[]).map((group) => (
          <div className="sb-pal-group" key={group}>
            <div className="sb-pal-title">{group}</div>
            {BLOCK_LIBRARY.filter((m) => m.group === group).map((m) => (
              <button
                type="button"
                key={m.type}
                className="sb-pal-item"
                style={{ borderColor: m.accent + "66" }}
                onClick={() => addBlock(m.type)}
                title={m.hint}
              >
                <i style={{ background: m.accent }} />
                {m.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div
        className="sb-canvas"
        ref={canvasRef}
        onPointerDown={() => onSelect(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        <svg className="sb-wires">
          {graph.connections.map((c) => {
            const a = byId.get(c.from);
            const b = byId.get(c.to);
            if (!a || !b) return null;
            const p1 = portPos(a, "out");
            const p2 = portPos(b, "in");
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            return (
              <g key={c.id}>
                <path d={pathBetween(a, b)} className="sb-wire" />
                <circle
                  cx={mx}
                  cy={my}
                  r={7}
                  className="sb-wire-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConnection(c.id);
                  }}
                />
                <text x={mx} y={my + 3} className="sb-wire-del-x">×</text>
              </g>
            );
          })}
          {linking &&
            (() => {
              const a = byId.get(linking.from);
              if (!a) return null;
              const p1 = portPos(a, "out");
              const dx = Math.max(40, Math.abs(linking.x - p1.x) / 2);
              return (
                <path
                  d={`M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${linking.x - dx} ${linking.y}, ${linking.x} ${linking.y}`}
                  className="sb-wire linking"
                />
              );
            })()}
        </svg>

        {graph.blocks.map((b) => {
          const meta = BLOCK_META[b.type];
          const hasInput = isLogic(b.type) || isAction(b.type);
          const hasOutput = isCondition(b.type) || isLogic(b.type);
          return (
            <div
              key={b.id}
              className={`sb-block ${selectedId === b.id ? "selected" : ""} ${b.type}`}
              style={{ left: b.x, top: b.y, width: BLOCK_W, borderColor: meta.accent + "88" }}
              onPointerDown={(e) => onBlockPointerDown(e, b)}
            >
              {hasInput && (
                <span
                  className="sb-port in"
                  data-port-in={b.id}
                  style={{ background: meta.accent }}
                  title="Input"
                />
              )}
              <div className="sb-block-head" style={{ background: meta.accent + "22", color: meta.accent }}>
                <span>{meta.label}</span>
                {isAction(b.type) && (
                  <button
                    type="button"
                    className="sb-del"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteBlock(b.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="sb-block-body">{blockSummary(b)}</div>
              {hasOutput && (
                <span
                  className="sb-port out"
                  data-port="out"
                  style={{ background: meta.accent }}
                  title="Drag to connect"
                  onPointerDown={(e) => onPortDown(e, b.id)}
                />
              )}
            </div>
          );
        })}

        {graph.blocks.length === 0 && (
          <div className="sb-empty">
            Click a block in the palette to start. Connect outputs → inputs to build
            condition → logic → action flows.
          </div>
        )}
      </div>
    </div>
  );
}
