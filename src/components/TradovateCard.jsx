// TradingViewCard.jsx — TradingView connection status card for Settings.
// Shows TradingView Desktop connection health via the sidecar.

import React, { useState, useEffect } from 'react';
import { useMT5 } from '../hooks/useMT5Live.jsx';

const SIDECAR = 'http://127.0.0.1:18814';

export default function TradovateCard() {
  const { connected, isLive } = useMT5();
  const [health, setHealth] = useState(null);

  useEffect(() => {
    fetch(`${SIDECAR}/health`)
      .then(r => r.json())
      .then(d => setHealth(d?.tv || null))
      .catch(() => setHealth(null));
  }, [connected]);

  const live = connected && isLive;

  return (
    <div className="set-card glass" style={{ gridColumn: '1 / -1' }}>
      <h3>TradingView <span className="jp">トレーディングビュー</span></h3>
      <p>
        Dwella reads live candles and quotes from your locally running TradingView Desktop app
        via the MCP CLI. No API keys needed — just keep TradingView open with a chart.
      </p>

      <div className="set-row" style={{ border: 'none', paddingBottom: 4 }}>
        <div className="lab">
          <b>Connection</b>
          <span>
            {live
              ? `Connected · ${health?.symbol || '—'} · ${health?.resolution || '—'}M`
              : health?.connected
                ? 'Sidecar running, waiting for data…'
                : 'Not connected — start TradingView with --remote-debugging-port=9222'}
          </span>
        </div>
        <span
          className="mono"
          style={{ fontSize: 11, fontWeight: 700, color: live ? 'var(--up)' : 'var(--gold)' }}
        >
          {live ? '● LIVE' : '○ OFFLINE'}
        </span>
      </div>

      <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid var(--line2)' }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: '.06em', marginBottom: 4 }}>
          HOW IT WORKS
        </div>
        <div style={{ fontSize: 12, color: 'var(--mut)', lineHeight: 1.6 }}>
          1. Open <b>TradingView Desktop</b> with <code>--remote-debugging-port=9222 --remote-allow-origins=*</code><br />
          2. Set your chart to <b>ENQ</b> (Micro E-mini Nasdaq) on <b>3M</b> timeframe<br />
          3. Dwella reads candles via the MCP CLI on every poll cycle<br />
          4. All data stays local — nothing is sent externally
        </div>
      </div>
    </div>
  );
}
