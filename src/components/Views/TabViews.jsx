// TabViews.jsx
// Dwella trading views — real TradingView data only.
//   Dashboard → stones + AI column + analytics (all derived from live TradingView)
//   ChartView → full candlestick chart for selected symbol
//   Markets   → order flow terminal (real L2 book, real candles, real tape delta)
//   Radar     → candle-derived iceberg/stop-run events from real candles
//   Strategies→ BARK / IZZY / PICK / SLUG scanner on real candles
//   Risk      → daily loss limit vs REAL account equity
//   Positions → REAL open positions from TradingView
//   Journal   → the trader's own record
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useMT5, tapeDelta } from '../../hooks/useMT5Live.jsx';
import { useMarketEngine } from '../../hooks/useMarketEngine.js';
import DOMLadder from '../DOMLadder.jsx';
import CumulativeDelta from '../CumulativeDelta.jsx';
import EventHeatmap from '../EventHeatmap.jsx';
import CandlestickChart from '../CandlestickChart.jsx';
import IcebergRadar from '../IcebergRadar.jsx';
import StrategyCards from '../StrategyCards.jsx';
import RiskDesk from '../RiskDesk.jsx';
import MT5StatusBadge from '../MT5StatusBadge.jsx';
import LiveQuoteStrip from '../LiveQuoteStrip.jsx';
import TradingViewCard from '../TradovateCard.jsx';
import {
  computeATR,
  buildVolumeProfile,
  valueArea,
  deriveCandleEvents,
} from '../../lib/indicators.js';
import { scanStrategies } from '../../lib/strategies.js';

const fmt = (n, d = 2) =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const SYMBOLS = ['ENQ', 'MES', 'GCE', 'YM', 'ES', 'RTY', 'CL', 'SI', 'NQ'];
const NAMES = { ENQ: 'Micro Nasdaq', MES: 'Micro E-Mini S&P', GCE: 'Micro Gold', YM: 'Dow Jones', ES: 'E-mini S&P', RTY: 'Russell 2000', CL: 'Crude Oil', SI: 'Silver', NQ: 'E-mini Nasdaq' };
const DECIMALS = { ENQ: 2, MES: 2, GCE: 1, YM: 0, ES: 2, RTY: 1, CL: 2, SI: 3, NQ: 2 };
const JPS = { ENQ: 'マイクロナス', MES: 'マイクロS&P', GCE: 'マイクロ金', YM: 'ダウ', ES: 'S&P', RTY: 'ラッセル', CL: '原油', SI: '銀', NQ: 'ナスダック' };

