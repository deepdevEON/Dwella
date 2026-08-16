// StrategyCards.jsx
// The four named setups (BARK / IZZY / PICK / SLUG) with live scanner status.
// Dwella design system — real TradingView data only.

import React, { useState } from 'react';
import { STRATEGIES } from '../lib/strategies.js';
import { LIVE_ENTRY_UNITS } from '../lib/execution.js';

export default function StrategyCards({ signals, onExecute, tradeMode }) {
  const [executing, setExecuting] = useState(null);
  const signalMap = {};
  for (const s of signals || []) {
    signalMap[s.strategyId] = signalMap[s.strategyId] || [];
    if (signalMap[s.strategyId].length < 2) signalMap[s.strategyId].push(s);
  }

  return (
    <div className="grid grid-cols-2 gap-4" style={{ gap: 14 }}>
      {STRATEGIES.map((st) => {
        const sigs = signalMap[st.id] || [];
        const active = sigs[0];
        return (
          <div key={st.id} className="stone" data-bloom style={{ display: 'flex', flexDirection: 'column', minHeight: 210 }}>
            <div className="s-top">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  className="mono"
                  style={{
                    width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center',
                    fontSize: 10, fontWeight: 700, color: 'var(--blush)',
                    background: 'rgba(246,201,211,.1)', border: '1px solid rgba(246,201,211,.3)',
                  }}
                >
                  {st.id.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <h3 style={{ fontFamily: 'var(--disp)', fontSize: 15, fontWeight: 600 }}>{st.name}</h3>
                  <span className="mono" style={{ fontSize: 9, color: 'var(--dim)' }}>{st.full}</span>
                </div>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 9, padding: '3px 8px', borderRadius: 20, letterSpacing: '.06em',
                  color: active ? 'var(--blush)' : 'var(--dim)',
                  border: `1px solid ${active ? 'rgba(246,201,211,.4)' : 'var(--line)'}`,
                  background: active ? 'rgba(246,201,211,.1)' : 'transparent',
                }}
              >
                {active ? '● LIVE SETUP' : '◦ SCANNING'}
              </span>
            </div>

            <p style={{ fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.55, margin: '12px 0 14px', flex: 1 }}>
              {st.description}
            </p>

            {active ? (
              <div
                className="glass"
                style={{ padding: 12, border: '1px solid rgba(246,201,211,.18)', background: 'rgba(246,201,211,.045)' }}
              >
                <div className="s-top" style={{ marginBottom: 8 }}>
                  <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: active.dir === 'long' ? 'var(--up)' : 'var(--down)' }}>
                    {active.dir === 'long' ? '▲ LONG SETUP' : '▼ SHORT SETUP'}
                  </span>
                  <span className="mono" style={{ fontSize: 9, color: 'var(--dim)' }}>
                    {active.eventType === 'iceberg' ? 'Iceberg event' : active.eventType === 'pullback' ? 'EMA pullback' : 'Stop-run event'}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {[
                    { l: 'AREA', v: active.area, c: 'var(--ink)' },
                    { l: 'ENTRY', v: active.entry?.toLocaleString('en-US', { maximumFractionDigits: 2 }), c: 'var(--ink)' },
                    { l: 'STOP', v: active.stop?.toLocaleString('en-US', { maximumFractionDigits: 2 }), c: 'var(--down)' },
                  ].map((x, i) => (
                    <div key={i}>
                      <div className="mono" style={{ fontSize: 8.5, color: 'var(--dim)', letterSpacing: '.1em' }}>{x.l}</div>
                      <div className="mono" style={{ fontSize: 12, fontWeight: 600, color: x.c, marginTop: 2 }}>{x.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', fontStyle: 'italic' }}>
                Waiting for {st.filter.toLowerCase()}…
              </div>
            )}

            {active && (
              <>
                <div className="mono" style={{ fontSize: 9, color: 'var(--gold)', marginTop: 9, textAlign: 'center' }}>
                  1 unit per confirmed setup · no add-ons
                </div>
                <button
                className="btn btn-primary"
                disabled={executing === active.id}
                onClick={async () => {
                  setExecuting(active.id);
                  try {
                    // A confirmed live setup is a single entry, not a
                    // pyramiding instruction. The scanner applies the same
                    // guard server-side; keep manual execution consistent.
                    const order = {
                      ...active,
                      symbol: active.symbol || 'ENQ',
                      qty: LIVE_ENTRY_UNITS,
                      tradeMode,
                    };
                    await onExecute?.(order);
                  } finally {
                    setExecuting(null);
                  }
                }}
                style={{
                  marginTop: 10, width: '100%', padding: '10px 0', fontSize: 12,
                  fontWeight: 600, borderRadius: 10, fontFamily: 'var(--mono)',
                  letterSpacing: '.04em',
                }}
              >
                {executing === active.id
                  ? 'Placing…'
                  : tradeMode === 'paper'
                    ? `📝 Paper ${active.dir === 'long' ? 'Long' : 'Short'}`
                    : `🚀 Execute ${active.dir === 'long' ? 'Long' : 'Short'}`}
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
