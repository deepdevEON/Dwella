// BootScreen.jsx — Cinematic split-screen splash.
// Left: branded hero with ambient effects. Right: login / auto-connect.
// Once setup is complete, automatically launches to dashboard.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useMT5 } from '../hooks/useMT5Live.jsx';

const BOOT_MSGS = [
  'Connecting to TradingView…',
  'Grafting data streams…',
  'Polishing the stones…',
  'Opening the garden…',
];

const AUTH_URL = 'http://127.0.0.1:18815';

export default function BootScreen({ onDone }) {
  const { connected, checking, isLive, error, ticks, candles } = useMT5();
  const [step, setStep] = useState(0);
  const [launching, setLaunching] = useState(false);
  const autoLaunched = useRef(false);

  // Auth state
  const [authPhase, setAuthPhase] = useState('idle');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [authError, setAuthError] = useState(null);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);

  // Boot messages
  useEffect(() => {
    const iv = setInterval(() => {
      setStep((s) => s >= BOOT_MSGS.length - 1 ? (clearInterval(iv), s) : s + 1);
    }, 600);
    return () => clearInterval(iv);
  }, []);

  // Check for existing session on mount
  useEffect(() => {
    const saved = localStorage.getItem('dwella_session');
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.token && s.user) {
          setToken(s.token);
          setUser(s.user);
          setAuthPhase('connected');
          // Verify token is still valid
          fetch(`${AUTH_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${s.token}` },
          }).then(r => r.json()).then(data => {
            if (data?.ok) {
              setUser(data.user);
            } else {
              autoLoginFromKeychain();
            }
          }).catch(() => {});
        }
      } catch {}
    }
  }, []);

  // Auto-login from macOS Keychain
  const autoLoginFromKeychain = useCallback(async () => {
    try {
      const res = await fetch(`${AUTH_URL}/auth/keychain`);
      const data = await res.json();
      if (data?.ok && data?.username) {
        setUsername(data.username);
        setAuthPhase('authenticating');
        const loginRes = await fetch(`${AUTH_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: data.username, password: 'auto_keychain' }),
        });
        const loginData = await loginRes.json();
        if (loginData?.ok) {
          setUser(loginData.user);
          setToken(loginData.token);
          localStorage.setItem('dwella_session', JSON.stringify({ user: loginData.user, token: loginData.token }));
          setAuthPhase('connected');
        }
      }
    } catch {}
  }, []);

  // Auto-launch after connected
  useEffect(() => {
    if (authPhase === 'connected' && !autoLaunched.current) {
      autoLaunched.current = true;
      setTimeout(() => { setLaunching(true); setTimeout(onDone, 500); }, 1000);
    }
  }, [authPhase, onDone]);

  // Register
  const handleRegister = useCallback(async () => {
    if (!username.trim() || !password.trim()) return;
    setAuthPhase('authenticating');
    setAuthError(null);
    try {
      const res = await fetch(`${AUTH_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password: password.trim(), email: email.trim() }),
      });
      const data = await res.json();
      if (data?.ok) {
        setUser(data.user);
        setToken(data.token);
        localStorage.setItem('dwella_session', JSON.stringify({ user: data.user, token: data.token }));
        setAuthPhase('connected');
      } else {
        setAuthPhase('error');
        setAuthError(data?.error || 'Registration failed');
      }
    } catch {
      setAuthPhase('error');
      setAuthError('Cannot reach auth server');
    }
  }, [username, password, email]);

  // Login
  const handleLogin = useCallback(async () => {
    if (!username.trim() || !password.trim()) return;
    setAuthPhase('authenticating');
    setAuthError(null);
    try {
      const res = await fetch(`${AUTH_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password: password.trim() }),
      });
      const data = await res.json();
      if (data?.ok) {
        setUser(data.user);
        setToken(data.token);
        localStorage.setItem('dwella_session', JSON.stringify({ user: data.user, token: data.token }));
        setAuthPhase('connected');
      } else {
        setAuthPhase('error');
        setAuthError(data?.error || 'Login failed');
      }
    } catch {
      setAuthPhase('error');
      setAuthError('Cannot reach auth server');
    }
  }, [username, password]);

  const handleReset = useCallback(() => {
    autoLaunched.current = false;
    setAuthPhase('idle');
    setPassword('');
    setAuthError(null);
    setUser(null);
    setToken(null);
    localStorage.removeItem('dwella_session');
  }, []);

  const pct = Math.min(100, step * 24 + (authPhase === 'connected' ? 20 : 0));
  const ready = authPhase === 'connected';
  const enq = ticks?.ENQ || {};
  const mes = ticks?.MES || {};
  const gce = ticks?.GCE || {};
  const handleLaunch = () => { setLaunching(true); setTimeout(onDone, 500); };

  return (
    <div id="boot">
      {/* Ambient background layers */}
      <div className="ambient-rays" />
      <div className="ambient-noise" />

      {/* ── Left panel: Cinematic hero ──────────────────────── */}
      <div className="boot-left">
        <div className="bl-tag">Dwella</div>
        <h1>Trade with<br /><em>precision</em></h1>
        <p className="bl-sub">
          Real-time futures execution backed by TradingView.
          Every tick, every candle, every level — live.
        </p>
        <div className="bl-msg">{BOOT_MSGS[Math.min(step, BOOT_MSGS.length - 1)]}</div>

        {/* Floating preview card */}
        <div className="bl-preview">
          <div className="bp-row">
            <span className="bp-sym">NQ · E-mini Nasdaq</span>
            <span className="bp-badge">M3 LIVE</span>
          </div>
          <div className="bp-price">
            {enq.bid ? `$${enq.bid.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
          </div>
          <div className="bp-chg">
            {enq.ask ? `Spread ${(enq.ask - enq.bid).toFixed(2)}` : ''}
          </div>
          <div className="bp-bar"><span style={{ '--w': '72%' }} /></div>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.03)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', letterSpacing: '.08em' }}>MES</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>
                {mes.bid ? mes.bid.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—'}
              </div>
            </div>
            <div style={{ padding: 8, borderRadius: 8, background: 'rgba(255,255,255,.03)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', letterSpacing: '.08em' }}>GC</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>
                {gce.bid ? gce.bid.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right panel: Connection ─────────────────────────── */}
      <div className="boot-right">
        <div className="br-inner">
          <div className="br-brand">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <circle cx="16" cy="16" r="14" fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.6" />
              <circle cx="16" cy="16" r="4" fill="var(--accent)" opacity="0.8" />
              <circle cx="16" cy="16" r="1.5" fill="var(--accent-bright)" />
            </svg>
            <div className="nm">Dwella<i>繁栄</i></div>
          </div>

          <h2>
            {ready ? `Welcome back, ${user?.display_name || user?.username}`
              : authPhase === 'register' ? 'Create account'
              : 'Sign in'}
          </h2>
          <p className="br-sub">
            {ready
              ? 'All data live — NQ · ES · GC on 3M charts.'
              : authPhase === 'register'
                ? 'Create your Dwella account to get started.'
                : 'Log in to your Dwella account. All data is real — no simulation.'}
          </p>

          {/* Status */}
          <div className="br-status">
            <span className={`dot ${authPhase === 'error' ? 'err' : ready ? 'on' : authPhase === 'authenticating' ? 'auth' : 'off'}`} />
            <div className="br-s-text">
              <b>
                {ready ? 'Connected & Ready'
                  : authPhase === 'authenticating' ? 'Authenticating…'
                  : authPhase === 'error' ? 'Authentication Failed'
                  : 'Not Connected'}
              </b>
              <span>
                {ready
                  ? `TradingView live · NQ · ES · GC · 3M`
                  : authPhase === 'error' ? authError
                  : 'Enter your Dwella credentials below'}
              </span>
            </div>
          </div>

          {/* Login form */}
          {(authPhase === 'idle' || authPhase === 'error' || authPhase === 'register') && (
            <div className="br-login-form">
              {authPhase === 'register' && (
                <div className="br-field">
                  <label className="br-label">Email <span style={{ opacity: 0.5 }}>(optional)</span></label>
                  <input className="br-input" type="email" placeholder="your@email.com"
                    value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
              )}
              <div className="br-field">
                <label className="br-label">Username</label>
                <input className="br-input" type="text" placeholder="your username"
                  value={username} onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && password.trim() && (authPhase === 'register' ? handleRegister() : handleLogin())}
                  autoFocus autoComplete="username" />
              </div>
              <div className="br-field">
                <label className="br-label">Password</label>
                <input className="br-input" type="password" placeholder="••••••••"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && username.trim() && (authPhase === 'register' ? handleRegister() : handleLogin())}
                  autoComplete="current-password" />
              </div>
              {authError && <div className="br-login-error">⚠ {authError}</div>}
              <button className="br-login-btn"
                onClick={authPhase === 'register' ? handleRegister : handleLogin}
                disabled={!username.trim() || !password.trim() || authPhase === 'authenticating'}
                onMouseMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  e.currentTarget.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
                  e.currentTarget.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
                }}>
                {authPhase === 'authenticating'
                  ? <span className="br-auth-spinner"><span /><span /><span /> {authPhase === 'register' ? 'Creating…' : 'Signing in…'}</span>
                  : authPhase === 'register' ? '✨ Create Account' : '🔑 Sign In'}
              </button>
              <button className="br-back-btn" onClick={() => setAuthPhase(authPhase === 'register' ? 'idle' : 'register')}>
                {authPhase === 'register' ? '← Already have an account? Sign in' : 'Need an account? Create one →'}
              </button>
            </div>
          )}

          {/* Authenticating spinner (auto-login) */}
          {authPhase === 'authenticating' && !username && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div className="br-auth-spinner" style={{ justifyContent: 'center' }}>
                <span /><span /><span />
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 12 }}>
                Checking saved credentials…
              </p>
            </div>
          )}

          {/* Connected */}
          {ready && (
            <div className="br-connected-info">
              <div className="br-info-row">
                <span className="br-info-label">Account</span>
                <span className="br-info-val">{user?.display_name || user?.username}</span>
              </div>
              <div className="br-info-row">
                <span className="br-info-label">Email</span>
                <span className="br-info-val">{user?.email || '—'}</span>
              </div>
              <div className="br-info-row">
                <span className="br-info-label">Charts</span>
                <span className="br-info-val mono">NQ · ES · GC — 3M</span>
              </div>
              <div className="br-info-row">
                <span className="br-info-label">Data Source</span>
                <span className="br-info-val mono">TradingView MCP</span>
              </div>
              <button className="br-disconnect-btn" onClick={handleReset}>Switch account</button>
            </div>
          )}

          {/* Launch */}
          <button className="br-launch" onClick={handleLaunch} disabled={!ready || launching}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              e.currentTarget.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
              e.currentTarget.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
            }}>
            {launching ? 'Opening Terminal…' : ready ? '→ Launch Terminal' : 'Sign in to continue…'}
          </button>
          <div className="br-bar"><span style={{ width: `${pct}%` }} /></div>
          <div className="br-foot">
            {authPhase === 'error'
              ? <span style={{ color: 'var(--loss)' }}>⚠ {authError}</span>
              : ready
                ? <span>Symbols: NQ · ES · GC · 3M &nbsp;|&nbsp; {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                : <span>Your data stays local — Dwella never sends trades externally</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
