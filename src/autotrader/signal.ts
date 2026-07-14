export interface TradeSignal {
  id: string;
  symbol: string;
  action: "buy" | "sell" | "close";
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  timestamp: number;
  strategyId: string;
  reason?: string;
}

export interface SignalEvent {
  type: "signal" | "order_placed" | "order_filled" | "order_rejected" | "risk_blocked";
  payload: unknown;
  timestamp: number;
}

type SignalHandler = (event: SignalEvent) => void;

class SignalBus {
  private handlers = new Set<SignalHandler>();
  private auditLog: SignalEvent[] = [];
  private externalSignalUnsub?: () => void;

  constructor() {
    this.subscribeToExternalSignals();
  }

  subscribe(handler: SignalHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  emit(event: SignalEvent) {
    this.auditLog.push(event);
    if (this.auditLog.length > 500) this.auditLog.shift();
    for (const h of this.handlers) {
      try { h(event); } catch {}
    }
  }

  getHistory(): SignalEvent[] {
    return [...this.auditLog];
  }

  clearHistory() {
    this.auditLog = [];
  }

  private subscribeToExternalSignals() {
    if (typeof window !== "undefined" && window.dwella?.buffy?.onSignal) {
      this.externalSignalUnsub = window.dwella.buffy.onSignal((sig) => {
        this.emit({
          type: "signal",
          payload: { source: "buffy", signal: sig },
          timestamp: sig.timestamp || Date.now(),
        });
      });
    }
  }

  async sendExternalSignal(signal: {
    symbol: string;
    action: string;
    confidence?: number;
    reasoning?: string;
    entry?: number | null;
    stop?: number | null;
    target?: number | null;
    timeframe?: string;
  }) {
    try {
      await fetch("http://127.0.0.1:8645/buffy/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...signal, timestamp: Date.now() }),
      });
    } catch {}
  }

  destroy() {
    this.externalSignalUnsub?.();
    this.handlers.clear();
  }
}

export const signalBus = new SignalBus();
