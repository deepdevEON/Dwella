import { syncLivePositions, type TradeOrder } from "../practice-trading";
import type { Bar, Timeframe } from "../replay-engine";
import type {
  Strategy,
  StrategyParams,
  BarContext,
  OrderRequest,
  Position,
} from "../backtest/engine";
import { OrderExecutor } from "./executor";
import { RiskManager } from "./risk";
import { signalBus, type TradeSignal } from "./signal";
import { getStrategy, BUILTIN_STRATEGIES } from "../backtest/strategies";

export interface RunnerConfig {
  strategyId: string;
  symbol: string;
  timeframe: Timeframe;
  intervalMs: number;
  maxBars: number;
}

export interface RunnerState {
  strategyId: string;
  strategyName: string;
  symbol: string;
  timeframe: Timeframe;
  status: "stopped" | "running" | "paused";
  lastBarTime: number | null;
  signalsGenerated: number;
  ordersPlaced: number;
  lastError?: string;
  equity: number;
}

const TF_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
  W1: 604_800_000,
  MN: 2_592_000_000,
};

class StrategyRunner {
  private config: RunnerConfig;
  private strategy?: Strategy;
  private executor: OrderExecutor;
  private risk: RiskManager;
  private bars: Bar[] = [];
  private livePosition: LivePosition | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private state: RunnerState;
  private equity = 51284.72;
  private params: StrategyParams = {};
  private onStateChange: (state: RunnerState) => void;
  private onSignal: (signal: TradeSignal) => void;

  constructor(
    config: RunnerConfig,
    risk: RiskManager,
    executor: OrderExecutor,
    onStateChange?: (state: RunnerState) => void,
    onSignal?: (signal: TradeSignal) => void,
  ) {
    this.config = config;
    this.risk = risk;
    this.executor = executor;
    this.strategy = getStrategy(config.strategyId);
    this.onStateChange = onStateChange || (() => {});
    this.onSignal = onSignal || (() => {});
    this.state = {
      strategyId: config.strategyId,
      strategyName: this.strategy?.name || config.strategyId,
      symbol: config.symbol,
      timeframe: config.timeframe,
      status: "stopped",
      lastBarTime: null,
      signalsGenerated: 0,
      ordersPlaced: 0,
      equity: this.equity,
    };
    this.applyDefaults();
  }

  private applyDefaults() {
    if (this.strategy?.defaults) {
      this.params = { ...this.strategy.defaults };
    }
  }

  async loadBars() {
    try {
      const result = await window.dwella.getMarketBars(
        this.config.symbol,
        this.config.timeframe,
        this.config.maxBars,
      );
      if (result?.ok && result.bars) {
        this.bars = result.bars.map((mb) => ({
          time: mb.t,
          open: mb.o,
          high: mb.h,
          low: mb.l,
          close: mb.c,
          volume: mb.v,
        }));
        if (this.bars.length > 0) {
          this.state.lastBarTime = this.bars[this.bars.length - 1].time;
        }
        this.syncPositions();
      }
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : "Failed to load bars";
    }
    this.emitState();
  }

  start() {
    if (this.state.status === "running") return;
    this.state.status = "running";
    this.state.lastError = undefined;
    this.loadBars();
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
    this.emitState();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.state.status = "stopped";
    this.emitState();
  }

