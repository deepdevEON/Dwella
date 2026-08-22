import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

// TradingView Desktop is an external local prerequisite. Dwella does not
// embed it, claim its CDP port, open it, or store its broker credentials.
// The user starts TradingView Desktop with remote debugging enabled and signs
// into Tradovate inside that official session before connecting Dwella.

let mainWindow;

// Prevent multiple Dwella windows from sharing one TradingView session and
// competing for the same sidecar. A second launch focuses the existing app.
const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // macOS keeps the process alive after its last window is closed. In that
    // state a normal relaunch used to acquire the single-instance event but
    // do nothing, leaving Dwella running headlessly with no window to show.
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

let fakeSleepProcess = null;
let fakeSleepSystemOverride = false;
let tradingViewLoginWindow = null;

// ---------------------------------------------------------------------
// Dwella data persistence → trading/ folder
// ---------------------------------------------------------------------
const TRADING_DIR = path.join(app.getPath('documents'), 'Dwella', 'trading');
const JOURNAL_FILE = path.join(TRADING_DIR, 'journal.json');
const SETTINGS_FILE = path.join(TRADING_DIR, 'config', 'settings.json');
const COMPONENTS_DIR = path.join(TRADING_DIR, 'components');
const COMPONENTS_VERSION = 'dwella-components-v2';

