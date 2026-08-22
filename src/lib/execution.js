// execution.js
// Dwella execution engine — converts strategy signals into TradingView orders
// with automatic stop-loss and 2R take-profit bracket orders.
//
// Modes:
//   paper  — logs trades to local state, no real orders placed
//   live   — places real bracket orders via the TradingView sidecar
//
// Position sizing: fixed-risk model from the video (risk ~$500/trade default)

import { checkDailyLimit } from './strategies.js';

const LOCAL_TRADING_BRIDGE_URL = 'http://127.0.0.1:18814';
const DESKTOP_RUNTIME = typeof window !== 'undefined'
  && (window.location.protocol === 'file:' || Boolean(window.electronAPI));
const CONFIGURED_TRADING_BRIDGE_URL = import.meta.env.VITE_TRADING_BRIDGE_URL || '';
const LOCAL_BRIDGE_URL_PATTERN = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i;
const TRADING_BRIDGE_URL = (
  typeof window !== 'undefined'
    && window.location.protocol !== 'file:'
    && LOCAL_BRIDGE_URL_PATTERN.test(CONFIGURED_TRADING_BRIDGE_URL)
    ? ''
    : CONFIGURED_TRADING_BRIDGE_URL || (DESKTOP_RUNTIME ? LOCAL_TRADING_BRIDGE_URL : '')
).replace(/\/$/, '');
const TRADING_BRIDGE_TOKEN = import.meta.env.VITE_TRADING_BRIDGE_TOKEN || '';

function bridgeHeaders(headers = {}) {
  const next = new Headers(headers);
  if (TRADING_BRIDGE_TOKEN) next.set('Authorization', `Bearer ${TRADING_BRIDGE_TOKEN}`);
  return next;
}

// The live scanner deliberately enters one unit per confirmed setup. Keep
// this helper for analytics/manual previews, but never use it to pyramid an
// already-triggered live setup.
export const LIVE_ENTRY_UNITS = 1;

// ── Contract specs (tick size, point value) ────────────────────────────────
export const CONTRACTS = {
  ENQ: { tickSize: 0.25, pointValue: 5.0, name: 'NQ' },
  MES: { tickSize: 0.25, pointValue: 1.25, name: 'MES' },
  GCE: { tickSize: 0.10, pointValue: 10.0, name: 'GC' },
  YM: { tickSize: 1, pointValue: 5.0, name: 'YM' },
};

// ── Default risk parameters ────────────────────────────────────────────────
export const DEFAULT_RISK = {
  riskPerTrade: 500,      // dollars risked per trade
  maxDailyLoss: 0.07,     // 7% of account balance
  maxOpenTrades: 3,       // max concurrent positions
  maxRMultiple: 3,        // cap the R-multiple on targets
  defaultR: 2,            // default reward:risk ratio
};

// ── Position sizing: fixed-risk model ──────────────────────────────────────
// size = riskUsd / (stopDistance × pointValue)
export function positionSize({ riskUsd, stopDistance, pointValue }) {
  if (!stopDistance || stopDistance <= 0 || !pointValue) return 0;
  return Math.max(1, Math.floor(riskUsd / (stopDistance * pointValue)));
}