// ----------------------------------------------------------------
// CHART VIEW — full candlestick chart for a selected symbol
// ----------------------------------------------------------------
export function ChartView({ symbol, onBack }) {
  const live = useMT5();
  const { snap, derived } = useMarketEngine({ symbol });

  const candles = live.candles[symbol] || [];
  const tick = live.ticks[symbol] || {};
  const price = tick.last ?? tick.bid ?? (candles.length ? candles[candles.length - 1].close : null);

  return (
    <div className="view active">
      {/* Back button + header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <button
          onClick={onBack}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 10,
            background: 'rgba(255,255,255,.05)', border: '1px solid var(--line)',
            color: 'var(--mut)', fontSize: 13, fontFamily: 'var(--body)', fontWeight: 600,
            cursor: 'pointer', transition: '.2s',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to Dashboard
        </button>
        <div>
          <span className="kicker">{symbol} · {NAMES[symbol]}</span>
          <h2 style={{ fontFamily: 'var(--disp)', fontSize: 28, marginTop: 4 }}>
            {NAMES[symbol]} <span className="jp">{JPS[symbol]}</span>
          </h2>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="live">● live</span>
          <div className="mono" style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: price != null ? (tick.last >= (tick.open ?? 0) ? 'var(--up)' : 'var(--down)') : 'var(--dim)' }}>
              {price != null ? fmt(price, DECIMALS[symbol]) : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--dim)' }}>M3 · tvdatafeed</div>
          </div>
        </div>
      </div>

      {/* Full candlestick chart */}
      <div className="panel glass">
        <div className="chart-wrap">
          <div style={{ height: 'calc(100vh - 280px)', minHeight: 500 }}>
            <CandlestickChart
              candles={candles}
              price={price}
            />
          </div>
        </div>
        <div className="chart-foot">
          <span>M3 bars · tvdatafeed · {symbol}</span>
          <span>5m ATR <span className="tp">{fmt(derived?.atr, 2)}</span></span>
          <span>Candles <span className="tp">{candles.length}</span></span>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// CHARTS — pick a market, open its full chart, add trades from it
// ----------------------------------------------------------------
export function ChartsView({ onOpenChart }) {
  const live = useMT5();

  const markets = useMemo(
    () =>
      SYMBOLS.map((sym) => {
        const t = live.ticks[sym] || {};
        const cs = live.candles[sym] || [];
        const last = t.last ?? t.bid ?? (cs.length ? cs[cs.length - 1].close : null);
        const prev = cs.length >= 2 ? cs[cs.length - 2].close : last;
        const chg = last != null && prev ? ((last - prev) / prev) * 100 : 0;
        return { sym, name: NAMES[sym], jp: JPS[sym], last, chg, up: chg >= 0, candles: cs, dec: DECIMALS[sym] };
      }),
    [live.ticks, live.candles]
  );

  return (
    <div className="view active">
      <div className="mb-4">
        <span className="kicker">チャート · Market Charts</span>          <h2 style={{ fontFamily: 'var(--disp)', fontSize: 26, marginTop: 8 }}>Choose the exact pair to trade from.</h2>
        <p style={{ color: 'var(--mut)', marginTop: 8, fontSize: 13 }}>
          Live M3 candlesticks from tvdatafeed · each chart card keeps its own symbol through execution.
        </p>
      </div>

      <div className="charts-grid">
        {markets.map((m) => (
          <button
            key={m.sym}
            className="charts-card glass"
            onClick={() => onOpenChart?.(m.sym)}
            data-bloom
          >
            <div className="cc-top">
              <span className="cc-sym mono">{m.sym}</span>
              <span className={`cc-chg mono ${m.last != null ? (m.up ? 'up' : 'down') : ''}`}>
                {m.last != null ? `${m.chg >= 0 ? '+' : ''}${fmt(m.chg, 2)}%` : 'awaiting feed'}
              </span>
            </div>
            <div className="cc-name">{m.name} <span className="jp">{m.jp}</span></div>
            <div className={`cc-price mono ${m.last != null ? (m.up ? 'up' : 'down') : ''}`}>
              {m.last != null ? fmt(m.last, m.dec) : '—'}
            </div>
            <div className="cc-spark">
              <MiniCandlestick candles={m.candles} />
            </div>
            <div className="cc-cta mono">OPEN CHART →</div>
          </button>
        ))}
        {!live.isLive && (
          <div className="charts-card glass" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, cursor: 'default' }}>
            <span className="mono" style={{ color: 'var(--dim)' }}>TradingView Offline</span>
            <span className="mono" style={{ color: 'var(--mut)', fontSize: 11 }}>Start TradingView Desktop</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// SCANNER PANEL — auto-trading status & controls
// ----------------------------------------------------------------
export function ScannerPanel() {
  const [scanner, setScanner] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const poll = () => {
      fetch('http://127.0.0.1:18814/scanner')
        .then(r => r.json())
        .then(setScanner)
        .catch(() => setScanner(null));
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  const arm = async () => {
    setLoading(true);
    try {
      await fetch('http://127.0.0.1:18814/scanner/arm', { method: 'POST' });
      const s = await fetch('http://127.0.0.1:18814/scanner').then(r => r.json());
      setScanner(s);
    } catch (e) {}
    setLoading(false);
  };

  const disarm = async () => {
    setLoading(true);
    try {
      await fetch('http://127.0.0.1:18814/scanner/disarm', { method: 'POST' });
      const s = await fetch('http://127.0.0.1:18814/scanner').then(r => r.json());
      setScanner(s);
    } catch (e) {}
    setLoading(false);
  };

  if (!scanner || !scanner.available) {
    return (
      <div className="panel glass">
        <div className="ph">
          <h3>Auto-Trading <span className="jp">自動売買</span></h3>
        </div>
        <div className="mono" style={{ color: 'var(--dim)', fontSize: 12, padding: '10px 0' }}>
          Scanner offline — start the sidecar to enable.
        </div>
      </div>
    );
  }

  const armed = scanner.armed;
  const signals = scanner.signals || [];
  const trades = scanner.trade_log || [];
  const dailyPnl = scanner.daily_pnl || 0;
  const lastScan = scanner.last_scan || '';
  const dailyTaken = scanner.daily_positions_taken ?? 0;
  const dailyLimit = scanner.daily_position_limit ?? scanner.config?.daily_position_limit ?? 0;
  const dailyUnlimited = dailyLimit === 0;
  const entryUnits = scanner.entry_units ?? scanner.config?.entry_units ?? 1;
  const dashboards = scanner.dashboards || {};
  const contextFrames = scanner.context_timeframes || ['1', '5', '15', '60', '240', 'D'];
  const contextLabels = { '1': '1m', '5': '5m', '15': '15m', '60': '1H', '240': '4H', D: 'D' };
  const contextColors = { BULLISH: 'var(--up)', BEARISH: 'var(--down)', NEUTRAL: 'var(--dim)' };
  const contextDashboard = dashboards[scanner.symbols?.[0] || 'ENQ'] || Object.values(dashboards)[0] || {};

  return (
    <div className="panel glass" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--disp)', fontWeight: 600, fontSize: 16, margin: 0 }}>Auto-Trading <span className="jp">自動売買</span></h3>            <div className="mono" style={{ color: 'var(--dim)', fontSize: 10, marginTop: 3, letterSpacing: '.04em' }}>
            INVESTING MASTERY 777 · 3m reclaim · native 1m/5m/15m/1H/4H/D stack · {armed ? (lastScan ? `last scan ${lastScan.slice(11,19)}` : 'scanning...') : 'paused'}

          </div>
        </div>
        <button
          onClick={armed ? disarm : arm}
          disabled={loading}
          style={{
            padding: '8px 20px',
            borderRadius: 20,
            fontSize: 12,
            fontFamily: 'var(--mono)',
            fontWeight: 700,
            letterSpacing: '.04em',
            cursor: 'pointer',
            transition: 'all 0.25s ease',
            background: armed
              ? 'linear-gradient(135deg, rgba(143,224,178,.3), rgba(143,224,178,.1))'
              : 'linear-gradient(135deg, #d9b46c, #f0d49a)',
            color: armed ? '#8fe0b2' : '#1a0d10',
            border: armed ? '1px solid rgba(143,224,178,.5)' : '1px solid rgba(217,180,108,.6)',
            boxShadow: armed ? '0 0 20px rgba(143,224,178,.2)' : '0 4px 16px rgba(217,180,108,.4)',
          }}
        >
          {loading ? '...' : armed ? '● TRADING' : '▶ START TRADING'}
        </button>
      </div>

      {/* Stats row */}
      <div className="scanner-stats">
        <div style={{ flex: 1, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line2)' }}>
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '.08em' }}>DAILY P&L</div>
          <div className={`mono ${dailyPnl >= 0 ? 'up' : 'down'}`} style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
            {dailyPnl >= 0 ? '+$' : '-$'}{Math.abs(dailyPnl).toFixed(2)}
          </div>
        </div>
        <div style={{ flex: 1, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line2)' }}>
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '.08em' }}>OPEN</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginTop: 2 }}>
            {scanner.open_positions || 0} / {scanner.config?.max_positions ?? 3}
          </div>
        </div>
        <div style={{ flex: 1, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line2)' }}>
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '.08em' }}>TODAY</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--gold)', marginTop: 2 }}>
            {dailyUnlimited ? 'UNLIMITED' : `${dailyTaken} / ${dailyLimit}`}
          </div>
          <div className="mono" style={{ fontSize: 8, color: 'var(--dim)', letterSpacing: '.04em' }}>{dailyUnlimited ? 'daily entry cap disabled' : 'positions used'}</div>
        </div>
        <div style={{ flex: 1, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line2)' }}>
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '.08em' }}>ENTRY SIZE</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--gold)', marginTop: 2 }}>
            {entryUnits} <span style={{ fontSize: 9, color: 'var(--dim)', fontWeight: 400 }}>unit</span>
          </div>
          <div className="mono" style={{ fontSize: 8, color: 'var(--dim)', letterSpacing: '.04em' }}>one per setup</div>
        </div>
        <div style={{ flex: 1, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line2)' }}>
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '.08em' }}>TRADES</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginTop: 2 }}>
            {trades.length}
          </div>
        </div>
      </div>

      {/* Multi-timeframe playbook */}
      <div style={{ margin: '12px 0 14px', padding: '10px 12px', borderRadius: 10, background: 'rgba(255,255,255,.025)', border: '1px solid var(--line2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span className="mono" style={{ color: 'var(--blush)', fontSize: 10, letterSpacing: '.08em' }}>BOB INVESTING MASTERY · 777 PLAYBOOK</span>
          <span className="mono" style={{ color: 'var(--dim)', fontSize: 9 }}>reclaim close · closed bars only</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 9, color: 'var(--gold)', padding: '3px 7px', borderRadius: 5, background: 'rgba(217,180,108,.1)', border: '1px solid rgba(217,180,108,.2)' }}>RECLAIM 3m</span>
          <span className="mono" style={{ fontSize: 9, color: 'var(--dim)' }}>→</span>
          {contextFrames.map((tf) => {
            const context = contextDashboard.timeframes?.[tf];
            const bias = context?.bias || 'WAITING';
            return <span key={tf} className="mono" style={{ fontSize: 9, color: contextColors[bias] || 'var(--dim)', padding: '3px 7px', borderRadius: 5, background: bias === 'BULLISH' ? 'rgba(143,224,178,.08)' : bias === 'BEARISH' ? 'rgba(255,109,134,.08)' : 'rgba(255,255,255,.03)', border: '1px solid var(--line2)' }}>{contextLabels[tf] || tf} {bias}</span>;
          })}
        </div>
        <div className="mono" style={{ marginTop: 7, fontSize: 9, color: 'var(--dim)' }}>Red = where you buy · blue = where you sell · wait when higher frames conflict.</div>
        <div className="mono" style={{ marginTop: 5, fontSize: 9, color: 'var(--dim)' }}>
          RED {contextDashboard.red_line?.price != null ? contextDashboard.red_line.price.toLocaleString() : '—'} · BLUE {contextDashboard.blue_line?.price != null ? contextDashboard.blue_line.price.toLocaleString() : '—'} · 777 {contextDashboard.seven_score?.label || '000'} · beans {contextDashboard.bean_count ?? 0}
        </div>
      </div>

      {/* Live Setups */}
      <div className="mono" style={{ color: 'var(--blush)', fontSize: 10, letterSpacing: '.08em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: armed ? '#8fe0b2' : '#ff6d86', display: 'inline-block', boxShadow: armed ? '0 0 8px #8fe0b2' : 'none' }} />
        LIVE SETUPS
      </div>

      {/* Signal cards */}
      {signals.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {signals.slice(-5).reverse().map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', borderRadius: 10, marginBottom: 4,
              background: s.direction === 'long'
                ? 'linear-gradient(90deg, rgba(143,224,178,.08), rgba(143,224,178,.02))'
                : 'linear-gradient(90deg, rgba(255,109,134,.08), rgba(255,109,134,.02))',
              border: `1px solid ${s.direction === 'long' ? 'rgba(143,224,178,.2)' : 'rgba(255,109,134,.2)'}`,
            }}>
              <span style={{
                fontSize: 8, fontFamily: 'var(--mono)', fontWeight: 800,
                padding: '2px 7px', borderRadius: 4,
                background: s.direction === 'long' ? 'rgba(143,224,178,.2)' : 'rgba(255,109,134,.2)',
                color: s.direction === 'long' ? 'var(--up)' : 'var(--down)',
                letterSpacing: '.06em',
              }}>{s.direction === 'long' ? '▲ LONG' : '▼ SHORT'}</span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{s.symbol}</span>
              <span className="mono" style={{
                fontSize: 9, color: 'var(--blush)',
                padding: '2px 6px', borderRadius: 4,
                background: 'rgba(246,201,211,.1)',
                border: '1px solid rgba(246,201,211,.2)',
              }}>{s.pattern || s.strategy}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 'auto' }}>
                Entry {s.entry?.toFixed(1)}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'rgba(255,109,134,.7)' }}>
                SL {s.stop?.toFixed(1)}
              </span>                <span className="mono" style={{ fontSize: 10, color: 'rgba(143,224,178,.7)' }}>
                TP {s.target?.toFixed(1)}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--gold)' }}>
                {s.qty ?? entryUnits} unit
              </span>
              {s.timeframes_checked > 0 && <span className="mono" style={{ fontSize: 9, color: 'var(--blush)' }}>{s.alignment_count}/{s.timeframes_checked} TF</span>}
            </div>
          ))}
        </div>
      )}

      {/* Per-symbol scan status */}
      {scanner.scan_log && scanner.scan_log.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '.08em', marginBottom: 6 }}>SCANNER STATUS</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {scanner.scan_log.map((e, i) => {
              const trendColor = e.trend === 'up' ? 'var(--up)' : e.trend === 'down' ? 'var(--down)' : 'var(--dim)';
              const distVal = typeof e.dist_to_slow_atr === 'number' ? e.dist_to_slow_atr : null;
              const closeToSetup = distVal !== null && distVal < 0.85;
              return (
                <div key={i} style={{
                  padding: '6px 10px', borderRadius: 8,
                  background: e.status === 'signal' ? 'rgba(143,224,178,.08)' : 'rgba(255,255,255,.02)',
                  border: `1px solid ${e.status === 'signal' ? 'rgba(143,224,178,.3)' : closeToSetup ? 'rgba(217,180,108,.25)' : 'var(--line2)'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>{e.symbol}</span>
                    <span className="mono" style={{
                      fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                      background: e.status === 'signal' ? 'rgba(143,224,178,.2)' : e.status === 'watching' ? 'rgba(217,180,108,.12)' : 'rgba(255,255,255,.05)',
                      color: e.status === 'signal' ? 'var(--up)' : e.status === 'watching' ? 'var(--gold)' : 'var(--dim)',
                      letterSpacing: '.04em',
                    }}>{e.status === 'signal' ? '⚡ SIGNAL' : e.status === 'watching' ? '◉ WATCHING' : '— NO DATA'}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 9, color: 'var(--mut)', marginTop: 3 }}>
                    <span style={{ color: trendColor }}>{e.trend?.toUpperCase()}</span>
                    {' · '}${e.price?.toLocaleString()}
                    {distVal !== null && (
                      <span style={{ color: closeToSetup ? 'var(--gold)' : 'var(--dim)' }}> · {distVal.toFixed(2)}×</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {signals.length === 0 && (!scanner.scan_log || scanner.scan_log.length === 0) && (
        <div style={{
          padding: '14px', borderRadius: 10,
          background: 'rgba(255,255,255,.02)',
          border: '1px dashed var(--line)',
          textAlign: 'center',
          marginBottom: 12,
        }}>
          <div className="mono" style={{ color: armed ? 'var(--mut)' : 'var(--dim)', fontSize: 11 }}>
            {armed ? 'Scanner starting...' : 'Click Start Trading to scan for setups'}</div>
        </div>
      )}

      {/* Recent trades */}
      {trades.length > 0 && (
        <div>
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '.08em', marginBottom: 6 }}>EXECUTED TRADES</div>
          {trades.slice(-3).reverse().map((t, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 10px', borderRadius: 6, marginBottom: 3,
              background: 'rgba(255,255,255,.02)',
              fontSize: 10, fontFamily: 'var(--mono)',
            }}>
              <span style={{ color: t.direction === 'long' ? 'var(--up)' : 'var(--down)', fontWeight: 700 }}>
                {t.direction === 'long' ? '▲' : '▼'} {t.symbol}
              </span>
              <span style={{ color: 'var(--blush)' }}>{t.strategy}</span>
              <span className="mono" style={{ color: 'var(--dim)', marginLeft: 'auto' }}>{t.time?.slice(11, 19) || ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------
// DASHBOARD — stones + performance + AI column + analytics (real data)
// ----------------------------------------------------------------
export function DashboardView({ query = '', onOpenChart }) {
  const live = useMT5();
  const [selectedSymbol, setSelectedSymbol] = useState('ENQ');
  const [timeframe, setTimeframe] = useState('15m');
  const [chartCandles, setChartCandles] = useState([]);
  const acct = live.account || {};
  const positions = live.positions || [];
  const selectedCandles = live.candles[selectedSymbol] || [];
  const selectedTick = live.ticks[selectedSymbol] || {};
  const selectedPrice = selectedTick.last ?? selectedTick.bid ?? (selectedCandles.length ? selectedCandles[selectedCandles.length - 1].close : null);
  const chartTimeframe = { '1m': '1', '5m': '5', '15m': '15', '1H': '60', '4H': '240', D: 'D' }[timeframe] || '15';

  // The toolbar is a real resolution switch, not a relabelled 3m chart.
  // The sidecar prefers native TradingView bars and only falls back to its
  // verified 3m stream when a provider does not expose that resolution.
  useEffect(() => {
    let active = true;
    if (!live.isLive) {
      setChartCandles([]);
      return () => { active = false; };
    }
    fetch(`http://127.0.0.1:18814/candles?symbol=${selectedSymbol}&timeframe=${chartTimeframe}&count=300`)
      .then((res) => res.json())
      .then((data) => { if (active) setChartCandles(Array.isArray(data?.candles) ? data.candles : []); })
      .catch(() => { if (active) setChartCandles([]); });
    return () => { active = false; };
  }, [live.isLive, selectedSymbol, chartTimeframe]);

  const displayCandles = chartCandles.length ? chartCandles : selectedCandles;
  const selectedEvents = useMemo(() => live.isLive ? deriveCandleEvents(displayCandles) : [], [live.isLive, displayCandles]);
  const displayProfile = useMemo(() => buildVolumeProfile(displayCandles.slice(-60)), [displayCandles]);
  const displayValueArea = useMemo(() => valueArea(displayProfile, 0.7), [displayProfile]);
  const equity = Number(acct.equity || 0);
  const balance = Number(acct.balance || 0);
  const dailyPnl = Number(acct.profit || 0) + positions.reduce((sum, position) => sum + Number(position.profit || 0), 0);
  const buyingPower = Number(acct.margin_free || 0);
  const marginUsedPct = equity ? (Number(acct.margin || 0) / equity) * 100 : 0;
  const drawdown = balance ? Math.max(0, ((balance - equity) / balance) * 100) : 0;
  const marketCards = ['ENQ', 'ES', 'YM', 'GCE'].map((symbol) => ({ symbol, tick: live.ticks[symbol] || {}, candles: live.candles[symbol] || [] }));
  const money = (value, digits = 2) => Number.isFinite(Number(value)) ? `$${Math.abs(Number(value)).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}` : '—';
  const positionMeta = (rawSymbol) => {
    const raw = String(rawSymbol || '').replace('@', '').toUpperCase();
    if (raw.includes('MNQ')) return { symbol: 'NQ', decimals: 2 };
    if (raw.includes('MES')) return { symbol: 'ES', decimals: 2 };
    if (raw.includes('YM')) return { symbol: 'YM', decimals: 0 };
    if (raw.includes('GC')) return { symbol: 'GC', decimals: 1 };
    if (raw.includes('ES')) return { symbol: 'ES', decimals: 2 };
    if (raw.includes('RTY')) return { symbol: 'RTY', decimals: 1 };
    if (raw.includes('CL')) return { symbol: 'CL', decimals: 2 };
    if (raw.includes('SI')) return { symbol: 'SI', decimals: 3 };
    if (raw.includes('NQ')) return { symbol: 'NQ', decimals: 2 };
    return { symbol: raw || '—', decimals: 2 };
  };

  return (
    <div className="view active dwella-dashboard">
      <div className="dwella-kpi-strip">
        <div className="dwella-brand-lockup"><div className="sanctuary-crest"><span className="sanctuary-cross" /></div><div><strong>DWELLA</strong><small>WALK IN THE LIGHT. TRADE WITH PURPOSE.</small></div></div>
        {[
          ['ACCOUNT EQUITY', money(equity)],
          ['DAILY P&L', `${dailyPnl >= 0 ? '+' : '-'}${money(dailyPnl)}`],
          ['BUYING POWER', money(buyingPower)],
          ['DRAWDOWN', `-${drawdown.toFixed(2)}%`],
          ['RISK EXPOSURE', `${marginUsedPct.toFixed(1)}%`],
        ].map(([label, value], index) => <div className={`dwella-kpi ${index === 1 ? (dailyPnl >= 0 ? 'positive' : 'negative') : ''}`} key={label}><span>{label}</span><b>{value}</b><small>{index === 0 ? '↗ live account' : index === 1 ? 'realized + open' : index === 3 ? `${money(Math.max(0, balance - equity), 2)} below balance` : index === 4 ? 'account margin' : 'connected TradingView'}</small></div>)}
        <div className="dwella-verse">“I am the light of the world.”<small>— John 8:12</small></div><div className="dwella-cross-orb">+</div>
      </div>

      <div className="dwella-market-strip">
        {marketCards.map(({ symbol, tick, candles }) => {
          const last = tick.last ?? tick.bid ?? null; const prev = candles.at(-2)?.close ?? last; const change = last && prev ? ((last - prev) / prev) * 100 : 0;
          return <button key={symbol} className={`dwella-market-card ${selectedSymbol === symbol ? 'selected' : ''}`} onClick={() => { setSelectedSymbol(symbol); onOpenChart?.(symbol); }}><span className="market-status-dot" /><strong>{symbol === 'ENQ' ? 'NQ' : symbol === 'GCE' ? 'GC' : symbol}</strong><small>{NAMES[symbol]}</small><b>{last != null ? fmt(last, DECIMALS[symbol]) : '—'}</b><em className={change >= 0 ? 'up' : 'down'}>{last != null ? `${change >= 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(2)}%` : 'awaiting'}</em></button>;
        })}<button className="dwella-add-market" onClick={() => onOpenChart?.(selectedSymbol)}>+</button>
      </div>

      <div className="dwella-workspace">
        <div className="dwella-chart-panel glass">
          <div className="dwella-chart-toolbar">          <div className="dwella-symbol-label"><b>{selectedSymbol === 'ENQ' ? 'NQ' : selectedSymbol === 'GCE' ? 'GC' : selectedSymbol}</b><span>· {timeframe} · DWELLA</span><i className={live.isLive ? 'live' : ''} />{selectedPrice != null && <em>{fmt(displayCandles.at(-1)?.open, DECIMALS[selectedSymbol])} H {fmt(displayCandles.at(-1)?.high, DECIMALS[selectedSymbol])} L {fmt(displayCandles.at(-1)?.low, DECIMALS[selectedSymbol])} C {fmt(selectedPrice, DECIMALS[selectedSymbol])}</em>}</div><div className="dwella-timeframes">{['1m', '5m', '15m', '1H', '4H', 'D'].map((tf) => <button key={tf} className={timeframe === tf ? 'active' : ''} onClick={() => setTimeframe(tf)}>{tf}</button>)}</div><span className="dwella-tool-label">♡　⌘　⚙　♧</span></div>
          <div className="dwella-chart-canvas"><CandlestickChart candles={displayCandles} profile={displayProfile} valueArea={displayValueArea} events={selectedEvents} price={selectedPrice} /></div>

          <div className="dwella-chart-tabs"><button className="active">Order Flow</button><button>Volume Delta</button><button>Market Structure</button><button>Trades</button></div><div className="dwella-flow-preview"><EventHeatmap events={selectedEvents} candles={displayCandles} price={selectedPrice} height={105} /></div>
        </div>

        <aside className="dwella-autotrader-panel glass">        <div className="dwella-panel-heading"><h3>＋ AUTOTRADER</h3><span className="dwella-active-dot">● ACTIVE</span></div><label>STRATEGY</label><div className="dwella-select">INVESTING MASTERY 777 <small>Red/Blue Wick Stack · Reclaim Close　⌄</small></div>
<div className="dwella-setting-row"><label>AUTOMATED ENTRIES</label><span className="dwella-switch on" /></div><div className="dwella-settings-grid"><div><label>RISK PER TRADE</label><b>1.00%</b></div><div><label>DAILY LOSS CAP</label><b>EXTERNAL</b></div><div><label>MAX DRAWDOWN</label><b>{drawdown.toFixed(2)}%</b></div><div><label>POSITION SIZING</label><b>1 unit</b></div></div><label className="dwella-section-label">INSTRUMENTS</label><div className="dwella-instrument-list">{['ENQ', 'ES', 'YM', 'GCE'].map((symbol) => <button key={symbol} className={selectedSymbol === symbol ? 'active' : ''} onClick={() => setSelectedSymbol(symbol)}>{symbol === 'ENQ' ? 'NQ' : symbol === 'GCE' ? 'GC' : symbol}</button>)}</div><label className="dwella-section-label">TRADING SESSIONS</label>{['London　07:00 - 10:00', 'New York　09:30 - 16:00', 'Midday　12:00 - 14:00'].map((session, index) => <div className="dwella-session-row" key={session}><span>{session}</span><i className={index === 1 ? 'on' : ''} /></div>)}<button className="dwella-pause-btn" onClick={() => document.querySelector('.sanctuary-nav-item.active')?.click()}>Ⅱ　PAUSE AUTOTRADER</button></aside>
      </div>

      <div className="dwella-bottom-grid"><div className="glass dwella-table-panel"><div className="dwella-panel-heading"><h3>◉ ACTIVE POSITIONS <small>{positions.length} OPEN</small></h3><span>›</span></div><div className="dwella-table-scroll"><table className="dwella-table"><thead><tr><th>INSTRUMENT</th><th>SIDE</th><th>SIZE</th><th>ENTRY</th><th>MARKET</th><th>P&amp;L</th><th>P&amp;L %</th><th>R:R</th></tr></thead><tbody>{positions.length ? positions.map((p, index) => { const meta = positionMeta(p.symbol); const pnl = Number(p.profit || 0); return <tr key={p.ticket || index}><td>{meta.symbol}</td><td className={p.type === 0 ? 'up' : 'down'}>{p.type === 0 ? 'LONG' : 'SHORT'}</td><td>{p.volume}</td><td>{fmt(p.price_open, meta.decimals)}</td><td>{fmt(p.price_current, meta.decimals)}</td><td className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : '-'}{money(pnl)}</td><td>{equity ? `${((pnl / equity) * 100).toFixed(2)}%` : '—'}</td><td>—</td></tr>; }) : <tr><td colSpan="8" className="empty-state">No open positions returned by TradingView.</td></tr>}</tbody></table></div></div><div className="glass dwella-table-panel"><div className="dwella-panel-heading"><h3>◔ ORDERS <small>{live.openOrders?.length || 0} WORKING</small></h3><span>›</span></div><div className="dwella-table-scroll"><table className="dwella-table"><thead><tr><th>INSTRUMENT</th><th>TYPE</th><th>SIDE</th><th>SIZE</th><th>PRICE</th><th>STATUS</th></tr></thead><tbody>{live.openOrders?.length ? live.openOrders.map((o, index) => <tr key={o.id || index}><td>{o.symbol || '—'}</td><td>{o.orderType || '—'}</td><td className="up">{o.action || o.side || '—'}</td><td>{o.qty || o.quantity || 1}</td><td>{fmt(Number(o.price), 2)}</td><td><span className="dwella-status-pill">{o.status || 'WORKING'}</span></td></tr>) : <tr><td colSpan="6" className="empty-state">No working orders returned by TradingView.</td></tr>}</tbody></table></div></div></div>
      <div className="dwella-footer"><span>MARKET STATUS <b className={live.isLive ? 'up' : 'down'}>{live.isLive ? 'CONNECTED' : 'OFFLINE'} ●</b></span><span>DATA FEED <b className={live.isLive ? 'up' : 'down'}>{live.isLive ? 'LIVE' : 'WAITING'} ●</b></span><em>“Blessed is the one who is faithful in what is least.” — Luke 16:10</em><span>SERVER TIME <b>{new Date().toLocaleTimeString('en-US', { hour12: false })} ET</b></span><span className="dwella-footer-icons">☼　?　↗</span></div>
    </div>
  );
}

function MiniCandlestick({ candles }) {
  if (!candles || candles.length < 2) return <svg className="spark gold" viewBox="0 0 120 50" preserveAspectRatio="none" />;
  
  // Take last 20 candles for the mini chart
  const slice = candles.slice(-20);
  const allHighs = slice.map(c => c.high);
  const allLows = slice.map(c => c.low);
  const min = Math.min(...allLows);
  const max = Math.max(...allHighs);
  const range = max - min || 1;
  
  const barWidth = 4;
  const gap = 2;
  const chartHeight = 46;
  const chartWidth = slice.length * (barWidth + gap);
  
  const scaleY = (price) => {
    return chartHeight - ((price - min) / range) * (chartHeight - 4) - 2;
  };
  
  return (
    <svg className="spark" viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" style={{ width: '100%', height: 50 }}>
      {slice.map((c, i) => {
        const x = i * (barWidth + gap);
        const isUp = c.close >= c.open;
        const color = isUp ? 'var(--up)' : 'var(--down)';
        const bodyTop = scaleY(Math.max(c.open, c.close));
        const bodyBottom = scaleY(Math.min(c.open, c.close));
        const bodyHeight = Math.max(1, bodyBottom - bodyTop);
        
        return (
          <g key={i}>
            {/* Wick */}
            <line
              x1={x + barWidth / 2}
              y1={scaleY(c.high)}
              x2={x + barWidth / 2}
              y2={scaleY(c.low)}
              stroke={color}
              strokeWidth={1}
            />
            {/* Body */}
            <rect
              x={x}
              y={bodyTop}
              width={barWidth}
              height={bodyHeight}
              fill={isUp ? 'var(--up)' : 'var(--down)'}
              opacity={0.8}
              rx={1}
            />
          </g>
        );
      })}
    </svg>
  );
}

// ----------------------------------------------------------------
// MARKETS — Order Flow Terminal (real data)
// ----------------------------------------------------------------
export function MarketsView() {
  const live = useMT5();
  const tick = live.ticks.ENQ || {};
  const livePrice = tick.last ?? tick.bid ?? null;
  const { snap, derived } = useMarketEngine({ symbol: 'ENQ', livePrice });

  const realEvents = useMemo(() => (live.isLive ? deriveCandleEvents(live.candles.ENQ || []) : []), [live.isLive, live.candles.ENQ]);
  const realSignals = useMemo(() => {
    if (!live.isLive || !live.candles.ENQ) return [];
    const cs = live.candles.ENQ;
    const atr = computeATR(cs, 14);
    const profile = buildVolumeProfile(cs.slice(-60));
    const va = valueArea(profile, 0.7);
    const events = deriveCandleEvents(cs);
    return scanStrategies({ candles: cs, price: livePrice ?? cs[cs.length - 1].close, atr5: atr, profile, valueArea: va, events });
  }, [live.isLive, live.candles.ENQ, livePrice]);

  const book = live.book.ENQ || { bids: [], asks: [] };
  const delta = tapeDelta(live.tape.ENQ || []);

  return (
    <div className="view active">
      <LiveQuoteStrip />

      {!live.isLive && (
        <div className="px-3 py-2 rounded-lg mb-3" style={{ background: 'rgba(255,109,134,.08)', border: '1px solid rgba(255,109,134,.25)' }}>
          <span className="mono" style={{ color: 'var(--down)', fontSize: 11 }}>
            TradingView feed offline — no simulated data. Start TradingView Desktop to see live markets.
          </span>
        </div>
      )}

      <div className="fut-grid">
        {/* L2 book */}
        <div>
          <div className="panel glass">
            <div className="ph">
              <h3>Order Book <span className="jp">板</span></h3>
              <MT5StatusBadge compact />
            </div>
            <DOMLadder book={book} price={livePrice} bid={tick.bid} ask={tick.ask} decimals={2} />
            <div className="depth-row">
              <span>Bid <b className="up">{fmt(tick.bid, 2)}</b></span>
              <span>Spread <b className="gold">{tick.bid != null && tick.ask != null ? fmt(tick.ask - tick.bid, 2) : '—'}</b></span>
              <span>Ask <b className="down">{fmt(tick.ask, 2)}</b></span>
            </div>
          </div>

          <div className="panel glass" style={{ marginTop: 14 }}>
            <div className="ph">
              <h3>Cumulative Delta <span className="jp">デルタ</span></h3>
              <span className="mono" style={{ color: 'var(--dim)', fontSize: 10 }}>real tick flags</span>
            </div>
            <CumulativeDelta deltaHistory={delta.bars.map((b) => b.d).slice(-120)} height={110} />
            <div className="depth-row">
              <span className="up">Buy {delta.buyVol}</span>
              <span className={delta.sum >= 0 ? 'up' : 'down'}>{delta.sum >= 0 ? '+' : ''}{delta.sum}</span>
              <span className="down">Sell {delta.sellVol}</span>
            </div>
          </div>
        </div>

        {/* Chart + heatmap */}
        <div>
          <div className="panel glass">
            <div className="ph">
              <h3>Price & Volume Profile <span className="jp">チャート</span></h3>
              <span className="mono" style={{ color: 'var(--dim)', fontSize: 10 }}>TradingView · M3 · 70% VA</span>
            </div>
            <div className="h-[300px]">
              <CandlestickChart
                candles={live.candles.ENQ || []}
                price={livePrice}
              />
            </div>
          </div>

          <div className="panel glass" style={{ marginTop: 14 }}>
            <div className="ph">
              <h3>Liquidity Heatmap <span className="jp">熱地図</span></h3>
              <span className="mono" style={{ color: 'var(--dim)', fontSize: 10 }}>real candle events</span>
            </div>              <EventHeatmap events={realEvents} candles={live.candles.ENQ || []} price={livePrice} height={170} />
          </div>
        </div>

        {/* Readouts */}
        <div>
          <div className="panel glass">
            <div className="ph">
              <h3>Market Read <span className="jp">読み</span></h3>
            </div>
            <MarketReadout snap={snap} derived={derived} live={live} signals={realSignals} />
          </div>

          <div className="panel glass" style={{ marginTop: 14 }}>
            <div className="ph">
              <h3>Recent Events <span className="jp">出来事</span></h3>
            </div>
            <IcebergRadar
              events={realEvents}
              icebergs={realEvents.filter((e) => e.type === 'iceberg')}
              stopRuns={realEvents.filter((e) => e.type === 'stop-run')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MarketReadout({ snap, derived, live, signals }) {
  const bias = derived?.bias || { bias: 'Neutral', confidence: 50 };
  const t = live?.ticks?.ENQ || {};
  const last = t.last ?? t.bid ?? snap.price;
  const stat = (label, value, color = 'var(--ink)') => (
    <div className="spec-list" style={{ marginTop: 0 }}>
      <div className="sl">
        <span>{label}</span>
        <b style={{ color }}>{value}</b>
      </div>
    </div>
  );
  return (
    <div>
      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>SESSION BIAS</span>
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: bias.bias === 'Bullish' ? 'var(--blush)' : bias.bias === 'Bearish' ? 'var(--down)' : 'var(--mut)' }}>
            {bias.bias}
          </span>
        </div>
        <div className="h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
          <div
            className="h-full rounded-full"
            style={{ width: `${bias.confidence}%`, background: bias.bias === 'Bullish' ? 'var(--blush)' : bias.bias === 'Bearish' ? 'var(--down)' : 'var(--mut)' }}
          />
        </div>
      </div>
      {stat('Bid', fmt(t.bid, 2), 'var(--up)')}
      {stat('Ask', fmt(t.ask, 2), 'var(--down)')}
      {stat('Last', fmt(last, 2))}
      {stat('5-min ATR', fmt(derived?.atr, 2), 'var(--blush)')}
      {stat('Cum Delta', `${snap.cumDelta >= 0 ? '+' : ''}${fmt(snap.cumDelta, 0)}`, snap.cumDelta >= 0 ? 'var(--up)' : 'var(--down)')}
      {stat('POC', fmt(derived?.va?.poc, 2), 'var(--gold)')}
      {stat('GEX', '— (no options feed)', 'var(--dim)')}
      {stat('Options Flow', '— (no options feed)', 'var(--dim)')}

      <div className="mt-3 p-2.5 rounded-lg" style={{ background: 'rgba(246,201,211,.05)', border: '1px solid rgba(246,201,211,.15)' }}>
        <div className="mono mb-1" style={{ fontSize: 9, color: 'var(--blush)' }}>LIVE SIGNALS</div>
        {signals?.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {signals.slice(0, 4).map((s) => (
              <div key={s.id} className="flex items-center justify-between" style={{ fontSize: 10, fontFamily: 'var(--mono)' }}>
                <span style={{ color: 'var(--mut)' }}>
                  <strong style={{ color: s.dir === 'long' ? 'var(--blush)' : 'var(--down)' }}>{s.dir.toUpperCase()}</strong> {s.strategyId.toUpperCase()} @ {s.area}
                </span>
                <span style={{ color: 'var(--ink)' }}>{fmt(s.entry, 2)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', fontStyle: 'italic' }}>
            Waiting for an event at an important area…
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// RADAR — the greatest edge (real candle-derived events)
// ----------------------------------------------------------------
export function RadarView() {
  const live = useMT5();
  const [filter, setFilter] = useState('all');
  const events = useMemo(() => {
    const evs = live.isLive ? deriveCandleEvents(live.candles.ENQ || []) : [];
    let list = evs;
    if (filter === 'iceberg') list = evs.filter((e) => e.type === 'iceberg');
    if (filter === 'stoprun') list = evs.filter((e) => e.type === 'stop-run');
    return [...list].sort((a, b) => b.time - a.time).slice(0, 30);
  }, [live.isLive, live.candles.ENQ, filter]);

  return (
    <div className="view active">
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="kicker">氷山 · Greatest Edge</span>
          <h2 style={{ fontFamily: 'var(--disp)', fontSize: 26, marginTop: 8 }}>Iceberg Radar</h2>
        </div>
        <div className="flex gap-1">
          {[{ id: 'all', label: 'All' }, { id: 'iceberg', label: 'Icebergs' }, { id: 'stoprun', label: 'Stop Runs' }].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className="ct-btn"
              style={filter === f.id ? { borderColor: 'rgba(246,201,211,.4)', color: 'var(--blush)', background: 'rgba(246,201,211,.08)' } : {}}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <ExplainerCard icon="🧊" title="What is an iceberg?" body="Big money hides most of its order — a large-range candle that absorbs and closes flat is the fingerprint. Real M5 candles are scanned for it." />
        <ExplainerCard icon="🎯" title="What is a stop run?" body="A wick that sweeps beyond the recent range extreme and closes back off it — retail stops hit, likely to reverse. Detected from real candles." />
        <ExplainerCard icon="⚖️" title="Why this is the edge" body="Both reveal a concentration of traders at a price. Wait for the event at an important area, confirm with a full ATR (+15%), then trade." />
      </div>

      <div className="panel glass">
        <div className="ph">
          <h3>Event Log <span className="jp">記録</span></h3>
          <span className="mono" style={{ color: 'var(--dim)', fontSize: 10 }}>{events.length} detected · real M5</span>
        </div>
        <div className="overflow-x-auto">
          <table className="mk-table">
            <thead>
              <tr>
                <th>TIME</th>
                <th>TYPE</th>
                <th style={{ textAlign: 'right' }}>PRICE</th>
                <th style={{ textAlign: 'right' }}>SIZE</th>
                <th>DIRECTION</th>
                <th>READ</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--dim)' }}>
                    Waiting for the market to reveal itself…
                  </td>
                </tr>
              )}
              {events.map((e, i) => {
                const isIce = e.type === 'iceberg';
                const up = isIce ? e.dir === 'bid' : e.dir === 'up';
                return (
                  <tr key={i}>
                    <td style={{ color: 'var(--dim)' }}>{new Date(e.time).toLocaleTimeString('en-US', { hour12: false })}</td>
                    <td>
                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold`} style={isIce ? { background: 'rgba(246,201,211,.15)', color: 'var(--blush)' } : { background: 'rgba(217,180,108,.15)', color: 'var(--gold)' }}>
                        {isIce ? 'ICEBERG' : 'STOP RUN'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(e.price, 2)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--mut)' }}>
                      {isIce ? `${e.displayed} shown / ${e.total} total` : `${e.size?.toFixed?.(2) ?? '—'} pts`}
                    </td>
                    <td>
                      <span style={{ color: up ? 'var(--blush)' : 'var(--down)', fontWeight: 700 }}>{up ? '▲ UP' : '▼ DOWN'}</span>
                    </td>
                    <td style={{ color: 'var(--mut)', fontSize: 10 }}>
                      {isIce ? (up ? 'Hidden bid absorption' : 'Hidden ask absorption') : up ? 'Stops swept above' : 'Stops swept below'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// STRATEGIES
// ----------------------------------------------------------------
export function StrategiesView() {
  const live = useMT5();
  const { derived } = useMarketEngine({ symbol: 'ENQ' });
  const [execResult, setExecResult] = useState(null);
  const signals = useMemo(() => {
    if (!live.isLive || !live.candles.ENQ) return [];
    const cs = live.candles.ENQ;
    const atr = computeATR(cs, 14);
    const profile = buildVolumeProfile(cs.slice(-60));
    const va = valueArea(profile, 0.7);
    const events = deriveCandleEvents(cs);
    return scanStrategies({ candles: cs, price: live.ticks.ENQ?.last ?? cs[cs.length - 1].close, atr5: atr, profile, valueArea: va, events });
  }, [live.isLive, live.candles.ENQ, live.ticks.ENQ]);

  const handleExecute = async (order) => {
    const result = await live.tvPlaceOrder(order);
    setExecResult(result);
    setTimeout(() => setExecResult(null), 5000);
  };

  return (
    <div className="view active">
      <div className="mb-4">
        <span className="kicker">戦略 · Setup Scanner</span>
        <h2 style={{ fontFamily: 'var(--disp)', fontSize: 26, marginTop: 8 }}>BARK · IZZY · PICK · SLUG</h2>
        <p style={{ color: 'var(--mut)', marginTop: 8, fontSize: 13 }}>Event at an important area, confirmed by a full 5-min ATR (+15%) — scanned on real TradingView candles.</p>
      </div>

      {live.tradeMode === 'paper' && (
        <div style={{ padding: '8px 14px', borderRadius: 10, background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.25)', marginBottom: 14 }}>
          <span className="mono" style={{ fontSize: 10, color: '#fbbf24', fontWeight: 600 }}>📝 PAPER MODE — orders are simulated, not sent externally</span>
        </div>
      )}
      {live.tradeMode === 'live' && (
        <div style={{ padding: '8px 14px', borderRadius: 10, background: 'rgba(143,224,178,.08)', border: '1px solid rgba(143,224,178,.25)', marginBottom: 14 }}>
          <span className="mono" style={{ fontSize: 10, color: 'var(--up)', fontWeight: 600 }}>🚀 LIVE MODE — orders execute live</span>
        </div>
      )}

      {execResult && (
        <div style={{ padding: '10px 14px', borderRadius: 10, background: execResult.ok ? 'rgba(143,224,178,.08)' : 'rgba(255,109,134,.08)', border: `1px solid ${execResult.ok ? 'rgba(143,224,178,.3)' : 'rgba(255,109,134,.3)'}`, marginBottom: 14 }}>
          <span className="mono" style={{ fontSize: 11, color: execResult.ok ? 'var(--up)' : 'var(--down)' }}>
            {execResult.ok ? `✓ Order placed${execResult.paper ? ' (paper)' : ''} — ${execResult.order?.action} ${execResult.order?.qty} ${execResult.order?.symbol}` : `✗ Failed: ${execResult.error || 'unknown error'}`}
          </span>
        </div>
      )}

      <StrategyCards signals={signals} onExecute={handleExecute} tradeMode={live.tradeMode} />
    </div>
  );
}

// ----------------------------------------------------------------
// AUTOTRADER / ORDERS / PERFORMANCE
// ----------------------------------------------------------------
export function AutoTraderView() {
  const live = useMT5();
  return (
    <div className="view active">
      <div className="sanctuary-page-heading">
        <span className="kicker">Command Center · 自動売買</span>
        <h2>Let the rules do the watching.</h2>
        <p>BOB's Investing Mastery 777 playbook is active. Entries use one confirmed 3m reclaim close at a red/blue wick level, read against the native timeframe stack; all account values below come from the connected TradingView account.</p>
      </div>
      <div className="sanctuary-live-banner">
        <span className={`session-dot ${live.isLive ? 'open' : ''}`} />
        <span>{live.isLive ? 'Live feed connected' : 'Waiting for TradingView feed'}</span>
        <span className="mono">{live.tradeMode === 'live' ? 'LIVE EXECUTION' : 'PAPER MODE'}</span>
      </div>
      <ScannerPanel />
    </div>
  );
}

export function OrdersView() {
  const live = useMT5();
  const orders = live.openOrders || [];
  const log = live.tradeLog || [];
  return (
    <div className="view active">
      <div className="sanctuary-page-heading">
        <span className="kicker">Promises Made · Orders</span>
        <h2>Orders, without guesswork.</h2>
        <p>Working orders and execution history are shown only when returned by the live bridge.</p>
      </div>
      <div className="sanctuary-kpi-grid">
        <div className="sanctuary-kpi glass"><span>Working orders</span><b>{orders.length}</b></div>
        <div className="sanctuary-kpi glass"><span>Recorded executions</span><b>{log.length}</b></div>
        <div className="sanctuary-kpi glass"><span>Mode</span><b className={live.tradeMode === 'live' ? 'up' : 'gold'}>{live.tradeMode === 'live' ? 'LIVE' : 'PAPER'}</b></div>
      </div>
      <div className="panel glass sanctuary-table-panel">
        <div className="ph"><h3>Working Orders <span className="jp">注文</span></h3><MT5StatusBadge compact /></div>
        {orders.length ? <div className="sanctuary-order-list">{orders.map((order, index) => <div className="sanctuary-order-row" key={order.id || index}><b>{order.symbol || '—'}</b><span>{order.action || order.side || '—'}</span><span className="mono">{order.qty || order.quantity || 1} unit</span><span className="mono">{order.status || 'working'}</span></div>)}</div> : <div className="empty-state mono">No working orders returned by TradingView.</div>}
      </div>
      <div className="panel glass sanctuary-table-panel">
        <div className="ph"><h3>Execution History <span className="jp">履歴</span></h3><span className="mono muted-label">{log.length} recorded</span></div>
        {log.length ? <div className="sanctuary-order-list">{log.slice().reverse().map((trade, index) => <div className="sanctuary-order-row" key={trade.id || index}><b>{trade.symbol || '—'}</b><span className="gold">{String(trade.strategyId || trade.strategy || 'SNIPER').toUpperCase()}</span><span>{trade.dir || trade.action || '—'}</span><span className="mono">{trade.orderStatus || (trade.tradeMode === 'paper' ? 'filled' : 'working')}</span></div>)}</div> : <div className="empty-state mono">No executions recorded yet.</div>}
      </div>
    </div>
  );
}

export function PerformanceView() {
  const live = useMT5();
  const [journal, setJournal] = useState({ summary: {}, days: [] });
  useEffect(() => {
    let active = true;
    fetch('http://127.0.0.1:18814/journal').then((response) => response.json()).then((data) => { if (active && data) setJournal(data); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const summary = journal.summary || {};
  const pnl = Number(summary.total_pnl || 0);
  const winDays = Number(summary.win_days || 0);
  const lossDays = Number(summary.loss_days || 0);
  const totalDays = winDays + lossDays;
  return (
    <div className="view active">
      <div className="sanctuary-page-heading"><span className="kicker">The Path Walked · Performance</span><h2>Measure the path, not the noise.</h2><p>Performance is derived from the sidecar journal and current connected account.</p></div>
      <div className="sanctuary-kpi-grid sanctuary-kpi-grid-wide">
        <div className={`sanctuary-kpi glass ${pnl < 0 ? 'negative' : ''}`}><span>Recorded P&L</span><b>{pnl >= 0 ? '+$' : '-$'}{Math.abs(pnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b></div>
        <div className="sanctuary-kpi glass"><span>Win rate</span><b>{totalDays ? Math.round((winDays / totalDays) * 100) : 0}%</b></div>
        <div className="sanctuary-kpi glass"><span>Winning days</span><b className="up">{winDays}</b></div>
        <div className="sanctuary-kpi glass"><span>Losing days</span><b className="down">{lossDays}</b></div>
        <div className="sanctuary-kpi glass"><span>Account equity</span><b className="gold">{live.account?.equity ? `$${Number(live.account.equity).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}</b></div>
      </div>
      <div className="panel glass sanctuary-performance-panel"><div className="ph"><h3>Daily Record <span className="jp">日次記録</span></h3><span className="mono muted-label">{journal.days?.length || 0} days retained</span></div>{journal.days?.length ? <div className="sanctuary-performance-list">{journal.days.slice().reverse().map((day) => <div className="sanctuary-performance-row" key={day.date}><span className="mono">{day.date}</span><span className={`mono ${day.pnl >= 0 ? 'up' : 'down'}`}>{day.pnl >= 0 ? '+$' : '-$'}{Math.abs(Number(day.pnl || 0)).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span></div>)}</div> : <div className="empty-state mono">No daily performance records returned yet.</div>}</div>
    </div>
  );
}

// ----------------------------------------------------------------
// RISK
// ----------------------------------------------------------------
export function RiskView() {
  const live = useMT5();
  const balance = live.account?.balance ?? 100000;
  const dayPL = Number(live.account?.profit || 0) + (live.positions || []).reduce((s, p) => s + (p.profit || 0), 0);
  return (
    <div className="view active">
      <div className="mb-4">
        <span className="kicker">守り · Risk Desk</span>
        <h2 style={{ fontFamily: 'var(--disp)', fontSize: 26, marginTop: 8 }}>Protect the downside first.</h2>
      </div>
      <RiskDesk dayPL={dayPL} accountBalance={balance} />
    </div>
  );
}

// ----------------------------------------------------------------
// POSITIONS — real TradingView positions
// ----------------------------------------------------------------
export function PositionsView() {
  const live = useMT5();
  const positions = live.positions || [];
  const acct = live.account || {};
  const totPnl = positions.reduce((s, p) => s + (p.profit || 0), 0);
  const marginUsed = acct.margin ?? 0;
  const equity = acct.equity ?? 0;
  const tradeLog = live.tradeLog || [];

  return (
    <div className="view active">
      <div className="pv-stats">
        <div className="pv-stat glass"><div className="l">Balance</div><div className="v">${fmt(acct.balance ?? 0, 0)}</div></div>
        <div className="pv-stat glass"><div className="l">Equity</div><div className="v">${fmt(equity, 0)}</div></div>
        <div className="pv-stat glass"><div className="l">Margin used</div><div className="v">${fmt(marginUsed, 0)}</div></div>
        <div className="pv-stat glass"><div className="l">Open P/L</div><div className={`v ${totPnl >= 0 ? 'up' : 'down'}`}>{totPnl >= 0 ? '+' : ''}${fmt(totPnl, 0)}</div></div>
      </div>

      <div className="panel glass">
        <div className="ph">
          <h3>Position Detail <span className="jp">明細</span></h3>
          <span className="pos-tot">real TradingView · <b>{positions.length}</b> open</span>
        </div>
        {positions.length ? (
          <table className="pv-table">
            <thead>
              <tr>
                <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>SL</th><th>TP</th><th>Profit</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p, i) => {
                const sym = p.symbol.replace('@', '');
                const isLong = p.type === 0;
                return (
                  <tr key={i}>
                    <td><b>{sym}</b></td>
                    <td style={{ color: isLong ? 'var(--up)' : 'var(--down)' }}>{isLong ? 'LONG' : 'SHORT'}</td>
                    <td>{fmt(p.volume, 2)}</td>
                    <td>{fmt(p.price_open, DECIMALS[sym] ?? 2)}</td>
                    <td>{fmt(p.sl, DECIMALS[sym] ?? 2)}</td>
                    <td>{fmt(p.tp, DECIMALS[sym] ?? 2)}</td>
                    <td style={{ color: p.profit >= 0 ? 'var(--up)' : 'var(--down)' }}>{p.profit >= 0 ? '+' : ''}${fmt(p.profit, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="mono" style={{ color: 'var(--dim)', padding: '18px 0' }}>
            No open positions on the account.
          </div>
        )}
      </div>

      {/* Trade Log — executed orders from strategies */}
      <div className="panel glass" style={{ marginTop: 14 }}>
        <div className="ph">
          <h3>Trade Log <span className="jp">取引記録</span></h3>
          <span className="mono" style={{ color: 'var(--dim)', fontSize: 10 }}><b>{tradeLog.length}</b> executed · <b>{live.openOrders?.length || 0}</b> open</span>
        </div>
        {tradeLog.length ? (
          <table className="pv-table">
            <thead>
              <tr>
                <th>TIME</th><th>STRATEGY</th><th>SYMBOL</th><th>SIDE</th><th>QTY</th><th>ENTRY</th><th>SL</th><th>TP</th><th>R:R</th><th>STATUS</th><th>MODE</th>
              </tr>
            </thead>
            <tbody>
              {tradeLog.map((t, i) => {
                const isPaper = t.tradeMode === 'paper';
                const status = t.orderStatus || (isPaper ? 'filled' : 'working');
                const statusStyle = {
                  working: { bg: 'rgba(251,191,36,.12)', color: '#fbbf24', border: 'rgba(251,191,36,.3)', pulse: true, label: '● WORKING' },
                  filled: { bg: 'rgba(143,224,178,.12)', color: '#8fe0b2', border: 'rgba(143,224,178,.3)', pulse: false, label: '✓ FILLED' },
                  partiallyfilled: { bg: 'rgba(217,180,108,.12)', color: '#d9b46c', border: 'rgba(217,180,108,.3)', pulse: true, label: '◐ PARTIAL' },
                  cancelled: { bg: 'rgba(255,109,134,.08)', color: '#ff6d86', border: 'rgba(255,109,134,.25)', pulse: false, label: '✕ CANCELLED' },
                  rejected: { bg: 'rgba(226,69,95,.10)', color: '#e2455f', border: 'rgba(226,69,95,.3)', pulse: false, label: '⚠ REJECTED' },
                };
                const ss = statusStyle[status] || statusStyle.working;
                return (
                  <tr key={i}>
                    <td style={{ color: 'var(--dim)', fontSize: 10 }}>{new Date(t.time).toLocaleTimeString('en-US', { hour12: false })}</td>
                    <td><span style={{ color: 'var(--blush)', fontWeight: 700 }}>{(t.strategyId || '?').toUpperCase()}</span></td>
                    <td><b>{t.symbol}</b></td>
                    <td style={{ color: t.dir === 'long' ? 'var(--up)' : 'var(--down)' }}>{t.dir === 'long' ? 'LONG' : 'SHORT'}</td>
                    <td>{t.qty || 1}</td>
                    <td>{fmt(t.entry, DECIMALS[t.symbol] ?? 2)}</td>
                    <td style={{ color: 'var(--down)' }}>{fmt(t.stop, DECIMALS[t.symbol] ?? 2)}</td>
                    <td style={{ color: 'var(--up)' }}>{fmt(t.target, DECIMALS[t.symbol] ?? 2)}</td>
                    <td style={{ color: 'var(--gold)' }}>{t.rMultiplier || 2}R</td>
                    <td>
                      <span style={{
                        fontSize: 9, padding: '2px 7px', borderRadius: 10,
                        background: ss.bg, color: ss.color,
                        border: `1px solid ${ss.border}`,
                        fontWeight: 600, letterSpacing: '.04em',
                        animation: ss.pulse ? 'statusPulse 2s ease-in-out infinite' : 'none',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}>
                        {ss.label}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 10, background: isPaper ? 'rgba(251,191,36,.08)' : 'rgba(143,224,178,.08)', color: isPaper ? '#fbbf24' : 'var(--up)', border: `1px solid ${isPaper ? 'rgba(251,191,36,.2)' : 'rgba(143,224,178,.2)'}` }}>
                        {isPaper ? 'PAPER' : 'LIVE'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="mono" style={{ color: 'var(--dim)', padding: '18px 0' }}>
            No trades executed yet — fire a strategy signal to begin.
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// JOURNAL — daily P&L (profitable vs non-profitable days) + notes
// ----------------------------------------------------------------
export function JournalView() {
  const { snap, dayPL } = useMarketEngine({ symbol: 'ENQ' });
  const [entries, setEntries] = useState([]);
  const [newEntry, setNewEntry] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newStrategy, setNewStrategy] = useState('SNIPER');
  const [journal, setJournal] = useState({ days: [], summary: {} });
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Real daily P&L from the sidecar (persisted daily_journal.json)
  useEffect(() => {
    const poll = () => {
      fetch('http://127.0.0.1:18814/journal')
        .then((r) => r.json())
        .then((d) => { if (d && Array.isArray(d.days)) setJournal(d); })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const loadedRef = useRef(false);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.loadJournal) return;
    api.loadJournal().then((saved) => {
      if (Array.isArray(saved) && saved.length) setEntries(saved);
      loadedRef.current = true;
    });
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.saveJournal || !loadedRef.current) return;
    const t = setTimeout(() => api.saveJournal(entries), 400);
    return () => clearTimeout(t);
  }, [entries]);

  const addEntry = () => {
    if (!newEntry.trim() || !newTitle.trim()) return;
    setEntries((prev) => [
      {
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        title: newTitle,
        notes: newEntry,
        outcome: dayPL >= 0 ? `+$${Math.abs(dayPL).toFixed(0)}` : `-$${Math.abs(dayPL).toFixed(0)}`,
        strategy: newStrategy,
      },
      ...prev,
    ]);
    setNewEntry('');
    setNewTitle('');
  };

  const days = journal.days || [];
  const summary = journal.summary || {};
  const winDays = summary.win_days ?? 0;
  const lossDays = summary.loss_days ?? 0;
  const totalPnl = summary.total_pnl ?? 0;
  const today = summary.today || null;
  const utcNow = new Date();
  const todayKey = `${utcNow.getUTCFullYear()}-${String(utcNow.getUTCMonth() + 1).padStart(2, '0')}-${String(utcNow.getUTCDate()).padStart(2, '0')}`;
  const monthKey = `${calendarMonth.getUTCFullYear()}-${String(calendarMonth.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthDays = days.filter((d) => d.date?.startsWith(monthKey));
  const monthWins = monthDays.filter((d) => d.pnl > 0).length;
  const monthLosses = monthDays.filter((d) => d.pnl < 0).length;
  const monthPnl = monthDays.reduce((sum, d) => sum + (d.pnl || 0), 0);
  const monthWinRate = monthWins + monthLosses ? Math.round((monthWins / (monthWins + monthLosses)) * 100) : 0;
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const firstWeekday = new Date(Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth(), 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(calendarMonth.getUTCFullYear(), calendarMonth.getUTCMonth() + 1, 0)).getUTCDate();
  const calendarCellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const calendarCells = Array.from({ length: calendarCellCount }, (_, index) => {
    const dayNumber = index - firstWeekday + 1;
    if (dayNumber < 1 || dayNumber > daysInMonth) return null;
    const date = `${monthKey}-${String(dayNumber).padStart(2, '0')}`;
    return { date, dayNumber, record: dayMap.get(date) || null };
  });
  const selectedRecord = dayMap.get(selectedDate) || null;
  const moveMonth = (delta) => {
    setCalendarMonth((current) => new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + delta, 1)));
  };
  return (
    <div className="view active">
      <div className="j-head">
        <div>
          <span className="kicker">日誌 · Trade Journal</span>
          <h2 style={{ fontFamily: 'var(--disp)', fontSize: 26, marginTop: 8 }}>Profitable days, and the rest.</h2>
        </div>
        <button className="btn btn-primary" onClick={() => document.getElementById('journal-form')?.scrollIntoView({ behavior: 'smooth' })}>
          + New Entry
        </button>
      </div>

      {/* Daily P&L summary — real account results */}
      <div className="j-days glass">
        <div className="j-days-head">
          <span className="kicker">Account Results · 日次損益</span>
          <span className="mono" style={{ color: 'var(--dim)', fontSize: 10 }}>real TradingView realized P&L</span>
        </div>
        <div className="j-stats">
          <div className={`j-stat ${totalPnl >= 0 ? 'up' : 'down'}`}>
            <div className="l">Total P&L</div>
            <div className="v">{totalPnl >= 0 ? '+$' : '-$'}{fmt(Math.abs(totalPnl), 0)}</div>
          </div>
          <div className="j-stat up">
            <div className="l">Green days</div>
            <div className="v">{winDays}<small> / {winDays + lossDays || '—'}</small></div>
          </div>
          <div className="j-stat down">
            <div className="l">Red days</div>
            <div className="v">{lossDays}<small> / {winDays + lossDays || '—'}</small></div>
          </div>
          <div className={`j-stat ${today ? (today.pnl >= 0 ? 'up' : 'down') : ''}`}>
            <div className="l">Today</div>
            <div className="v">{today ? `${today.pnl >= 0 ? '+$' : '-$'}${fmt(Math.abs(today.pnl), 0)}` : '—'}</div>
          </div>
        </div>

        {/* Real month calendar — every day is visible, including no-trade days */}
        <div className="j-calendar-wrap">
          <div className="j-calendar-toolbar">
            <div>
              <span className="kicker">Trading Calendar · 取引カレンダー</span>
              <h3 className="j-calendar-title">{calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3>
            </div>
            <div className="j-calendar-actions">
              <button className="j-calendar-nav" onClick={() => moveMonth(-1)} aria-label="Previous month">‹</button>
              <button className="j-today-btn" onClick={() => { const now = new Date(); setCalendarMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))); setSelectedDate(todayKey); }}>Today</button>
              <button className="j-calendar-nav" onClick={() => moveMonth(1)} aria-label="Next month">›</button>
            </div>
          </div>
          <div className="j-month-stats">
            <span><b>{monthWinRate}%</b> win rate</span>
            <span className="up"><b>{monthWins}</b> winning</span>
            <span className="down"><b>{monthLosses}</b> losing</span>
            <span className={monthPnl >= 0 ? 'up' : 'down'}><b>{monthPnl >= 0 ? '+$' : '-$'}{fmt(Math.abs(monthPnl), 0)}</b> month P&L</span>
          </div>
          <div className="j-calendar-weekdays">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="j-calendar-grid">
            {calendarCells.map((cell, index) => {
              if (!cell) return <div className="j-calendar-cell empty" key={`empty-${index}`} aria-hidden="true" />;
              const pnl = cell.record?.pnl ?? null;
              const status = pnl == null ? 'none' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat';
              const isToday = cell.date === todayKey;
              const isSelected = cell.date === selectedDate;
              return (
                <button
                  key={cell.date}
                  className={`j-calendar-cell ${status} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelectedDate(cell.date)}
                  aria-label={`${cell.date}${pnl == null ? ', no record' : `, ${pnl >= 0 ? 'profit' : 'loss'} ${Math.abs(pnl).toFixed(2)}`}`}
                >
                  <span className="j-cell-day">{cell.dayNumber}</span>
                  {pnl != null ? <span className="j-cell-pnl">{pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span> : <span className="j-cell-dot" />}
                  {cell.record && <span className="j-cell-caption">{pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'FLAT'}</span>}
                </button>
              );
            })}
          </div>
          <div className="j-calendar-legend">
            <span><i className="win" /> Winning day</span>
            <span><i className="loss" /> Losing day</span>
            <span><i className="flat" /> Flat day</span>
            <span><i className="none" /> No record</span>
          </div>
        </div>

        <div className="j-selected-day">
          <div>
            <span className="kicker">Selected Day</span>
            <h3>{new Date(`${selectedDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>
          </div>
          {selectedRecord ? (
            <div className={`j-selected-result ${selectedRecord.pnl >= 0 ? 'up' : 'down'}`}>
              <span>{selectedRecord.pnl > 0 ? 'WINNING DAY' : selectedRecord.pnl < 0 ? 'LOSING DAY' : 'FLAT DAY'}</span>
              <b>{selectedRecord.pnl >= 0 ? '+$' : '-$'}{fmt(Math.abs(selectedRecord.pnl), 2)}</b>
              <small>Realized P&L · equity {selectedRecord.equity ? `$${fmt(selectedRecord.equity, 0)}` : '—'}</small>
            </div>
          ) : (
            <div className="j-selected-empty mono">No realized P&L record for this day.</div>
          )}
        </div>
      </div>

      {/* Manual notes */}
      <div className="panel glass" id="journal-form" style={{ marginTop: 16 }}>
        <div className="text-[10px] font-semibold mb-2" style={{ color: 'var(--blush)' }}>NEW JOURNAL ENTRY</div>
        <div className="grid grid-cols-[1fr_auto] gap-2 mb-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Trade title (e.g., ENQ BARK — stop run at VA low)"
            className="px-3 py-2 rounded-lg"
            style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, outline: 'none' }}
          />
          <select value={newStrategy} onChange={(e) => setNewStrategy(e.target.value)} style={{ fontSize: 12 }}>
            {['SNIPER', 'BARK', 'IZZY', 'PICK', 'SLUG'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <textarea
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
          placeholder="What happened, what did you do, what did you learn? Be honest — the journal is where you get better."
          rows={3}
          className="w-full px-3 py-2 rounded-lg mb-2"
          style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', color: 'var(--ink)', fontSize: 12, outline: 'none', resize: 'none' }}
        />
        <button className="btn btn-primary" onClick={addEntry}>+ Log Entry</button>
      </div>

      <div className="j-list" style={{ marginTop: 16 }}>
        {entries.length === 0 && (
          <div className="mono" style={{ color: 'var(--dim)', fontSize: 12 }}>No entries yet — plant your first petal.</div>
        )}
        {entries.map((e, i) => (
          <div key={i} className="j-card glass" data-bloom>
            <div className="jc-top">
              <span className="d">{e.date}</span>
              <span className="mono" style={{ color: e.outcome.startsWith('+') ? 'var(--up)' : 'var(--down)', fontSize: 11 }}>{e.outcome.startsWith('+') ? 'WIN' : 'LOSS'}</span>
            </div>
            <div className="jc-inst">
              {e.strategy} <span className={`side ${e.outcome.startsWith('+') ? 'long' : 'short'}`}>{e.strategy}</span>
            </div>
            <div className={`jc-pnl ${e.outcome.startsWith('+') ? 'up' : 'down'}`}>{e.outcome}</div>
            <div className="jc-note">{e.notes}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// SETTINGS
// ----------------------------------------------------------------
export function SettingsView() {
  const live = useMT5();
  const isLiveMode = live.tradeMode === 'live';

  return (
    <div className="view active">
      <div className="mb-4">
        <span className="kicker">設定 · Settings</span>
        <h2 style={{ fontFamily: 'var(--disp)', fontSize: 26, marginTop: 8 }}>Tune the garden.</h2>
      </div>
      <div className="set-grid">
        <TradingViewCard />

        {/* Trading Mode Card */}
        <div className="set-card glass">
          <h3>Trading Mode <span className="jp">取引モード</span></h3>
          <p>Switch between paper trading (simulated) and live execution via TradingView.</p>
          <div className="set-row">
            <div className="lab"><b>Mode</b><span>{isLiveMode ? 'Live — orders sent to TradingView' : 'Paper — orders simulated locally'}</span></div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => live.setTradeMode('paper')}
                className="btn"
                style={{ padding: '6px 14px', fontSize: 11, borderRadius: 8, fontWeight: 600, border: `1px solid ${!isLiveMode ? 'rgba(251,191,36,.4)' : 'var(--line)'}`, background: !isLiveMode ? 'rgba(251,191,36,.1)' : 'transparent', color: !isLiveMode ? '#fbbf24' : 'var(--mut)' }}
              >
                📝 Paper
              </button>
              <button
                onClick={() => {
                  if (!live.connected) {
                    alert('Start TradingView Desktop with --remote-debugging-port=9222 to see live data.');
                    return;
                  }
                  live.setTradeMode('live');
                }}
                className="btn"
                style={{ padding: '6px 14px', fontSize: 11, borderRadius: 8, fontWeight: 600, border: `1px solid ${isLiveMode ? 'rgba(143,224,178,.4)' : 'var(--line)'}`, background: isLiveMode ? 'rgba(143,224,178,.1)' : 'transparent', color: isLiveMode ? 'var(--up)' : 'var(--mut)' }}
              >
                🚀 Live
              </button>
            </div>
          </div>
        </div>

        {/* Risk Management Card */}
        <div className="set-card glass">
          <h3>Risk Management <span className="jp">リスク管理</span></h3>
          <p>Fixed-risk position sizing from the video — risk a fixed dollar amount per trade.</p>
          <div className="set-row">
            <div className="lab"><b>Risk per trade ($)</b><span>Size = risk ÷ (stop × point value)</span></div>
            <input
              type="number"
              value={live.risk?.riskPerTrade ?? 500}
              onChange={(e) => live.setRisk({ riskPerTrade: Number(e.target.value) || 500 })}
              style={{ width: 80, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--mono)', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--ink)', outline: 'none', textAlign: 'right' }}
            />
          </div>
          <div className="set-row">
            <div className="lab"><b>Max open trades</b><span>Concurrent positions cap</span></div>
            <input
              type="number"
              value={live.risk?.maxOpenTrades ?? 3}
              min={1}
              max={10}
              onChange={(e) => live.setRisk({ maxOpenTrades: Number(e.target.value) || 3 })}
              style={{ width: 50, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--mono)', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--ink)', outline: 'none', textAlign: 'right' }}
            />
          </div>
          <div className="set-row">
            <div className="lab"><b>Default R:R</b><span>Reward : Risk ratio</span></div>
            <input
              type="number"
              value={live.risk?.defaultR ?? 2}
              min={1}
              max={5}
              step={0.5}
              onChange={(e) => live.setRisk({ defaultR: Number(e.target.value) || 2 })}
              style={{ width: 50, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--mono)', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--ink)', outline: 'none', textAlign: 'right' }}
            />
          </div>
          <div className="set-row">
            <div className="lab"><b>Daily loss limit (%)</b><span>Kill switch at % of balance</span></div>
            <input
              type="number"
              value={Math.round((live.risk?.maxDailyLoss ?? 0.07) * 100)}
              min={1}
              max={20}
              onChange={(e) => live.setRisk({ maxDailyLoss: (Number(e.target.value) || 7) / 100 })}
              style={{ width: 50, padding: '5px 8px', fontSize: 12, fontFamily: 'var(--mono)', background: 'rgba(255,255,255,.04)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--ink)', outline: 'none', textAlign: 'right' }}
            />
          </div>
        </div>

        <div className="set-card glass">
          <h3>Data <span className="jp">データ</span></h3>
          <p>Dwella runs only on real TradingView data — no simulation.</p>
          <div className="set-row">
            <div className="lab"><b>TradingView sidecar</b><span>127.0.0.1:18814 · data + execution bridge</span></div>
            <MT5StatusBadge compact />
          </div>
          <div className="set-row">
            <div className="lab"><b>Symbols</b><span>ENQ · MES · GCE · YM · ES · RTY · CL · SI · NQ (real feed)</span></div>
            <span className="mono" style={{ color: 'var(--gold)', fontSize: 11 }}>LIVE</span>
          </div>
        </div>
        <div className="set-card glass">
          <h3>Discipline <span className="jp">規律</span></h3>
          <p>The video's non-negotiable rules, armed by default.</p>
          <div className="set-row">
            <div className="lab"><b>Hard daily-loss kill switch</b><span>Lock at the configured limit</span></div>
            <div className="toggle on" />
          </div>
          <div className="set-row">
            <div className="lab"><b>Turn off P&L</b><span>Stop watching houses go by</span></div>
            <div className="toggle on" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// Shared UI helpers
// ----------------------------------------------------------------
function ExplainerCard({ icon, title, body }) {
  return (
    <div className="tile glass" data-bloom style={{ padding: 18 }}>
      <div style={{ fontSize: 20, marginBottom: 8 }}>{icon}</div>
      <h3 style={{ fontSize: 13, marginBottom: 6 }}>{title}</h3>
      <p style={{ fontSize: 11, color: 'var(--mut)', lineHeight: 1.5 }}>{body}</p>
    </div>
  );
}
