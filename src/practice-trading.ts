/** Practice (paper) trading engine — runs entirely client-side. */

import { Bar } from "./replay-engine";

export type OrderSide = "Long" | "Short";
export type OrderType = "Market" | "Limit" | "Stop";
export type OrderStatus = "Pending" | "Open" | "Closed" | "Cancelled";
export type CloseReason = "manual" | "stop" | "take-profit" | "expired";

export interface TradeOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  entryPrice: number;
  /** Underlying trigger price for pending Limit/Stop orders. */
  stopPrice?: number;
  limitPrice?: number;
  /** Per-order protective stop. Fill at exact level when bar.high/low crosses it. */
  stopLoss?: number;
  /** Per-order profit target. Fill at exact level when bar.high/low crosses it. */
  takeProfit?: number;
  status: OrderStatus;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  openedAt: number;
  closedAt?: number;
  closedReason?: CloseReason;
  label?: string;
}

export interface PracticeAccount {
  balance: number;
  equity: number;
  openPositions: TradeOrder[];
  closedTrades: TradeOrder[];
  pendingOrders: TradeOrder[];
  totalPnl: number;
  winRate: number;
  tradeCount: number;
}

export interface OrderOptions {
  stopLoss?: number;
  takeProfit?: number;
}

/** NQ-style $20/point/contract. Other symbols would override per-symbol. */
const POINT_VALUE = 20;

let _idCounter = 0;
function nextId(): string {
  _idCounter++;
  return `pp-${Date.now()}-${_idCounter}`;
}

export function createAccount(startingBalance = 51284.72): PracticeAccount {
  return {
    balance: startingBalance,
    equity: startingBalance,
    openPositions: [],
    closedTrades: [],
    pendingOrders: [],
    totalPnl: 0,
    winRate: 0,
    tradeCount: 0,
  };
}

/** Place a market order — opens at the current bar's close. */
export function placeMarketOrder(
  account: PracticeAccount,
  bar: Bar,
  side: OrderSide,
  quantity: number,
  options: OrderOptions = {},
  label?: string,
): { account: PracticeAccount; order: TradeOrder } {
  const order: TradeOrder = {
    id: nextId(),
    symbol: "NQ",
    side,
    type: "Market",
    quantity,
    entryPrice: bar.close,
    stopLoss: options.stopLoss,
    takeProfit: options.takeProfit,
    status: "Open",
    openedAt: bar.time,
    label,
  };
  return {
    account: {
      ...account,
      openPositions: [...account.openPositions, order],
      tradeCount: account.tradeCount + 1,
    },
    order,
  };
}

/** Place a Limit/Stop order that fills when its trigger fires on a later bar. */
export function placePendingOrder(
  account: PracticeAccount,
  side: OrderSide,
  type: "Limit" | "Stop",
  quantity: number,
  entryPrice: number,
  options: OrderOptions = {},
  label?: string,
): { account: PracticeAccount; order: TradeOrder } {
  const order: TradeOrder = {
    id: nextId(),
    symbol: "NQ",
    side,
    type,
    quantity,
    entryPrice,
    stopPrice: type === "Stop" ? entryPrice : undefined,
    limitPrice: type === "Limit" ? entryPrice : undefined,
    stopLoss: options.stopLoss,
    takeProfit: options.takeProfit,
    status: "Pending",
    openedAt: Math.floor(Date.now() / 1000),
    label,
  };
  return {
    account: { ...account, pendingOrders: [...account.pendingOrders, order] },
    order,
  };
}

export function cancelOrder(account: PracticeAccount, orderId: string): PracticeAccount {
  return {
    ...account,
    pendingOrders: account.pendingOrders.filter(o => {
      if (o.id === orderId) {
        o.status = "Cancelled";
        o.closedReason = "expired";
        account.closedTrades = [...account.closedTrades, o];
      }
      return o.id !== orderId;
    }),
  };
}

export function closePosition(account: PracticeAccount, orderId: string, bar: Bar): PracticeAccount {
  return closePositionAtFillPrice(account, orderId, bar, bar.close, "manual");
}

