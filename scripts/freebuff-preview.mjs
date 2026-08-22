import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const fs = require('node:fs');

// Vite serves the public-facing preview on the managed PORT.
// The Python auth server listens on a fixed internal port; Vite proxies
// /auth → the auth server so it stays private and never shares the public port.
const authPort = String(process.env.DWELLA_AUTH_PORT || '18817');
const traderPort = String(process.env.PLAYWRIGHT_PORT || '8646');
const appPort = String(process.env.PORT || '18815');

const serviceToken = process.env.PLAYWRIGHT_TRADER_TOKEN
  || process.env.VITE_PLAYWRIGHT_TRADER_TOKEN
  || randomBytes(24).toString('hex');

// The managed preview can run with a different $HOME than the shell that
// installed the Playwright browsers (e.g. /root vs /home/daytona). Playwright
// resolves its browser cache from $HOME by default, which makes it look in
// /root/.cache/ms-playwright while the browsers live in /home/daytona's cache.
// Pin the browsers path so the paired service always finds the installed
// Chromium regardless of which user the preview runs as. The cache does not
// always contain browsers.json, so validate an actual Chromium executable.
function hasChromiumExecutable(cachePath) {
  try {
    return fs.readdirSync(cachePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+/.test(entry.name))
      .some((entry) => {
        const root = `${cachePath}/${entry.name}`;
        return [
          'chrome-linux/chrome',
          'chrome-linux64/chrome',
          'chrome-win/chrome.exe',
          'chrome-win64/chrome.exe',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        ].some((relativePath) => fs.existsSync(`${root}/${relativePath}`));
      });
  } catch {
    return false;
  }
}

function resolvePlaywrightBrowsersPath() {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/home/daytona/.cache/ms-playwright',
    '/root/.cache/ms-playwright',
    '/home/codespace/.cache/ms-playwright',
    '/workspaces/.cache/ms-playwright',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (hasChromiumExecutable(candidate)) return candidate;
  }
  return '';
}

const playwrightBrowsersPath = resolvePlaywrightBrowsersPath();

const sharedEnv = {
  ...process.env,
  PLAYWRIGHT_PORT: traderPort,
  ...(playwrightBrowsersPath ? { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath } : {}),
};
const viteEnv = {
  ...sharedEnv,
  PORT: appPort,
  DWELLA_AUTH_PORT: authPort,
  VITE_PLAYWRIGHT_TRADER_TOKEN: serviceToken,
};
const traderEnv = {
  ...sharedEnv,
  HOST: '0.0.0.0',
  PORT: traderPort,
  PLAYWRIGHT_TRADER_TOKEN: serviceToken,
  // Keep the bearer guard enabled even though Vite proxies the paired service
  // locally. A public preview must not bypass authorization merely because the
  // request reaches the Node service from 127.0.0.1.
  ALLOW_UNAUTHENTICATED_LOCAL: 'false',
};

const bunCommand = process.platform === 'win32' ? 'bun.exe' : 'bun';

// Start Vite first — it claims the public port (18815).
const vite = spawn(bunCommand, ['run', 'dev:client', '--', '--host', '0.0.0.0', '--port', appPort], {
  env: viteEnv,
  stdio: 'inherit',
});
const trader = spawn(process.execPath, ['browserbase-trader/server.js'], {
  env: traderEnv,
  stdio: 'inherit',
});

// The React web shell uses the same PBKDF2/SQLite auth service as Electron.
// Start it with the paired preview so browser sign-in and registration are
// real flows instead of forcing every web user into read-only preview mode.
// If Python is unavailable, keep the Vite + Playwright preview alive and let
// the UI report that the auth sidecar is unavailable.
const auth = spawn('python3', ['mt5/auth_server.py', '--http-port', authPort], {
  env: {
    ...sharedEnv,
    DWELLA_RUNTIME_DIR: process.env.DWELLA_RUNTIME_DIR || './trading',
  },
  stdio: 'inherit',
});

auth.on('error', (error) => console.warn(`[preview] Dwella auth sidecar unavailable: ${error.message}`));
auth.on('exit', (code, signal) => {
  if (!stopping && (code || signal)) console.warn(`[preview] Dwella auth sidecar stopped (${signal || `exit ${code}`}).`);
});

let stopping = false;

function stop(signal = 'SIGTERM', exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of [vite, trader, auth]) {
    if (!child.killed) child.kill(signal);
  }
  const forceExit = setTimeout(() => process.exit(exitCode), 3500);
  forceExit.unref();
}

function handleChildError(name, error) {
  console.error(`[preview] ${name} failed to start: ${error.message}`);
  stop('SIGTERM', 1);
}

function handleChildExit(name, code, signal) {
  if (stopping) return;
  const reason = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
  console.error(`[preview] ${name} stopped (${reason}); stopping the paired process.`);
  stop('SIGTERM', code ?? 1);
}

vite.on('error', (error) => handleChildError('Vite', error));
trader.on('error', (error) => handleChildError('Playwright TradingView', error));
vite.on('exit', (code, signal) => handleChildExit('Vite', code, signal));
trader.on('exit', (code, signal) => handleChildExit('Playwright TradingView', code, signal));

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));