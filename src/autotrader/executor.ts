import { signalBus } from "./signal";
import { RiskManager } from "./risk";
import {
  placeLiveMarketOrder,
  placeLiveBracketOrder,
  closeLiveOrder,
  syncLivePositions,
  type TradeOrder,
} from "../practice-trading";

export interface ExecutorConfig {
  maxRetries: number;
  retryDelayMs: number;
}

export interface PendingOrder {
  signalId: string;
  symbol: string;
  action: "buy" | "sell" | "close";
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  retries: number;
  status: "pending" | "placed" | "filled" | "failed" | "retrying";
  order?: TradeOrder;
  error?: string;
}

export class OrderExecutor {
  private risk: RiskManager;
  private config: ExecutorConfig;
  private pendingOrders = new Map<string, PendingOrder>();
  private onUpdate: (orders: PendingOrder[]) => void;

  constructor(
    risk: RiskManager,
    config: Partial<ExecutorConfig> = {},
    onUpdate?: (orders: PendingOrder[]) => void,
  ) {
    this.risk = risk;
    this.config = { maxRetries: 3, retryDelayMs: 2000, ...config };
    this.onUpdate = onUpdate || (() => {});
  }

  async executeSignal(signal: {
    id: string;
    symbol: string;
    action: "buy" | "sell" | "close";
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
    strategyId?: string;
  }): Promise<void> {
    if (signal.action === "close") {
      await this.closePositions(signal.symbol, signal.id);
      return;
    }

    let currentPrice = 0;
    try {
      const snap = await syncLivePositions();
      if (snap.openPositions.length > 0) {
        currentPrice = snap.openPositions[0].entryPrice;
      }
    } catch {
      currentPrice = 0;
    }

    const validation = this.risk.validateOrder(signal.symbol, signal.quantity, currentPrice);
    if (!validation.ok) {
      signalBus.emit({
        type: "risk_blocked",
        payload: { signalId: signal.id, reason: validation.reason },
        timestamp: Date.now(),
      });
      return;
    }

    const pending: PendingOrder = {
      signalId: signal.id,
      symbol: signal.symbol,
      action: signal.action,
      quantity: signal.quantity,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      retries: 0,
      status: "pending",
    };
    this.pendingOrders.set(signal.id, pending);
    this.onUpdate(Array.from(this.pendingOrders.values()));

    await this.attemptPlace(pending);
  }

  private async attemptPlace(pending: PendingOrder): Promise<void> {
    pending.status = "retrying";
    this.pendingOrders.set(pending.signalId, pending);
    this.onUpdate(Array.from(this.pendingOrders.values()));

    const side = pending.action === "buy" ? "Long" : "Short";
    let res: { ok: boolean; order?: TradeOrder; error?: string };

    if (pending.stopLoss || pending.takeProfit) {
      res = await placeLiveBracketOrder({
        symbol: pending.symbol,
        side,
        volume: pending.quantity,
        entry: 0,
        stopLoss: pending.stopLoss,
        takeProfit: pending.takeProfit,
        comment: `auto-${pending.signalId.slice(0, 8)}`,
      });
    } else {
      res = await placeLiveMarketOrder({
        symbol: pending.symbol,
        side,
        volume: pending.quantity,
        comment: `auto-${pending.signalId.slice(0, 8)}`,
      });
    }

    if (res.ok && res.order) {
      pending.status = "placed";
      pending.order = res.order;
      this.pendingOrders.set(pending.signalId, pending);
      this.onUpdate(Array.from(this.pendingOrders.values()));
      signalBus.emit({
        type: "order_placed",
        payload: { signalId: pending.signalId, order: res.order },
        timestamp: Date.now(),
      });
      setTimeout(() => this.syncOrderStatus(pending), 1500);
    } else {
      pending.retries += 1;
      pending.error = res.error;
      this.pendingOrders.set(pending.signalId, pending);
      this.onUpdate(Array.from(this.pendingOrders.values()));
      signalBus.emit({
        type: "order_rejected",
        payload: { signalId: pending.signalId, error: res.error, retries: pending.retries },
        timestamp: Date.now(),
      });
      if (pending.retries < this.config.maxRetries) {
        setTimeout(() => this.attemptPlace(pending), this.config.retryDelayMs);
      } else {
        pending.status = "failed";
        this.pendingOrders.set(pending.signalId, pending);
        this.onUpdate(Array.from(this.pendingOrders.values()));
      }
    }
  }

  private async syncOrderStatus(pending: PendingOrder) {
    try {
      const positions = await syncLivePositions();
      const found = positions.openPositions.find(
        (p) => p.symbol === pending.symbol && p.quantity === pending.quantity,
      );
      if (found) {
        pending.status = "filled";
        pending.order = { ...pending.order!, ...found } as TradeOrder;
        this.pendingOrders.set(pending.signalId, pending);
        this.onUpdate(Array.from(this.pendingOrders.values()));
        signalBus.emit({
          type: "order_filled",
          payload: { signalId: pending.signalId, order: pending.order },
          timestamp: Date.now(),
        });
      }
    } catch {}
  }

  private async closePositions(symbol: string, signalId: string) {
    try {
      const positions = await syncLivePositions();
      for (const p of positions.openPositions) {
        if (p.symbol === symbol) {
          const res = await closeLiveOrder({
            ticket: typeof p.ticket === "number" ? p.ticket : undefined,
            symbol: p.symbol,
            volume: p.quantity,
          });
          signalBus.emit({
            type: "order_filled",
            payload: { signalId, closed: p.id, ok: res.ok, error: res.error },
            timestamp: Date.now(),
          });
        }
      }
    } catch {}
  }

  getPendingOrders(): PendingOrder[] {
    return Array.from(this.pendingOrders.values());
  }
}
