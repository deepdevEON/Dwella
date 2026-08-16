// LiveQuoteStrip.jsx — real-time TradingView quotes for the configured futures pairs.
// Shows last / bid / ask / spread / session change from the live sidecar.
// Dimmed with em-dashes when the TradingView feed is offline (never simulated).

import React from 'react';
import { useMT5 } from '../hooks/useMT5Live.jsx';

const SYMBOLS = ['ENQ', 'MES', 'GCE', 'YM', 'ES', 'RTY', 'CL', 'SI', 'NQ'];
const NAMES = { ENQ: 'Micro Nasdaq', MES: 'Micro S&P', GCE: 'Micro Gold', YM: 'Dow Jones', ES: 'E-mini S&P', RTY: 'Russell 2000', CL: 'Crude Oil', SI: 'Silver', NQ: 'E-mini Nasdaq' };
const DECIMALS = { ENQ: 2, MES: 2, GCE: 1, YM: 0, ES: 2, RTY: 1, CL: 2, SI: 3, NQ: 2 };
const JPS = { ENQ: 'マイクロナス', MES: 'マイクロS&P', GCE: 'マイクロ金', YM: 'ダウ', ES: 'S&P', RTY: 'ラッセル', CL: '原油', SI: '銀', NQ: 'ナスダック' };

const fmt = (n, dec) =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

export default function LiveQuoteStrip() {
  const { isLive, ticks, candles } = useMT5();

  return (
    <div className="live-quote-grid">
      {SYMBOLS.map((sym) => {
        const t = ticks[sym] || {};
        const cs = candles[sym] || [];
        const dec = DECIMALS[sym];
        const last = t.last ?? t.bid ?? null;
        const prevClose = cs.length >= 2 ? cs[cs.length - 2].close : null;
        const chg = last != null && prevClose ? ((last - prevClose) / prevClose) * 100 : null;
        const spread = t.bid != null && t.ask != null ? t.ask - t.bid : null;
        const up = chg != null && chg >= 0;
        return (
          <div
            key={sym}
            className={`glass px-3.5 py-2.5 flex items-center justify-between transition-all ${isLive ? '' : 'opacity-50'}`}
          >
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold" style={{ color: 'var(--ink)' }}>{sym}</span>
                <span className="mono" style={{ fontSize: 8, color: 'var(--dim)' }}>{JPS[sym]}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: isLive ? 'var(--ink)' : 'var(--dim)' }}>
                  {fmt(last, dec)}
                </span>
                {chg != null && (
                  <span className="mono" style={{ fontSize: 9, fontWeight: 600, color: up ? 'var(--up)' : 'var(--down)' }}>
                    {up ? '+' : ''}
                    {chg.toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
            <div className="text-right mono">
              <div style={{ fontSize: 9, color: 'var(--dim)' }}>
                {isLive ? (
                  <>
                    <span style={{ color: 'var(--up)' }}>B {fmt(t.bid, dec)}</span>
                    <span style={{ margin: '0 4px', color: 'var(--dim)' }}>·</span>
                    <span style={{ color: 'var(--down)' }}>A {fmt(t.ask, dec)}</span>
                  </>
                ) : (
                  'B — · A —'
                )}
              </div>
              <div style={{ fontSize: 8, color: 'var(--dim)', marginTop: 2 }}>
                {isLive && spread != null ? `spread ${fmt(spread, dec)}` : 'awaiting TradingView feed'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
