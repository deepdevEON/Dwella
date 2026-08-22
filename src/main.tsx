import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Browser preview fallback: window.dwella normally comes from the Electron preload.
if (!window.dwella) {
  const ok = async (message = "Preview mode — no Electron backend."): Promise<ActionResult> => ({ ok: true, message });
  window.dwella = {
    platform: "browser",
    windowControls: { minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, isMaximized: async () => false, onMaxChanged: () => () => {} },
    hasLocalLogin: async () => true,
    createLocalLogin: () => ok("Preview login created."),
    verifyLocalLogin: () => ok("Welcome back."),
    clearLocalLogin: () => ok(),
    getSystemStatus: async () => ({ hermesInstalled: false, hermesRunning: false, hermesApiHealthy: false, platform: "browser" }),
    startHermes: () => ok(), stopHermes: () => ok(), askHermes: () => ok(),

    openExternal: async () => {},
    openTradingViewLogin: async () => {
      const popup = window.open("https://www.tradingview.com/accounts/signin/", "dwella-tradingview-login", "popup=yes,width=460,height=760,resizable=yes,scrollbars=yes");
      return popup
        ? { ok: true, message: "TradingView sign-in opened." }
        : { ok: false, message: "Allow pop-ups for Dwella to open TradingView sign-in." };
    },
    getMarketQuotes: async () => {
      // Browser preview talks to the MT5 bridge directly; Electron proxies via main process.
      try { const r = await fetch("http://127.0.0.1:8643/quotes"); const b = await r.json(); return b.ok ? b.quotes : []; } catch { return []; }
    },
    getMarketBars: async (s, tf, count = 180) => {
      const interval = { M1: "1", M5: "5", M15: "15", M30: "30", H1: "60", H4: "240", D1: "D" }[tf] || tf;
      const params = new URLSearchParams({ symbol: s, timeframe: interval, count: String(count) });
      const response = await fetch(`/market/bars?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "TradingView live market data is unavailable.");
      return payload;
    },
    getAccount: async () => {
      try { return await (await fetch("http://127.0.0.1:8643/account")).json(); } catch { return { ok: false }; }
    },
    getPositions: async () => {
      try { return await (await fetch("http://127.0.0.1:8643/positions")).json(); } catch { return { ok: false }; }
    },
    placeMarketOrder: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    placeLimitOrder: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    placeStopOrder: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    placeStopLimitOrder: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    placeBracketOrder: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    modifyOrder: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    closeOrder: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    closeAllOrders: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    getOrderHistory: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    getTransactionLog: async () => ({ ok: false, error: "Preview mode — orders disabled." }),
    buffy: {
      getHistory: async () => { try { const r=await fetch("http://127.0.0.1:8645/buffy/messages"); const b=await r.json(); return b.messages||[]; } catch { return []; } },
      getSignals: async () => { try { const r=await fetch("http://127.0.0.1:8645/buffy/signals"); const b=await r.json(); return b.signals||[]; } catch { return []; } },
      onMessage: () => () => {},
      onSignal: () => () => {},
    }
  };
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
