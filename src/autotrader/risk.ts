import type { TradeOrder } from "../practice-trading";

const SYMBOL_DEFAULTS: Record<string, { pointValue: number; tickSize: number }> = {
  NQ: { pointValue: 20, tickSize: 0.25 },
  MNQ: { pointValue: 2, tickSize: 0.25 },
  ES: { pointValue: 50, tickSize: 0.25 },
  MES: { pointValue: 5, tickSize: 0.25 },
  YM: { pointValue: 5, tickSize: 1 },
  GC: { pointValue: 100, tickSize: 0.1 },
  MGC: { pointValue: 10, tickSize: 0.1 },
  CL: { pointValue: 1000, tickSize: 0.01 },
  RTY: { pointValue: 50, tickSize: 0.25 },
};

export interface RiskConfig {
  maxPositionPerSymbol: number;
  maxTotalExposure: number;
  dailyLossLimit: number;
  maxDrawdownPct: number;
  correlatedSymbols: string[][];
  defaultContracts: number;
  riskPerTradePct: number;
}

export interface RiskState {
  dailyPnl: number;
  dayStartEquity: number;
  peakEquity: number;
  maxDrawdown: number;
  currentExposure: number;
  positionsBySymbol: Record<string, { count: number; exposure: number }>;
  circuitBreaker: boolean;
}

const DEFAULT_CONFIG: RiskConfig = {
  maxPositionPerSymbol: 5,
  maxTotalExposure: 50000,
  dailyLossLimit: 2000,
  maxDrawdownPct: 10,
  correlatedSymbols: [["NQ", "ES"], ["MNQ", "MES"]],
  defaultContracts: 1,
  riskPerTradePct: 1,
};

export class RiskManager {
  private config: RiskConfig;
  private state: RiskState;
  private lastDay: number;

  constructor(config: Partial<RiskConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      dailyPnl: 0,
      dayStartEquity: 0,
      peakEquity: 0,
      maxDrawdown: 0,
      currentExposure: 0,
      positionsBySymbol: {},
      circuitBreaker: false,
    };
    this.lastDay = new Date().getDate();
    this.checkDayReset();
  }

  private checkDayReset() {
    const today = new Date().getDate();
    if (today !== this.lastDay) {
      this.lastDay = today;
      this.state.dailyPnl = 0;
    }
  }

  updateAccount(equity: number, positions: TradeOrder[]) {
    this.checkDayReset();
    this.state.dayStartEquity = this.state.dayStartEquity || equity;
    this.state.peakEquity = Math.max(this.state.peakEquity, equity);
    const dd = this.state.peakEquity > 0 ? (equity - this.state.peakEquity) / this.state.peakEquity : 0;
    this.state.maxDrawdown = Math.min(this.state.maxDrawdown, dd * 100);
    if (dd * 100 <= this.config.maxDrawdownPct) {
      this.state.circuitBreaker = false;
    } else {
      this.state.circuitBreaker = true;
    }
    this.rebuildExposure(positions);
  }

  recordPnl(pnl: number) {
    this.checkDayReset();
    this.state.dailyPnl += pnl;
  }

  rebuildExposure(positions: TradeOrder[]) {
    const bySymbol: Record<string, { count: number; exposure: number }> = {};
    let total = 0;
    for (const p of positions) {
      const sym = p.symbol;
      if (!bySymbol[sym]) bySymbol[sym] = { count: 0, exposure: 0 };
      bySymbol[sym].count += p.quantity;
      bySymbol[sym].exposure += p.quantity * p.entryPrice;
      total += p.quantity * p.entryPrice;
    }
    this.state.positionsBySymbol = bySymbol;
    this.state.currentExposure = total;
  }

  validateOrder(symbol: string, quantity: number, price: number): { ok: boolean; reason?: string } {
    if (this.state.circuitBreaker) {
      return { ok: false, reason: "Circuit breaker active (max drawdown exceeded)" };
    }
    if (this.state.dailyPnl <= -this.config.dailyLossLimit) {
      return { ok: false, reason: "Daily loss limit reached" };
    }
    const symPos = this.state.positionsBySymbol[symbol];
    const newCount = (symPos?.count || 0) + quantity;
    if (newCount > this.config.maxPositionPerSymbol) {
      return { ok: false, reason: `Max position per symbol (${this.config.maxPositionPerSymbol}) exceeded` };
    }
    const exposure = this.state.currentExposure + quantity * price;
    if (exposure > this.config.maxTotalExposure) {
      return { ok: false, reason: "Max total exposure exceeded" };
    }
    for (const group of this.config.correlatedSymbols) {
      if (group.includes(symbol)) {
        const groupExposure = group.reduce((sum, s) => {
          const pos = this.state.positionsBySymbol[s];
          return sum + (pos?.exposure || 0);
        }, 0) + quantity * price;
        if (groupExposure > this.config.maxTotalExposure * 0.6) {
          return { ok: false, reason: `Correlated exposure limit exceeded for ${group.join("/")}` };
        }
      }
    }
    return { ok: true };
  }

  calculateQuantity(symbol: string, equity: number, entryPrice: number, stopLoss: number): number {
    if (stopLoss > 0 && entryPrice > 0) {
      const stopDist = Math.abs(entryPrice - stopLoss);
      const pointValue = SYMBOL_DEFAULTS[symbol]?.pointValue ?? 20;
      const riskDollars = (this.config.riskPerTradePct / 100) * equity;
      const qty = Math.floor(riskDollars / (stopDist * pointValue));
      return Math.max(1, Math.min(qty, this.config.maxPositionPerSymbol));
    }
    return this.config.defaultContracts;
  }

  getState(): RiskState {
    return { ...this.state, positionsBySymbol: { ...this.state.positionsBySymbol } };
  }

  getConfig(): RiskConfig {
    return { ...this.config };
  }

  setConfig(cfg: Partial<RiskConfig>) {
    this.config = { ...this.config, ...cfg };
  }
}