function ensureDirs() {
  fs.mkdirSync(path.join(TRADING_DIR, 'config'), { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------
// First-run component bootstrap
// ---------------------------------------------------------------------
function findBundledResource(relativePath) {
  const candidates = [
    path.join(process.resourcesPath, relativePath),
    path.join(__dirname, '..', relativePath),
    path.join(__dirname, '..', 'packaging', relativePath),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function ensureBundledComponents() {
  const bundledRuntime = findBundledResource('runtime');
  const bundledMcp = findBundledResource('tradingview-mcp');
  // TradingView Desktop is never copied into or launched from Dwella.
  const installedRuntime = path.join(COMPONENTS_DIR, 'runtime');
  const installedMcp = path.join(COMPONENTS_DIR, 'tradingview-mcp');
  const marker = path.join(COMPONENTS_DIR, '.version');

  try {
    fs.mkdirSync(COMPONENTS_DIR, { recursive: true });
    const runtimeReady = fs.existsSync(path.join(installedRuntime, 'node'));
    const mcpReady = fs.existsSync(path.join(installedMcp, 'src', 'cli', 'index.js'));
    const markerReady = fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8').trim() === COMPONENTS_VERSION;

    // The DMG carries the complete runtime and bridge. Copy them into the
    // user's writable Dwella directory once so the app does not depend on
    // modifying a signed/read-only .app bundle on later repairs.
    if (bundledRuntime && (!runtimeReady || !markerReady)) {
      fs.cpSync(bundledRuntime, installedRuntime, { recursive: true, force: true });
    }
    if (bundledMcp && (!mcpReady || !markerReady)) {
      fs.cpSync(bundledMcp, installedMcp, { recursive: true, force: true });
    }
    if (bundledRuntime && bundledMcp &&
        fs.existsSync(path.join(installedRuntime, 'node')) &&
        fs.existsSync(path.join(installedMcp, 'src', 'cli', 'index.js'))) {
      fs.writeFileSync(marker, COMPONENTS_VERSION, 'utf-8');
    }
  } catch (error) {
    // The sidecar still receives the bundled paths below, so a permissions
    // problem in the per-user cache does not make a valid DMG unusable.
    console.error('Dwella component bootstrap failed:', error);
  }

  const localNode = path.join(installedRuntime, 'node');
  const localMcp = path.join(installedMcp, 'src', 'cli', 'index.js');
  const node = fs.existsSync(localNode) ? localNode : findBundledResource('runtime/node');
  const mcp = fs.existsSync(localMcp) ? localMcp : findBundledResource('tradingview-mcp/src/cli/index.js');
  const runtimeDir = node ? path.dirname(node) : (bundledRuntime || '');
  return {
    node,
    mcp,
    runtimeDir,
    bundledNode: findBundledResource('runtime/node'),
    bundledMcp: bundledMcp || '',
  };
}

// ---------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('journal:load', () => readJson(JOURNAL_FILE, []));
  ipcMain.handle('journal:save', (_e, entries) => {
    writeJson(JOURNAL_FILE, entries);
    return { ok: true, path: JOURNAL_FILE };
  });
  ipcMain.handle('settings:load', () => readJson(SETTINGS_FILE, {}));
  ipcMain.handle('settings:save', (_e, settings) => {
    writeJson(SETTINGS_FILE, settings);
    return { ok: true, path: SETTINGS_FILE };
  });
  ipcMain.handle('app:data-path', () => TRADING_DIR);
  ipcMain.handle('tv:status', async () => {
    try {
      const response = await fetch('http://127.0.0.1:18814/tv/status', { signal: AbortSignal.timeout(2500) });
      return await response.json();
    } catch {
      return { connected: false, error: 'The local TradingView Desktop bridge is unavailable.' };
    }
  });
  ipcMain.handle('app:open-external', async (_event, value) => {
    try {
      const url = new URL(String(value));
      if (url.protocol !== 'https:') return { ok: false, reason: 'Only HTTPS links are allowed.' };
      await shell.openExternal(url.toString());
      return { ok: true };
    } catch {
      return { ok: false, reason: 'The link could not be opened.' };
    }
  });
  ipcMain.handle('tv:login', async () => {
    if (tradingViewLoginWindow && !tradingViewLoginWindow.isDestroyed()) {
      tradingViewLoginWindow.show();
      tradingViewLoginWindow.focus();
      return { ok: true, reused: true };
    }

    tradingViewLoginWindow = new BrowserWindow({
      ...(mainWindow ? { parent: mainWindow } : {}),
      width: 460,
      height: 760,
      minWidth: 380,
      minHeight: 560,
      title: 'Sign in to TradingView',
      backgroundColor: '#f5f3ed',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    let loginResolved = false;
    const finishTvLogin = () => {
      if (loginResolved) return;
      loginResolved = true;
      if (tradingViewLoginWindow && !tradingViewLoginWindow.isDestroyed()) tradingViewLoginWindow.close();
      tradingViewLoginWindow = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tv:login-complete', { ok: true });
      }
    };
    tradingViewLoginWindow.on('closed', () => { tradingViewLoginWindow = null; });
    tradingViewLoginWindow.webContents.on('did-navigate', (_event, url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const isTv = host === 'tradingview.com' || host.endsWith('.tradingview.com');
        const path = parsed.pathname.toLowerCase();
        const stillAuth = path.includes('/accounts/signin') || path.includes('/accounts/signup') || path.includes('/accounts/recover') || path.includes('/accounts/reset');
        if (isTv && !stillAuth) finishTvLogin();
      } catch { /* ignore non-TradingView navigation */ }
    });

    try {
      await tradingViewLoginWindow.loadURL('https://www.tradingview.com/accounts/signin/');
      return { ok: true };
    } catch {
      if (tradingViewLoginWindow && !tradingViewLoginWindow.isDestroyed()) tradingViewLoginWindow.close();
      return { ok: false, reason: 'The official TradingView sign-in page could not be opened.' };
    }
  });
  ipcMain.handle('fake-sleep:start', () => startFakeSleep(false));
  ipcMain.handle('fake-sleep:authorize', () => authorizeAndStartFakeSleep());
  ipcMain.handle('fake-sleep:restore', () => restoreSystemSleep());
  ipcMain.handle('fake-sleep:stop', () => stopFakeSleep());
  ipcMain.handle('fake-sleep:readiness', () => getFakeSleepReadiness());
  ipcMain.handle('fake-sleep:status', async () => ({
    active: Boolean(fakeSleepProcess && !fakeSleepProcess.killed),
    systemOverride: fakeSleepSystemOverride,
    readiness: await getFakeSleepReadiness(),
  }));
}

// ---------------------------------------------------------------------
// Fake Sleep — keep the Mac awake while explicitly sleeping the display.
// This is intentionally user-triggered and does not override macOS lid
// safety behavior; a closed MacBook lid may still put the machine to sleep.
// ---------------------------------------------------------------------
async function getFakeSleepReadiness() {
  if (process.platform !== 'darwin') {
    return { ready: false, acPower: false, externalDisplay: false, reason: 'Closed-display mode is available on macOS only.' };
  }

  try {
    const [{ stdout: power }, { stdout: displays }] = await Promise.all([
      execFileAsync('/usr/bin/pmset', ['-g', 'ps']),
      execFileAsync('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json']),
    ]);
    const acPower = /AC Power/i.test(power) && !/Battery Power/i.test(power.split(/AC Power/i)[0].slice(-80));
    const data = JSON.parse(displays);
    const items = [];
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(visit);
      if (value.spdisplays_connection_type || value.spdisplays_display_type) items.push(value);
      Object.values(value).forEach(visit);
    };
    visit(data);
    const externalDisplay = items.some((item) => {
      const type = String(item.spdisplays_connection_type || '').toLowerCase();
      const display = String(item.spdisplays_display_type || '').toLowerCase();
      return type && !type.includes('internal') && !display.includes('built-in');
    });
    const ready = acPower && externalDisplay;
    return {
      ready,
      acPower,
      externalDisplay,
      reason: ready
        ? 'Ready for supported closed-display mode.'
        : 'Connect AC power and an external display before closing the lid.',
    };
  } catch (error) {
    return { ready: false, acPower: false, externalDisplay: false, reason: `Could not verify clamshell requirements: ${error.message}` };
  }
}

async function runAdminPowerCommand(enable) {
  if (process.platform !== 'darwin') return { ok: false, reason: 'Administrator authorization is available on macOS only.' };
  const value = enable ? '1' : '0';
  const command = `/usr/bin/pmset -a disablesleep ${value}`;
  const script = `do shell script ${JSON.stringify(command)} with administrator privileges`;
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script]);
    return { ok: true, enabled: enable };
  } catch (error) {
    const output = `${error.message || ''} ${error.stderr || ''}`;
    const cancelled = /cancel|canceled|cancelled|1002/i.test(output);
    return { ok: false, cancelled, reason: cancelled ? 'Administrator authorization was cancelled.' : output.trim() };
  }
}

