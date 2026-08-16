// App.jsx
// Dwella — Futures Terminal.
// Boots straight into the terminal — no website/landing. All data is REAL
// TradingView via the MT5Provider (sidecar at 127.0.0.1:18814). No simulation.
import React, { useState, useEffect } from 'react';
import { MT5Provider, useMT5 } from './hooks/useMT5Live.jsx';
import { ToastProvider, useToast } from './components/ToastSystem.jsx';
import BootScreen from './components/BootScreen.jsx';
import AppShell from './components/AppShell.jsx';

// Wires the toast system into the MT5 context so order polling can fire toasts.
function ToastBridge() {
  const { addToast } = useToast();
  const { setToastFn } = useMT5();
  useEffect(() => { if (setToastFn) setToastFn(addToast); }, [addToast, setToastFn]);
  return null;
}

export default function App() {
  const [stage, setStage] = useState('boot'); // boot → app

  return (
    <ToastProvider>
      <MT5Provider>
        <ToastBridge />
        <div className="w-screen h-screen relative overflow-hidden select-none" style={{ background: 'var(--bg-void)' }}>
          {/* Ambient background layers */}
          <div className="ambient-gradient" />
          <div className="ambient-rays" />
          <div className="ambient-noise" />

          {stage === 'boot' && <BootScreen onDone={() => setStage('app')} />}
          {stage === 'app' && <AppShell />}
        </div>
      </MT5Provider>
    </ToastProvider>
  );
}
