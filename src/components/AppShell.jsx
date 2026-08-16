// AppShell.jsx — Dwella terminal shell with liquid glass design.
import React, { useEffect, useState } from 'react';
import {
  DashboardView,
  MarketsView,
  ChartView,
  ChartsView,
  AutoTraderView,
  StrategiesView,
  PositionsView,
  OrdersView,
  RiskView,
  PerformanceView,
  JournalView,
  SettingsView,
} from './Views/TabViews.jsx';
import { useMT5 } from '../hooks/useMT5Live.jsx';

const NAV = [
  { v: 'dashboard', t: 'Home', icon: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M12 14v4M10 16h4" /></> },
  { v: 'markets', t: 'Markets', icon: <><path d="M4 20V9M10 20V4M16 20v-8M22 20V7M2 20h20" /></> },
  { v: 'autotrader', t: 'AutoTrader', icon: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></> },
  { v: 'charts', t: 'Charts', icon: <><path d="M4 20V10M10 20V4M16 20v-8M22 20V7" /></> },
  { v: 'strategies', t: 'Strategies', icon: <><path d="M3 17l6-6 4 4 8-8M21 7v5M21 7h-5" /></> },
  { v: 'positions', t: 'Positions', icon: <><path d="M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></> },
  { v: 'orders', t: 'Orders', icon: <><path d="M4 6h16M4 12h10M4 18h14" /><circle cx="19" cy="12" r="1.4" /></> },
  { v: 'risk', t: 'Risk', icon: <><path d="M12 3l8 3v6c0 5-3.5 7.7-8 9-4.5-1.3-8-4-8-9V6z" /><path d="M12 9v4M12 16h.01" /></> },
  { v: 'performance', t: 'Performance', icon: <><path d="M3 20h18" /><path d="M5 16l4-5 3 3 6-8" /></> },
  { v: 'journal', t: 'Journal', icon: <><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4z" /><path d="M5 17a3 3 0 013-3h11M9 8h6M9 11h4" /></> },
  { v: 'settings', t: 'Settings', icon: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></> },
];

function useClocks() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);
  return now;
}

function SessionClock({ tz, name, now }) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const current = hour * 60 + minute;
  const open = tz === 'Asia/Tokyo' ? current >= 540 && current < 900 : tz === 'Europe/London' ? current >= 480 && current < 990 : current >= 570 && current < 960;
  return (
    <div className={`sess ${open ? 'open' : ''}`}>
      <span className="sd" />
      <div className="sc">
        <b>{name}</b>
        <span>{String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')}</span>
      </div>
    </div>
  );
}

export default function AppShell() {
  const [active, setActive] = useState('dashboard');
  const [chartSymbol, setChartSymbol] = useState(null);
  const now = useClocks();
  const user = (() => { try { return JSON.parse(localStorage.getItem('dwella_session') || '{}').user || {}; } catch { return {}; } })();

  const openChart = (symbol) => { setChartSymbol(symbol); setActive('chart'); };
  const closeChart = () => { setChartSymbol(null); setActive('dashboard'); };
  const selectView = (view) => { setActive(view); setChartSymbol(null); };

  const renderView = () => {
    if (active === 'chart' && chartSymbol) return <ChartView symbol={chartSymbol} onBack={closeChart} />;
    switch (active) {
      case 'markets': return <MarketsView />;
      case 'charts': return <ChartsView onOpenChart={openChart} />;
      case 'autotrader': return <AutoTraderView />;
      case 'strategies': return <StrategiesView />;
      case 'positions': return <PositionsView />;
      case 'orders': return <OrdersView />;
      case 'risk': return <RiskView />;
      case 'performance': return <PerformanceView />;
      case 'journal': return <JournalView />;
      case 'settings': return <SettingsView />;
      default: return <DashboardView onOpenChart={openChart} />;
    }
  };

  const winCtl = (action) => { const api = window.electronAPI; if (api?.[action]) api[action](); };
  const displayName = user.display_name || user.username || 'Trader';

  return (
    <div id="app" className="appear">
      {/* Ambient background */}
      <div className="ambient-gradient" />
      <div className="ambient-noise" />

      {/* Titlebar */}
      <div className="titlebar">
        <div className="tb-brand">
          <svg viewBox="0 0 32 32" width="20" height="20">
            <circle cx="16" cy="16" r="14" fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.6" />
            <circle cx="16" cy="16" r="4" fill="var(--accent)" opacity="0.8" />
          </svg>
          Dwella
        </div>
        <span className="tb-name">TradingView · Live Terminal</span>
        <div className="tb-ctrls">
          <button aria-label="Minimize" onClick={() => winCtl('minimize')}>—</button>
          <button aria-label="Maximize" onClick={() => winCtl('maximize')}>□</button>
          <button className="close" aria-label="Close" onClick={() => winCtl('close')}>×</button>
        </div>
      </div>

      <div className="shell">
        {/* Sidebar */}
        <aside className="rail">
          <nav aria-label="Terminal navigation">
            {NAV.map((item) => (
              <button
                key={item.v}
                className={`rail-btn ${active === item.v ? 'active' : ''}`}
                onClick={() => selectView(item.v)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {item.icon}
                </svg>
                <span className="tip">{item.t}</span>
              </button>
            ))}
          </nav>
          <div className="spacer" />
          {/* User card at bottom */}
          <div style={{ padding: '0 8px', width: '100%' }}>
            <div style={{
              padding: '10px 8px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(255,255,255,.02)',
              border: '1px solid var(--border)',
              textAlign: 'center',
            }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--accent-bright), var(--accent))',
                display: 'grid',
                placeItems: 'center',
                margin: '0 auto 6px',
                fontSize: 14,
                fontWeight: 700,
                color: '#0a0a0f',
                fontFamily: 'var(--font-display)',
              }}>
                {displayName.charAt(0).toUpperCase()}
              </div>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-primary)' }}>
                {displayName}
              </div>
              <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--accent)', letterSpacing: '0.1em', marginTop: 2 }}>
                STEWARD
              </div>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <div className="stage">
          {/* Top bar */}
          <div className="topbar">
            <div className="crumb">
              {NAV.find((n) => n.v === active)?.t || 'Dashboard'}
              <span className="jp">
                {NAV.find((n) => n.v === active)?.v === 'dashboard' ? 'overview'
                  : NAV.find((n) => n.v === active)?.v === 'markets' ? 'watchtower'
                  : NAV.find((n) => n.v === active)?.v === 'autotrader' ? 'command'
                  : ''}
              </span>
            </div>

            <div className="sessions">
              <SessionClock tz="America/New_York" name="NY" now={now} />
              <SessionClock tz="Europe/London" name="LDN" now={now} />
              <SessionClock tz="Asia/Tokyo" name="TKY" now={now} />
            </div>

            <div className="profile">
              <div className="av">{displayName.charAt(0).toUpperCase()}</div>
              <div className="pn">
                <b>{displayName}</b>
                <span>STEWARD</span>
              </div>
            </div>
          </div>

          {/* Views */}
          <main id="views">{renderView()}</main>
        </div>
      </div>
    </div>
  );
}
