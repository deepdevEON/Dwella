// RiskDesk.jsx
// The risk desk — enforces the video's #1 discipline rules:
//   - daily loss limit (~7%), hard-stop the account at the broker level
//   - "turn off your P&L" toggle (stop staring at the money, trade the system)
//   - position size always from the risk rule
// Sakura design system; dayPL + balance come from the REAL TradingView.

import React, { useState } from 'react';
import { dailyLossLimit, checkDailyLimit } from '../lib/strategies.js';

export default function RiskDesk({ dayPL, accountBalance = 50000 }) {
  const [showPL, setShowPL] = useState(true);
  const [limitPct, setLimitPct] = useState(7);
  const limit = dailyLossLimit(accountBalance, limitPct / 100);
  const status = checkDailyLimit({ accountBalance, dayPL, pct: limitPct / 100 });
  const remainingPct = (Math.max(0, status.remaining) / accountBalance) * 100;

  const fmtUsd = (n) =>
    `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* P&L toggle hero card */}
      <div className="panel glass" style={{ position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, var(--blush), transparent)', opacity: .6 }} />
        <div className="ph" style={{ alignItems: 'flex-start' }}>
          <div>
            <h3>Today's P/L <span className="jp">損益</span></h3>
            <p style={{ fontSize: 11, color: 'var(--mut)', maxWidth: 520, lineHeight: 1.6, marginTop: 6 }}>
              <strong style={{ color: 'var(--blush)' }}>"The minute I turned off my P&L, that's when I took off as a trader."</strong>{' '}
              — Scott Pulcini. Stop staring at the money in real terms; trade the system, let the money come.
            </p>
          </div>
          <button
            onClick={() => setShowPL((v) => !v)}
            className="mono"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 10, fontSize: 10.5, fontWeight: 700, transition: '.2s',
              color: showPL ? 'var(--blush)' : 'var(--mut)',
              background: showPL ? 'rgba(246,201,211,.1)' : 'rgba(255,255,255,.03)',
              border: `1px solid ${showPL ? 'rgba(246,201,211,.35)' : 'var(--line2)'}`,
            }}
          >
            {showPL ? '● Hide P/L' : '○ Show P/L'}
          </button>
        </div>

        <div
          className="mono"
          style={{
            fontSize: 38, fontWeight: 700, letterSpacing: '-.01em', margin: '4px 0 14px', transition: '.25s',
            color: dayPL >= 0 ? 'var(--blush)' : 'var(--down)',
            textShadow: dayPL >= 0 ? '0 0 24px rgba(246,201,211,.35)' : 'none',
            ...(showPL ? {} : { color: 'transparent', textShadow: '0 0 14px rgba(255,255,255,.25)', userSelect: 'none' }),
          }}
        >
          {showPL ? (dayPL >= 0 ? '+' : '') + fmtUsd(dayPL) : '••••••••'}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div className="hc-stone" style={{ padding: 12 }}>
            <div className="mono" style={{ fontSize: 9, letterSpacing: '.1em', color: 'var(--dim)', marginBottom: 6 }}>DAILY LOSS LIMIT ({limitPct}%)</div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>-{fmtUsd(limit)}</div>
          </div>
          <div className="hc-stone" style={{ padding: 12 }}>
            <div className="mono" style={{ fontSize: 9, letterSpacing: '.1em', color: 'var(--dim)', marginBottom: 6 }}>REMAINING BUFFER</div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: remainingPct > 2 ? 'var(--up)' : 'var(--gold)' }}>
              {showPL ? fmtUsd(status.remaining) : '••••'} <span style={{ fontSize: 9, color: 'var(--dim)' }}>({remainingPct.toFixed(1)}%)</span>
            </div>
          </div>
          <div className="hc-stone" style={{ padding: 12 }}>
            <div className="mono" style={{ fontSize: 9, letterSpacing: '.1em', color: 'var(--dim)', marginBottom: 6 }}>RISK PER TRADE</div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--blush)' }}>{fmtUsd(accountBalance * 0.01)}</div>
          </div>
        </div>

        {/* Hard-stop breach banner */}
        {status.breached && (
          <div
            style={{
              marginTop: 12, padding: 12, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10,
              background: 'rgba(255,109,134,.12)', border: '1px solid rgba(255,109,134,.4)',
            }}
          >
            <span style={{ fontSize: 16 }}>⛔</span>
            <div style={{ fontSize: 12, color: 'var(--sakura)', fontWeight: 600 }}>
              Daily loss limit breached — trading halted for today. There's always another day.
            </div>
          </div>
        )}
      </div>

      {/* Discipline rules */}
      <div className="panel glass">
        <div className="ph">
          <h3>The Rules That Protect You <span className="jp">規律</span></h3>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { n: '01', t: 'Hard daily loss limit', d: 'Risk no more than 6-8% of the account in a day. Set it at the broker level so you cannot overtrade in the heat of the moment — "in the heat of the moment, you are not going to make the right decision."' },
            { n: '02', t: 'Fixed risk per trade', d: 'Every trade risks the same dollar amount, computed from ATR. Sizing comes from the zone tool, never from feelings.' },
            { n: '03', t: 'Trade like an algo', d: "Entry, exit, size are fixed before you click. You don't trade what you feel — if you have the edge, you put it on." },
            { n: '04', t: 'Trail to events, not break-even', d: 'Move your stop to the next stop/iceberg event in the market. Break-even is in your mind; an event is something that actually happened.' },
            { n: '05', t: 'Get stopped by the firm', d: 'Choose a broker/account that physically stops you at the limit. The two $700k days came from blowing through a $100k limit.' },
          ].map((r) => (
            <div key={r.n} style={{ display: 'flex', gap: 14 }}>
              <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: 'var(--blush)', paddingTop: 2 }}>{r.n}</span>
              <div style={{ borderLeft: '1px solid var(--line2)', paddingLeft: 14 }}>
                <h4 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{r.t}</h4>
                <p style={{ fontSize: 11, color: 'var(--mut)', lineHeight: 1.6, marginTop: 3 }}>{r.d}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Limit control */}
      <div className="panel glass">
        <div className="ph">
          <h3>Daily Limit % <span className="jp">限度</span></h3>
          <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--blush)' }}>{limitPct}%</span>
        </div>
        <input
          type="range"
          min={3}
          max={10}
          value={limitPct}
          onChange={(e) => setLimitPct(Number(e.target.value))}
          style={{ width: '100%', marginTop: 4 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 8 }}>
          <span>3% — Conservative</span>
          <span>7% — Standard</span>
          <span>10% — Aggressive</span>
        </div>
      </div>
    </div>
  );
}
