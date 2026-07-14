import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import CandleChart from "./CandleChart";
import {
  placeLiveMarketOrder,
  placeLiveLimitOrder,
  placeLiveStopOrder,
  placeLiveBracketOrder,
  closeLiveOrder,
  syncLivePositions,
  OrderSide,
  OrderType,
  type TradeOrder,
  type PracticeAccount,
} from "./practice-trading";

/* ── helpers ─────────────────────────────────────────── */
const fmtPrice = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const SYMBOLS = ["NQ", "ES", "GC", "MES", "MNQ", "MGCD"];
const QUICK_QTY = [1, 2, 5, 10] as const;
const RISK_PCTS = [0.5, 1, 2] as const;
const LARGE_ORDER_THRESHOLD = 5;

/* ── types ───────────────────────────────────────────── */
interface WatchItem {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
}

interface DOMLevel {
  price: number;
  volume: number;
  side: "bid" | "ask";
  depth: number;
}

interface TimeSale {
  id: string;
  time: string;
  price: number;
  volume: number;
  side: "buy" | "sell";
  isLarge: boolean;
}

interface PositionRow extends TradeOrder {
  currentPrice?: number;
  profit?: number;
}

/* ── props ───────────────────────────────────────────── */
interface TradingPanelProps {
  account: AccountSummary | null;
  positions: Mt5Position[];
  markets: { s: string; n: string; v: string; p: string; c: string }[];
  chartSym: string;
  setChartSym: (s: string) => void;
  chartTf: string;
  setChartTf: (tf: string) => void;
  chartBars: MarketBar[];
  chartSource: string;
  chartSrc: string;
}

/* ── mock generators ─────────────────────────────────── */
function generateDOM(basePrice: number): DOMLevel[] {
  const levels: DOMLevel[] = [];
  const maxVol = 800;
  for (let i = 8; i >= 0; i--) {
    const p = basePrice - i * 0.25;
    const vol = Math.floor(Math.random() * maxVol * 0.6) + 20;
    levels.push({ price: roundTick(p), volume: vol, side: "bid", depth: vol / maxVol });
  }
  for (let i = 1; i <= 8; i++) {
    const p = basePrice + i * 0.25;
    const vol = Math.floor(Math.random() * maxVol * 0.6) + 20;
    levels.push({ price: roundTick(p), volume: vol, side: "ask", depth: vol / maxVol });
  }
  return levels;
}

function generateTimeSales(count: number): TimeSale[] {
  const items: TimeSale[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const side = Math.random() > 0.48 ? "buy" : "sell";
    const vol = Math.random() > 0.85 ? Math.floor(Math.random() * 15) + 5 : Math.floor(Math.random() * 4) + 1;
    items.push({
      id: `ts-${i}`,
      time: fmtTime(Math.floor((now - i * 3000) / 1000)),
      price: roundTick(18500 + Math.random() * 300 - 150),
      volume: vol,
      side,
      isLarge: vol >= 5,
    });
  }
  return items;
}

function roundTick(p: number) {
  return Math.round(p * 100) / 100;
}

