import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReplayState, Bar, ReplaySpeed, Timeframe, SourceKind,
  createReplayFromBars, currentBar, visibleBars,
  stepForward, stepBack, seekTo, startPlay, pausePlay, setSpeed, restart,
  barIntervalMs, generateSyntheticBars,
} from "./replay-engine";
import {
  PracticeAccount, TradeOrder, OrderSide, OrderType, OrderOptions,
  createAccount, placeMarketOrder, placePendingOrder,
  closePosition, updateEquity, checkPendingOrders, checkSlTpTriggers, cancelOrder,
} from "./practice-trading";
import CandleChart, { ChartMarker, MarketBar } from "./CandleChart";

const REPLAY_BAR_CAP = 500; // matches dwella_bridge.py /bars cap
const SPEEDS: ReplaySpeed[] = [1, 2, 5, 10, 50];
const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const SYMBOLS = ["NQ", "ES", "GC", "EURUSD"];

// ── helpers ───────────────────────────────────────────────────────────
function fmtTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit",
  });
}
function fmtDate(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });
}
function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPnl(n: number): string {
  return `${n >= 0 ? "+" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}
function classPnl(n: number): string {
  return n > 0 ? "green" : n < 0 ? "red" : "";
}
function cacheKey(symbol: string, tf: Timeframe): string {
  return `${symbol}|${tf}`;
}
function replayBarsToMarketBars(bars: Bar[]): MarketBar[] {
  return bars.map(b => ({ t: b.time * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
}

// ══════════════════════════════════════════════════════════════════════
// MAIN REPLAY PANEL
// ══════════════════════════════════════════════════════════════════════
export default function ReplayPanel() {
  const [replay, setReplay] = useState<ReplayState>(() => {
    const bars = generateSyntheticBars("NQ", REPLAY_BAR_CAP, "M1");
    return createReplayFromBars(bars, "NQ", "M1", "synthetic");
  });
  const [account, setAccount] = useState<PracticeAccount>(() => createAccount(51284.72));
  const [tab, setTab] = useState<"positions" | "history">("positions");
  const [loading, setLoading] = useState(false);

  const tickRef = useRef<number | null>(null);
  const nextAdvanceMs = useRef<number>(0);
  const barsCache = useRef<Map<string, Bar[]>>(new Map());

  // ── Load bars for (symbol, tf) — cache first, MT5 second, synthetic last ──
  useEffect(() => {
    // Closure-scoped liveness: per-effect so a stale fetch from the previous
    // symbol/tf can't overwrite the new state.
    let alive = true;
    const symbol = replay.selectedSymbol;
    const tf = replay.selectedTimeframe;
    const key = cacheKey(symbol, tf);

    const cached = barsCache.current.get(key);
    if (cached) {
      setReplay(prev =>
        pausePlay(createReplayFromBars(cached, symbol, tf, prev.sourceKind))
      );
      return;
    }

    setLoading(true);
    if (window.dwella?.getMarketBars) {
      window.dwella
        .getMarketBars(symbol, tf, REPLAY_BAR_CAP)
        .then(result => {
          if (!alive) return;
          if (result?.ok && result.bars && result.bars.length >= 2) {
            const bars: Bar[] = result.bars.map(b => ({
              time: Math.floor(b.t / 1000),
              open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
            }));
            barsCache.current.set(key, bars);
            setReplay(createReplayFromBars(bars, symbol, tf, "mt5"));
            setLoading(false);
            return;
          }
          // Empty/error result: drop to synthetic so the UI still demos the flow.
          const bars = generateSyntheticBars(symbol, REPLAY_BAR_CAP, tf);
          barsCache.current.set(key, bars);
          setReplay(createReplayFromBars(bars, symbol, tf, "synthetic"));
          setLoading(false);
        })
        .catch(() => {
          if (!alive) return;
          const bars = generateSyntheticBars(symbol, REPLAY_BAR_CAP, tf);
          barsCache.current.set(key, bars);
          setReplay(createReplayFromBars(bars, symbol, tf, "synthetic"));
          setLoading(false);
        });
    } else {
      const bars = generateSyntheticBars(symbol, REPLAY_BAR_CAP, tf);
      barsCache.current.set(key, bars);
      setReplay(createReplayFromBars(bars, symbol, tf, "synthetic"));
      setLoading(false);
    }
    return () => { alive = false; };
  }, [replay.selectedSymbol, replay.selectedTimeframe]);

  // ── Re-evaluate SL/TP / equity / pending triggers whenever the bar advances ──
  useEffect(() => {
    const bar = replay.bars[replay.currentIndex];
    if (!bar) return;
    setAccount(prev => {
      let acc = checkPendingOrders(prev, bar);
      acc = checkSlTpTriggers(acc, bar);
      acc = updateEquity(acc, bar);
      return acc;
    });
  }, [replay.currentIndex, replay.bars]);

  // ── Playback tick ─────────────────────────────────────────────────────
  const tick = useCallback(() => {
    setReplay(prev => {
      if (!prev.isPlaying) return prev;
      if (prev.currentIndex >= prev.bars.length - 1) {
        return { ...prev, isPlaying: false, startedAt: null, baseBarTime: null };
      }
      const now = Date.now();
      if (now >= nextAdvanceMs.current) {
        nextAdvanceMs.current = now + barIntervalMs(prev.speed, prev.selectedTimeframe);
        return stepForward(prev);
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    tickRef.current = window.setInterval(tick, 50);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [tick]);

  const resetTimer = () => {
    nextAdvanceMs.current = Date.now() + barIntervalMs(replay.speed, replay.selectedTimeframe);
  };

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleStepForward = () => { resetTimer(); setReplay(prev => stepForward(prev)); };
  const handleStepBack = () => { resetTimer(); setReplay(prev => stepBack(prev)); };
  const handleSeek = (idx: number) => { resetTimer(); setReplay(prev => seekTo(prev, idx)); };

  const handlePlaceOrder = (side: OrderSide, type: OrderType, qty: number, options: OrderOptions) => {
    const bar = currentBar(replay);
    if (!bar) return;
    if (type === "Market") {
      const { account: a } = placeMarketOrder(account, bar, side, qty, options);
      setAccount(a);
    } else if (type === "StopLimit") {
      const { account: a } = placePendingOrder(account, side, "Stop", qty, bar.close, options);
      setAccount(a);
    } else {
      const { account: a } = placePendingOrder(account, side, type, qty, bar.close, options);
      setAccount(a);
    }
  };

  const handleClosePosition = (orderId: string) => {
    const bar = currentBar(replay);
    if (!bar) return;
    setAccount(prev => closePosition(prev, orderId, bar));
  };
  const handleCancelOrder = (orderId: string) => setAccount(prev => cancelOrder(prev, orderId));
  const handleRestart = () => {
    resetTimer();
    setReplay(prev => restart(prev));
    setAccount(createAccount(51284.72));
  };
  const handleSymbolChange = (symbol: string) =>
    setReplay(prev => pausePlay({ ...prev, selectedSymbol: symbol, bars: [], currentIndex: 0 }));
  const handleTimeframeChange = (tf: Timeframe) =>
    setReplay(prev => pausePlay({ ...prev, selectedTimeframe: tf, bars: [], currentIndex: 0 }));

  const bar = currentBar(replay);
  const chartBars = replayBarsToMarketBars(visibleBars(replay));
  const isAtEnd = replay.currentIndex >= replay.bars.length - 1;
  const sourceLabel: "MT5 live" | "Synth" = replay.sourceKind === "mt5" ? "MT5 live" : "Synth";

  // ── Chart overlay markers ────────────────────────────────────────────
  const markers: ChartMarker[] = [];
  for (const p of account.openPositions) {
    markers.push({
      price: p.entryPrice,
      color: "#9d8cff",
      label: `${p.side[0]} ${p.quantity} · entry ${fmtPrice(p.entryPrice)}`,
    });
    if (p.stopLoss != null)
      markers.push({ price: p.stopLoss, color: "#f18489", label: `SL ${fmtPrice(p.stopLoss)}` });
    if (p.takeProfit != null)
      markers.push({ price: p.takeProfit, color: "#6fd8aa", label: `TP ${fmtPrice(p.takeProfit)}` });
  }

  // ── Hand-off to existing visual language ─────────────────────────────
  return (
    <div className="replay-layout">
      {/* Left: chart + playback */}
      <div className="replay-main">
        <div className="terminal-bar">
          <div className="tabs">
            {SYMBOLS.map(s => (
              <button
                key={s}
                type="button"
                className={replay.selectedSymbol === s ? "active" : ""}
                onClick={() => handleSymbolChange(s)}
                disabled={loading}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="terminal-quote">
            {bar ? (
              <>
                <b>{fmtPrice(bar.close)}</b>
                <em>{bar.close >= bar.open ? "▲" : "▼"} {fmtPrice(Math.abs(bar.close - bar.open))}</em>
                <small>{replay.selectedSymbol} · {sourceLabel} · {fmtDate(bar.time)} {fmtTime(bar.time)}</small>
              </>
            ) : (
              <small>loading…</small>
            )}
          </div>
          <div className="tabs tf">
            {TIMEFRAMES.map(tf => (
              <button
                key={tf}
                type="button"
                className={replay.selectedTimeframe === tf ? "active" : ""}
                onClick={() => handleTimeframeChange(tf)}
                disabled={loading}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="terminal" style={{ padding: 0 }}>
          <CandleChart bars={chartBars} markers={markers} />
        </div>

        <div className="replay-progress">
          <span>{bar ? `${fmtDate(bar.time)} ${fmtTime(bar.time)}` : "—"}</span>
          <span>Bar {Math.max(0, replay.currentIndex) + 1} / {replay.bars.length}</span>
        </div>
        <div
          className="replay-progress-track"
          onClick={e => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            handleSeek(Math.round(pct * Math.max(0, replay.bars.length - 1)));
          }}
        >
          <div
            className="replay-progress-fill"
            style={{ width: `${replay.bars.length > 1 ? (replay.currentIndex / (replay.bars.length - 1)) * 100 : 0}%` }}
          />
        </div>

        <div className="playback-controls">
          <button type="button" className="ctrl" onClick={handleRestart} title="Restart">⏮</button>
          <button type="button" className="ctrl" onClick={handleStepBack} title="Step back" disabled={replay.currentIndex <= 0}>◀</button>
          <button
            type="button"
            className={`ctrl ${replay.isPlaying ? "playing" : ""}`}
            onClick={() => {
              if (replay.isPlaying) setReplay(prev => pausePlay(prev));
              else {
                resetTimer();
                setReplay(prev => isAtEnd ? restart(prev) : startPlay(prev));
              }
            }}
            title={replay.isPlaying ? "Pause" : "Play"}
          >
            {replay.isPlaying ? "⏸" : "▶"}
          </button>
          <button type="button" className="ctrl" onClick={handleStepForward} title="Step forward" disabled={isAtEnd}>▶</button>
          <button type="button" className="ctrl" onClick={() => handleSeek(replay.bars.length - 1)} title="Skip to end">⏭</button>
          <span className="ctrl-sep" />
          {SPEEDS.map(s => (
            <button
              key={s}
              type="button"
              className={`speed ${replay.speed === s ? "active" : ""}`}
              onClick={() => setReplay(prev => setSpeed(prev, s))}
            >
              {s}×
            </button>
          ))}
        </div>

        {account.pendingOrders.length > 0 && (
          <div className="replay-pending glass">
            <div className="section-head">
              <h3>Pending Orders</h3>
              <span>{account.pendingOrders.length}</span>
            </div>
            {account.pendingOrders.map(o => (
              <div className="replay-pending-row" key={o.id}>
                <b className={o.side === "Long" ? "pos" : "neg"}>{o.side[0]}</b>
                <span>{o.type} {o.quantity} {replay.selectedSymbol} @ {fmtPrice(o.entryPrice)}</span>
                {o.stopLoss != null && <small className="neg">SL {fmtPrice(o.stopLoss)}</small>}
                {o.takeProfit != null && <small className="pos">TP {fmtPrice(o.takeProfit)}</small>}
                <button type="button" className="close-link" onClick={() => handleCancelOrder(o.id)}>Cancel</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right: account summary + order entry + positions */}
      <div className="replay-side">
        <article className="term-acct">
          <h3>Practice account</h3>
          <div className="acct-stats">
            <span><b>${fmtPrice(account.balance)}</b><small>Balance</small></span>
            <span><b>${fmtPrice(account.equity)}</b><small>Equity</small></span>
            <span><b className={classPnl(account.totalPnl)}>{fmtPnl(account.totalPnl)}</b><small>Total P&L</small></span>
            <span><b>{account.winRate}%</b><small>Win rate</small></span>
          </div>
          <small className="acct-src">
            {account.tradeCount} trades · {account.openPositions.length} open · {account.closedTrades.length} closed
          </small>
        </article>

        <ReplayOrderEntry onPlaceOrder={handlePlaceOrder} bar={bar} symbol={replay.selectedSymbol} />

        <article className="term-poss">
          <div className="replay-tabs">
            <button type="button" className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>
              Positions ({account.openPositions.length})
            </button>
            <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
              History ({account.closedTrades.length})
            </button>
          </div>

          {tab === "positions" ? (
            account.openPositions.length === 0 ? (
              <p className="term-offline">No open positions. Step through bars and place an order.</p>
            ) : (
              account.openPositions.map(p => (
                <div className="replay-pos-row" key={p.id}>
                  <b>{p.side[0]}</b>
                  <span>{p.symbol}</span>
                  <span>{p.quantity}</span>
                  <span>{fmtPrice(p.entryPrice)}</span>
                  <span className={p.stopLoss != null ? "neg" : "muted"}>{p.stopLoss != null ? fmtPrice(p.stopLoss) : "—"}</span>
                  <span className={p.takeProfit != null ? "pos" : "muted"}>{p.takeProfit != null ? fmtPrice(p.takeProfit) : "—"}</span>
                  <span>{bar ? fmtPrice(bar.close) : "—"}</span>
                  <button type="button" className="close-btn" onClick={() => handleClosePosition(p.id)}>Close</button>
                </div>
              ))
            )
          ) : account.closedTrades.length === 0 ? (
            <p className="term-offline">No closed trades yet.</p>
          ) : (
            [...account.closedTrades].reverse().slice(0, 30).map(t => (
              <div className="replay-pos-row" key={t.id}>
                <b className={t.side === "Long" ? "pos" : "neg"}>{t.side[0]}</b>
                <span>{t.symbol}</span>
                <span>{t.quantity}</span>
                <span>{fmtPrice(t.entryPrice)}</span>
                <span>{t.exitPrice != null ? fmtPrice(t.exitPrice) : "—"}</span>
                <strong className={classPnl(t.pnl ?? 0)}>{t.pnl != null ? fmtPnl(t.pnl) : "—"}</strong>
                <small className={t.closedReason === "stop" ? "neg" : t.closedReason === "take-profit" ? "pos" : "muted"}>{t.closedReason ?? "—"}</small>
              </div>
            ))
          )}
        </article>
      </div>
    </div>
  );
}

// ── Inline order entry (matches existing terminal-form language) ────
function ReplayOrderEntry({
  onPlaceOrder, bar, symbol,
}: {
  onPlaceOrder: (side: OrderSide, type: OrderType, qty: number, options: OrderOptions) => void;
  bar: Bar | null;
  symbol: string;
}) {
  const [side, setSide] = useState<OrderSide>("Long");
  const [type, setType] = useState<OrderType>("Market");
  const [qty, setQty] = useState(1);
  const [useSl, setUseSl] = useState(false);
  const [useTp, setUseTp] = useState(false);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");

  const slNum = useSl && sl !== "" && Number.isFinite(Number(sl)) ? Number(sl) : undefined;
  const tpNum = useTp && tp !== "" && Number.isFinite(Number(tp)) ? Number(tp) : undefined;
  const canPlace = bar !== null;

  return (
    <article className="order-entry glass">
      <div className="order-entry-head">
        <span>New Order</span>
        <small>{symbol} · {type}</small>
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
          {(["Market", "Limit", "Stop"] as OrderType[]).map(t => (
            <button key={t} type="button" className={type === t ? "active" : ""} onClick={() => setType(t)} disabled={!canPlace}>{t}</button>
          ))}
        </div>
      </div>

      <div className="order-row">
        <label>Qty</label>
        <div className="order-qty">
          <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} disabled={!canPlace}>−</button>
          <span>{qty}</span>
          <button type="button" onClick={() => setQty(Math.min(10, qty + 1))} disabled={!canPlace}>+</button>
        </div>
      </div>

      <div className="order-row sltp">
        <label className="check"><input type="checkbox" checked={useSl} onChange={e => setUseSl(e.target.checked)} disabled={!canPlace} /> SL</label>
        <input className="price-input" type="number" placeholder="—" value={sl} onChange={e => setSl(e.target.value)} disabled={!useSl || !canPlace} step="0.25" />
        <label className="check"><input type="checkbox" checked={useTp} onChange={e => setUseTp(e.target.checked)} disabled={!canPlace} /> TP</label>
        <input className="price-input" type="number" placeholder="—" value={tp} onChange={e => setTp(e.target.value)} disabled={!useTp || !canPlace} step="0.25" />
      </div>

      {bar && <div className="entry-preview">Entry ≈ {fmtPrice(bar.close)}</div>}

      <button
        type="button"
        className="place-order"
        disabled={!canPlace}
        onClick={() => onPlaceOrder(side, type, qty, { stopLoss: slNum, takeProfit: tpNum })}
      >
        {side === "Long" ? "Buy ↗" : "Sell ↘"} {qty} {symbol}
      </button>
    </article>
  );
}
