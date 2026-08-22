import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  History,
  ImageIcon,
  Home,
  KeyRound,
  LinkIcon,
  LogOut,
  Maximize2,
  Menu,
  MonitorPlay,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sun,
  Target,
  Trash2,
  TrendingUp,
  Upload,
  Moon,
  Monitor,
  Palette,
  Wifi,
  X,
} from 'lucide-react';
import TradingViewChart from './components/TradingViewChart.jsx';
import BacktestPanel from './BacktestPanel.tsx';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CountingNumber, GradientText, ShimmeringText } from './components/animate-ui/texts.jsx';

const WEB_RUNTIME = typeof window !== 'undefined' && window.location.protocol !== 'file:';
const DESKTOP_RUNTIME = typeof window !== 'undefined'
  && (window.location.protocol === 'file:' || Boolean(window.electronAPI));
const AUTH_API_URL = import.meta.env.VITE_AUTH_API_URL
  || (WEB_RUNTIME ? '' : 'http://127.0.0.1:18817');
const LOCAL_TRADING_BRIDGE_URL = 'http://127.0.0.1:18814';
// explicit bridge boundary
const CONFIGURED_TRADING_BRIDGE_URL = import.meta.env.VITE_TRADING_BRIDGE_URL || '';
const LOCAL_BRIDGE_URL_PATTERN = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i;
const TRADING_BRIDGE_URL = (
  WEB_RUNTIME && LOCAL_BRIDGE_URL_PATTERN.test(CONFIGURED_TRADING_BRIDGE_URL)
    ? ''
    : CONFIGURED_TRADING_BRIDGE_URL || (DESKTOP_RUNTIME ? LOCAL_TRADING_BRIDGE_URL : '')
).replace(/\/$/, '');
const TRADING_BRIDGE_TOKEN = import.meta.env.VITE_TRADING_BRIDGE_TOKEN || '';
const TRADING_BRIDGE_CONFIGURED = Boolean(TRADING_BRIDGE_URL);
const TRADING_BRIDGE_LABEL = DESKTOP_RUNTIME ? 'TradingView Desktop bridge' : 'Linux Tradovate bridge';
const PLAYWRIGHT_TRADER_URL = (
  import.meta.env.VITE_PLAYWRIGHT_TRADER_URL
  || import.meta.env.VITE_BROWSERBASE_TRADER_URL
  || (DESKTOP_RUNTIME ? 'http://127.0.0.1:8646' : typeof window !== 'undefined' ? window.location.origin : '')
).replace(/\/$/, '');
const PLAYWRIGHT_TRADER_TOKEN = import.meta.env.VITE_PLAYWRIGHT_TRADER_TOKEN
  || import.meta.env.VITE_BROWSERBASE_TRADER_TOKEN
  || '';
// The browser preview owns the self-hosted Playwright session. Electron uses
// its existing official TradingView login window instead of pointing at a
// service that Electron does not launch.
const PLAYWRIGHT_TRADER_CONFIGURED = WEB_RUNTIME && Boolean(PLAYWRIGHT_TRADER_URL);
const TRADINGVIEW_LOGIN_URL = 'https://www.tradingview.com/accounts/signin/';
const PAPER_KEY = 'dwella-paper-v1';
const PAPER_START = 50000;
const APPEARANCE_KEY = 'dwella-appearance-v1';
const APPEARANCE_DEFAULTS = { theme: 'system', background: 'default', customBackground: '' };
const SCRIPTURE_KEY = 'dwella-scripture-v1';
const DEVICE_KEY = 'dwella-device-pair-v2';
const BIBLE_TRANSLATIONS = [
  { id: 'kjv', name: 'King James Version' },
  { id: 'web', name: 'World English Bible' },
];
const BIBLE_BOOKS = ['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth', '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon', 'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation'];
const BIBLE_CHAPTERS = [50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10, 42, 150, 31, 12, 8, 66, 52, 5, 48, 12, 14, 3, 9, 1, 4, 7, 3, 3, 3, 2, 14, 4, 28, 16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5, 3, 6, 4, 3, 1, 13, 5, 5, 3, 5, 1, 1, 1, 22];
const FALLBACK_WORD = { reference: 'Psalm 119:105', text: 'Thy word is a lamp unto my feet, and a light unto my path.' };
const BACKGROUND_PRESETS = [
  { id: 'default', label: 'Workspace', description: 'Clean neutral shell' },
  { id: 'nebula', label: 'Nebula', description: 'Deep space blue' },
  { id: 'aurora', label: 'Aurora', description: 'Teal and lime glow' },
  { id: 'dusk', label: 'Dusk', description: 'Warm evening gradient' },
];
const THEME_OPTIONS = [
  { id: 'system', label: 'Device', description: 'Follow mobile or desktop', icon: Monitor },
  { id: 'light', label: 'Light', description: 'Bright workspace', icon: Sun },
  { id: 'dark', label: 'Dark', description: 'Low-light workspace', icon: Moon },
];

function loadAppearance() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(APPEARANCE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return APPEARANCE_DEFAULTS;
    return {
      ...APPEARANCE_DEFAULTS,
      ...saved,
      theme: ['system', 'light', 'dark'].includes(saved.theme) ? saved.theme : APPEARANCE_DEFAULTS.theme,
      background: [...BACKGROUND_PRESETS.map((item) => item.id), 'custom'].includes(saved.background) ? saved.background : APPEARANCE_DEFAULTS.background,
      customBackground: typeof saved.customBackground === 'string' ? saved.customBackground : '',
    };
  } catch {
    return APPEARANCE_DEFAULTS;
  }
}

function loadDevicePairing() {
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.code) return null;
    return { code: data.code, pairedAt: data.pairedAt || null, device: data.device || 'Unknown device' };
  } catch { return null; }
}

function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function appearanceClassName(appearance) {
  return [
    appearance?.theme && appearance.theme !== 'system' ? `theme-${appearance.theme}` : '',
    appearance?.customBackground ? 'has-custom-background' : `background-${appearance?.background || 'default'}`,
  ].filter(Boolean).join(' ');
}

function appearanceStyle(appearance) {
  if (!appearance?.customBackground) return undefined;
  return { '--dwella-wallpaper': `url(${JSON.stringify(appearance.customBackground)})` };
}

const TABS = [
  { id: 'home', label: 'Desk', description: 'Live overview', icon: Home },
  { id: 'history', label: 'Activity', description: 'Orders & positions', icon: History },
  { id: 'insights', label: 'Insights', description: 'Market context', icon: BarChart3 },
  { id: 'backtest', label: 'Research', description: 'Test a strategy', icon: Target },
  { id: 'trade', label: 'Trade', description: 'TradingView session', icon: TrendingUp },
];
const SETTINGS_TAB = { id: 'settings', label: 'Settings', description: 'Appearance & preferences', icon: Settings2 };
const SCRIPTURE_TAB = { id: 'scripture', label: 'Scripture', description: 'Read the Bible', icon: BookOpen };
const ALL_TABS = [...TABS, SETTINGS_TAB, SCRIPTURE_TAB];
const TAB_IDS = ALL_TABS.map((tab) => tab.id);
const MARKETS = [
  { id: 'NQ', name: 'Nasdaq futures' },
  { id: 'ES', name: 'S&P futures' },
  { id: 'GC', name: 'Gold futures' },
  { id: 'YM', name: 'Dow futures' },
];
const TRADE_SYMBOLS = [
  { id: 'NQ', name: 'Nasdaq 100' },
  { id: 'ES', name: 'S&P 500' },
  { id: 'GC', name: 'Gold' },
  { id: 'YM', name: 'Dow' },
];
const TRADE_TIMEFRAMES = ['1m', '3m', '5m', '15m', '1H', '4H', '1D'];

function isStandaloneDisplay() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches
      || window.matchMedia?.('(display-mode: fullscreen)').matches
      || window.navigator.standalone === true,
  );
}

function initialTab() {
  try {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return TAB_IDS.includes(requested) ? requested : 'home';
  } catch {
    return 'home';
  }
}

function sessionToken() {
  try {
    return window.sessionStorage.getItem('dwella-auth-token') || '';
  } catch {
    return '';
  }
}

function initialsForUser(user) {
  const value = user?.display_name || user?.username || 'DW';
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'DW';
}

function formatPrice(value, symbol = '') {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const digits = symbol === 'YM' ? 0 : symbol === 'GC' ? 1 : 2;
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(Number(timestamp) > 1e12 ? Number(timestamp) : Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function resolveServiceUrl(value) {
  if (!value || !PLAYWRIGHT_TRADER_URL) return '';
  try {
    return new URL(value, `${PLAYWRIGHT_TRADER_URL}/`).toString();
  } catch {
    return '';
  }
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const { timeout: timeoutMs = 7000, ...fetchOptions } = options;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const error = new Error(payload.error || payload.message || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    window.clearTimeout(timer);
  }
}

async function cloudRequest(path, options = {}) {
  if (!PLAYWRIGHT_TRADER_CONFIGURED) throw new Error('The Playwright TradingView service is not configured.');
  const headers = new Headers(options.headers || {});
  if (PLAYWRIGHT_TRADER_TOKEN) headers.set('Authorization', `Bearer ${PLAYWRIGHT_TRADER_TOKEN}`);
  return requestJson(`${PLAYWRIGHT_TRADER_URL}${path}`, { ...options, headers });
}

function sidecarRequest(path, options = {}) {
  if (!TRADING_BRIDGE_CONFIGURED) {
    throw new Error('No Linux trading bridge is configured. Paper mode remains available.');
  }
  const headers = new Headers(options.headers || {});
  if (TRADING_BRIDGE_TOKEN) headers.set('Authorization', `Bearer ${TRADING_BRIDGE_TOKEN}`);
  return requestJson(`${TRADING_BRIDGE_URL}${path}`, { ...options, headers }).then((payload) => {
    // Keep the existing desktop-era call sites compatible while exposing the
    // normalized contract returned by a Linux Tradovate bridge.
    if (path === '/tv/status') {
      const normalized = normalizeBridgeStatus(payload);
      return {
        ...payload,
        connected: normalized.connected,
        account_connected: normalized.accountConnected,
        account_fresh: normalized.accountConnected,
        executionReady: normalized.executionReady,
        provider: normalized.provider,
        error: normalized.error,
      };
    }
    return payload;
  });
}

function normalizeBridgeStatus(data) {
  const tradovate = data?.tradovate || {};
  const tradingView = data?.tv || {};
  const account = data?.account && typeof data.account === 'object' && Object.keys(data.account).length
    ? data.account
    : null;
  const connected = Boolean(data?.connected || tradingView.connected || tradovate.loggedIn);
  const accountConnected = Boolean(
    data?.account_connected
      || data?.account_fresh
      || data?.accountConnected
      || tradovate.accountId
      || (account && (tradovate.executionReady || connected)),
  );
  const reportedExecutionReady = data?.execution?.ready
    ?? data?.executionReady
    ?? data?.execution_ready
    ?? tradovate.executionReady;
  return {
    configured: TRADING_BRIDGE_CONFIGURED,
    checking: false,
    connected,
    accountConnected,
    executionReady: reportedExecutionReady == null
      ? Boolean(connected && accountConnected)
      : Boolean(reportedExecutionReady),
    account,
    provider: data?.provider || (data?.tradovate ? 'Tradovate' : data?.tv ? 'TradingView Desktop' : ''),
    error: data?.error || tradovate.error || tradingView.error || '',
  };
}

function loadPaper() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PAPER_KEY) || 'null');
    if (saved && typeof saved.balance === 'number') return saved;
  } catch { /* browser privacy mode */ }
  return { balance: PAPER_START, positions: [], closed: [] };
}

