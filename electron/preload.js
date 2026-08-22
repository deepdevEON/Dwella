const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // Dwella trading data persistence (trading/ folder)
  loadJournal: () => ipcRenderer.invoke('journal:load'),
  saveJournal: (entries) => ipcRenderer.invoke('journal:save', entries),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getDataPath: () => ipcRenderer.invoke('app:data-path'),

  // Fake Sleep: keep macOS awake while the display is explicitly off
  fakeSleepStart: () => ipcRenderer.invoke('fake-sleep:start'),
  fakeSleepAuthorize: () => ipcRenderer.invoke('fake-sleep:authorize'),
  fakeSleepRestore: () => ipcRenderer.invoke('fake-sleep:restore'),
  fakeSleepStop: () => ipcRenderer.invoke('fake-sleep:stop'),
  fakeSleepStatus: () => ipcRenderer.invoke('fake-sleep:status'),

  // TradingView connection status and credential-free sign-in handoff
  tvStatus: () => ipcRenderer.invoke('tv:status'),
  getMarketBars: async (symbol, timeframe, count = 300) => {
    const tf = { M1: '1', M5: '5', M15: '15', M30: '30', H1: '60', H4: '240', D1: 'D' }[timeframe] || timeframe;
    try {
      const response = await fetch(`http://127.0.0.1:18814/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(tf)}&count=${encodeURIComponent(count)}`);
      const payload = await response.json();
      const candles = Array.isArray(payload?.candles) ? payload.candles : [];
      if (!response.ok || !candles.length) return { ok: false, source: 'tradingview-desktop' };
      return {
        ok: true,
        source: 'tradingview-desktop',
        symbol,
        tf: timeframe,
        bars: candles.map((bar) => ({
          t: Number(bar.time) * 1000,
          o: Number(bar.open),
          h: Number(bar.high),
          l: Number(bar.low),
          c: Number(bar.close),
          v: Number(bar.volume || 0),
        })),
      };
    } catch {
      return { ok: false, source: 'tradingview-desktop' };
    }
  },
  openTradingViewLogin: () => ipcRenderer.invoke('tv:login'),
  onTvStatus: (cb) => ipcRenderer.on('tv:status', (_e, data) => cb(data)),
  onTradingViewLoginComplete: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('tv:login-complete', listener);
    return () => ipcRenderer.removeListener('tv:login-complete', listener);
  },
});
