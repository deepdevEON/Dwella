// TradingViewChart.jsx
// Embeds the official TradingView charting widget directly in the mobile app.
// This is the same charting engine TradingView ships to every browser — real
// charts, indicators, drawing tools, multi-timeframe — no desktop app needed.
//
// The widget is read-only for execution (TradingView does not expose order
// placement to third-party embeds). Orders are routed through Dwella's
// execution layer (paper in the cloud, or the TradingView Desktop CDP bridge
// when it is reachable on the same network).

import { useEffect, useRef, useState } from 'react';

const SCRIPT_SRC = 'https://s3.tradingview.com/tv.js';

// Dwella short symbol → TradingView chart symbol.
//
// The free TradingView embed widget cannot load exchange futures (continuous
// futures like CME_MINI:NQ1! require a paid TradingView plan and render as
// "This symbol is only available on TradingView" with no data). We therefore
// map to free, always-available cash/CFD proxies that track the same
// underlying (verified live against the widget). The real futures feed is
// still available in the signed-in TradingView remote session and through the
// Dwella MT5 bridge; this widget is the lightweight preview.
const TV_SYMBOLS = {
  NQ: 'FOREXCOM:NAS100',   // US 100 Cash CFD (tracks NQ)
  ES: 'FOREXCOM:SPX500',   // S&P 500 Index (tracks ES)
  GC: 'OANDA:XAUUSD',      // Gold Spot (tracks GC)
  YM: 'FOREXCOM:US30',     // Dow Jones Index (tracks YM)
  CL: 'OANDA:WTICOUSD',    // West Texas Oil (tracks CL)
};

const TV_TIMEFRAMES = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '1H': '60',
  '4H': '240',
  '1D': 'D',
};

function loadTradingViewScript() {
  return new Promise((resolve) => {
    if (window.TradingView) return resolve(true);
    const existing = document.getElementById('dwella-tv-script');
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.TradingView)));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.id = 'dwella-tv-script';
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.TradingView));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

export default function TradingViewChart({ symbol = 'NQ', timeframe = '5m', theme = 'dark', height = 460 }) {
  const containerRef = useRef(null);
  const widgetRef = useRef(null);
  const [chartState, setChartState] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    const tvSymbol = TV_SYMBOLS[symbol] || TV_SYMBOLS.NQ;
    const tvInterval = TV_TIMEFRAMES[timeframe] || '5';

    const mount = async () => {
      setChartState('loading');
      const ok = await loadTradingViewScript();
      if (cancelled) return;
      if (!ok || !containerRef.current || !window.TradingView) {
        setChartState('error');
        return;
      }
      try {
        widgetRef.current = new window.TradingView.widget({
          autosize: true,
          symbol: tvSymbol,
          interval: tvInterval,
          timezone: 'Etc/UTC',
          theme,
          style: '1',
          locale: 'en',
          toolbar_bg: '#0b0a12',
          enable_publishing: false,
          allow_symbol_change: false,
          container_id: containerRef.current.id,
          hide_side_toolbar: false,
          studies: ['STD;SMA', 'STD;EMA'],
          overrides: {
            'paneProperties.background': '#0b0a12',
            'paneProperties.vertGridProperties.color': 'rgba(157,177,212,0.06)',
            'paneProperties.horzGridProperties.color': 'rgba(157,177,212,0.06)',
            'scalesProperties.textColor': '#8b93a7',
          },
        });
        setChartState('ready');
      } catch (error) {
        setChartState('error');
        // eslint-disable-next-line no-console
        console.warn('TradingView widget mount failed:', error);
      }
    };

    mount();
    return () => {
      cancelled = true;
      if (widgetRef.current && typeof widgetRef.current.remove === 'function') {
        try { widgetRef.current.remove(); } catch { /* already removed */ }
        widgetRef.current = null;
      }
    };
  }, [symbol, timeframe, theme]);

  return (
    <div className="tv-chart-embed" style={{ position: 'relative', height }}>
      <div
        ref={containerRef}
        id={`dwella-tv-${symbol}-${timeframe}`.replace(/[^a-zA-Z0-9_-]/g, '')}
        style={{ width: '100%', height: '100%' }}
      />
      {chartState !== 'ready' && <div className="tv-chart-loading" role="status">
        {chartState === 'error' ? 'TradingView chart could not load in this browser.' : 'Loading TradingView chart…'}
      </div>}
    </div>
  );
}
