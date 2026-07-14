/**
 * BacktestEngine — event-driven, bar-by-bar backtesting simulation with realistic
 * execution modeling (next-bar market fills, limit/stop triggers, slippage, commission,
 * margin enforcement, portfolio-level equity tracking and risk-based position sizing).
 *
 * Pure TypeScript: no React, no DOM. Safe to run in the browser or in Node, which makes
 * it trivially testable and reusable by the report generator and the Backtest UI.
 */

import { Bar, Timeframe, timeframeSeconds } from "../replay-engine";

export type { Bar, Timeframe } from "../replay-engine";

export type Side = "long" | "short";
export type OrderType = "market" | "limit" | "stop";

export interface PositionSizing {
  mode: "fixed" | "risk";
  /** contracts per trade (fixed mode). */
  contracts?: number;
  /** fraction of equity risked per trade, e.g. 0.01 = 1% (risk mode). */
  riskPct?: number;
  /** hard cap on contracts regardless of sizing mode. */
  maxContracts?: number;
}

export interface StrategyParams {
  [key: string]: number | string;
}

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export interface OrderRequest {
  side: Side;
  type?: OrderType;
  qty?: number;
  limitPrice?: number;
  stopPrice?: number;
  sl?: number;
  tp?: number;
  label?: string;
}

/** Per-bar context handed to the strategy. */
export interface BarContext {
  symbol: string;
  bar: Bar;
  index: number;
  /** All base-timeframe bars up to and including the current one. */
  bars: Bar[];
  /** Higher-timeframe bars active at the current bar, keyed by timeframe. */
  tf: Record<string, Bar | null>;
  position: Position | null;
  pending: Order[];
  params: StrategyParams;
  equity: number;

  buy(req?: Partial<OrderRequest>): void;
  sell(req?: Partial<OrderRequest>): void;
  /** Flatten the open position at the next bar's open (with slippage). */
  close(reason?: string): void;
  cancel(orderId: string): void;
  log(msg: string): void;
}

export interface Strategy {
  id: string;
  name: string;
  description?: string;
  /** Parameter schema used to render controls + build the optimization grid. */
  params?: ParamSpec[];
  defaults?: StrategyParams;
  /** Bars the strategy needs historical context for (e.g. indicator warmup). */
  warmupBars?: number;
  onBar(ctx: BarContext): void | Promise<void>;
}

export interface BacktestConfig {
  symbol: string;
  baseTimeframe: Timeframe;
  initialCapital: number;
  /** Slippage in ticks applied to market/stop fills. Defaults to 1. */
  slippageTicks?: number;
  /** Commission charged per contract, per side, in account currency. */
  commissionPerContract?: number;
  /** $ per price point per contract (NQ = 20, ES = 50, GC = 100). */
  pointValue?: number;
  /** Minimum price increment (NQ = 0.25, GC = 0.1). */
  tickSize?: number;
  /** Margin required per contract (used for margin enforcement). */
  marginPerContract?: number;
  /** Annual risk-free rate (decimal) used for Sharpe. Defaults to 0.02. */
  riskFreeRate?: number;
  allowShort?: boolean;
  sizing?: PositionSizing;
  /** Inclusive date window (unix seconds). */
  startDate?: number;
  endDate?: number;
  /** Extra timeframes to keep aligned + available to the strategy. */
  additionalTimeframes?: Timeframe[];
}

export interface Order {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  sl?: number;
  tp?: number;
  status: "working" | "filled" | "cancelled";
  fillPrice?: number;
  fillBar?: number;
  fillTime?: number;
  label?: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryTime: number;
  entryBar: number;
  sl?: number;
  tp?: number;
  commission: number;
  /** running max favorable / adverse excursion in $ (for trade distribution). */
  mfe: number;
  mae: number;
}

export type ExitReason = "signal" | "stop" | "take-profit" | "end-of-data" | "margin";