function useLiveMarkets() {
  const [state, setState] = useState({ loading: true, connected: false, markets: [] });

  const refresh = useCallback(async () => {
    const runtime = typeof window !== 'undefined' ? (window.dwella || window.electronAPI) : null;
    const getBars = runtime?.getMarketBars;
    const fetchBars = typeof getBars === 'function'
      ? getBars
      : async (symbol, timeframe, count) => {
        const params = new URLSearchParams({ symbol, timeframe, count: String(count) });
        const payload = await requestJson(`/market/bars?${params.toString()}`);
        if (!payload?.ok || !Array.isArray(payload.bars)) throw new Error(payload?.error || 'TradingView live data is unavailable.');
        return payload;
      };

    const markets = await Promise.all(MARKETS.map(async (market) => {
      try {
        const payload = await fetchBars(market.id, '5', 80);
        const bars = (Array.isArray(payload?.bars) ? payload.bars : []).filter((bar) => Number.isFinite(Number(bar?.c)));
        const last = bars.at(-1)?.c ?? null;
        const previous = bars.at(-2)?.c ?? last;
        const change = last != null && previous ? ((Number(last) - Number(previous)) / Number(previous)) * 100 : null;
        return { ...market, bars, last: last == null ? null : Number(last), change, error: '' };
      } catch (error) {
        return { ...market, bars: [], last: null, change: null, error: error?.message || 'Feed unavailable' };
      }
    }));

    setState({ loading: false, connected: markets.some((market) => market.last != null), markets });
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return { ...state, refresh };
}

function DwellaMark({ label = true }) {
  return (
    <span className={`brand-mark${label ? ' has-label' : ''}`} aria-label="Dwella">
      <span className="brand-orbit" aria-hidden="true"><i /><i /><i /></span>
      {label && <span className="brand-word">DWELLA</span>}
    </span>
  );
}

function App() {
  useEffect(() => {
    // The TradingView iframe posts 'dwella-view-ready' when the first
    // screenshot arrives. Until then, the .remote-view gets the
    // 'remote-frame-loading' class so the user sees an explicit status
    // instead of a blank canvas.
    const onViewReady = (event) => {
      if (event.data?.type !== 'dwella-view-ready') return;
      document.querySelectorAll('.remote-view').forEach((remote) => {
        remote.classList.remove('remote-frame-loading');
      });
    };
    window.addEventListener('message', onViewReady, false);

    // Mark every .remote-view that appears as loading so the CSS overlay
    // fires immediately (before the iframe posts its ready signal).
    const markLoading = () => {
      document.querySelectorAll('.remote-view').forEach((remote) => {
        if (!remote.querySelector('iframe')) return;
        remote.classList.add('remote-frame-loading');
      });
    };
    markLoading();
    const frameObserver = new MutationObserver(markLoading);
    frameObserver.observe(document.body, { childList: true, subtree: true });

    const sync = () => {
      const standalone = isStandaloneDisplay();
      document.documentElement.classList.toggle('dwella-standalone', standalone);
      document.body.classList.toggle('dwella-standalone', standalone);
    };
    sync();
    const media = window.matchMedia?.('(display-mode: standalone)');
    media?.addEventListener?.('change', sync);
    return () => {
      window.removeEventListener('message', onViewReady);
      frameObserver.disconnect();
      media?.removeEventListener?.('change', sync);
    };
  }, []);

  return <LocalDwellaApp />;
}

function LocalDwellaApp() {
  const [auth, setAuth] = useState({ status: 'checking', user: null });
  const [showLogin, setShowLogin] = useState(false);
  const [appearance, setAppearance] = useState(loadAppearance);
  const [devicePairing, setDevicePairing] = useState(loadDevicePairing);

  useEffect(() => {
    try { window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); } catch { /* ignore unavailable storage */ }
  }, [appearance]);

  useEffect(() => {
    const bootStart = Date.now();
    const MIN_LOAD_MS = 2200;
    const token = sessionToken();

    const resolve = (user) => {
      const elapsed = Date.now() - bootStart;
      const remaining = Math.max(0, MIN_LOAD_MS - elapsed);
      setTimeout(() => {
        setAuth({ status: 'authenticated', user: user || { username: 'preview', display_name: 'Preview workspace', preview: true } });
      }, remaining);
    };

    if (!token) {
      resolve(null);
      return undefined;
    }
    let active = true;
    requestJson(`${AUTH_API_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then((payload) => {
        if (active) resolve(payload.user);
      })
      .catch(() => {
        try { window.sessionStorage.removeItem('dwella-auth-token'); } catch { /* ignore */ }
        if (active) resolve(null);
      });
    return () => { active = false; };
  }, []);

  const completeAuth = ({ user, token, preview = false }) => {
    if (token && !preview) {
      try { window.sessionStorage.setItem('dwella-auth-token', token); } catch { /* ignore */ }
    }
    setAuth({ status: 'authenticated', user: user || { username: 'preview', display_name: 'Preview workspace', preview: true } });
    setShowLogin(false);
  };

  const logout = () => {
    const token = sessionToken();
    if (token) requestJson(`${AUTH_API_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    try { window.sessionStorage.removeItem('dwella-auth-token'); } catch { /* ignore */ }
    setAuth({ status: 'authenticated', user: { username: 'preview', display_name: 'Preview workspace', preview: true } });
  };

  const requestLogin = useCallback(() => {
    if (auth.user?.preview) {
      setShowLogin(true);
      return false; // indicates auth is needed
    }
    return true; // already authenticated
  }, [auth.user]);

  return (
    <>
      <AnimatePresence mode="wait">
        {auth.status === 'checking' ? (
          <motion.div key="loading" exit={{ opacity: 0, scale: .96, filter: 'blur(8px)' }} transition={{ duration: .45, ease: [0.22, 1, .36, 1] }}>
            <LoadingScreen appearance={appearance} />
          </motion.div>
        ) : (
          <motion.div className="app-motion-stage" key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .5, ease: [0.22, 1, .36, 1] }}>
            <Dashboard user={auth.user} onLogout={logout} requestLogin={requestLogin} appearance={appearance} onAppearanceChange={setAppearance} devicePairing={devicePairing} onDevicePairingChange={setDevicePairing} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showLogin && (
          <LoginSheet onSuccess={completeAuth} onClose={() => setShowLogin(false)} />
        )}
      </AnimatePresence>
    </>
  );
}

function LoadingScreen({ appearance }) {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState(0);
  const phases = ['SECURE SESSION', 'SYNC LIVE PATH', 'OPEN WORKSPACE'];

  useEffect(() => {
    if (reduceMotion) return undefined;
    const timer = window.setInterval(() => setPhase((current) => Math.min(current + 1, phases.length - 1)), 720);
    return () => window.clearInterval(timer);
  }, [reduceMotion, phases.length]);

  const progress = reduceMotion ? 1 : (phase + 1) / phases.length;

  return (
    <div className={`auth-page loading-page windows-loading ${appearanceClassName(appearance)}`} style={appearanceStyle(appearance)} role="status" aria-live="polite">
      <div className="windows-wallpaper" aria-hidden="true"><span /><span /><span /><i /></div>
      <motion.div
        className="windows-login-window"
        initial={reduceMotion ? false : { opacity: 0, y: 18, scale: .97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 180, damping: 24, mass: .8 }}
      >
        <div className="windows-titlebar"><span className="windows-title-brand"><b>DW</b><span>DWELLA CONTROL ROOM</span></span><span className="windows-controls" aria-hidden="true"><i>−</i><i>□</i><i>×</i></span></div>
        <div className="windows-login-content">
          <motion.div className="windows-login-avatar" animate={reduceMotion ? undefined : { boxShadow: ['0 0 0 0 rgba(217,255,79,.2)', '0 0 0 12px rgba(217,255,79,0)', '0 0 0 0 rgba(217,255,79,0)'] }} transition={{ duration: 2.4, repeat: Infinity }}><DwellaMark label={false} /></motion.div>
          <span className="windows-login-kicker">PRIVATE WORKSPACE</span>
          <h1>Welcome back.</h1>
          <p>Preparing your secure command center.</p>
          <div className="windows-status-field"><span>SESSION STATUS</span><strong><i />{phases[phase]}</strong><motion.b animate={reduceMotion ? undefined : { rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} aria-hidden="true" /></div>
          <div className="windows-progress" aria-hidden="true"><motion.span initial={{ scaleX: 0 }} animate={{ scaleX: progress }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} /></div>
          <div className="windows-session-meta"><span><ShieldCheck size={13} />Encrypted session</span><span>DW / 02.26</span></div>
        </div>
      </motion.div>
      <div className="windows-loading-footer"><span><i />Dwella workspace</span><span>{phases[phase]}<b>···</b></span></div>
    </div>
  );
}

function AuthScreen({ onSuccess }) {
  const reduceMotion = useReducedMotion();
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 80);
    return () => window.clearTimeout(t);
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!username.trim() || password.length < (registering ? 6 : 1)) return;
    setBusy(true);
    setError('');
    try {
      const payload = await requestJson(`${AUTH_API_URL}/auth/${registering ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), email: email.trim(), display_name: displayName.trim(), password }),
      });
      onSuccess({ user: payload.user, token: payload.token });
    } catch (requestError) {
      setError(requestError?.name === 'AbortError' ? 'The local auth service did not respond.' : requestError?.message || 'Could not open your session.');
    } finally {
      setBusy(false);
    }
  };

  const reveal = (delay = 0) => reduceMotion ? {} : { initial: { opacity: 0, y: 22, filter: 'blur(6px)' }, animate: entered ? { opacity: 1, y: 0, filter: 'blur(0px)' } : {}, transition: { type: 'spring', stiffness: 140, damping: 22, mass: .8, delay } };
  const slideRight = (delay = 0) => reduceMotion ? {} : { initial: { opacity: 0, x: 40 }, animate: entered ? { opacity: 1, x: 0 } : {}, transition: { type: 'spring', stiffness: 120, damping: 20, delay } };
  const scaleIn = (delay = 0) => reduceMotion ? {} : { initial: { opacity: 0, scale: .92 }, animate: entered ? { opacity: 1, scale: 1 } : {}, transition: { type: 'spring', stiffness: 160, damping: 20, delay } };

  return (
    <div className="auth-page">
      <div className="auth-grid-lines" aria-hidden="true" />
      <motion.div className="auth-layout" {...scaleIn(0)}>
        <section className="auth-story">
          <motion.div className="auth-brand" {...reveal(.08)}><DwellaMark /><span className="system-tag">PRIVATE MONEY OS · 02.26</span></motion.div>
          <div className="auth-story-copy">
            <motion.span className="eyebrow" {...reveal(.18)}><i />TRADING WORKSPACE</motion.span>
            <motion.h1 {...reveal(.28)}>Make room<br />for <GradientText text="better" /><br />decisions.</motion.h1>
            <motion.p {...reveal(.38)}>Live market context, research, and controlled execution — together in one calm command center.</motion.p>
          </div>
          <motion.div className="story-foot" {...reveal(.5)}><span>DWELLA / CONTROL ROOM</span><span>01 — 05</span></motion.div>
        </section>
        <section className="auth-card">
          <motion.div className="auth-card-top" {...reveal(.12)}><motion.span {...slideRight(.16)}>{registering ? 'CREATE ACCESS' : 'WELCOME BACK'}</motion.span><motion.span className="secure-label" {...slideRight(.22)}><ShieldCheck size={13} />LOCAL SESSION</motion.span></motion.div>
          <motion.div className="auth-card-copy" {...reveal(.2)}>
            <AnimatePresence mode="wait">
              <motion.h2 key={registering ? 'reg' : 'login'} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ type: 'spring', stiffness: 200, damping: 22 }}>{registering ? 'Create your workspace.' : 'Enter your workspace.'}</motion.h2>
            </AnimatePresence>
            <AnimatePresence mode="wait">
              <motion.p key={registering ? 'reg-p' : 'login-p'} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ type: 'spring', stiffness: 180, damping: 22, delay: .04 }}>{registering ? 'Your local account protects access to Dwella. TradingView credentials stay on TradingView.' : 'Sign in before opening account connections or trading controls.'}</motion.p>
            </AnimatePresence>
          </motion.div>
          <motion.form className="auth-form" onSubmit={submit} {...reveal(.3)}>
            <AnimatePresence initial={false}>
              {registering && (
                <motion.label key="reg-dn" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 24 }}><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex Smith" autoComplete="name" /></motion.label>
              )}
            </AnimatePresence>
            <motion.label {...reveal(.34)}><span>{registering ? 'Username' : 'Username or email'}</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="your handle" autoComplete="username" autoFocus /></motion.label>
            <AnimatePresence initial={false}>
              {registering && (
                <motion.label key="reg-email" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 24 }}><span>Email <small>optional</small></span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" /></motion.label>
              )}
            </AnimatePresence>
            <motion.label {...reveal(.38)}><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={registering ? 'At least 6 characters' : 'Your private password'} autoComplete={registering ? 'new-password' : 'current-password'} /></motion.label>
            <AnimatePresence initial={false}>
              {error && <motion.div className="form-error" role="alert" initial={{ opacity: 0, y: -8, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: .96 }} transition={{ type: 'spring', stiffness: 240, damping: 22 }}><CircleAlert size={15} />{error}<small>Make sure the paired Dwella preview is running.</small></motion.div>}
            </AnimatePresence>
            <motion.button className="button button-lime auth-submit" type="submit" disabled={busy || !username.trim() || password.length < (registering ? 6 : 1)} whileHover={reduceMotion ? undefined : { scale: 1.02, y: -1 }} whileTap={reduceMotion ? undefined : { scale: .97 }} transition={{ type: 'spring', stiffness: 400, damping: 25 }}>{busy ? (
              <><motion.span animate={{ opacity: [1, .4, 1] }} transition={{ duration: 1.2, repeat: Infinity }}>Opening session…</motion.span></>
            ) : (
              <>{registering ? 'Create local account' : 'Sign in'}<ArrowRight size={16} /></>
            )}</motion.button>
          </motion.form>
          <motion.button className="text-link auth-switch" onClick={() => { setRegistering((value) => !value); setError(''); }} {...reveal(.44)}>New here? Create an account</motion.button>
          <motion.div className="auth-divider" {...reveal(.48)}><span>OR</span></motion.div>
          <motion.button className="button button-ghost preview-button" onClick={() => onSuccess({ preview: true, user: { username: 'preview', display_name: 'Preview workspace', preview: true } })} {...reveal(.52)} whileHover={reduceMotion ? undefined : { scale: 1.02, y: -1 }} whileTap={reduceMotion ? undefined : { scale: .97 }}><Eye size={15} />Open read-only preview</motion.button>
          <motion.small className="preview-note" {...reveal(.56)}>Preview mode never connects to TradingView or places orders.</motion.small>
        </section>
      </motion.div>
    </div>
  );
  }

function LoginSheet({ onSuccess, onClose }) {
  const reduceMotion = useReducedMotion();
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (!username.trim() || password.length < (registering ? 6 : 1)) return;
    setBusy(true);
    setError('');
    try {
      const payload = await requestJson(`${AUTH_API_URL}/auth/${registering ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), email: email.trim(), display_name: displayName.trim(), password }),
      });
      onSuccess({ user: payload.user, token: payload.token });
    } catch (requestError) {
      setError(requestError?.name === 'AbortError' ? 'The local auth service did not respond.' : requestError?.message || 'Could not open your session.');
    } finally {
      setBusy(false);
    }
  };

  const sheetIn = reduceMotion ? {} : { initial: { opacity: 0, y: '100%' }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: '100%' } };
  const backdropIn = reduceMotion ? {} : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };

  return (
    <div className="login-sheet-overlay">
      <motion.div className="login-sheet-backdrop" {...backdropIn} transition={{ duration: .2 }} onClick={onClose} />
      <motion.div className="login-sheet" {...sheetIn} transition={{ type: 'spring', stiffness: 260, damping: 28 }}>
        <div className="login-sheet-header">
          <div className="login-sheet-brand"><DwellaMark label={false} /><span>SIGN IN</span></div>
          <button className="login-sheet-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="login-sheet-body">
          <p className="login-sheet-sub">Sign in to place live trades and connect your TradingView account.</p>
          <form className="auth-form login-sheet-form" onSubmit={submit}>
            <AnimatePresence initial={false}>
              {registering && (
                <motion.label key="reg-dn" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 24 }}><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Alex Smith" autoComplete="name" /></motion.label>
              )}
            </AnimatePresence>
            <label><span>{registering ? 'Username' : 'Username or email'}</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="your handle" autoComplete="username" autoFocus /></label>
            <AnimatePresence initial={false}>
              {registering && (
                <motion.label key="reg-email" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 24 }}><span>Email <small>optional</small></span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" /></motion.label>
              )}
            </AnimatePresence>
            <label><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={registering ? 'At least 6 characters' : 'Your private password'} autoComplete={registering ? 'new-password' : 'current-password'} /></label>
            {error && <div className="form-error" role="alert"><CircleAlert size={15} />{error}</div>}
            <button className="button button-lime auth-submit" type="submit" disabled={busy || !username.trim() || password.length < (registering ? 6 : 1)}>{busy ? 'Opening session…' : registering ? 'Create account' : 'Sign in'}<ArrowRight size={16} /></button>
          </form>
          <button className="text-link auth-switch" onClick={() => { setRegistering((value) => !value); setError(''); }}>{registering ? 'Already have access? Sign in' : 'New here? Create an account'}</button>
        </div>
      </motion.div>
    </div>
  );
}