/* ── component ───────────────────────────────────────── */
export default function TradingPanel({
  account,
  positions,
  markets,
  chartSym,
  setChartSym,
  chartTf,
  setChartTf,
  chartBars,
  chartSource,
  chartSrc,
}: TradingPanelProps) {
  const [side, setSide] = useState<OrderSide>("Long");
  const [orderType, setOrderType] = useState<OrderType>("Market");
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [useSl, setUseSl] = useState(false);
  const [useTp, setUseTp] = useState(false);
  const [slVal, setSlVal] = useState("");
  const [tpVal, setTpVal] = useState("");
  const [useOco, setUseOco] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const [watchlist, setWatchlist] = useState<WatchItem[]>([
    { symbol: "NQ", name: "Nasdaq 100 E-mini", price: 18642.5, changePct: 1.24 },
    { symbol: "ES", name: "S&P 500 E-mini", price: 5388.25, changePct: 0.87 },
    { symbol: "GC", name: "Gold Futures", price: 2348.6, changePct: -0.32 },
    { symbol: "MES", name: "Micro ES", price: 5389.0, changePct: 0.91 },
    { symbol: "MNQ", name: "Micro NQ", price: 18645.0, changePct: 1.18 },
  ]);
  const [watchSort, setWatchSort] = useState<"change" | "price" | "name">("change");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sym: string } | null>(null);
  const [newSym, setNewSym] = useState("");

  const [livePositions, setLivePositions] = useState<PositionRow[]>([]);
  const [domLevels, setDomLevels] = useState<DOMLevel[]>([]);
  const [timeSales, setTimeSales] = useState<TimeSale[]>([]);

  const [trailingMap, setTrailingMap] = useState<Record<string, boolean>>({});

  const lastBar = chartBars.length > 0 ? chartBars[chartBars.length - 1] : null;
  const currentPrice = lastBar ? lastBar.c : 18542.0;

  useEffect(() => {
    setDomLevels(generateDOM(currentPrice));
    setTimeSales(generateTimeSales(40));
    const id = setInterval(() => {
      setDomLevels(generateDOM(currentPrice + (Math.random() - 0.5) * 4));
      setTimeSales(generateTimeSales(40));
    }, 3000);
    return () => clearInterval(id);
  }, [chartSym, currentPrice]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const snap = await syncLivePositions();
        if (!active) return;
        const mapped: PositionRow[] = snap.openPositions.map(p => ({
          ...p,
          currentPrice: p.entryPrice + (Math.random() - 0.45) * 20,
          profit: (Math.random() - 0.4) * 300,
        }));
        setLivePositions(mapped);
      } catch {}
    };
    load();
    const id = setInterval(load, 8000);
    return () => { active = false; clearInterval(id); };
  }, [chartSym]);

  /* ── order logic ──────────────────────────────────── */
  const slNum = useSl && slVal !== "" && Number.isFinite(Number(slVal)) ? Number(slVal) : undefined;
  const tpNum = useTp && tpVal !== "" && Number.isFinite(Number(tpVal)) ? Number(tpVal) : undefined;
  const limNum = orderType === "Limit" || orderType === "StopLimit"
    ? (limitPrice !== "" && Number.isFinite(Number(limitPrice)) ? Number(limitPrice) : undefined)
    : undefined;
  const stopNum = orderType === "Stop" || orderType === "StopLimit"
    ? (stopPrice !== "" && Number.isFinite(Number(stopPrice)) ? Number(stopPrice) : undefined)
    : undefined;

  const canPlace = lastBar !== null;

  const handleSubmit = useCallback(async () => {
    if (!canPlace || busy) return;
    if (qty > LARGE_ORDER_THRESHOLD && !showConfirm) {
      setShowConfirm(true);
      return;
    }
    setBusy(true);
    setShowConfirm(false);
    setMsg("");
    try {
      const common = {
        symbol: chartSym,
        side,
        volume: qty,
        stopLoss: slNum,
        takeProfit: tpNum,
        magic: 0,
        comment: "TradingPanel",
      };
      let res;
      if (orderType === "Market") {
        res = await placeLiveMarketOrder(common);
      } else if (orderType === "Limit") {
        res = await placeLiveLimitOrder({ ...common, entry: limNum ?? currentPrice });
      } else if (orderType === "Stop") {
        res = await placeLiveStopOrder({ ...common, entry: stopNum ?? currentPrice });
      } else {
        res = await placeLiveBracketOrder({
          ...common,
          entry: limNum ?? currentPrice,
          stopLoss: slNum,
          takeProfit: tpNum,
        });
      }
      if (res.ok) {
        setMsg(`Order placed: ${side} ${qty} ${chartSym} ${orderType}`);
        setSlVal(""); setTpVal(""); setLimitPrice(""); setStopPrice("");
        setUseSl(false); setUseTp(false); setUseOco(false);
        if (orderType === "Market") setOrderType("Limit");
      } else {
        setMsg(res.error || "Order failed");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Order error");
    } finally {
      setBusy(false);
    }
  }, [side, orderType, qty, slNum, tpNum, limNum, stopNum, chartSym, canPlace, busy, showConfirm, currentPrice]);

  const handleQuickRisk = useCallback((pct: number) => {
    if (!lastBar) return;
    const dist = currentPrice * (pct / 100);
    if (side === "Long") {
      setSlVal(String(roundTick(currentPrice - dist)));
      if (useOco) setTpVal(String(roundTick(currentPrice + dist)));
    } else {
      setSlVal(String(roundTick(currentPrice + dist)));
      if (useOco) setTpVal(String(roundTick(currentPrice - dist)));
    }
    setUseSl(true);
    if (useOco) setUseTp(true);
  }, [side, currentPrice, useOco, lastBar]);

  const handleClosePosition = useCallback(async (pos: PositionRow) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await closeLiveOrder({
        ticket: typeof pos.ticket === "number" ? pos.ticket : undefined,
        symbol: pos.symbol,
        volume: pos.quantity,
      });
      if (res.ok) {
        setMsg(`Closed ${pos.symbol} ${pos.side}`);
        setLivePositions(prev => prev.filter(p => p.id !== pos.id));
      } else {
        setMsg(res.error || "Close failed");
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Close error");
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleTrailing = useCallback((id: string) => {
    setTrailingMap(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  /* ── watchlist logic ───────────────────────────────── */
  const sortedWatch = useCallback(() => {
    const arr = [...watchlist];
    if (watchSort === "change") arr.sort((a, b) => b.changePct - a.changePct);
    else if (watchSort === "price") arr.sort((a, b) => a.price - b.price);
    else arr.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return arr;
  }, [watchlist, watchSort]);

  const addSymbol = useCallback(() => {
    const sym = newSym.trim().toUpperCase();
    if (!sym || watchlist.some(w => w.symbol === sym)) return;
    const existing = markets.find(m => m.s === sym);
    setWatchlist(prev => [...prev, {
      symbol: sym,
      name: existing?.n || sym,
      price: existing ? Number(existing.v.replace(/,/g, "")) : currentPrice + (Math.random() - 0.5) * 10,
      changePct: (Math.random() - 0.5) * 3,
    }]);
    setNewSym("");
  }, [newSym, markets, currentPrice]);

  const removeSymbol = useCallback((sym: string) => {
    setWatchlist(prev => prev.filter(w => w.symbol !== sym));
  }, []);

  const handleWatchContext = useCallback((e: React.MouseEvent, sym: string) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, sym });
  }, []);

  const ctxTrade = useCallback((s: string, sd: OrderSide) => {
    setChartSym(s);
    setSide(sd);
    setOrderType("Market");
    setCtxMenu(null);
  }, [setChartSym]);

  /* ── DOM click ────────────────────────────────────── */
  const handleDomClick = useCallback((level: DOMLevel) => {
    if (level.side === "bid") {
      setSide("Long");
      setOrderType("Limit");
      setLimitPrice(String(level.price));
    } else {
      setSide("Short");
      setOrderType("Stop");
      setStopPrice(String(level.price));
    }
  }, []);

  /* ── computed ─────────────────────────────────────── */
  const totalExposure = livePositions.reduce((s, p) => s + (p.quantity * (p.currentPrice ?? p.entryPrice) * 20), 0);
  const netPnl = livePositions.reduce((s, p) => s + (p.profit ?? 0), 0);
  const marginUsed = totalExposure * 0.12;

  const currentMkt = markets.find(m => m.s === chartSym);

  return (
    <div className="trading-panel">
      {/* ── chart + order entry row ─────────────────── */}
      <div className="tp-top">
        <section className="tp-chart glass">
          <div className="terminal-bar">
            <div className="tabs">
              {["NQ", "GC", "ES", "MES", "MNQ"].map(s => (
                <button key={s} className={chartSym === s ? "active" : ""} onClick={() => setChartSym(s)}>{s}</button>
              ))}
            </div>
            <div className="terminal-quote">
              <b>{currentMkt?.v || fmtPrice(currentPrice)}</b>
              <em>{currentMkt?.p || "…"}</em>
              <small>{chartSource ? `${chartSource} · ${chartSrc === "yahoo" ? "Yahoo" : chartSrc === "demo" ? "Demo" : "MT5"}` : "connecting"}</small>
            </div>
            <div className="tabs tf">
              {["M1", "M5", "M15", "H1", "D1"].map(tf => (
                <button key={tf} className={chartTf === tf ? "active" : ""} onClick={() => setChartTf(tf)}>{tf}</button>
              ))}
            </div>
          </div>
          <CandleChart bars={chartBars} />
        </section>

        <article className="tp-order-entry glass">
          <div className="order-entry-head">
            <span>New Order</span>
            <small>{chartSym} · {orderType}</small>
          </div>

          <div className="order-row">
            <label>Side</label>
            <div className="order-side">
              <button type="button" className={side === "Long" ? "long active" : ""} onClick={() => setSide("Long")} disabled={!canPlace}>Long</button>
              <button type="button" className={side === "Short" ? "short active" : ""} onClick={() => setSide("Short")} disabled={!canPlace}>Short</button>
            </div>
          </div>

          <div className="order-row">
            <label>Type</label>
            <div className="order-type">
              {(["Market", "Limit", "Stop", "StopLimit"] as OrderType[]).map(t => (
                <button key={t} type="button" className={orderType === t ? "active" : ""} onClick={() => setOrderType(t)} disabled={!canPlace}>{t}</button>
              ))}
            </div>
          </div>

          <div className="order-row">
            <label>Qty</label>
            <div className="order-qty">
              {QUICK_QTY.map(n => (
                <button key={n} type="button" className={qty === n ? "qty-active" : ""} onClick={() => setQty(n)} disabled={!canPlace}>{n}</button>
              ))}
            </div>
          </div>

          {(orderType === "Limit" || orderType === "StopLimit") && (
            <div className="order-row">
              <label>Limit</label>
              <input className="price-input" type="number" value={limitPrice} onChange={e => setLimitPrice(e.target.value)} placeholder={fmtPrice(currentPrice)} disabled={!canPlace} />
            </div>
          )}
          {(orderType === "Stop" || orderType === "StopLimit") && (
            <div className="order-row">
              <label>Stop</label>
              <input className="price-input" type="number" value={stopPrice} onChange={e => setStopPrice(e.target.value)} placeholder={fmtPrice(currentPrice)} disabled={!canPlace} />
            </div>
          )}

          <div className="order-row sltp">
            <label className="check"><input type="checkbox" checked={useSl} onChange={e => setUseSl(e.target.checked)} disabled={!canPlace} /> SL</label>
            <input className="price-input" type="number" placeholder="—" value={slVal} onChange={e => setSlVal(e.target.value)} disabled={!useSl || !canPlace} />
            <label className="check"><input type="checkbox" checked={useTp} onChange={e => setUseTp(e.target.checked)} disabled={!canPlace} /> TP</label>
            <input className="price-input" type="number" placeholder="—" value={tpVal} onChange={e => setTpVal(e.target.value)} disabled={!useTp || !canPlace} />
          </div>

          {useSl && (
            <div className="risk-row">
              <span>Quick risk</span>
              <div className="risk-btns">
                {RISK_PCTS.map(pct => (
                  <button key={pct} type="button" onClick={() => handleQuickRisk(pct)} disabled={!canPlace}>{pct}%</button>
                ))}
              </div>
            </div>
          )}

          <div className="order-row" style={{ marginTop: 6 }}>
            <label className="check"><input type="checkbox" checked={useOco} onChange={e => setUseOco(e.target.checked)} disabled={!canPlace} /> OCO Bracket</label>
          </div>

          {lastBar && <div className="entry-preview">Ref {fmtPrice(currentPrice)} · {chartTf}</div>}

          <button type="button" className="place-order" disabled={!canPlace || busy} onClick={handleSubmit}>
            {side === "Long" ? "Buy" : "Sell"} {qty} {chartSym}
          </button>

          {msg && <p className={`tp-msg ${msg.includes("failed") || msg.includes("error") ? "neg" : "pos"}`}>{msg}</p>}

          <AnimatePresence>
            {showConfirm && (
              <motion.div className="confirm-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <motion.div className="confirm-dialog" initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}>
                  <h4>Confirm Large Order</h4>
                  <p>You are about to place a {qty}-contract {chartSym} {side} {orderType} order.</p>
                  <div className="confirm-actions">
                    <button type="button" className="confirm-cancel" onClick={() => setShowConfirm(false)}>Cancel</button>
                    <button type="button" className="confirm-yes" onClick={handleSubmit} disabled={busy}>Confirm & Place</button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </article>
      </div>

      {/* ── bottom row ──────────────────────────────── */}
      <div className="tp-bottom">
        <section className="tp-dom glass">
          <div className="section-head"><h3>Depth of Market</h3><span>{chartSym}</span></div>
          <div className="dom-ladder">
            {domLevels.map((lv, i) => (
              <div
                key={i}
                className={`dom-row ${lv.side}`}
                onClick={() => handleDomClick(lv)}
              >
                <span className="dom-price">{fmtPrice(lv.price)}</span>
                <div className="dom-bar-wrap">
                  <div className="dom-bar" style={{ width: `${Math.min(100, lv.depth * 100)}%` }} />
                </div>
                <span className="dom-vol">{lv.volume}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="tp-right-stack">
          <section className="tp-positions glass">
            <div className="section-head"><h3>Positions</h3>
              <span className="pos-summary">
                {livePositions.length > 0 && (
                  <>
                    <span>Exposure <b>${fmtPrice(totalExposure)}</b></span>
                    <span>P&amp;L <b className={netPnl >= 0 ? "pos" : "neg"}>{netPnl >= 0 ? "+" : ""}${fmtPrice(Math.abs(netPnl))}</b></span>
                    <span>Margin <b>${fmtPrice(marginUsed)}</b></span>
                  </>
                )}
              </span>
            </div>
            {livePositions.length === 0 ? (
              <p className="term-offline">No open positions.</p>
            ) : (
              <div className="tp-pos-table">
                <div className="tp-pos-head">
                  <span>Symbol</span><span>Side</span><span>Qty</span><span>Entry</span><span>Current</span><span>P&amp;L</span><span>Trail</span><span />
                </div>
                {livePositions.map(p => (
                  <div className="tp-pos-row" key={p.id}>
                    <b>{p.symbol}</b>
                    <em className={p.side === "Long" ? "pos" : "neg"}>{p.side}</em>
                    <span>{p.quantity}</span>
                    <span>{fmtPrice(p.entryPrice)}</span>
                    <span>{p.currentPrice ? fmtPrice(p.currentPrice) : "—"}</span>
                    <strong className={(p.profit ?? 0) >= 0 ? "pos" : "neg"}>
                      {(p.profit ?? 0) >= 0 ? "+" : ""}${fmtPrice(Math.abs(p.profit ?? 0))}
                    </strong>
                    <label className="check"><input type="checkbox" checked={!!trailingMap[p.id]} onChange={() => toggleTrailing(p.id)} /> Trail</label>
                    <button className="close-btn" onClick={() => handleClosePosition(p)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="tp-watchlist glass">
            <div className="section-head"><h3>Watchlist</h3>
              <div className="watch-controls">
                <select value={watchSort} onChange={e => setWatchSort(e.target.value as typeof watchSort)}>
                  <option value="change">Change %</option>
                  <option value="price">Price</option>
                  <option value="name">Name</option>
                </select>
              </div>
            </div>
            <div className="watch-add">
              <input value={newSym} onChange={e => setNewSym(e.target.value)} placeholder="Add symbol…" onKeyDown={e => e.key === "Enter" && addSymbol()} />
              <button type="button" onClick={addSymbol}>+</button>
            </div>
            <div className="watch-list">
              {sortedWatch().map(w => (
                <div
                  key={w.symbol}
                  className={`watch-row ${w.changePct >= 0 ? "pos" : "neg"}`}
                  onContextMenu={e => handleWatchContext(e, w.symbol)}
                  onClick={() => { setChartSym(w.symbol); }}
                >
                  <b>{w.symbol}</b>
                  <span className="watch-name">{w.name}</span>
                  <span className="watch-price">{fmtPrice(w.price)}</span>
                  <strong className={`watch-chg ${w.changePct >= 0 ? "pos" : "neg"}`}>{fmtPct(w.changePct)}</strong>
                  <button className="watch-remove" onClick={e => { e.stopPropagation(); removeSymbol(w.symbol); }}>✕</button>
                </div>
              ))}
            </div>
            <AnimatePresence>
              {ctxMenu && (
                <motion.div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} onMouseLeave={() => setCtxMenu(null)}>
                  <button onClick={() => ctxTrade(ctxMenu.sym, "Long")}>Buy / Go Long</button>
                  <button onClick={() => ctxTrade(ctxMenu.sym, "Short")}>Sell / Go Short</button>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          <section className="tp-time-sales glass">
            <div className="section-head"><h3>Time & Sales</h3><span>{chartSym}</span></div>
            <div className="ts-list">
              {timeSales.map(t => (
                <div key={t.id} className={`ts-row ${t.side} ${t.isLarge ? "ts-large" : ""}`}>
                  <span className="ts-time">{t.time}</span>
                  <span className="ts-price">{fmtPrice(t.price)}</span>
                  <span className={`ts-side ${t.side}`}>{t.side === "buy" ? "B" : "S"}</span>
                  <span className="ts-vol">{t.volume}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