async function authorizeAndStartFakeSleep() {
  const authorization = await runAdminPowerCommand(true);
  if (!authorization.ok) return { ...authorization, active: false, systemOverride: false };
  fakeSleepSystemOverride = true;
  const started = await startFakeSleep(true);
  if (!started.ok) {
    await runAdminPowerCommand(false);
    fakeSleepSystemOverride = false;
  }
  return { ...started, authorized: true, systemOverride: fakeSleepSystemOverride };
}

async function restoreSystemSleep() {
  await stopFakeSleep(true, false);
  if (!fakeSleepSystemOverride) return { ok: true, enabled: false, systemOverride: false };
  const restored = await runAdminPowerCommand(false);
  if (restored.ok) fakeSleepSystemOverride = false;
  return { ...restored, systemOverride: fakeSleepSystemOverride };
}

async function startFakeSleep(authorized = false) {
  if (process.platform !== 'darwin') return { ok: false, active: false, reason: 'macOS only' };
  if (fakeSleepProcess && !fakeSleepProcess.killed) return { ok: true, active: true, readiness: await getFakeSleepReadiness() };

  const readiness = await getFakeSleepReadiness();
  if (!authorized && !readiness.ready) {
    return { ok: false, active: false, reason: readiness.reason, readiness };
  }

  try {
    // -i prevents idle system sleep, -m prevents disk idle sleep, and -s
    // prevents system sleep while on AC power. We deliberately omit -d so
    // the display can be put to sleep separately below.
    fakeSleepProcess = spawn('/usr/bin/caffeinate', ['-ims'], {
      detached: false,
      stdio: 'ignore',
    });
    fakeSleepProcess.once('error', (error) => {
      console.error('Fake Sleep could not start:', error);
      fakeSleepProcess = null;
    });
    fakeSleepProcess.once('exit', () => { fakeSleepProcess = null; });

    // Force the display off without stopping the broker/data processes.
    await execFileAsync('/usr/bin/pmset', ['displaysleepnow']);
    return { ok: true, active: true, readiness };
  } catch (error) {
    console.error('Fake Sleep could not start:', error);
    if (fakeSleepProcess) {
      try { fakeSleepProcess.kill('SIGTERM'); } catch { /* already exited */ }
    }
    fakeSleepProcess = null;
    return { ok: false, active: false, reason: error.message, readiness };
  }
}