// Given a signal and account state, compute the order parameters
export function buildOrder(signal, { accountBalance = 100000, tradeMode = 'paper', risk = DEFAULT_RISK, openTradeCount = 0 }) {
  const spec = CONTRACTS[signal.symbol || 'ENQ'] || CONTRACTS.ENQ;

  // Daily loss limit check
  const dailyCheck = checkDailyLimit({
    accountBalance,
    dayPL: 0, // caller should pass actual day P&L
    pct: risk.maxDailyLoss,
  });
  if (dailyCheck.breached) {
    return { ok: false, reason: 'Daily loss limit breached', dailyCheck };
  }

  // Max open trades check
  if (openTradeCount >= risk.maxOpenTrades) {
    return { ok: false, reason: `Max ${risk.maxOpenTrades} open trades reached` };
  }

  // Position sizing
  const stopDistance = signal.stopDistance || Math.abs(signal.entry - signal.stop);
  const tpDistance = signal.targetDistance || stopDistance * risk.defaultR;

  // Cap R-multiple
  const rMult = Math.min(signal.rMultiplier || risk.defaultR, risk.maxRMultiple);
  const cappedTpDistance = stopDistance * rMult;

  const contracts = positionSize({
    riskUsd: risk.riskPerTrade,
    stopDistance,
    pointValue: spec.pointValue,
  });

  if (contracts <= 0) {
    return { ok: false, reason: 'Position size is 0 — risk too small or stop too wide' };
  }

  const action = signal.dir === 'long' ? 'Buy' : 'Sell';
  const sl = signal.dir === 'long'
    ? signal.entry - stopDistance
    : signal.entry + stopDistance;
  const tp = signal.dir === 'long'
    ? signal.entry + cappedTpDistance
    : signal.entry - cappedTpDistance;

  const actualRisk = contracts * stopDistance * spec.pointValue;
  const actualReward = contracts * cappedTpDistance * spec.pointValue;

  return {
    ok: true,
    action,
    symbol: signal.symbol || 'ENQ',
    contractName: spec.name,
    orderType: 'Market',
    qty: tradeMode === 'live' ? LIVE_ENTRY_UNITS : contracts,
    entry: signal.entry,
    sl: Math.round(sl / spec.tickSize) * spec.tickSize,
    tp: Math.round(tp / spec.tickSize) * spec.tickSize,
    stopDistance,
    tpDistance: cappedTpDistance,
    rMultiplier: rMult,
    riskUsd: tradeMode === 'live'
      ? LIVE_ENTRY_UNITS * stopDistance * spec.pointValue
      : actualRisk,
    rewardUsd: actualReward,
    signalId: signal.id,
    strategyId: signal.strategyId,
    area: signal.area,
    tradeMode,
    time: Date.now(),
  };
}

// ── Execute an order via the configured bridge ─────────────────────────────
export async function executeOrder(order, sidecarUrl = TRADING_BRIDGE_URL) {
  if (order.tradeMode !== 'paper' && !sidecarUrl) {
    return { ok: false, error: 'No Linux trading bridge is configured. Paper mode remains available.', order, paper: false };
  }
  if (order.tradeMode === 'paper') {
    // Paper mode — just return the order as "filled"
    return {
      ok: true,
      paper: true,
      orderId: `PAPER-${Date.now()}`,
      fill: { price: order.entry, time: Date.now() },
      order,
    };
  }

  // Live mode — place via TradingView sidecar
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${sidecarUrl}/tv/order`, {
      signal: ctrl.signal,
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        action: order.action,
        symbol: order.symbol,
        orderType: order.orderType,
        qty: order.qty,
        sl: order.sl,
        tp: order.tp,
        comment: `Dwella ${order.strategyId?.toUpperCase() || ''}`,
      }),
    });
    clearTimeout(t);
    const data = await res.json();
    return { ...data, order, paper: false };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), order, paper: false };
  }
}

// ── Cancel an open order ───────────────────────────────────────────────────
export async function cancelOrder(orderId, sidecarUrl = TRADING_BRIDGE_URL) {
  if (!sidecarUrl) return { ok: false, error: 'No Linux trading bridge is configured.' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${sidecarUrl}/tv/cancel?orderId=${orderId}`, {
      signal: ctrl.signal,
      method: 'DELETE',
      headers: bridgeHeaders(),
    });
    clearTimeout(t);
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// ── Fetch open orders ──────────────────────────────────────────────────────
export async function fetchOpenOrders(sidecarUrl = TRADING_BRIDGE_URL) {
  if (!sidecarUrl) return { orders: [] };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${sidecarUrl}/tv/openorders`, { signal: ctrl.signal, headers: bridgeHeaders() });
    clearTimeout(t);
    return await res.json();
  } catch {
    return { orders: [] };
  }
}