export interface Trade {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  sl?: number;
  tp?: number;
  exitReason: ExitReason;
  grossPnl: number;
  commission: number;
  netPnl: number;
  netPnlPct: number;
  barsHeld: number;
  mfe: number;
  mae: number;
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdown: number;
  price: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: Timeframe;
  strategyId: string;
  strategyName: string;
  startDate: number;
  endDate: number;
  initialCapital: number;
  finalEquity: number;
  config: BacktestConfig;
  params: StrategyParams;
  equityCurve: EquityPoint[];
  trades: Trade[];
  logs: string[];
  barsProcessed: number;
  dataGapsFilled: number;
}

interface SymbolDefaults {
  pointValue: number;
  tickSize: number;
  marginPerContract: number;
  decimals: number;
}

const SYMBOL_DEFAULTS: Record<string, SymbolDefaults> = {
  NQ: { pointValue: 20, tickSize: 0.25, marginPerContract: 1000, decimals: 2 },
  MNQ: { pointValue: 2, tickSize: 0.25, marginPerContract: 100, decimals: 2 },
  ES: { pointValue: 50, tickSize: 0.25, marginPerContract: 500, decimals: 2 },
  MES: { pointValue: 5, tickSize: 0.25, marginPerContract: 50, decimals: 2 },
  YM: { pointValue: 5, tickSize: 1, marginPerContract: 400, decimals: 2 },
  GC: { pointValue: 100, tickSize: 0.1, marginPerContract: 1100, decimals: 1 },
  MGC: { pointValue: 10, tickSize: 0.1, marginPerContract: 110, decimals: 1 },
  CL: { pointValue: 1000, tickSize: 0.01, marginPerContract: 700, decimals: 2 },
  RTY: { pointValue: 50, tickSize: 0.25, marginPerContract: 500, decimals: 2 },
  EURUSD: { pointValue: 10, tickSize: 0.00001, marginPerContract: 2000, decimals: 5 },
  USDJPY: { pointValue: 1000, tickSize: 0.001, marginPerContract: 2000, decimals: 3 },
};

const FALLBACK: SymbolDefaults = { pointValue: 1, tickSize: 0.01, marginPerContract: 500, decimals: 2 };

function symbolDefaults(symbol: string): SymbolDefaults {
  return SYMBOL_DEFAULTS[symbol] ?? FALLBACK;
}