async function stopFakeSleep(wakeDisplay = true, restoreOverride = true) {
  if (fakeSleepProcess) {
    try { fakeSleepProcess.kill('SIGTERM'); } catch { /* already exited */ }
    fakeSleepProcess = null;
  }
  if (wakeDisplay && process.platform === 'darwin') {
    // A short user-activity assertion wakes the display when Fake Sleep ends.
    execFile('/usr/bin/caffeinate', ['-u', '-t', '1'], (error) => {
      if (error) console.error('Fake Sleep could not wake the display:', error);
    });
  }
  if (restoreOverride && fakeSleepSystemOverride) {
    const restored = await runAdminPowerCommand(false);
    if (restored.ok) fakeSleepSystemOverride = false;
    return { ok: restored.ok, active: false, systemOverride: fakeSleepSystemOverride, reason: restored.reason };
  }
  return { ok: true, active: false, systemOverride: fakeSleepSystemOverride };
}

// ---------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    // Match the supplied reference composition while allowing macOS to clamp
    // the window to the available work area on smaller displays.
    width: 1536,
    height: 1024,
    minWidth: 1100,
    minHeight: 700,
    resizable: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    // The HTML supplies Windows-style controls and a full draggable surface.
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#09080d',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      // TradingView Desktop is a separate local prerequisite. This window
      // intentionally has no embedded webview or broker credential surface.
    },
    show: false,
  });

  const isDev = process.env.NODE_ENV === 'development';
  // The desktop shell uses the same mobile-first React experience as the
  // web preview. The older terminal HTML remains in the repository as a
  // legacy fallback only; it is never the normal packaged entrypoint.
  const reactDistPath = path.join(__dirname, '../dist/index.html');
  const reactDevUrl = 'http://localhost:5173';

  if (isDev && process.env.DWELLA_REACT_DEV === '1') {
    mainWindow.loadURL(reactDevUrl);
  } else if (fs.existsSync(reactDistPath)) {
    mainWindow.loadFile(reactDistPath);
  } else {
    // Keep the entrypoint deterministic: never fall back to the legacy HTML
    // terminal, which used to embed/open a separate TradingView surface.
    mainWindow.loadURL(reactDevUrl);
  }

  // A webview-heavy terminal can keep Electron's `ready-to-show` event from
  // firing even after the local page has loaded. Showing only from that event
  // left the process alive with a CDP page but no visible Dwella window.
  let windowShown = false;
  const showWindow = () => {
    if (windowShown || !mainWindow || mainWindow.isDestroyed()) return;
    windowShown = true;
    mainWindow.show();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', showWindow);
  mainWindow.webContents.once('did-finish-load', showWindow);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Dwella page load failed (${errorCode}): ${errorDescription} — ${validatedURL}`);
    // Keep the shell usable even if TradingView or another remote resource
    // fails; the local terminal itself should still be visible.
    showWindow();
  });
  setTimeout(showWindow, 2500);
  mainWindow.on('closed', () => {
    // macOS may keep the application alive after its window closes; never
    // leave a hidden keep-awake assertion running in that state.
    stopFakeSleep(false);
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------
// Sidecar management — spawn Python processes, skip if already running.
// ---------------------------------------------------------------------
const TV_SIDECAR_PORT = 18814;
const AUTH_SIDECAR_PORT = 18815;
let tvSidecar = null;
let authSidecar = null;

function spawnSidecar(script, port, logName) {
  const logDir = path.join(TRADING_DIR, 'logs');
  const components = ensureBundledComponents();
  const sidecarEnv = {
    ...process.env,
    DWELLA_RUNTIME_DIR: TRADING_DIR,
    DWELLA_COMPONENTS_DIR: COMPONENTS_DIR,
    // Prefer the version shipped inside the app. The writable cache is only
    // a fallback; otherwise an older cached bridge can silently override the
    // fixed bundled history loader on upgrades.
    ...(components.bundledMcp ? { DWELLA_MCP_CLI: path.join(components.bundledMcp, 'src', 'cli', 'index.js') } :
      (components.mcp ? { DWELLA_MCP_CLI: components.mcp } : {})),
    ...(components.bundledNode ? { DWELLA_NODE: components.bundledNode } :
      (components.node ? { DWELLA_NODE: components.node } : {})),
    ...(components.bundledMcp ? { DWELLA_BUNDLED_MCP_DIR: components.bundledMcp } : {}),
    ...(components.bundledNode ? { DWELLA_BUNDLED_NODE: components.bundledNode } : {}),
    // Do not inject an embedded TradingView path: the sidecar must detect the
    // user's pre-installed official Desktop app instead.
    // The standalone Node binary is distributed with its libnode dylib beside
    // it. Point the loader at the per-user copy first, with the bundled path
    // as a fallback for a read-only or first-run cache failure.
    ...(components.runtimeDir ? { DYLD_LIBRARY_PATH: components.runtimeDir } : {}),
  };
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }

  const probe = net.createConnection({ host: '127.0.0.1', port });
  let decided = false;

  const spawnIt = () => {
    if (decided) return;
    decided = true;
    try {
      const logFd = fs.openSync(path.join(logDir, logName), 'a');
      const binaryName = script === 'tv_desktop_sidecar.py' || script === 'tv_sidecar.py' ? 'dwella-sidecar' : 'dwella-auth';
      // Support both the current flattened app bundle and the newer
      // Resources/bin layout so an installed DMG always uses its bundled
      // runtime instead of silently falling back to system Python.
      const packagedCandidates = [
        path.join(process.resourcesPath, 'bin', binaryName),
        path.join(process.resourcesPath, `bin-${binaryName}`),
      ];
      const packagedBinary = packagedCandidates.find((candidate) => fs.existsSync(candidate));
      const bundled = Boolean(packagedBinary);
      const command = bundled ? packagedBinary : 'python3';
      const args = bundled
        ? ['--http-port', String(port)]
        : [path.join(__dirname, '..', 'mt5', script), '--http-port', String(port)];
      const proc = spawn(command, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: sidecarEnv,
      });
      proc.on('error', (err) => console.error(`${script} error:`, err));
      proc.unref();
      return proc;
    } catch (err) {
      console.error(`${script} spawn failed:`, err);
      return null;
    }
  };

  return new Promise((resolve) => {
    probe.once('connect', () => { decided = true; probe.destroy(); resolve(null); });
    probe.once('error', () => resolve(spawnIt()));
    probe.setTimeout(2000, () => { probe.destroy(); resolve(spawnIt()); });
  });
}

// ---------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------
app.whenReady().then(async () => {
  registerIpc();
  createWindow();

  // Start both sidecars
  tvSidecar = await spawnSidecar('tv_desktop_sidecar.py', TV_SIDECAR_PORT, 'tv-sidecar.log');
  authSidecar = await spawnSidecar('auth_server.py', AUTH_SIDECAR_PORT, 'auth-server.log');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  stopFakeSleep(false);
  for (const proc of [tvSidecar, authSidecar]) {
    if (proc) {
      try { proc.kill(); } catch { /* ignore */ }
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