function Dashboard({ user, onLogout, requestLogin, appearance, onAppearanceChange, devicePairing, onDevicePairingChange }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const toastTimer = useRef(null);
  const scrollRef = useRef(null);
  const displayName = user?.display_name || user?.username || 'Trader';
  const shortName = displayName.split(/\s+/)[0] || 'Trader';

  const announce = useCallback((message) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  const navigate = useCallback((tab) => {
    if (!TAB_IDS.includes(tab)) return;
    setActiveTab(tab);
    setMenuOpen(false);
    try {
      const url = new URL(window.location.href);
      if (tab === 'home') url.searchParams.delete('tab');
      else url.searchParams.set('tab', tab);
      window.history.replaceState({}, '', url);
    } catch { /* embedded webview */ }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen?.();
      else await document.documentElement.requestFullscreen?.();
    } catch {
      announce('Full-screen was blocked. Add Dwella to your Home Screen for app mode.');
    }
  };

  const currentTab = ALL_TABS.find((tab) => tab.id === activeTab) || TABS[0];
  return (
    <div className={`app-stage ${appearanceClassName(appearance)}`} style={appearanceStyle(appearance)}>
      <div className="trading-shell">
        <aside className="desktop-sidebar">
          <div className="sidebar-brand"><DwellaMark /><span className="sidebar-version">DESK / 01</span></div>
          <div className="sidebar-section-label">WORKSPACE</div>
          <nav className="sidebar-nav" aria-label="Workspace navigation">{TABS.map((tab) => <NavButton key={tab.id} tab={tab} active={activeTab === tab.id} indicatorId="sidebar-nav-active" onClick={() => navigate(tab.id)} />)}</nav>
          <div className="sidebar-settings"><NavButton tab={SETTINGS_TAB} active={activeTab === SETTINGS_TAB.id} indicatorId="sidebar-settings-active" onClick={() => navigate(SETTINGS_TAB.id)} /><NavButton tab={SCRIPTURE_TAB} active={activeTab === SCRIPTURE_TAB.id} indicatorId="sidebar-scripture-active" onClick={() => navigate(SCRIPTURE_TAB.id)} /></div>
          <div className="sidebar-spacer" />
          <div className="sidebar-status"><div className="status-line"><span className={`live-dot${devicePairing?.pairedAt ? ' paired' : ''}`} />{devicePairing?.pairedAt ? 'DEVICE PAIRED' : 'LIVE DATA PATH'}</div><strong>{devicePairing?.pairedAt ? devicePairing.device : 'TradingView'}</strong><small>{devicePairing?.pairedAt ? 'Live prices active' : 'Paper-first execution'}</small></div>
          <button className="sidebar-user" onClick={() => announce(`Signed in as ${displayName}.`)}><span className="avatar">{initialsForUser(user)}</span><span><strong>{displayName}</strong><small>Local account</small></span><ChevronRight size={15} /></button>
        </aside>
        <div className="workspace-shell">
          <header className="workspace-header">
            <button className="mobile-menu" onClick={() => setMenuOpen((value) => !value)} aria-label="Open workspace menu"><Menu size={19} /></button>
            <div className="mobile-brand"><DwellaMark label={false} /><span>DWELLA</span></div>
            <div className="header-context"><span className="header-kicker">{currentTab.label.toUpperCase()} / {currentTab.description.toUpperCase()}</span><h2>{currentTab.label}</h2></div>
            <div className="header-actions"><span className="header-mode"><i />PAPER / LIVE FEED</span><button className="header-icon settings-icon" onClick={() => navigate(SETTINGS_TAB.id)} aria-label="Open settings" title="Open settings"><Settings2 size={17} /></button><button className="header-icon" onClick={toggleFullscreen} aria-label="Toggle full screen" title="Toggle full screen"><Maximize2 size={17} /></button><button className="header-icon" onClick={() => announce('No new alerts.')} aria-label="Notifications"><Bell size={17} /><b /></button><button className="header-icon logout-icon" onClick={onLogout} aria-label="Sign out"><LogOut size={17} /></button></div>
          </header>
          <AnimatePresence initial={false}>
            {menuOpen && <motion.div className="mobile-menu-panel" initial={{ opacity: 0, height: 0, y: -8 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={{ opacity: 0, height: 0, y: -8 }} transition={{ type: 'spring', stiffness: 330, damping: 30 }}>{TABS.map((tab) => <NavButton key={tab.id} tab={tab} active={activeTab === tab.id} indicatorId="mobile-menu-active" onClick={() => navigate(tab.id)} />)}<div className="mobile-menu-divider" /><NavButton tab={SETTINGS_TAB} active={activeTab === SETTINGS_TAB.id} indicatorId="mobile-menu-settings-active" onClick={() => navigate(SETTINGS_TAB.id)} /><NavButton tab={SCRIPTURE_TAB} active={activeTab === SCRIPTURE_TAB.id} indicatorId="mobile-menu-scripture-active" onClick={() => navigate(SCRIPTURE_TAB.id)} /></motion.div>}
          </AnimatePresence>
          <main className="workspace-scroll" ref={scrollRef}>
            <AnimatePresence mode="wait">
              <motion.div key={activeTab} className="view-transition" initial={{ opacity: 0, y: 18, filter: 'blur(8px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -10, filter: 'blur(5px)' }} transition={{ type: 'spring', stiffness: 250, damping: 29, mass: .72 }}>
                {activeTab === 'home' && <ReferenceDeskView userName={shortName} navigate={navigate} announce={announce} />}
                {activeTab === 'history' && <ActivityView navigate={navigate} announce={announce} />}
                {activeTab === 'insights' && <InsightsView navigate={navigate} announce={announce} />}
                {activeTab === 'backtest' && <ResearchView announce={announce} />}
                {activeTab === 'trade' && <TradeView announce={announce} requestLogin={requestLogin} />}
                {activeTab === SETTINGS_TAB.id && <SettingsView appearance={appearance} onChange={onAppearanceChange} devicePairing={devicePairing} onDevicePairingChange={onDevicePairingChange} />}
                {activeTab === SCRIPTURE_TAB.id && <ScriptureView announce={announce} />}
              </motion.div>
            </AnimatePresence>
          </main>
          <MobileNav activeTab={activeTab} onClick={navigate} />
        </div>
      </div>
      <AnimatePresence initial={false}>
        {toast && <motion.div className="toast" role="status" aria-live="polite" initial={{ opacity: 0, y: 18, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: .96 }} transition={{ type: 'spring', stiffness: 330, damping: 25 }}><Check size={15} />{toast}</motion.div>}
      </AnimatePresence>
    </div>
  );
}

function NavButton({ tab, active, onClick, indicatorId = 'workspace-nav-active' }) {
  const Icon = tab.icon;
  return <button className={`nav-button${active ? ' active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}><span className="nav-icon"><Icon size={17} strokeWidth={active ? 2.2 : 1.7} /></span><span><strong>{tab.label}</strong><small>{tab.description}</small></span>{active && <motion.i layoutId={indicatorId} transition={{ type: 'spring', stiffness: 520, damping: 36 }} />}</button>;
}

function MobileNav({ activeTab, onClick }) {
  return <nav className="mobile-nav" aria-label="Primary navigation">{TABS.map((tab) => { const Icon = tab.icon; const active = activeTab === tab.id; return <button key={tab.id} className={active ? 'active' : ''} onClick={() => onClick(tab.id)} aria-label={tab.label} aria-current={active ? 'page' : undefined} title={tab.label}><Icon size={20} strokeWidth={active ? 2.25 : 1.8} /><span className="mobile-nav-label">{tab.label}</span>{active && <motion.i className="mobile-nav-indicator" layoutId="mobile-nav-active" transition={{ type: 'spring', stiffness: 520, damping: 36 }} />}</button>; })}</nav>;
}

function PageHeader({ eyebrow, title, children, status = 'neutral' }) {
  return <div className="page-header"><div><span className={`eyebrow ${status}`}><i />{eyebrow}</span><h1>{title}</h1></div>{children}</div>;
}

function ReferenceDeskView({ userName, navigate, announce }) {
  const market = useLiveMarkets();
  const paper = loadPaper();
  const liveCount = market.markets.filter((item) => item.last != null).length;
  const chartValues = market.markets.find((item) => item.id === 'NQ')?.bars?.map((bar) => Number(bar.c)).filter(Number.isFinite).slice(-28) || [];
  const balanceRatio = paper.balance > 0 ? Math.min(100, (paper.balance / PAPER_START) * 100) : 0;
  const go = (tab, message) => { navigate(tab); if (message) announce(message); };

  const [word, setWord] = useState(null);
  const [wordLoading, setWordLoading] = useState(true);
  const loadWord = useCallback(() => {
    let cancelled = false;
    setWordLoading(true);
    fetch('https://bible-api.com/?random=verse')
      .then((response) => response.json())
      .then((data) => { if (cancelled) return; setWord({ reference: data?.reference || FALLBACK_WORD.reference, text: (data?.verses?.[0]?.text || '').replace(/\s+/g, ' ').trim() || FALLBACK_WORD.text }); })
      .catch(() => { if (!cancelled) setWord(FALLBACK_WORD); })
      .finally(() => { if (!cancelled) setWordLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { void loadWord(); }, [loadWord]);
  const displayedWord = word || FALLBACK_WORD;

  return (
    <div className="page desk-page reference-dashboard">
      <div className="reference-top-nav">
        <div className="reference-nav-brand"><DwellaMark label={false} /></div>
        <nav className="reference-nav-links" aria-label="Overview navigation">
          <button className="active" onClick={() => go('home')}>Home</button>
          <button onClick={() => go('history', 'Opening revenue activity.')}>Revenue</button>
          <button onClick={() => go('insights', 'Opening the market forecast.')}>Forecast</button>
          <button onClick={() => go('history', 'Opening transactions.')}>Transactions</button>
          <button onClick={() => go('insights', 'Opening customer context.')}>Customers</button>
          <button onClick={() => go('backtest', 'Opening automation research.')}>Automation</button>
          <button onClick={() => go('history', 'Opening workspace reports.')}>Reports</button>
        </nav>
        <div className="reference-top-actions"><button onClick={() => announce('Search is ready.')} aria-label="Search">⌕</button><button onClick={() => announce('No new notifications.')} aria-label="Notifications">♧</button><span className="reference-avatar">{userName.slice(0, 2).toUpperCase()}</span></div>
      </div>

      <div className="reference-overview-head">
        <div><span className={`eyebrow ${market.connected ? 'good' : 'warm'}`}><i />{market.loading ? 'SYNCING LIVE WORKSPACE' : market.connected ? `${liveCount} MARKETS ONLINE` : 'PAPER WORKSPACE'}</span><h1>Overview <button className="reference-link-button" onClick={() => announce('Overview link copied.')} aria-label="Copy overview link">↗</button></h1></div>
        <div className="reference-controls"><button className="reference-control" onClick={() => announce('Showing the current date range.')}>▣ <span>Jan 01 — Jul 31</span><b>⌄</b></button><span className="reference-compare">compared to</span><button className="reference-control" onClick={() => announce('Comparison period selected.')}>▣ <span>Aug 01 — Dec 31</span><b>⌄</b></button><button className="reference-control compact" onClick={() => announce('Daily view selected.')}>Daily <b>⌄</b></button><button className="reference-control add" onClick={() => announce('Dashboard widget menu opened.')}>Add widget <strong>＋</strong></button></div>
      </div>

      <section className="reference-grid" aria-label="Workspace overview cards">
        <article className="reference-card reference-retention reveal">
          <ReferenceCardHeader title="Retention" />
          <div className="reference-chart reference-retention-chart"><ReferenceBars values={chartValues} accent="pink" empty="WAITING FOR LIVE BARS" /></div>
          <div className="reference-axis"><span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span></div>
        </article>

        <article className="reference-card reference-kpi reference-transactions reveal reveal-delay-1">
          <ReferenceCardHeader title="Transactions" /><div className="reference-kpi-body"><strong>{paper.closed.length || '—'}</strong><ReferenceDots values={chartValues} /><span className="reference-kpi-delta"><small>vs last period</small><b>{paper.closed.length ? `+${paper.closed.length}` : '—'}</b></span></div>
        </article>
        <article className="reference-card reference-kpi reveal reveal-delay-2">
          <ReferenceCardHeader title="Customers" /><div className="reference-kpi-body"><strong>{paper.positions.length || '—'}</strong><ReferenceDots values={chartValues.slice().reverse()} /><span className="reference-kpi-delta"><small>open positions</small><b>{paper.positions.length || '—'}</b></span></div>
        </article>

        <article className="reference-card reference-volume reveal reveal-delay-1">
          <ReferenceCardHeader title="Gross Volume" /><div className="reference-volume-value"><CountingNumber number={paper.balance} format={formatMoney} /><span className="reference-percent">{balanceRatio ? 'PAPER' : 'WAITING'}</span></div><div className="reference-progress-list"><ReferenceProgress label="Paper balance" value={balanceRatio} color="lime" detail={formatMoney(paper.balance)} /><ReferenceProgress label="Open positions" value={Math.min(100, paper.positions.length * 12)} color="blue" detail={String(paper.positions.length)} /><ReferenceProgress label="Closed trades" value={Math.min(100, paper.closed.length * 12)} color="pink" detail={String(paper.closed.length)} /></div>
        </article>

        <article className="reference-card reference-payments reference-word reveal reveal-delay-2">
          <ReferenceCardHeader title="Word of God" /><div className="reference-word-body"><blockquote>{wordLoading ? 'Seeking today’s word…' : `“${displayedWord.text}”`}</blockquote><cite>{displayedWord.reference}</cite></div><div className="reference-query"><span>Let the Word guide your decisions.</span><button onClick={() => { void loadWord(); announce('A new word for today.'); }}>Another verse <b>↗</b></button><button onClick={() => go('scripture', 'Opening Scripture.')}>Open the Bible <b>↗</b></button></div></article>

        <article className="reference-card reference-insight reveal reveal-delay-3"><span className="reference-insight-badge">✧ Insights</span><strong>{market.connected ? `${liveCount}/${market.markets.length}` : '—'}</strong><h2>Markets are ready<br />when you are.</h2><p>Review live context, validate a thesis, and keep execution deliberate.</p><div className="reference-insight-line" /><button onClick={() => go('trade', 'Opening Trade.')}>Open Trade <ArrowRight size={14} /></button></article>
      </section>

      <div className="reference-footer"><span><i />PAPER-FIRST CONTROL ROOM · {userName.toUpperCase()}</span><button onClick={() => { void market.refresh(); announce('Refreshing live TradingView bars.'); }}><RefreshCw size={13} />Refresh data</button></div>
    </div>
  );
}

function ReferenceCardHeader({ title }) {
  return <div className="reference-card-header"><h2>{title}</h2><button onClick={() => {}} aria-label={`${title} options`}>•••</button></div>;
}

function ReferenceBars({ values, accent = 'lime', empty = 'NO DATA' }) {
  if (!values.length) return <div className="reference-bars-empty">{empty}</div>;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  return <div className={`reference-bars accent-${accent}`} aria-hidden="true">{values.map((value, index) => <i key={`${value}-${index}`} style={{ height: `${Math.max(12, ((value - low) / span) * 88 + 8)}%` }} />)}</div>;
}

function ReferenceDots({ values }) {
  const count = Math.max(18, Math.min(30, values.length || 24));
  return <span className="reference-dots" aria-hidden="true">{Array.from({ length: count }, (_, index) => <i key={index} className={(index + (values.length || 0)) % 5 === 0 || index > count - 5 ? 'hot' : ''} />)}</span>;
}

function ReferenceProgress({ label, value, color, detail }) {
  return <div className="reference-progress"><div><span>{label}</span><b>{detail}</b></div><span className="reference-progress-track"><i className={`accent-${color}`} style={{ width: `${value}%` }} /></span></div>;
}

function ScriptureView({ announce }) {
  const [prefs, setPrefs] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(SCRIPTURE_KEY) || 'null');
      const book = Number(stored?.book);
      const chapter = Number(stored?.chapter);
      if (BIBLE_BOOKS[book - 1] && chapter >= 1) {
        return { translation: BIBLE_TRANSLATIONS.some((t) => t.id === stored?.translation) ? stored.translation : 'kjv', book, chapter };
      }
    } catch { /* defaults */ }
    return { translation: 'kjv', book: 43, chapter: 3 };
  });
  const [chapterData, setChapterData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [daily, setDaily] = useState(null);
  const [dailyLoading, setDailyLoading] = useState(true);

  const bookName = BIBLE_BOOKS[prefs.book - 1] || 'John';
  const chapterCount = BIBLE_CHAPTERS[prefs.book - 1] || 1;
  const translationName = BIBLE_TRANSLATIONS.find((t) => t.id === prefs.translation)?.name || 'King James Version';

  useEffect(() => { try { window.localStorage.setItem(SCRIPTURE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }, [prefs]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setChapterData(null);
    fetch(`https://api.getbible.net/v2/${prefs.translation}/${prefs.book}/${prefs.chapter}.json`)
      .then((response) => { if (!response.ok) throw new Error('Chapter unavailable.'); return response.json(); })
      .then((data) => { if (cancelled) return; setChapterData({ verses: data.verses || [], title: data.name || `${bookName} ${prefs.chapter}` }); setLoading(false); })
      .catch((err) => { if (cancelled) return; setError(err?.message || 'Could not load the chapter.'); setLoading(false); });
    return () => { cancelled = true; };
  }, [prefs.translation, prefs.book, prefs.chapter, bookName, nonce]);

  const refreshDaily = useCallback(() => {
    let cancelled = false;
    setDailyLoading(true);
    fetch('https://bible-api.com/?random=verse')
      .then((response) => response.json())
      .then((data) => { if (cancelled) return; setDaily({ reference: data?.reference || '', text: (data?.verses?.[0]?.text || '').replace(/\s+/g, ' ').trim() || '' }); })
      .catch(() => { if (!cancelled) setDaily(null); })
      .finally(() => { if (!cancelled) setDailyLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { void refreshDaily(); }, [refreshDaily]);

  const goBook = (id) => { setPrefs((current) => ({ ...current, book: Number(id), chapter: 1 })); };
  const goChapter = (n) => { setPrefs((current) => ({ ...current, chapter: n })); };
  const stepChapter = (delta) => goChapter(Math.min(chapterCount, Math.max(1, prefs.chapter + delta)));

  return (
    <div className="page scripture-page">
      <PageHeader eyebrow="SCRIPTURE" title="Read the Word." status="neutral"><span className="page-badge"><BookOpen size={14} />BIBLE READING</span></PageHeader>
      <p className="page-lede">A calm reader for the Bible. Public-domain translations load free from an open API — no account, no tracking, and your reading position stays on this device.</p>

      <section className="daily-verse panel-dark reveal"><div className="daily-verse-head"><span className="eyebrow"><i />VERSE OF THE DAY</span><button onClick={() => { void refreshDaily(); announce('A new verse for today.'); }} aria-label="New verse" title="New verse"><RefreshCw size={14} className={dailyLoading ? 'spin' : ''} /></button></div>{dailyLoading ? <div className="daily-verse-loading">Seeking today's verse…</div> : daily ? <blockquote>“{daily.text}”<cite>{daily.reference}</cite></blockquote> : <div className="daily-verse-loading">Verse unavailable right now — check your connection.</div>}</section>

      <section className="scripture-controls panel reveal reveal-delay-1"><label className="scripture-select"><span>TRANSLATION</span><select value={prefs.translation} onChange={(event) => setPrefs((current) => ({ ...current, translation: event.target.value }))}>{BIBLE_TRANSLATIONS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label className="scripture-select"><span>BOOK</span><select value={prefs.book} onChange={(event) => goBook(event.target.value)}>{BIBLE_BOOKS.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></label></section>

      <nav className="chapter-pills panel reveal reveal-delay-2" aria-label={`${bookName} chapters`}>{Array.from({ length: chapterCount }, (_, index) => <button key={index + 1} className={prefs.chapter === index + 1 ? 'active' : ''} onClick={() => goChapter(index + 1)}>{index + 1}</button>)}</nav>

      <section className="panel chapter-panel reveal reveal-delay-3"><div className="chapter-heading"><div><span className="eyebrow">{translationName.toUpperCase()}</span><h2>{chapterData?.title || `${bookName} ${prefs.chapter}`}</h2></div><div className="chapter-nav"><button onClick={() => stepChapter(-1)} disabled={prefs.chapter <= 1}><ChevronLeft size={15} />Prev</button><button onClick={() => stepChapter(1)} disabled={prefs.chapter >= chapterCount}>Next<ArrowRight size={15} /></button></div></div>{loading && <div className="chapter-loading"><BookOpen size={18} />Loading {bookName} {prefs.chapter}…</div>}{!loading && error && <div className="empty-state"><span><CircleAlert size={19} /></span><strong>Chapter unavailable</strong><p>{error}</p><button className="button button-soft" onClick={() => setNonce((value) => value + 1)}>Try again</button></div>}{!loading && !error && chapterData && <div className="chapter-text">{chapterData.verses.map((verse) => <p key={verse.verse} className="verse"><sup>{verse.verse}</sup>{verse.text}</p>)}</div>}</section>

      <p className="disclaimer"><BookOpen size={14} />KJV and WEB are public-domain translations served by the open getbible.net API. Your reading position is saved on this device only.</p>
    </div>
  );
}

function DeskView({ userName, navigate, announce }) {
  const market = useLiveMarkets();
  const paper = loadPaper();
  const liveCount = market.markets.filter((item) => item.last != null).length;
  return (
    <div className="page desk-page">
      <div className="desk-command-row">
        <div className="desk-command-title"><span className="eyebrow">DWELLA / CONTROL ROOM</span><h1>Overview</h1></div>
        <div className="desk-command-actions">
          <button className="command-chip" onClick={() => announce('Showing the current trading window.')}>Last 30 days <span>⌄</span></button>
          <button className="command-chip" onClick={() => announce('Comparison controls are ready.')}>Compare period <span>⌄</span></button>
          <button className="command-chip command-chip-primary" onClick={() => announce('Dashboard widget menu opened.')}>Add widget <b>+</b></button>
        </div>
      </div>
      <section className="desk-hero panel-dark reveal"><div className="hero-grid" aria-hidden="true" /><div className="hero-copy"><span className={`eyebrow ${market.connected ? 'good' : 'warm'}`}><i />{market.loading ? 'CONNECTING TO TRADINGVIEW' : market.connected ? `${liveCount}/${market.markets.length} MARKETS RECEIVING BARS` : 'TRADINGVIEW FEED WAITING'}</span><h1>Good morning,<br /><em>{userName}.</em></h1><p>One deliberate place to read the market, test a thesis, and execute only when the session is ready.</p><div className="hero-actions"><button className="button button-lime" onClick={() => navigate('trade')}><TrendingUp size={16} />Open Trade <ArrowRight size={15} /></button><button className="button button-outline" onClick={() => navigate('backtest')}><Target size={16} />Research a setup</button></div></div><div className="hero-stamp"><span>DW</span><small>CALM<br />EXECUTION</small><b>02<br />26</b></div></section>
      <section className="signal-strip panel reveal reveal-delay-1"><div className="signal-intro"><span className="eyebrow">MARKET PULSE</span><strong>Live context</strong><small>TradingView bars only</small></div>{market.markets.map((item, index) => <MarketTile key={item.id} market={item} index={index} onClick={() => navigate('trade')} />)}</section>
      <section className="desk-columns reveal reveal-delay-2"><article className="panel account-panel"><div className="panel-heading"><div><span className="eyebrow">PAPER ACCOUNT</span><h2>Room to practice.</h2></div><span className="mode-badge"><i />PAPER</span></div><div className="account-balance"><CountingNumber number={paper.balance} format={formatMoney} /></div><div className="account-stats"><span><small>OPEN POSITIONS</small><strong>{paper.positions.length}</strong></span><span><small>CLOSED TRADES</small><strong>{paper.closed.length}</strong></span><span><small>ROUTING</small><strong>GATED</strong></span></div><button className="panel-link" onClick={() => navigate('trade')}>Open order ticket <ArrowRight size={14} /></button></article><article className="panel workflow-panel"><div className="panel-heading"><div><span className="eyebrow">THE ROUTE</span><h2>From signal to order.</h2></div><Wifi size={18} /></div><div className="route-list"><RouteStep number="01" title="Connect" detail="Sign in on TradingView's own page." /><RouteStep number="02" title="Validate" detail="Research with the same live bars." /><RouteStep number="03" title="Execute" detail="Paper first. Live only when armed." /></div></article></section>
      <section className="panel focus-panel reveal reveal-delay-3"><div><span className="eyebrow">WORKSPACE RULE</span><h2>No invented market values.</h2><p>When TradingView is unavailable, the workspace shows a clear waiting state instead of pretending a feed is live.</p></div><button className="button button-soft" onClick={() => { void market.refresh(); announce('Refreshing live TradingView bars.'); }}><RefreshCw size={15} />Refresh feed</button></section>
    </div>
  );
}

function MarketTile({ market, index = 0, onClick }) {
  const reduceMotion = useReducedMotion();
  const values = market.bars.map((bar) => Number(bar.c)).filter(Number.isFinite).slice(-24);
  return <motion.button className="market-tile" onClick={onClick} initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 250, damping: 25, delay: reduceMotion ? 0 : index * .055 }} whileHover={reduceMotion ? undefined : { y: -4, scale: 1.012 }} whileTap={reduceMotion ? undefined : { scale: .985 }}><div className="market-tile-top"><strong><i className={market.last != null ? 'live' : ''} />{market.id}</strong><span className={market.change == null ? 'muted' : market.change >= 0 ? 'positive' : 'negative'}>{market.change == null ? 'waiting' : `${market.change >= 0 ? '+' : ''}${market.change.toFixed(2)}%`}</span></div><small>{market.name}</small><b>{formatPrice(market.last, market.id)}</b><MiniBars values={values} /></motion.button>;
}

function MiniBars({ values }) {
  if (!values.length) return <div className="mini-bars empty">NO BARS</div>;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  return <div className="mini-bars" aria-hidden="true">{values.map((value, index) => <i key={`${value}-${index}`} style={{ height: `${Math.max(14, ((value - low) / span) * 82 + 10)}%` }} />)}</div>;
}

function RouteStep({ number, title, detail }) {
  const reduceMotion = useReducedMotion();
  return <motion.div className="route-step" whileHover={reduceMotion ? undefined : { x: 4 }} transition={{ type: 'spring', stiffness: 380, damping: 28 }}><b>{number}</b><span><strong>{title}</strong><small>{detail}</small></span><Check size={14} /></motion.div>;
}

function ActivityView({ navigate, announce }) {
  const [filter, setFilter] = useState('All');
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ loading: true, error: '' });
  const filters = ['All', 'Open', 'Closed'];

  const refresh = useCallback(async () => {
    setState({ loading: true, error: '' });
    const local = loadPaper();
    const paperRows = [
      ...local.positions.map((item) => ({ ...item, status: 'Open', time: item.openedAt })),
      ...local.closed.map((item) => ({ ...item, status: 'Closed', time: item.closedAt })),
    ];
    try {
      const runtime = window.dwella || window.electronAPI;
      const payload = typeof runtime?.getOrderHistory === 'function' ? await runtime.getOrderHistory() : null;
      if (payload?.ok === false && !paperRows.length) throw new Error(payload.error || 'The execution runtime is unavailable.');
      const remote = Array.isArray(payload?.history) ? payload.history : Array.isArray(payload?.orders) ? payload.orders : [];
      const raw = remote.length ? remote : paperRows;
      setRows(raw.map((item, index) => {
        const side = String(item.side ?? item.action ?? item.type ?? '').toLowerCase();
        const pnl = Number(item.pnl ?? item.profit ?? item.netPnl);
        return { id: item.id ?? item.ticket ?? index, symbol: item.symbol || '—', side: side.includes('sell') || side.includes('short') || side === '1' ? 'SHORT' : 'LONG', status: String(item.status ?? (item.closedAt || item.exit || item.exitPrice ? 'Closed' : 'Open')), pnl: Number.isFinite(pnl) ? pnl : null, price: item.price ?? item.entryPrice ?? item.entry, time: item.closedAt ?? item.time ?? item.timestamp ?? item.openedAt };
      }));
    } catch (error) {
      setRows([]);
      setState({ loading: false, error: error?.message || 'The execution runtime is unavailable.' });
      return;
    }
    setState({ loading: false, error: '' });
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const visible = rows.filter((row) => filter === 'All' || row.status.toLowerCase() === filter.toLowerCase());
  return <div className="page activity-page"><PageHeader eyebrow="EXECUTION LEDGER" title="Activity." status={state.error ? 'warm' : 'neutral'}><button className="button button-soft" onClick={() => { void refresh(); announce('Refreshing the execution ledger.'); }} disabled={state.loading}><RefreshCw size={15} className={state.loading ? 'spin' : ''} />Refresh</button></PageHeader><section className="metric-row"><MetricCard label="RECORDED ORDERS" value={state.loading ? '—' : rows.length} note={state.error ? 'runtime unavailable' : 'current session'} /><MetricCard label="CURRENT VIEW" value={filter} note="filter below" /><MetricCard label="ROUTING" value="PAPER" note="live is gated" /></section><div className="filter-pills" role="tablist" aria-label="Activity filters">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} role="tab" aria-selected={filter === item} onClick={() => setFilter(item)}>{item}</button>)}</div><section className="panel table-panel"><div className="table-heading"><span>ORDER HISTORY</span><span>{visible.length} shown</span></div>{state.error && <EmptyState icon={CircleAlert} title="The runtime is not connected." detail={state.error} action="Try again" onClick={refresh} />}{!state.error && !state.loading && !visible.length && <EmptyState icon={History} title={`No ${filter.toLowerCase()} orders yet.`} detail="Connect TradingView or place a paper order in the Trade workspace." action="Open Trade" onClick={() => navigate('trade')} />}{visible.map((row) => <div className="order-row" key={row.id}><span className={`side-chip ${row.side === 'LONG' ? 'long' : 'short'}`}>{row.side === 'LONG' ? '▲' : '▼'}</span><span><strong>{row.symbol}</strong><small>{row.side} · {row.status}</small></span><span className="row-price">{row.price == null ? '—' : formatPrice(row.price, row.symbol)}</span><b className={row.pnl == null ? '' : row.pnl >= 0 ? 'positive' : 'negative'}>{row.pnl == null ? '—' : `${row.pnl >= 0 ? '+' : '-'}${formatMoney(Math.abs(row.pnl))}`}</b><time>{formatTime(row.time)}</time></div>)}</section></div>;
}

function MetricCard({ label, value, note }) {
  const reduceMotion = useReducedMotion();
  return <motion.div className="metric-card" whileHover={reduceMotion ? undefined : { y: -3 }} transition={{ type: 'spring', stiffness: 360, damping: 28 }}><span>{label}</span><strong>{value}</strong><small>{note}</small></motion.div>;
}

function EmptyState({ icon: Icon, title, detail, action, onClick }) {
  return <div className="empty-state"><span><Icon size={19} /></span><strong>{title}</strong><p>{detail}</p>{action && <button className="button button-soft" onClick={onClick}>{action}<ArrowRight size={14} /></button>}</div>;
}

function InsightsView({ navigate, announce }) {
  const market = useLiveMarkets();
  const available = market.markets.filter((item) => item.last != null);
  const [word, setWord] = useState(null);
  const [wordLoading, setWordLoading] = useState(true);
  const loadWord = useCallback(() => {
    let cancelled = false;
    setWordLoading(true);
    fetch('https://bible-api.com/?random=verse')
      .then((response) => response.json())
      .then((data) => { if (cancelled) return; setWord({ reference: data?.reference || FALLBACK_WORD.reference, text: (data?.verses?.[0]?.text || '').replace(/\s+/g, ' ').trim() || FALLBACK_WORD.text }); })
      .catch(() => { if (!cancelled) setWord(FALLBACK_WORD); })
      .finally(() => { if (!cancelled) setWordLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { void loadWord(); }, [loadWord]);
  const displayedWord = word || FALLBACK_WORD;
  return <div className="page insights-page"><PageHeader eyebrow="MARKET INTELLIGENCE" title="The Word first." status={market.connected ? 'good' : 'warm'}><button className="button button-soft" onClick={() => { void market.refresh(); announce('Refreshing market intelligence.'); }}><RefreshCw size={15} />Refresh</button></PageHeader><section className="metric-row"><MetricCard label="FEED STATE" value={market.loading ? 'Syncing' : market.connected ? 'Connected' : 'Offline'} note={available.length ? `${available.length} markets receiving bars` : 'start TradingView to populate'} /><MetricCard label="BREADTH" value={available.length ? `${advancing}/${available.length}` : '—'} note="markets advancing" /><MetricCard label="SOURCE" value="TradingView" note="no synthetic fallback" /></section><section className="insight-grid"><article className="insight-feature panel-dark"><span className="eyebrow good"><i />DECISION SUPPORT</span><h2>Context first.<br /><em>Action second.</em></h2><p>Read the same live bars that power the chart and research panel before you consider an order.</p><div><button className="button button-lime" onClick={() => navigate('trade')}><TrendingUp size={15} />Open chart</button><button className="button button-outline" onClick={() => navigate('backtest')}><Target size={15} />Research</button></div></article><article className="reference-card reference-word insight-word"><ReferenceCardHeader title="Word of God" /><div className="reference-word-body"><blockquote>{wordLoading ? 'Seeking today’s word…' : `“${displayedWord.text}”`}</blockquote><cite>{displayedWord.reference}</cite></div><div className="reference-query"><span>Let the Word guide your decisions.</span><button onClick={() => { void loadWord(); announce('A new word for today.'); }}>Another verse <b>↗</b></button><button onClick={() => { navigate('scripture'); announce('Opening Scripture.'); }}>Open the Bible <b>↗</b></button></div></article><article className="panel health-panel"><div className="panel-heading"><div><span className="eyebrow">WORKSPACE HEALTH</span><h2>Gate check.</h2></div><ShieldCheck size={18} /></div><HealthRow label="TradingView feed" value={market.connected ? 'Receiving bars' : 'Needs connection'} good={market.connected} /><HealthRow label="Synthetic fallback" value="Disabled by default" good /><HealthRow label="Live execution" value="Explicit acknowledgement" good /><HealthRow label="Backtest source" value="TradingView bars" good={market.connected} /></article></section><section className="panel market-list"><div className="panel-heading"><div><span className="eyebrow">MARKET NOTES</span><h2>What is moving.</h2></div><small>5 minute bars</small></div>{market.markets.map((item) => <div className="market-list-row" key={item.id}><strong><i className={item.last != null ? 'live' : ''} />{item.id}</strong><span>{item.name}</span><b>{formatPrice(item.last, item.id)}</b><em className={item.change == null ? 'muted' : item.change >= 0 ? 'positive' : 'negative'}>{item.change == null ? 'waiting' : `${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%`}</em></div>)}</section></div>;
}

function HealthRow({ label, value, good }) {
  return <div className="health-row"><span className={good ? 'good' : 'warm'}>{good ? <CircleCheck size={15} /> : <CircleAlert size={15} />}</span><span><strong>{label}</strong><small>{value}</small></span></div>;
}

function ResearchView() {
  return <div className="page research-page"><PageHeader eyebrow="RESEARCH LAB · LIVE DATA ONLY" title="Test before you trade." status="neutral"><span className="page-badge"><ShieldCheck size={14} />PAPER RESEARCH</span></PageHeader><p className="page-lede">Run a strategy against TradingView bars. Synthetic candles stay off unless you explicitly enable them in the panel.</p><section className="research-panel"><BacktestPanel /></section><p className="disclaimer"><CircleAlert size={14} />Backtests are research, not promises. Verify the data window, costs, and market entitlement before acting.</p></div>;
}

function TradeView({ announce, requestLogin }) {
  const [symbol, setSymbol] = useState('NQ');
  const [timeframe, setTimeframe] = useState('5m');
  const [cloud, setCloud] = useState({ configured: PLAYWRIGHT_TRADER_CONFIGURED, checking: false, sessionActive: false, browserConnected: false, sessionState: 'unknown', currentUrl: '', title: '', debugUrl: '', liveViewUrl: '', accountName: '', contextPersistent: false, error: '' });
  const [bridge, setBridge] = useState({ checking: true, connected: false, accountConnected: false, account: null, error: '' });
  const [cloudBusy, setCloudBusy] = useState(false);
  const [loginNotice, setLoginNotice] = useState('');
  const [lastPrice, setLastPrice] = useState(null);
  const [paper, setPaper] = useState(loadPaper);
  const [qty, setQty] = useState(1);
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [liveMode, setLiveMode] = useState(false);
  const [liveAck, setLiveAck] = useState(false);
  const [orderError, setOrderError] = useState('');
  const autoStarted = useRef(false);

  useEffect(() => { try { window.localStorage.setItem(PAPER_KEY, JSON.stringify(paper)); } catch { /* ignore */ } }, [paper]);

  const checkBridge = useCallback(async () => {
    try {
      const data = await sidecarRequest('/tv/status');
      const next = { checking: false, connected: Boolean(data?.connected || data?.tv?.connected), accountConnected: Boolean(data?.account_connected || data?.account_fresh), account: data?.account || null, error: '' };
      setBridge(next);
      return next;
    } catch (error) {
      const next = { checking: false, connected: false, accountConnected: false, account: null, error: error?.message || 'TradingView Desktop bridge unavailable' };
      setBridge(next);
      return next;
    }
  }, []);

  const refreshCloud = useCallback(async () => {
    if (!PLAYWRIGHT_TRADER_CONFIGURED) return null;
    setCloud((current) => ({ ...current, checking: true, error: '' }));
    try {
      const data = await cloudRequest('/browser/status');
      const next = { configured: true, checking: false, sessionActive: Boolean(data?.sessionActive), browserConnected: Boolean(data?.browserConnected), sessionState: data?.sessionState || data?.tradingView?.sessionState || 'unknown', currentUrl: data?.currentUrl || '', title: data?.title || '', debugUrl: resolveServiceUrl(data?.debugUrl || data?.viewUrl || data?.liveViewUrl), liveViewUrl: resolveServiceUrl(data?.liveViewUrl || data?.viewUrl || ''), accountName: data?.tradingView?.accountName || '', contextPersistent: Boolean(data?.persistentProfile || data?.contextPersistent), error: data?.error || '' };
      setCloud(next);
      return next;
    } catch (error) {
      const next = { configured: true, checking: false, sessionActive: false, browserConnected: false, sessionState: 'unknown', currentUrl: '', title: '', debugUrl: '', liveViewUrl: '', accountName: '', contextPersistent: false, error: error?.message || 'Playwright TradingView unavailable' };
      setCloud(next);
      return next;
    }
  }, []);

  const startCloud = useCallback(async () => {
    // Electron already has a secure, isolated TradingView login window. Do not
    // send desktop users to a Playwright port that Electron does not launch.
    if (DESKTOP_RUNTIME) {
      const runtime = window.dwella || window.electronAPI;
      if (typeof runtime?.openTradingViewLogin !== 'function') {
        const message = 'The official TradingView login window is unavailable in this desktop build.';
        setLoginNotice(message);
        return { error: message, sessionActive: false };
      }
      setCloudBusy(true);
      setLoginNotice('');
      try {
        const result = await runtime.openTradingViewLogin();
        if (result?.ok === false) throw new Error(result.message || result.reason || 'The official TradingView sign-in could not be opened.');
        setLoginNotice('TradingView is open in its official window. Finish sign-in there, then verify this session.');
        return { desktopLogin: true, sessionActive: false };
      } catch (error) {
        const message = error?.message || 'The official TradingView sign-in could not be opened.';
        setLoginNotice(message);
        return { error: message, sessionActive: false };
      } finally {
        setCloudBusy(false);
      }
    }

    if (!PLAYWRIGHT_TRADER_CONFIGURED) {
      setLoginNotice('The paired Playwright service is not configured for this preview.');
      return null;
    }
    setCloudBusy(true);
    setLoginNotice('');
    setCloud((current) => ({ ...current, checking: true, error: '' }));
    try {
      const data = await cloudRequest('/browser/start', { timeout: 60000 });
      const next = { configured: true, checking: false, sessionActive: Boolean(data?.sessionActive ?? true), browserConnected: Boolean(data?.browserConnected ?? true), sessionState: data?.sessionState || data?.tradingView?.sessionState || 'needs-login', currentUrl: data?.currentUrl || '', title: data?.title || '', debugUrl: resolveServiceUrl(data?.debugUrl || data?.viewUrl || data?.liveViewUrl), liveViewUrl: resolveServiceUrl(data?.liveViewUrl || data?.viewUrl || ''), accountName: data?.tradingView?.accountName || '', contextPersistent: Boolean(data?.persistentProfile || data?.contextPersistent), error: data?.error || '' };
      setCloud(next);
      return next;
    } catch (error) {
      const message = error?.message || 'Could not start local Chromium.';
      setCloud((current) => ({ ...current, checking: false, error: message }));
      setLoginNotice(message);
      return { error: message, sessionActive: false };
    } finally {
      setCloudBusy(false);
    }
  }, []);

  const startCloudWithRetry = useCallback(async () => {
    let result = null;
    const retryDelays = [0, 700, 1600, 3200];
    for (const delay of retryDelays) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      result = await startCloud();
      if (result?.sessionActive) return result;
    }
    return result;
  }, [startCloud]);

  const stopCloud = async () => {
    setCloudBusy(true);
    try {
      await cloudRequest('/browser/stop');
      await refreshCloud();
    } catch (error) {
      setCloud((current) => ({ ...current, error: error?.message || 'Could not end the browser session.' }));
    } finally {
      setCloudBusy(false);
    }
  };

  useEffect(() => {
    void checkBridge();
    const interval = window.setInterval(() => void checkBridge(), 15000);
    return () => window.clearInterval(interval);
  }, [checkBridge]);

  useEffect(() => {
    if (!PLAYWRIGHT_TRADER_CONFIGURED) return undefined;
    void refreshCloud();
    const interval = window.setInterval(() => void refreshCloud(), 20000);
    return () => window.clearInterval(interval);
  }, [refreshCloud]);

  useEffect(() => {
    if (!PLAYWRIGHT_TRADER_CONFIGURED || autoStarted.current) return undefined;
    autoStarted.current = true;
    let retryInterval = null;
    let cancelled = false;

    const retryStart = async () => {
      if (cancelled) return;
      // A status check cannot revive a service that failed during boot. Retry
      // the actual launch so Trade recovers after Chromium finishes waking.
      const status = await startCloud().catch(() => null);
      if (cancelled) return;
      if (status?.sessionActive && retryInterval) {
        window.clearInterval(retryInterval);
        retryInterval = null;
      }
    };

    void startCloudWithRetry().then((result) => {
      if (cancelled || result?.sessionActive) return;
      retryInterval = window.setInterval(() => { void retryStart(); }, 12000);
    });
    return () => {
      cancelled = true;
      if (retryInterval) window.clearInterval(retryInterval);
    };
  }, [startCloudWithRetry, startCloud]);

  useEffect(() => {
    let cancelled = false;
    const readPrice = async () => {
      let price = null;
      try {
        const runtime = window.dwella || window.electronAPI;
        if (typeof runtime?.getMarketQuotes === 'function') {
          const quotes = await runtime.getMarketQuotes();
          const quote = quotes?.find((item) => item?.s === symbol || item?.symbol === symbol);
          const value = Number(quote?.price);
          if (Number.isFinite(value) && value > 0) price = value;
        }
        if (!Number.isFinite(price) && typeof runtime?.getMarketBars === 'function') {
          const payload = await runtime.getMarketBars(symbol, timeframe, 2);
          const bar = payload?.bars?.at(-1);
          const value = Number(bar?.c);
          if (Number.isFinite(value) && value > 0) price = value;
        }
        // The browser preview has no Electron bridge. Read the quote through
        // the same-origin Vite proxy so the first Trade render also exercises
        // the paired Playwright session and never leaves the order ticket
        // permanently waiting for a desktop-only runtime.
        if (!Number.isFinite(price) && PLAYWRIGHT_TRADER_CONFIGURED) {
          const params = new URLSearchParams({ symbol, timeframe, count: '2' });
          const payload = await cloudRequest(`/market/bars?${params.toString()}`, { timeout: 15000 });
          const bar = payload?.bars?.at(-1);
          const value = Number(bar?.c);
          if (Number.isFinite(value) && value > 0) price = value;
        }
      } catch { /* remain explicitly unavailable */ }
      if (!cancelled) setLastPrice(Number.isFinite(price) && price > 0 ? price : null);
    };
    void readPrice();
    const interval = window.setInterval(() => void readPrice(), 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [symbol, timeframe]);

  const unrealized = paper.positions.reduce((total, position) => {
    const price = lastPrice ?? position.entry;
    return total + (position.side === 'long' ? 1 : -1) * (price - position.entry) * 5 * position.qty;
  }, 0);
  const equity = paper.balance + unrealized;
  const cloudReady = cloud.sessionActive && cloud.browserConnected;
  const signedIn = cloud.sessionState === 'signed-in';
  const sessionReady = signedIn || bridge.accountConnected;
  const remoteUrl = !DESKTOP_RUNTIME
    ? cloud.debugUrl || cloud.liveViewUrl || resolveServiceUrl('/browser/view')
    : '';

  const verify = async () => {
    const [cloudState, bridgeState] = await Promise.all([refreshCloud(), checkBridge()]);
    if (cloudState?.sessionState === 'signed-in' || bridgeState?.accountConnected) {
      setLoginNotice('TradingView session verified.');
      announce('TradingView session verified.');
    } else if (cloudState?.sessionActive) {
      setLoginNotice('The TradingView page is ready. Sign in inside it, then verify again.');
    } else {
      setLoginNotice('No TradingView session is visible yet. Start the browser and sign in on TradingView.');
    }
  };

  const signIn = async () => {
    // TradingView authentication is intentionally independent from Dwella
    // account auth. Preview users must be able to open TradingView's real
    // sign-in page; only order execution remains behind the Dwella login gate.
    const next = await startCloud();
    if (next?.sessionActive) {
      announce('TradingView is open. Sign in inside the embedded page.');
    }
  };

  const placeOrder = async (side) => {
    if (requestLogin && !requestLogin()) return;
    setOrderError('');
    const amount = Number(qty);
    if (!lastPrice || !Number.isFinite(amount) || amount < 1) {
      setOrderError('Wait for a live TradingView price before placing an order.');
      return;
    }
    if (liveMode && (!bridge.connected || !bridge.accountConnected)) {
      setOrderError('Live mode needs a verified TradingView Desktop account session.');
      return;
    }
    if (liveMode && !liveAck) {
      setOrderError('Acknowledge the live-trading risk notice first.');
      return;
    }
    if (liveMode) {
      try {
        const payload = await sidecarRequest('/tv/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: side === 'long' ? 'Buy' : 'Sell', symbol, qty: amount, sl: stop ? Number(stop) : undefined, tp: target ? Number(target) : undefined }) });
        if (!payload?.ok) throw new Error(payload?.error || 'TradingView rejected the order.');
        announce(`${side === 'long' ? 'Buy' : 'Sell'} ${amount} ${symbol} sent to TradingView.`);
      } catch (error) {
        setOrderError(error?.message || 'Could not reach the TradingView bridge.');
      }
      return;
    }
    const position = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, symbol, side, qty: amount, entry: lastPrice, stop: stop ? Number(stop) : null, target: target ? Number(target) : null, openedAt: Date.now() };
    setPaper((current) => ({ ...current, positions: [position, ...current.positions] }));
    announce(`${side === 'long' ? 'Long' : 'Short'} ${amount} ${symbol} @ ${formatPrice(lastPrice, symbol)} · paper`);
  };

  const closePosition = (id) => {
    setPaper((current) => {
      const position = current.positions.find((item) => item.id === id);
      if (!position) return current;
      const price = lastPrice ?? position.entry;
      const pnl = (position.side === 'long' ? 1 : -1) * (price - position.entry) * 5 * position.qty;
      return { balance: current.balance + pnl, positions: current.positions.filter((item) => item.id !== id), closed: [{ ...position, exit: price, pnl, closedAt: Date.now() }, ...current.closed].slice(0, 50) };
    });
    announce('Paper position closed.');
  };

  const resetPaper = () => { setPaper({ balance: PAPER_START, positions: [], closed: [] }); announce('Paper account reset.'); };

  return <div className="page trade-page"><PageHeader eyebrow="TRADINGVIEW SESSION" title="Trade with intent." status={sessionReady ? 'good' : cloudReady || bridge.connected ? 'warm' : 'neutral'}><span className="page-badge"><i className={sessionReady ? 'live' : ''} />{sessionReady ? 'ACCOUNT READY' : cloudReady ? 'LOGIN READY' : 'PAPER GATED'}</span></PageHeader><p className="page-lede">TradingView's real web app is the login surface. Your credentials stay there; Dwella only reads connection status and applies risk gates.</p><section className={`session-panel panel-dark${sessionReady ? ' ready' : ''}`}><div className="session-heading"><div className="tv-emblem">TV</div><div><span className="eyebrow">{signedIn ? 'PLAYWRIGHT ACCOUNT' : 'TRADINGVIEW ACCESS'}</span><h2>{signedIn ? cloud.accountName || 'TradingView account ready' : cloudReady ? 'Sign in inside TradingView.' : 'Open the official login.'}</h2></div><span className={`status-pill ${sessionReady ? 'good' : cloudReady || bridge.connected ? 'warm' : 'muted'}`}><i />{cloud.checking || bridge.checking ? 'CHECKING' : sessionReady ? 'VERIFIED' : cloudReady || bridge.connected ? 'ONLINE' : 'OFFLINE'}</span></div><p>{cloudReady ? 'The embedded TradingView browser is ready. The login page is rendered below and opens immediately when the session starts.' : 'Start the paired browser to load TradingView’s own sign-in page. No TradingView password is entered into Dwella.'}</p>{(loginNotice || cloud.error) && <div className="notice"><CircleAlert size={15} />{loginNotice || cloud.error}</div>}<div className="session-actions"><button className="button button-lime" onClick={signIn} disabled={cloudBusy}><MonitorPlay size={15} />{cloudBusy ? 'Opening browser…' : 'Sign in to TradingView'}</button><button className="button button-outline" onClick={verify} disabled={cloud.checking || bridge.checking}><RefreshCw size={15} className={cloud.checking || bridge.checking ? 'spin' : ''} />Verify session</button></div></section><section className="market-controls"><div className="symbol-tabs">{TRADE_SYMBOLS.map((item) => <button key={item.id} className={symbol === item.id ? 'active' : ''} onClick={() => setSymbol(item.id)}><strong>{item.id}</strong><small>{item.name}</small></button>)}</div><div className="timeframe-tabs">{TRADE_TIMEFRAMES.map((item) => <button key={item} className={timeframe === item ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}</div></section><section className="chart-panel panel"><div className="panel-heading"><div><span className="eyebrow good"><i />TRADINGVIEW LOGIN</span><h2>{symbol} <small>· {timeframe}</small></h2></div><span className={`status-pill ${lastPrice ? 'good' : 'muted'}`}><i />{lastPrice ? 'LIVE QUOTE' : 'WAITING FOR LIVE BARS'}</span></div>{remoteUrl ? <RemoteTradingView url={remoteUrl} token={PLAYWRIGHT_TRADER_TOKEN} /> : <div className="empty-state" style={{ minHeight: 'clamp(280px, 40dvh, 420px)' }}><span><Cloud size={19} /></span><strong>{cloud.checking ? 'Starting Chromium…' : 'TradingView browser unavailable'}</strong><p>{cloud.error || (cloud.checking ? 'The paired Playwright service is starting. This usually takes a few seconds.' : 'The paired Playwright service is not reachable from this preview.')}</p><button className="button button-lime" onClick={signIn} disabled={cloudBusy}><MonitorPlay size={15} />{cloudBusy ? 'Starting Chromium…' : 'Start TradingView browser'}</button></div>}<TradingViewChart symbol={symbol} timeframe={timeframe} height="clamp(220px, 26dvh, 300px)" /><p className="chart-note"><CircleAlert size={13} />The embedded website above is the sign-in surface. The chart widget is read-only; executable prices come only from the live TradingView bridge.</p></section><section className="order-layout"><article className="panel order-panel"><div className="panel-heading"><div><span className="eyebrow">ORDER TICKET</span><h2>{lastPrice ? <CountingNumber number={lastPrice} format={(value) => formatPrice(value, symbol)} /> : 'Waiting for price'}</h2></div><button className={`mode-switch ${liveMode ? 'on' : ''}`} role="switch" aria-checked={liveMode} onClick={() => { if (!bridge.connected || !bridge.accountConnected) { setOrderError('Live mode needs a verified TradingView Desktop account.'); return; } setOrderError(''); setLiveMode((value) => !value); }}><span>{liveMode ? 'LIVE' : 'PAPER'}</span><i /></button></div><div className="order-fields"><label><span>Quantity</span><input type="number" min="1" step="1" value={qty} onChange={(event) => setQty(event.target.value)} /></label><label><span>Stop loss</span><input type="number" placeholder="optional" value={stop} onChange={(event) => setStop(event.target.value)} /></label><label><span>Take profit</span><input type="number" placeholder="optional" value={target} onChange={(event) => setTarget(event.target.value)} /></label></div>{liveMode && <label className="risk-check"><input type="checkbox" checked={liveAck} onChange={(event) => setLiveAck(event.target.checked)} /><span>I understand live orders carry financial risk.</span></label>}<div className="order-buttons"><button className="buy-button" disabled={!lastPrice || !qty} onClick={() => void placeOrder('long')}><ArrowUpRight size={16} />Buy / Long</button><button className="sell-button" disabled={!lastPrice || !qty} onClick={() => void placeOrder('short')}><ArrowDownLeft size={16} />Sell / Short</button></div>{orderError && <div className="notice error"><CircleAlert size={15} />{orderError}</div>}</article><article className="panel paper-panel"><div className="panel-heading"><div><span className="eyebrow">PAPER ACCOUNT</span><h2><CountingNumber number={equity} format={formatMoney} /></h2></div><button className="icon-button" onClick={resetPaper} aria-label="Reset paper account"><RefreshCw size={15} /></button></div><div className="paper-stats"><span><small>BALANCE</small><strong><CountingNumber number={paper.balance} format={formatMoney} /></strong></span><span><small>UNREALIZED</small><strong className={unrealized >= 0 ? 'positive' : 'negative'}>{unrealized >= 0 ? '+' : '-'}{formatMoney(Math.abs(unrealized))}</strong></span><span><small>OPEN</small><strong>{paper.positions.length}</strong></span></div><div className="position-list">{!paper.positions.length && <p className="muted-copy">No open positions. Live price required before a paper order can be placed.</p>}{paper.positions.map((position) => <div className="position-row" key={position.id}><span className={position.side === 'long' ? 'positive' : 'negative'}>{position.side === 'long' ? '▲' : '▼'} {position.symbol}</span><small>{position.qty} @ {formatPrice(position.entry, position.symbol)}</small><button onClick={() => closePosition(position.id)}>Close</button></div>)}</div></article></section><p className="disclaimer"><ShieldCheck size={14} />Paper is the default. Live routing requires the local TradingView Desktop bridge, a verified account, and explicit acknowledgement.</p></div>;
}

function SettingsView({ appearance, onChange, devicePairing, onDevicePairingChange }) {
  const current = appearance || APPEARANCE_DEFAULTS;
  const [pairingCode, setPairingCode] = useState(() => devicePairing?.code || '');
  const [backgroundUrl, setBackgroundUrl] = useState(() => current.customBackground?.startsWith('data:') ? '' : current.customBackground || '');
  const [fileError, setFileError] = useState('');

  const update = (patch) => onChange({ ...current, ...patch });
  const selectPreset = (id) => {
    setFileError('');
    update({ background: id, customBackground: '' });
  };
  const applyBackgroundUrl = () => {
    const value = backgroundUrl.trim();
    setFileError('');
    update({ background: value ? 'custom' : 'default', customBackground: value });
  };
  const handleBackgroundFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFileError('Choose an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setFileError('Choose an image smaller than 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileError('');
      setBackgroundUrl('');
      update({ background: 'custom', customBackground: String(reader.result || '') });
    };
    reader.onerror = () => setFileError('This image could not be loaded.');
    reader.readAsDataURL(file);
  };
  const resetAppearance = () => {
    setBackgroundUrl('');
    setFileError('');
    onChange({ ...APPEARANCE_DEFAULTS });
  };
  const previewClass = current.customBackground ? 'has-custom-background' : `background-${current.background}`;

  return (
    <div className="page settings-page">
      <PageHeader eyebrow="WORKSPACE PREFERENCES" title="Make it yours." status="neutral"><span className="page-badge"><Settings2 size={14} />APPEARANCE</span></PageHeader>
      <p className="page-lede">Choose how Dwella feels on every screen. These preferences stay on this device and never include TradingView credentials.</p>
      <div className="settings-layout">
        <section className="panel settings-panel">
          <div className="settings-heading"><span className="settings-heading-icon"><Palette size={17} /></span><div><span className="eyebrow">DISPLAY SURFACE</span><h2>Light or dark?</h2><p>Use the device layout by default, or lock the workspace to a single appearance.</p></div></div>
          <div className="settings-choice-grid" role="radiogroup" aria-label="Color theme">
            {THEME_OPTIONS.map((option) => { const Icon = option.icon; const selected = current.theme === option.id; return <button key={option.id} className={`settings-choice${selected ? ' selected' : ''}`} onClick={() => update({ theme: option.id })} role="radio" aria-checked={selected}><span className="settings-choice-icon"><Icon size={17} /></span><span><strong>{option.label}</strong><small>{option.description}</small></span>{selected && <Check size={15} className="settings-choice-check" />}</button>; })}
          </div>
        </section>

        <section className="panel settings-preview-panel">
          <div className="settings-preview-header"><span className="eyebrow">LIVE PREVIEW</span><span className="settings-preview-status"><i />SAVED ON DEVICE</span></div>
          <div className={`settings-preview-surface ${previewClass}`} style={current.customBackground ? appearanceStyle(current) : undefined}>
            <div className="settings-preview-top"><span><i />DWELLA</span><b>9:41</b></div>
            <div className="settings-preview-title">Overview <span>&#8599;</span></div>
            <div className="settings-preview-cards"><span /><span /><span /></div>
            <div className="settings-preview-dock"><i /><i className="active" /><i /><i /><i /></div>
          </div>
        </section>
      </div>

      <section className="panel settings-panel settings-background-panel">
        <div className="settings-heading"><span className="settings-heading-icon"><ImageIcon size={17} /></span><div><span className="eyebrow">WORKSPACE WALLPAPER</span><h2>Set the atmosphere.</h2><p>Pick a built-in background or use your own image for the desktop frame, mobile shell, and loading window.</p></div></div>
        <div className="background-preset-grid">
          {BACKGROUND_PRESETS.map((preset) => { const selected = !current.customBackground && current.background === preset.id; return <button key={preset.id} className={`background-preset background-${preset.id}${selected ? ' selected' : ''}`} onClick={() => selectPreset(preset.id)} aria-pressed={selected}><span className="background-preset-swatch" /><span><strong>{preset.label}</strong><small>{preset.description}</small></span>{selected && <Check size={15} />}</button>; })}
        </div>
        <div className="settings-custom-row">
          <label className="settings-url-field"><span>IMAGE URL</span><input type="url" value={backgroundUrl} onChange={(event) => setBackgroundUrl(event.target.value)} placeholder="https://your-image-url.example/background.jpg" /></label>
          <button className="button button-soft settings-apply-button" onClick={applyBackgroundUrl} disabled={!backgroundUrl.trim()}><Check size={14} />Apply URL</button>
          <label className="button button-outline settings-upload-button"><Upload size={14} />Upload image<input type="file" accept="image/*" onChange={handleBackgroundFile} /></label>
        </div>
        {fileError && <p className="settings-error" role="alert"><CircleAlert size={14} />{fileError}</p>}
        {current.customBackground && <p className="settings-custom-note"><Check size={14} />Custom wallpaper active. Uploading a new image or choosing a preset replaces it.</p>}
        <button className="settings-reset" onClick={resetAppearance}><RotateCcw size={14} />Reset appearance</button>
      </section>

      <section className="panel settings-panel settings-pairing-panel">
        <div className="settings-heading"><span className="settings-heading-icon"><LinkIcon size={17} /></span><div><span className="eyebrow">DEVICE PAIRING</span><h2>Connect your Mac.</h2><p>{devicePairing?.pairedAt ? 'Your device is paired — live prices are active. The code below can be used to pair another device.' : 'Generate a pairing code, enter it in the Dwella desktop app on your Mac, and this browser will remember your device for live prices.'}</p></div></div>
        {devicePairing?.pairedAt ? (
          <div className="pairing-status">
            <div className="pairing-done"><CheckCircle size={20} /><span><strong>Paired with {devicePairing.device}</strong><small>{new Date(devicePairing.pairedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></span></div>
            <div className="pairing-code-display paired"><code>{devicePairing.code}</code><button className="button button-soft" onClick={() => { try { navigator.clipboard.writeText(devicePairing.code); } catch { /* noop */ } }}><Copy size={14} />Copy code</button></div>
            <button className="button button-outline" onClick={() => { try { window.localStorage.removeItem(DEVICE_KEY); } catch { /* ignore */ } onDevicePairingChange(null); }}><Trash2 size={14} />Unpair device</button>
          </div>
        ) : (
          <div className="pairing-flow">
            <div className="pairing-code-display">{pairingCode ? <><code>{pairingCode}</code><button className="button button-soft" onClick={() => { try { navigator.clipboard.writeText(pairingCode); } catch { /* noop */ } }}><Copy size={14} />Copy</button></> : <span className="pairing-empty">No code generated yet</span>}</div>
            <div className="pairing-actions">
              <button className="button button-lime" onClick={() => setPairingCode(generatePairingCode())}><KeyRound size={14} />Generate pairing code</button>
              {pairingCode && <button className="button button-lime" style={{background:'var(--ws-green)', color:'#081008'}} onClick={() => { const now = new Date().toISOString(); const data = { code: pairingCode, pairedAt: now, device: 'Dwella Mac Desktop' }; try { window.localStorage.setItem(DEVICE_KEY, JSON.stringify(data)); } catch { /* ignore */ } onDevicePairingChange(data); }}><CheckCircle size={14} />Simulate pairing</button>}
            </div>
            <p className="pairing-note"><CircleAlert size={13} />After generating a code, open the Dwella desktop app on your Mac and paste this code. Come back here and click "Simulate pairing" once the Mac app confirms the connection.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function CloudSessionCard({ cloud, busy, onStart, onOpen, onRefresh, onStop }) {
  const ready = cloud.sessionActive && cloud.browserConnected;
  const signedIn = cloud.sessionState === 'signed-in';
  return <section className={`cloud-card panel${ready ? ' ready' : ''}`}><div className="cloud-card-heading"><div className="cloud-emblem"><Cloud size={17} /></div><div><span className="eyebrow">PLAYWRIGHT TRADINGVIEW SESSION</span><h2>{ready ? 'Browser ready' : 'Free TradingView browser'}</h2></div><span className={`status-pill ${signedIn ? 'good' : ready ? 'warm' : 'muted'}`}><i />{cloud.checking ? 'CHECKING' : signedIn ? 'SIGNED IN' : ready ? 'NEEDS LOGIN' : 'NOT CONNECTED'}</span></div><p>This free self-hosted Playwright Chromium session loads TradingView’s real web app. Credentials are entered only on the remote TradingView page.</p>{ready && <div className="cloud-meta"><span><small>PAGE</small><strong>{cloud.title || 'TradingView'}</strong></span><span><small>SESSION</small><strong>{signedIn ? cloud.accountName || 'Account detected' : 'Login required'}</strong></span></div>}{cloud.error && <div className="notice error"><CircleAlert size={14} />{cloud.error}</div>}<div className="cloud-actions">{ready ? <button className="button button-lime" onClick={onOpen}><MonitorPlay size={15} />Open remote TradingView</button> : <button className="button button-lime" onClick={onStart} disabled={busy}>{busy ? 'Starting Chromium…' : 'Start browser'}</button>}<button className="button button-soft" onClick={ready ? onStop : onRefresh} disabled={busy}><RefreshCw size={14} />{ready ? 'End session' : 'Check session'}</button></div>{ready && cloud.contextPersistent && <small className="persist-note"><CircleCheck size={13} />Persistent profile enabled for this workspace.</small>}</section>;
}

function RemoteTradingView({ url, token }) {
  const wrapRef = useRef(null);
  const frameRef = useRef(null);
  let origin = '*';
  try { origin = new URL(url).origin; } catch { /* wildcard */ }
  useEffect(() => {
    const post = () => { try { frameRef.current?.contentWindow?.postMessage({ type: 'dwella-playwright-auth', token }, origin); } catch { /* not ready */ } };
    post();
    const interval = window.setInterval(post, 1800);
    return () => window.clearInterval(interval);
  }, [origin, token, url]);
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen?.();
      else await wrapRef.current?.requestFullscreen?.();
    } catch { /* browser gesture policy */ }
  };
  return <div className="remote-view" ref={wrapRef}><div className="remote-header"><span>TRADINGVIEW · ACCOUNTS / SIGNIN</span><button onClick={fullscreen}><Maximize2 size={13} />Full screen</button></div><iframe ref={frameRef} title="TradingView sign in" src={url} allow="clipboard-read; clipboard-write" /><p><ExternalLink size={13} />Enter credentials only in TradingView's page at <strong>www.tradingview.com/accounts/signin/</strong>.</p></div>;
}

export default App;