  pause() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.state.status = "paused";
    this.emitState();
  }

  getState(): RunnerState {
    return { ...this.state };
  }

  getBars(): Bar[] {
    return [...this.bars];
  }

  setParams(params: StrategyParams) {
    this.params = { ...this.params, ...params };
  }

  getParams(): StrategyParams {
    return { ...this.params };
  }

  private async tick() {
    if (this.state.status !== "running") return;
    try {
      const result = await window.dwella.getMarketBars(
        this.config.symbol,
        this.config.timeframe,
        5,
      );
      if (!result?.ok || !result.bars || result.bars.length === 0) return;

      const newBar: Bar = {
        time: result.bars[result.bars.length - 1].t,
        open: result.bars[result.bars.length - 1].o,
        high: result.bars[result.bars.length - 1].h,
        low: result.bars[result.bars.length - 1].l,
        close: result.bars[result.bars.length - 1].c,
        volume: result.bars[result.bars.length - 1].v,
      };

      if (newBar.time !== this.state.lastBarTime) {
        this.bars.push(newBar);
        if (this.bars.length > this.config.maxBars) {
          this.bars = this.bars.slice(-this.config.maxBars);
        }
        this.state.lastBarTime = newBar.time;
        await this.evaluateBar(newBar);
        this.syncPositions();
        this.emitState();
      }
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : "Tick error";
      this.emitState();
    }
  }

  private async evaluateBar(bar: Bar) {
    if (!this.strategy) return;

    const context: BarContext = {
      symbol: this.config.symbol,
      bar,
      index: this.bars.length - 1,
      bars: [...this.bars],
      tf: {},
      position: this.livePosition
        ? {
            id: this.livePosition.id,
            symbol: this.livePosition.symbol,
            side: this.livePosition.side,
            qty: this.livePosition.qty,
            entryPrice: this.livePosition.entryPrice,
            entryTime: this.livePosition.entryTime,
            entryBar: this.bars.length - 1,
            sl: this.livePosition.sl,
            tp: this.livePosition.tp,
            commission: 0,
            mfe: 0,
            mae: 0,
          }
        : null,
      pending: [],
      params: this.params,
      equity: this.equity,
      buy: (req) => this.handleBuy(req),
      sell: (req) => this.handleSell(req),
      close: (reason) => this.handleClose(reason),
      cancel: () => {},
      log: (msg) => {
        signalBus.emit({
          type: "signal",
          payload: { source: "runner", message: msg, strategyId: this.config.strategyId },
          timestamp: Date.now(),
        });
      },
    };

    try {
      await this.strategy.onBar(context);
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : "Strategy evaluation error";
    }
  }

  private handleBuy(req?: Partial<OrderRequest>) {
    const bar = this.bars[this.bars.length - 1];
    const qty = req?.qty && Number(req.qty) > 0 ? Number(req.qty) : 1;
    const sl = req?.sl ? Number(req.sl) : undefined;
    const tp = req?.tp ? Number(req.tp) : undefined;

    if (this.livePosition) return;

    const signal: TradeSignal = {
      id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: this.config.symbol,
      action: "buy",
      quantity: qty,
      stopLoss: sl,
      takeProfit: tp,
      timestamp: bar.time,
      strategyId: this.config.strategyId,
      reason: req?.label,
    };

    this.livePosition = {
      id: signal.id,
      symbol: this.config.symbol,
      side: "long",
      qty,
      entryPrice: bar.close,
      entryTime: bar.time,
      sl,
      tp,
    };

    this.state.signalsGenerated += 1;
    this.onSignal(signal);
    signalBus.emit({
      type: "signal",
      payload: { source: "runner", signal },
      timestamp: Date.now(),
    });
    this.executor.executeSignal(signal).then(() => {
      this.state.ordersPlaced += 1;
      this.emitState();
    });
  }

  private handleSell(req?: Partial<OrderRequest>) {
    const bar = this.bars[this.bars.length - 1];
    const qty = req?.qty && Number(req.qty) > 0 ? Number(req.qty) : 1;
    const sl = req?.sl ? Number(req.sl) : undefined;
    const tp = req?.tp ? Number(req.tp) : undefined;

    if (this.livePosition) return;

    const signal: TradeSignal = {
      id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: this.config.symbol,
      action: "sell",
      quantity: qty,
      stopLoss: sl,
      takeProfit: tp,
      timestamp: bar.time,
      strategyId: this.config.strategyId,
      reason: req?.label,
    };

    this.livePosition = {
      id: signal.id,
      symbol: this.config.symbol,
      side: "short",
      qty,
      entryPrice: bar.close,
      entryTime: bar.time,
      sl,
      tp,
    };

    this.state.signalsGenerated += 1;
    this.onSignal(signal);
    signalBus.emit({
      type: "signal",
      payload: { source: "runner", signal },
      timestamp: Date.now(),
    });
    this.executor.executeSignal(signal).then(() => {
      this.state.ordersPlaced += 1;
      this.emitState();
    });
  }

  private handleClose(reason?: string) {
    if (!this.livePosition) return;

    const bar = this.bars[this.bars.length - 1];
    const signal: TradeSignal = {
      id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: this.config.symbol,
      action: "close",
      quantity: this.livePosition.qty,
      timestamp: bar.time,
      strategyId: this.config.strategyId,
      reason: reason || "signal",
    };

    const closedPosition = this.livePosition;
    this.livePosition = null;

    this.state.signalsGenerated += 1;
    this.onSignal(signal);
    signalBus.emit({
      type: "signal",
      payload: { source: "runner", signal, closedPosition },
      timestamp: Date.now(),
    });
    this.executor.executeSignal(signal).then(() => {
      this.state.ordersPlaced += 1;
      this.emitState();
    });
  }

  private async syncPositions() {
    try {
      const snap = await syncLivePositions();
      const hasPosition = snap.openPositions.some((p: TradeOrder) => p.symbol === this.config.symbol);
      if (!hasPosition) {
        this.livePosition = null;
      }
      this.equity = snap.equity || this.equity;
      this.state.equity = this.equity;
      this.risk.updateAccount(this.equity, snap.openPositions);
    } catch {}
  }

  private emitState() {
    this.onStateChange(this.getState());
  }

  destroy() {
    this.stop();
  }
}

interface LivePosition {
  id: string;
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  entryTime: number;
  sl?: number;
  tp?: number;
}

export { StrategyRunner };
