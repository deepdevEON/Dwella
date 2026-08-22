import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MotionConfig } from 'framer-motion';
import './index.css';
import './workspace.css';
import './motion-overrides.css';

// Register the lightweight service worker so Add to Home Screen can reopen
// Dwella in its standalone app shell. Electron/file:// stays untouched.
if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./dwella-sw.js', { scope: './' }).catch(() => {
      // PWA installation is an enhancement; the web app remains fully usable.
    });
  });
}

// The web/mobile build uses the paired Playwright TradingView service for
// actual OHLCV bars. It deliberately has no demo/synthetic fallback here;
// the backtest must tell the user when live TradingView data is unavailable.
if (window.location.protocol !== 'file:' && !window.dwella) window.dwella = {};
if (window.location.protocol !== 'file:' && !window.dwella?.getMarketBars) {
  window.dwella.getMarketBars = async (symbol, timeframe, count = 300) => {
    const params = new URLSearchParams({ symbol, timeframe, count: String(count) });
    const response = await fetch(`/market/bars?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'TradingView live market data is unavailable.');
    }
    return payload;
  };
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>
);
