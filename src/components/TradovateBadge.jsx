// TradingViewBadge.jsx — live TradingView connection status pill.
// Green "TRADINGVIEW · LIVE" when sidecar is connected, gold "TRADINGVIEW —" when not.

import React from 'react';
import { useMT5 } from '../hooks/useMT5Live.jsx';

export default function TradovateBadge({ compact = false }) {
  const { connected, isLive } = useMT5();
  const live = connected && isLive;

  const dot = live ? 'var(--up)' : 'var(--gold)';
  const label = live ? 'TRADINGVIEW · LIVE' : 'TRADINGVIEW —';
  const color = live ? 'var(--up)' : 'var(--gold)';
  const border = live ? 'rgba(143,224,178,.4)' : 'rgba(217,180,108,.35)';

  const pill = (
    <span
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
      style={{ background: 'rgba(255,255,255,.04)', border: `1px solid ${border}` }}
      title={live ? 'TradingView Desktop connected via MCP · 3M candles' : 'TradingView not connected — start TV with --remote-debugging-port=9222'}
    >
      <span className="relative flex w-2 h-2">
        {live && <span className="absolute inline-flex w-full h-full rounded-full animate-ping opacity-60" style={{ background: dot }} />}
        <span className="relative inline-flex w-2 h-2 rounded-full" style={{ background: dot, boxShadow: `0 0 8px ${dot}` }} />
      </span>
      <span className="mono" style={{ fontSize: compact ? 9 : 10, fontWeight: 700, color }}>{label}</span>
    </span>
  );

  if (compact) return pill;
  return (
    <div className="flex items-center gap-2">
      {pill}
    </div>
  );
}
