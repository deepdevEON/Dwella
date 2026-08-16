// IcebergRadar.jsx
// The "greatest edge" feed — real-time log of iceberg and stop-run events
// detected from real TradingView 3M candles, with exact price levels flagged.

import React, { useMemo } from 'react';

export default function IcebergRadar({ events, icebergs, stopRuns }) {
  const feed = useMemo(() => {
    const all = [...(icebergs || []), ...(stopRuns || [])]
      .map((e, i) => ({ ...e, sortKey: e.time || Date.now() - i }))
      .sort((a, b) => b.sortKey - a.sortKey)
      .slice(0, 20);
    return all;
  }, [icebergs, stopRuns]);

  return (
    <div className="flex flex-col h-full">
      {/* Stat chips */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="glass p-2.5">
          <div className="mono" style={{ fontSize: 9, color: 'var(--dim)' }}>Icebergs Detected</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--blush)' }}>{(icebergs || []).length}</div>
        </div>
        <div className="glass p-2.5">
          <div className="mono" style={{ fontSize: 9, color: 'var(--dim)' }}>Stop Runs</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--gold)' }}>{(stopRuns || []).length}</div>
        </div>
      </div>

      {/* Live feed */}
      <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
        {feed.length === 0 && (
          <div className="mono p-3" style={{ fontSize: 12, color: 'var(--dim)' }}>Waiting for the market to reveal itself…</div>
        )}
        {feed.map((e, i) => {
          const isIce = e.type === 'iceberg';
          const up = isIce ? e.dir === 'bid' : e.dir === 'up';
          const time = new Date(e.time).toLocaleTimeString('en-US', { hour12: false });
          return (
            <div
              key={i}
              className="flex items-center justify-between px-3 py-2 rounded-lg border"
              style={{
                fontSize: 11,
                fontFamily: 'var(--mono)',
                background: isIce ? 'rgba(246,201,211,.07)' : 'rgba(217,180,108,.06)',
                borderColor: isIce ? 'rgba(246,201,211,.25)' : 'rgba(217,180,108,.2)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: up ? 'var(--blush)' : 'var(--down)' }} />
                <div>
                  <div style={{ fontWeight: 700, color: isIce ? 'var(--blush)' : 'var(--gold)' }}>
                    {isIce ? `ICEBERG ${up ? 'BUY' : 'SELL'}` : `STOP RUN ${up ? 'UP' : 'DOWN'}`}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--dim)' }}>
                    {isIce
                      ? `${e.displayed} shown / ${e.total} total`
                      : `Swept ${e.size?.toFixed?.(2) ?? '—'} pts`}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div style={{ fontWeight: 700, color: 'var(--ink)' }}>@{fmtPx(e.price)}</div>
                <div style={{ fontSize: 9, color: 'var(--dim)' }}>{time}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const fmtPx = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