function round(n: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function slip(price: number, side: Side, ticks: number, tickSize: number): number {
  const s = ticks * tickSize;
  return side === "long" ? price + s : price - s;
}

let _orderSeq = 0;
function nextId(prefix: string): string {
  _orderSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${_orderSeq}`;
}

/**
 * Event-driven backtesting engine. Construct with a config, then call `run` with a
 * strategy and a (pre-loaded) MultiTimeframeData bundle.
 */
export class BacktestEngine {
  readonly config: BacktestConfig;
  private readonly sym: SymbolDefaults;

  constructor(config: BacktestConfig) {
    this.config = config;
    this.sym = symbolDefaults(config.symbol);
  }

  /** Convenience: build a config with symbol-appropriate defaults filled in. */
  static withDefaults(config: BacktestConfig): BacktestConfig {
    const d = symbolDefaults(config.symbol);
    return {
      slippageTicks: 1,
      commissionPerContract: 2.0,
      pointValue: d.pointValue,
      tickSize: d.tickSize,
      marginPerContract: d.marginPerContract,
      riskFreeRate: 0.02,
      allowShort: true,
      sizing: { mode: "fixed", contracts: 1 },
      ...config,
    };
  }

  private get slippageTicks(): number {
    return this.config.slippageTicks ?? 1;
  }
  private get tickSize(): number {
    return this.config.tickSize ?? this.sym.tickSize;
  }
  private get pointValue(): number {
    return this.config.pointValue ?? this.sym.pointValue;
  }
  private get marginPerContract(): number {
    return this.config.marginPerContract ?? this.sym.marginPerContract;
  }
  private get commissionPerContract(): number {
    return this.config.commissionPerContract ?? 2.0;
  }
  private get decimals(): number {
    return this.sym.decimals;
  }

  run(
    strategy: Strategy,
    data: { series: Partial<Record<Timeframe, Bar[]>>; aligned: Partial<Record<Timeframe, (Bar | null)[]>>; gapsFilled: number },
    params: StrategyParams = strategy.defaults ?? {},
  ): BacktestResult {
    const base = this.config.baseTimeframe;
    let bars = [...(data.series[base] ?? [])];
    if (this.config.startDate !== undefined) bars = bars.filter(b => b.time >= this.config.startDate!);
    if (this.config.endDate !== undefined) bars = bars.filter(b => b.time <= this.config.endDate!);
    if (bars.length < 2) {
      throw new Error(`Not enough ${base} bars for ${this.config.symbol} in the selected range.`);
    }

    const warmup = strategy.warmupBars ?? 0;
    const initial = this.config.initialCapital;
    let cash = initial;
    let equity = initial;
    let position: Position | null = null;
    const pending: Order[] = [];
    const exitRequests: { posId: string; fillBar: number; reason: string }[] = [];
    const trades: Trade[] = [];
    const logs: string[] = [];
    const equityCurve: EquityPoint[] = [];

    const log = (msg: string) => {
      if (logs.length < 5000) logs.push(msg);
    };

    const usedMargin = () => (position ? this.marginPerContract * position.qty : 0);

    /** Mark-to-market equity using the close of `bar`. */
    const markEquity = (bar: Bar): number => {
      if (!position) return cash;
      const dir = position.side === "long" ? 1 : -1;
      const u = (bar.close - position.entryPrice) * position.qty * this.pointValue * dir;
      return cash + u;
    };

    const computeQty = (req: Partial<OrderRequest>, side: Side): number => {
      const sizing = this.config.sizing ?? { mode: "fixed", contracts: 1 };
      if (req.qty && req.qty > 0) return Math.floor(req.qty);
      if (sizing.mode === "risk" && req.sl !== undefined) {
        const stopDist = Math.abs((req.sl as number) - (position?.entryPrice ?? bars[eqIndex].close));
        const riskDollars = (sizing.riskPct ?? 0.01) * equity;
        const q = stopDist > 0 ? Math.floor(riskDollars / (stopDist * this.pointValue)) : 0;
        const capped = sizing.maxContracts ? Math.min(q, sizing.maxContracts) : q;
        return Math.max(1, capped);
      }
      const fixed = sizing.contracts ?? 1;
      const capped = sizing.maxContracts ? Math.min(fixed, sizing.maxContracts) : fixed;
      return Math.max(1, Math.floor(capped));
    };

    let eqIndex = 0; // current bar index, kept visible to computeQty

    const openPosition = (order: Order, fillPrice: number, bar: Bar) => {
      const commission = this.commissionPerContract * order.qty;
      position = {
        id: nextId("pos"),
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        entryPrice: fillPrice,
        entryTime: bar.time,
        entryBar: eqIndex,
        sl: order.sl,
        tp: order.tp,
        commission,
        mfe: 0,
        mae: 0,
      };
      cash -= commission;
      log(`OPEN ${order.side.toUpperCase()} ${order.qty} ${order.symbol} @ ${round(fillPrice, this.decimals)} (${order.type}${order.label ? " · " + order.label : ""})`);
    };

    const closePosition = (exitPrice: number, reason: ExitReason, bar: Bar) => {
      if (!position) return;
      const commission = this.commissionPerContract * position.qty;
      const dir = position.side === "long" ? 1 : -1;
      const gross = (exitPrice - position.entryPrice) * position.qty * this.pointValue * dir;
      const net = gross - position.commission - commission;
      const barsHeld = Math.max(1, eqIndex - position.entryBar);
      cash += gross - commission; // realize gross, pay exit commission
      trades.push({
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        qty: position.qty,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        exitTime: bar.time,
        exitPrice,
        sl: position.sl,
        tp: position.tp,
        exitReason: reason,
        grossPnl: round(gross),
        commission: round(position.commission + commission),
        netPnl: round(net),
        netPnlPct: position.entryPrice !== 0 ? round((gross / (position.entryPrice * position.qty * this.pointValue)) * 100, 4) : 0,
        barsHeld,
        mfe: round(position.mfe),
        mae: round(position.mae),
      });
      log(`CLOSE ${position.side.toUpperCase()} ${position.symbol} @ ${round(exitPrice, this.decimals)} P&L ${round(net) >= 0 ? "+" : ""}${round(net)} (${reason})`);
      position = null;
    };

    // ── main simulation loop ───────────────────────────────────────────────
    for (let i = 0; i < bars.length; i++) {
      eqIndex = i;
      const bar = bars[i];
      const alignedTf: Record<string, Bar | null> = {};
      for (const tf of Object.keys(data.aligned)) {
        const arr = data.aligned[tf as Timeframe];
        if (arr) alignedTf[tf] = arr[i] ?? null;
      }

      // 1) intrabar SL / TP on the open position (SL checked before TP = worst-case)
      if (position && i > position.entryBar) {
        const isLong = position.side === "long";
        if (position.sl !== undefined) {
          const hit = isLong ? bar.low <= position.sl : bar.high >= position.sl;
          if (hit) {
            closePosition(slip(position.sl, isLong ? "short" : "long", this.slippageTicks, this.tickSize), "stop", bar);
          }
        }
        if (position && position.tp !== undefined) {
          const hit = isLong ? bar.high >= position.tp : bar.low <= position.tp;
          if (hit) closePosition(position.tp, "take-profit", bar);
        }
      }

      // 2) pending entry orders fill on this bar
      if (position === null) {
        for (const order of pending) {
          if (order.status !== "working") continue;
          let fill: number | null = null;
          if (order.type === "market") {
            fill = slip(bar.open, order.side, this.slippageTicks, this.tickSize);
          } else if (order.type === "limit" && order.limitPrice !== undefined) {
            const trigger = order.side === "long" ? bar.low <= order.limitPrice : bar.high >= order.limitPrice;
            if (trigger) {
              fill = order.side === "long" ? Math.min(order.limitPrice, bar.open) : Math.max(order.limitPrice, bar.open);
            }
          } else if (order.type === "stop" && order.stopPrice !== undefined) {
            const trigger = order.side === "long" ? bar.high >= order.stopPrice : bar.low <= order.stopPrice;
            if (trigger) {
              const base = order.side === "long" ? Math.max(bar.open, order.stopPrice) : Math.min(bar.open, order.stopPrice);
              fill = slip(base, order.side, this.slippageTicks, this.tickSize);
            }
          }
          if (fill !== null) {
            const requiredMargin = this.marginPerContract * order.qty;
            if (equity - usedMargin() < requiredMargin) {
              log(`REJECT ${order.side} ${order.symbol}: insufficient margin (need ${round(requiredMargin)}, have ${round(equity - usedMargin())})`);
              order.status = "cancelled";
              continue;
            }
            order.status = "filled";
            order.fillPrice = fill;
            order.fillBar = i;
            order.fillTime = bar.time;
            openPosition(order, fill, bar);
            break; // only one position at a time
          }
        }
      }
      // drop filled/cancelled from working list
      for (let k = pending.length - 1; k >= 0; k--) if (pending[k].status !== "working") pending.splice(k, 1);

      // 3) pending exit requests (strategy close()) fill at this bar's open
      if (position) {
        const pos = position;
        for (let e = exitRequests.length - 1; e >= 0; e--) {
          const req = exitRequests[e];
          if (req.posId !== pos.id) continue;
          if (req.fillBar === i) {
            const exitFill = pos.side === "long"
              ? slip(bar.open, "short", this.slippageTicks, this.tickSize)
              : slip(bar.open, "long", this.slippageTicks, this.tickSize);
            closePosition(exitFill, "signal", bar);
          }
          if (req.fillBar <= i) exitRequests.splice(e, 1);
        }
      }

      // 4) update excursion stats for open position
      if (position) {
        const dir = position.side === "long" ? 1 : -1;
        const fav = (bar.high - position.entryPrice) * dir;
        const adv = (position.entryPrice - bar.low) * dir;
        position.mfe = Math.max(position.mfe, fav * position.qty * this.pointValue);
        position.mae = Math.max(position.mae, adv * position.qty * this.pointValue);
      }

      // 5) hand control to the strategy for this bar
      const ctx: BarContext = {
        symbol: this.config.symbol,
        bar,
        index: i,
        bars,
        tf: alignedTf,
        position,
        pending: [...pending],
        params,
        equity,
        buy: (req = {}) => this._requestOrder("buy", req, pending, position, log, computeQty, i, this.config.allowShort ?? true),
        sell: (req = {}) => this._requestOrder("sell", req, pending, position, log, computeQty, i, this.config.allowShort ?? true),
        close: (reason = "signal") => {
          if (position) exitRequests.push({ posId: position.id, fillBar: i + 1, reason });
        },
        cancel: (orderId: string) => {
          const o = pending.find(p => p.id === orderId);
          if (o) o.status = "cancelled";
        },
        log,
      };
      void strategy.onBar(ctx);
      position = ctx.position; // strategy only reads position; keep in sync

      // 6) record equity at this bar's close
      equity = markEquity(bar);
      const peakSoFar = Math.max(initial, ...equityCurve.map(p => p.equity), equity);
      const dd = peakSoFar > 0 ? (equity - peakSoFar) / peakSoFar : 0;
      equityCurve.push({ time: bar.time, equity: round(equity), drawdown: round(dd * 100, 4), price: bar.close });
    }

    // 7) flatten any open position at the final close (end-of-data)
    if (position) {
      const last = bars[bars.length - 1];
      const exitFill = position.side === "long"
        ? slip(last.close, "short", this.slippageTicks, this.tickSize)
        : slip(last.close, "long", this.slippageTicks, this.tickSize);
      closePosition(exitFill, "end-of-data", last);
      equity = markEquity(last);
      const lastPoint = equityCurve[equityCurve.length - 1];
      if (lastPoint) {
        lastPoint.equity = round(equity);
        const peak = Math.max(initial, ...equityCurve.map(p => p.equity));
        lastPoint.drawdown = round(((equity - peak) / peak) * 100, 4);
      }
    }

    return {
      symbol: this.config.symbol,
      timeframe: base,
      strategyId: strategy.id,
      strategyName: strategy.name,
      startDate: bars[0].time,
      endDate: bars[bars.length - 1].time,
      initialCapital: initial,
      finalEquity: round(equity),
      config: this.config,
      params,
      equityCurve,
      trades,
      logs,
      barsProcessed: bars.length,
      dataGapsFilled: data.gapsFilled,
    };
  }

  private _requestOrder(
    action: "buy" | "sell",
    req: Partial<OrderRequest>,
    pending: Order[],
    position: Position | null,
    log: (m: string) => void,
    computeQty: (req: Partial<OrderRequest>, side: Side) => number,
    index: number,
    allowShort: boolean,
  ): void {
    const side: Side = action === "buy" ? "long" : "short";
    if (side === "short" && !allowShort) {
      log(`REJECT ${action}: shorting disabled`);
      return;
    }
    if (position) {
      log(`REJECT ${action}: position already open (close it first)`);
      return;
    }
    const type: OrderType = req.type ?? "market";
    let qty = computeQty(req, side);
    if (qty < 1) {
      log(`REJECT ${action}: computed size < 1 contract`);
      return;
    }
    const order: Order = {
      id: nextId("ord"),
      symbol: this.config.symbol,
      side,
      type,
      qty,
      limitPrice: req.limitPrice,
      stopPrice: req.stopPrice ?? (type === "stop" ? req.limitPrice : undefined),
      sl: req.sl,
      tp: req.tp,
      status: "working",
      label: req.label,
    };
    pending.push(order);
  }
}
