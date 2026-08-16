// LiveStatusBadge.jsx — TradingView connection pill shown in the header & terminal.
// States: CONNECTING (amber), TV LIVE (green), OFFLINE (crimson).
// There is deliberately NO "simulated" state — Dwella runs on real data only.

import React from 'react';
import { useMT5 } from '../hooks/useMT5Live.jsx';

export default function MT5StatusBadge({ compact = false }) {
  const { isLive, connected, checking, lastUpdate, terminal } = useMT5();

  let dot = 'rgba(217,180,108,.9)';
  let label = 'CONNECTING';
  let sub = 'sidecar';
  let color = 'var(--gold)';
  let border = 'rgba(217,180,108,.35)';

  if (isLive) {
    dot = 'var(--up)';
    label = 'LIVE';
    sub = lastUpdate ? new Date(lastUpdate).toLocaleTimeString('en-US', { hour12: false }) : terminal || 'live';
    color = 'var(--up)';
    border = 'rgba(143,224,178,.4)';
  } else if (checking) {
    sub = 'sidecar';
  } else {
    dot = 'var(--down)';
    label = 'TV OFFLINE';
    sub = connected ? 'stale feed' : 'sidecar down';
    color = 'var(--down)';
    border = 'rgba(255,109,134,.4)';
  }

  const pill = (
    <span
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg"
      style={{ background: 'rgba(255,255,255,.04)', border: `1px solid ${border}` }}
      title={`${label} — ${sub}`}
    >
      <span className="relative flex w-2 h-2">
        {isLive && <span className="absolute inline-flex w-full h-full rounded-full animate-ping opacity-60" style={{ background: dot }} />}
        <span className="relative inline-flex w-2 h-2 rounded-full" style={{ background: dot, boxShadow: `0 0 8px ${dot}` }} />
      </span>
      <span className="mono" style={{ fontSize: compact ? 9 : 10, fontWeight: 700, color }}>{label}</span>
    </span>
  );

  if (compact) return pill;
  return (
    <div className="flex items-center gap-2">
      {pill}
      {sub && <span className="mono" style={{ fontSize: 8, color: 'var(--dim)' }}>{sub}</span>}
    </div>
  );
}
