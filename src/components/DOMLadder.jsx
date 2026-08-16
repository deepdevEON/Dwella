// DOMLadder.jsx
// Depth of Market ladder fed by real TradingView market data (when the
// broker streams it). Renders bids/asks with real volume at each level,
// mid price highlighted, and falls back to the real Level-1 quote with an
// honest note when no depth is available.
import React, { useMemo } from 'react';

const FMT = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

export default function DOMLadder({ book, price, bid = null, ask = null, decimals = 2 }) {
  const rows = useMemo(() => {
    if (!book) return [];
    const bids = [...(book.bids || [])].sort((a, b) => b.price - a.price); // best bid first
    const asks = [...(book.asks || [])].sort((a, b) => a.price - b.price); // best ask first
    const out = [];
    for (const a of [...asks].reverse()) out.push({ ...a, side: 'ask' });
    for (const b of bids) out.push({ ...b, side: 'bid' });
    return out;
  }, [book]);

  const maxVol = useMemo(() => Math.max(1, ...rows.map((r) => Number(r.volume) || 0)), [rows]);

  const hasDepth = rows.length > 0;

  return (
    <div className="ladder">
      <div className="lh">
        <span>BID SIZE</span>
        <span>PRICE</span>
        <span>ASK SIZE</span>
      </div>
      {!hasDepth ? (
        <div className="text-center py-10 px-4">
          <div className="mono text-[11px]" style={{ color: 'var(--dim)' }}>No L2 depth from this broker feed</div>
          <div className="mono text-[10px] mt-1" style={{ color: 'var(--mut)' }}>
            {bid != null && ask != null ? (
              <>Real Level-1 · B {FMT(bid, decimals)} / A {FMT(ask, decimals)}</>
            ) : (
              'Awaiting TradingView quote…'
            )}
          </div>
        </div>
      ) : (
        rows.map((row, i) => {
          const isBid = row.side === 'bid';
          const vol = Number(row.volume) || 0;
          const pct = Math.min(100, (vol / maxVol) * 50);
          const atMid = price != null && row.price === price;
          return (
            <div key={`${row.side}-${row.price}-${i}`} className={`lr ${atMid ? 'mid' : ''}`}>
              <div className="bid" style={{ width: isBid ? `${pct}%` : '0%' }} />
              <div className="ask" style={{ width: isBid ? '0%' : `${pct}%` }} />
              <span>{isBid ? FMT(vol, 0) : ''}</span>
              <span>{FMT(row.price, decimals)}</span>
              <span>{isBid ? '' : FMT(vol, 0)}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