/** Close an open position at an exact fill price (used by SL/TP triggers). */
export function closePositionAtFillPrice(
  account: PracticeAccount,
  orderId: string,
  bar: Bar,
  fillPrice: number,
  reason: CloseReason = "manual",
): PracticeAccount {
  const idx = account.openPositions.findIndex(o => o.id === orderId);
  if (idx === -1) return account;

  const order = { ...account.openPositions[idx] };
  const isLong = order.side === "Long";
  const rawPnl = (fillPrice - order.entryPrice) * order.quantity * (isLong ? 1 : -1);
  const pnl = round2(rawPnl * POINT_VALUE);
  const pnlPercent = order.entryPrice !== 0 ? round2((rawPnl / order.entryPrice) * 100) : 0;

  order.status = "Closed";
  order.exitPrice = round2(fillPrice);
  order.pnl = pnl;
  order.pnlPercent = pnlPercent;
  order.closedAt = bar.time;
  order.closedReason = reason;

  const newOpen = account.openPositions.filter((_, i) => i !== idx);
  const newClosed = [...account.closedTrades, order];
  const totalPnl = newClosed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = newClosed.filter(t => (t.pnl ?? 0) > 0).length;
  const winRate = newClosed.length > 0 ? round2((wins / newClosed.length) * 100) : 0;

  return {
    ...account,
    openPositions: newOpen,
    closedTrades: newClosed,
    balance: round2(account.balance + pnl),
    totalPnl: round2(totalPnl),
    winRate,
  };
}

export function updateEquity(account: PracticeAccount, bar: Bar): PracticeAccount {
  const unrealised = account.openPositions.reduce((sum, o) => {
    const isLong = o.side === "Long";
    const raw = (bar.close - o.entryPrice) * o.quantity * (isLong ? 1 : -1);
    return sum + raw * POINT_VALUE;
  }, 0);
  return { ...account, equity: round2(account.balance + unrealised) };
}

/** Walk open positions and close any whose SL/TP got hit on this bar.
 *  SL is checked BEFORE TP within a bar — worst-case fill assumption; matches
 *  MetaTrader 5's "worst-price fill" behavior when both levels are inside the
 *  bar's range. Fills happen at the exact SL/TP price. */
export function checkSlTpTriggers(account: PracticeAccount, bar: Bar): PracticeAccount {
  let acc = account;
  for (const o of [...acc.openPositions]) {
    const isLong = o.side === "Long";
    if (o.stopLoss !== undefined) {
      const slHit = isLong ? bar.low <= o.stopLoss : bar.high >= o.stopLoss;
      if (slHit) {
        acc = closePositionAtFillPrice(acc, o.id, bar, o.stopLoss, "stop");
        continue;
      }
    }
    if (o.takeProfit !== undefined) {
      const tpHit = isLong ? bar.high >= o.takeProfit : bar.low <= o.takeProfit;
      if (tpHit) acc = closePositionAtFillPrice(acc, o.id, bar, o.takeProfit, "take-profit");
    }
  }
  return acc;
}

export function checkPendingOrders(account: PracticeAccount, bar: Bar): PracticeAccount {
  let acc = account;
  for (const order of acc.pendingOrders) {
    let triggered = false;
    if (order.type === "Stop" && order.stopPrice !== undefined) {
      if (order.side === "Long" && bar.high >= order.stopPrice) triggered = true;
      if (order.side === "Short" && bar.low <= order.stopPrice) triggered = true;
    }
    if (order.type === "Limit" && order.limitPrice !== undefined) {
      if (order.side === "Long" && bar.low <= order.limitPrice) triggered = true;
      if (order.side === "Short" && bar.high >= order.limitPrice) triggered = true;
    }
    if (triggered) {
      const triggeredOrder: TradeOrder = {
        ...order,
        type: order.type as OrderType,
        status: "Open",
        entryPrice: bar.close,
        openedAt: bar.time,
      };
      acc = {
        ...acc,
        openPositions: [...acc.openPositions, triggeredOrder],
        pendingOrders: acc.pendingOrders.filter(o => o.id !== order.id),
        tradeCount: acc.tradeCount + 1,
      };
    }
  }
  return acc;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
