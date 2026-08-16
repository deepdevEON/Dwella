// useMT5Live.js
// React context that polls the Dwella TradingView sidecar (mt5/tv_sidecar.py)
// and exposes REAL data from TradingView Desktop via CDP:
//   - connection status (CDP health, freshness, errors)
//   - live ticks (bid / ask / last) for every configured futures symbol
//   - real M3 candles for each symbol
//   - real tick tape (buy/sell aggressor flags) → genuine cumulative delta
//   - real account info (balance / equity / margin)
//   - real open positions
//   - price alerts
//
// There is NO simulated fallback: if the feed is down, `isLive` is false
// and views render a disconnected state rather than fake data.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { buildOrder, executeOrder, fetchOpenOrders } from '../lib/execution.js';

const SIDECAR_URL = 'http://127.0.0.1:18814';
const AUTH_URL = 'http://127.0.0.1:18815';
const SYMBOLS = ['ENQ', 'MES', 'GCE', 'YM', 'ES', 'RTY', 'CL', 'SI', 'NQ'];
const POLL_MS = 4000;
const FETCH_TIMEOUT_MS = 3500;
const INITIAL_CANDLE_COUNT = 200;
const REFRESH_CANDLE_COUNT = 60;
const INITIAL_TAPE_COUNT = 300;
const REFRESH_TAPE_COUNT = 120;
const STALE_MS = 12000;

const MT5Context = createContext(null);

