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
    getMarketQuotes: async () => {
      // Browser preview talks to the MT5 bridge directly; Electron proxies via main process.
      try { const r = await fetch("http://127.0.0.1:8643/quotes"); const b = await r.json(); return b.ok ? b.quotes : []; } catch { return []; }
    },
    getMarketBars: async (s, tf, count = 180) => {
      try {
        const live = await (await fetch(`http://127.0.0.1:8643/bars?s=${s}&tf=${tf}&count=${count}`)).json();
        if (live?.ok && live.bars?.length) return live;
      } catch { /* bridge offline — fall through to demo bars */ }
      // Demo bars: deterministic random walk so the preview terminal always renders.
      const base = s === "NQ" ? 18500 : s === "GC" ? 2350 : 5390;
      const stepMin = tf === "M1" ? 1 : tf === "M5" ? 5 : tf === "M15" ? 15 : tf === "H1" ? 60 : 1440;
      let seed = [...`${s}${tf}`].reduce((a, ch) => a + ch.charCodeAt(0), 0);
      const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
      let close = base;
      const bars: MarketBar[] = Array.from({ length: count }, (_, i) => {
        const o = close, drift = rnd() * base * 0.0022;
        const c = o + drift;
        const h = Math.max(o, c) + Math.abs(rnd()) * base * 0.001;
        const l = Math.min(o, c) - Math.abs(rnd()) * base * 0.001;
        close = c;
        return { t: Date.now() - (count - i) * stepMin * 60000, o, h, l, c, v: Math.round(500 + Math.abs(rnd()) * 2000) };
      });
      return { ok: true, symbol: `${s} (demo)`, tf, src: "demo", bars };
    },
    getAccount: async () => {
      try { return await (await fetch("http://127.0.0.1:8643/account")).json(); } catch { return { ok: false }; }
    },
    getPositions: async () => {
      try { return await (await fetch("http://127.0.0.1:8643/positions")).json(); } catch { return { ok: false }; }
    },
    buffy: {
      getHistory: async () => { try { const r=await fetch("http://127.0.0.1:8645/buffy/messages"); const b=await r.json(); return b.messages||[]; } catch { return []; } },
      getSignals: async () => { try { const r=await fetch("http://127.0.0.1:8645/buffy/signals"); const b=await r.json(); return b.signals||[]; } catch { return []; } },
      onMessage: () => () => {},
      onSignal: () => () => {},
    }
  };
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