async function fetchJson(url, timeoutMs, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, ...init });
    const body = await res.json().catch(() => null);
    if (!res.ok && body == null) throw new Error(`HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

function mapCandle(row) {
  return {
    time: row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume || 0,
  };
}

function seriesChanged(previous = [], next = []) {
  if (!next.length) return false;
  if (!previous.length) return true;
  const a = previous[previous.length - 1];
  const b = next[next.length - 1];
  return a?.time !== b?.time || a?.open !== b?.open || a?.high !== b?.high || a?.low !== b?.low || a?.close !== b?.close || a?.volume !== b?.volume;
}

function mergeCandles(previous = [], next = [], limit = INITIAL_CANDLE_COUNT) {
  if (!next.length) return previous;
  const merged = [...previous];
  for (const row of next) {
    const exact = merged.findIndex((old) => old.time === row.time
      && old.open === row.open && old.high === row.high
      && old.low === row.low && old.close === row.close);
    if (exact >= 0) {
      merged[exact] = row;
      continue;
    }
    // A live candle can keep the same timestamp while its OHLC changes.
    // Replace the latest same-time bar instead of appending a duplicate.
    let sameTime = -1;
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      if (merged[i].time === row.time) { sameTime = i; break; }
    }
    if (sameTime >= 0) merged[sameTime] = row;
    else merged.push(row);
  }
  return merged.slice(-limit);
}

function mergeTape(previous = [], next = [], limit = INITIAL_TAPE_COUNT) {
  // The sidecar returns the latest tape tail. Replacing it avoids duplicate
  // events, since multiple fills can legitimately share a timestamp.
  return next.length ? next.slice(-limit) : previous;
}

async function fetchSymbolData(symbol, candleCount, tapeCount) {
  const [candleResult, tapeResult, bookResult] = await Promise.all([
    fetchJson(`${SIDECAR_URL}/candles?symbol=${symbol}&count=${candleCount}`, FETCH_TIMEOUT_MS).catch(() => null),
    fetchJson(`${SIDECAR_URL}/tape?symbol=${symbol}&count=${tapeCount}`, FETCH_TIMEOUT_MS).catch(() => null),
    fetchJson(`${SIDECAR_URL}/book?symbol=${symbol}`, FETCH_TIMEOUT_MS).catch(() => null),
  ]);
  return {
    symbol,
    candles: Array.isArray(candleResult?.candles) ? candleResult.candles.map(mapCandle) : [],
    tape: Array.isArray(tapeResult?.tape) ? tapeResult.tape : [],
    book: bookResult?.book || null,
  };
}

export function tapeDelta(tape) {
  if (!tape || !tape.length) return { sum: 0, buyVol: 0, sellVol: 0, bars: [] };
  let sum = 0;
  let buyVol = 0;
  let sellVol = 0;
  const bars = tape.map((t) => {
    const d = t.buy ? (t.volume || 1) : t.sell ? -(t.volume || 1) : 0;
    sum += d;
    buyVol += t.buy ? t.volume || 1 : 0;
    sellVol += t.sell ? t.volume || 1 : 0;
    return { time: t.time, d };
  });
  return { sum, buyVol, sellVol, bars };
}

export function MT5Provider({ children }) {
  const [state, setState] = useState({
    connected: false,
    checking: true,
    error: null,
    lastUpdate: null,
    ticks: {},
    candles: {},
    tape: {},
    book: {},
    account: {},
    positions: [],
    alerts: [],
    // Execution state
    tradeMode: 'paper',
    risk: { riskPerTrade: 500, maxOpenTrades: 3, defaultR: 2, maxDailyLoss: 0.07 },
    openOrders: [],
    tradeLog: [],
  });

  // Persist tradeMode + risk to localStorage
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dwella_exec') || '{}');
      if (saved.tradeMode) setState((p) => ({ ...p, tradeMode: saved.tradeMode }));
      if (saved.risk) setState((p) => ({ ...p, risk: { ...p.risk, ...saved.risk } }));
      if (saved.tradeLog) setState((p) => ({ ...p, tradeLog: saved.tradeLog }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('dwella_exec', JSON.stringify({
        tradeMode: state.tradeMode,
        risk: state.risk,
        tradeLog: state.tradeLog.slice(-200),
      }));
    } catch { /* ignore */ }
  }, [state.tradeMode, state.risk, state.tradeLog]);

  const inFlight = useRef(false);
  const heavyLoaded = useRef(false);
  const previousStatus = useRef({ ticks: {}, account: {}, positions: [] });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    let connected = false;
    let error = null;
    let lastUpdate = null;
    let ticks = {};
    let account = {};
    let positions = [];
    const symbolData = [];
    let alerts = null;
    let openOrders = null;
    try {
      const status = await fetchJson(`${SIDECAR_URL}/status`, FETCH_TIMEOUT_MS);
      connected = !!status?.connected;
      error = status?.error || null;
      lastUpdate = status?.last_update || null;
      ticks = status?.ticks || {};
      account = status?.account || {};
      positions = Array.isArray(status?.positions) ? status.positions : previousStatus.current.positions;

      // Commit the fast path immediately. Account, positions, quotes, and
      // connection state must not wait for candle/tape/book requests to
      // finish; otherwise the whole dashboard appears blank during a slow
      // feed response.
      if (mounted.current) {
        setState((prev) => ({
          ...prev,
          connected,
          checking: false,
          error,
          lastUpdate,
          ticks: Object.keys(ticks).length ? ticks : prev.ticks,
          account: Object.keys(account).length ? account : prev.account,
          positions: connected ? positions : prev.positions,
        }));
      }

      if (connected) {
        // Load the full history once, then refresh with small tails. All
        // symbols and panels load concurrently instead of serially waiting
        // through up to nine network round trips.
        const candleCount = heavyLoaded.current ? REFRESH_CANDLE_COUNT : INITIAL_CANDLE_COUNT;
        const tapeCount = heavyLoaded.current ? REFRESH_TAPE_COUNT : INITIAL_TAPE_COUNT;
        const results = await Promise.all(SYMBOLS.map((sym) => fetchSymbolData(sym, candleCount, tapeCount)));
        symbolData.push(...results);
        if (results.some((result) => result.candles.length > 0)) heavyLoaded.current = true;
      }

      [alerts, openOrders] = await Promise.all([
        fetchJson(`${SIDECAR_URL}/alerts`, FETCH_TIMEOUT_MS).catch(() => null),
        fetchOpenOrders(SIDECAR_URL).catch(() => null),
      ]);
    } catch (err) {
      error = err && err.name === 'AbortError' ? 'sidecar timeout' : String((err && err.message) || err);
    }

    if (!mounted.current) {
      inFlight.current = false;
      return;
    }

    previousStatus.current = { ticks, account, positions };
    setState((prev) => {
      const nextCandles = { ...prev.candles };
      const nextTape = { ...prev.tape };
      const nextBook = { ...prev.book };
      let candlesChanged = false;
      let tapeChanged = false;
      let bookChanged = false;

      for (const result of symbolData) {
        const mergedCandles = mergeCandles(prev.candles[result.symbol], result.candles, INITIAL_CANDLE_COUNT);
        const mergedTape = mergeTape(prev.tape[result.symbol], result.tape, INITIAL_TAPE_COUNT);
        if (seriesChanged(prev.candles[result.symbol], mergedCandles)) {
          nextCandles[result.symbol] = mergedCandles;
          candlesChanged = true;
        }
        if (seriesChanged(prev.tape[result.symbol], mergedTape)) {
          nextTape[result.symbol] = mergedTape;
          tapeChanged = true;
        }
        if (result.book && JSON.stringify(prev.book[result.symbol]) !== JSON.stringify(result.book)) {
          nextBook[result.symbol] = result.book;
          bookChanged = true;
        }
      }

      // Merge the completed heavy-data result into the existing state. The
      // fast path above already populated the account; replacing the whole
      // object here used to wipe trade mode, risk settings, and other state
      // while the slower requests completed.
      return {
        ...prev,
        connected,
        checking: false,
        error,
        lastUpdate,
        ticks: Object.keys(ticks).length ? ticks : prev.ticks,
        account: Object.keys(account).length ? account : prev.account,
        positions: connected ? positions : prev.positions,
        alerts: Array.isArray(alerts?.alerts) ? alerts.alerts : prev.alerts,
        openOrders: Array.isArray(openOrders?.orders) ? openOrders.orders : prev.openOrders,
        candles: candlesChanged ? nextCandles : prev.candles,
        tape: tapeChanged ? nextTape : prev.tape,
        book: bookChanged ? nextBook : prev.book,
      };
    });
    inFlight.current = false;
  }, []);

  useEffect(() => {
    poll();
    const iv = setInterval(poll, POLL_MS);
    return () => clearInterval(iv);
  }, [poll]);

  // ── Alert actions ──
  const createAlert = useCallback(async (symbol, condition, price, note) => {
    try {
      const res = await fetchJson(`${SIDECAR_URL}/alerts`, FETCH_TIMEOUT_MS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, condition, price, note }),
      });
      return res;
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }, []);

  const deleteAlert = useCallback(async (alertId) => {
    try {
      const res = await fetchJson(`${SIDECAR_URL}/alerts?id=${alertId}`, FETCH_TIMEOUT_MS, {
        method: 'DELETE',
      });
      return res;
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }, []);

  // ── Settings ──
  const setTradeMode = useCallback((mode) => {
    setState((prev) => ({ ...prev, tradeMode: mode }));
  }, []);

  const setRisk = useCallback((updates) => {
    setState((prev) => ({ ...prev, risk: { ...prev.risk, ...updates } }));
  }, []);

  const tvPlaceOrder = useCallback(async (signal) => {
    const accountBalance = Number(state.account?.balance || state.account?.equity || 0);
    const built = buildOrder(signal, {
      accountBalance,
      tradeMode: state.tradeMode,
      risk: state.risk,
      openTradeCount: state.positions.length,
    });
    if (!built.ok) return built;

    // Dwella's safety policy is one unit per confirmed setup in both paper and live modes.
    const order = { ...built, qty: 1 };
    const result = await executeOrder(order, SIDECAR_URL);
    setState((prev) => ({
      ...prev,
      tradeLog: [...prev.tradeLog, {
        ...order,
        ...result,
        orderStatus: result.ok ? (result.paper ? 'filled' : 'working') : 'rejected',
      }].slice(-200),
    }));
    return result;
  }, [state.account, state.positions.length, state.risk, state.tradeMode]);

  const setToastFn = useCallback((fn) => { /* noop for now */ }, []);

  const value = useMemo(() => {
    const lastGood = state.lastUpdate ? Date.parse(state.lastUpdate) : 0;
    const fresh = lastGood > 0 && Date.now() - lastGood < STALE_MS;
    return {
      ...state,
      isLive: state.connected && !state.checking && fresh,
      createAlert, deleteAlert, tvPlaceOrder,
      setTradeMode, setRisk,
      setToastFn,
    };
  }, [state, createAlert, deleteAlert, tvPlaceOrder, setTradeMode, setRisk, setToastFn]);

  return <MT5Context.Provider value={value}>{children}</MT5Context.Provider>;
}

const DEAD = {
  connected: false,
  checking: true,
  error: null,
  lastUpdate: null,
  ticks: {},
  candles: {},
  tape: {},
  book: {},
  account: {},
  positions: [],
  alerts: [],
  isLive: false,
  createAlert: async () => ({ ok: false, error: 'sidecar unavailable' }),
  deleteAlert: async () => ({ ok: false, error: 'sidecar unavailable' }),
  setTradeMode: () => {},
  setRisk: () => {},
  setToastFn: () => {},
};

export function useMT5() {
  const ctx = useContext(MT5Context);
  return ctx || DEAD;
}
