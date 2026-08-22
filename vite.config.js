import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const playwrightPort = Number.parseInt(process.env.PLAYWRIGHT_PORT || '8646', 10) || 8646;
const authPort = Number.parseInt(process.env.DWELLA_AUTH_PORT || '18817', 10) || 18817;
// The browser bundle reads the token from VITE_PLAYWRIGHT_TRADER_TOKEN, the
// Vite proxy forwards it to the paired service, and the service verifies it.
// When the managed preview runs plain Vite (no env token), mint one here and
// expose it to the bundle through process.env so all three stay in sync.
const configuredToken = process.env.PLAYWRIGHT_TRADER_TOKEN
  || process.env.VITE_PLAYWRIGHT_TRADER_TOKEN
  || process.env.VITE_BROWSERBASE_TRADER_TOKEN
  || '';
const playwrightToken = configuredToken || randomBytes(24).toString('hex');
if (!configuredToken) process.env.VITE_PLAYWRIGHT_TRADER_TOKEN = playwrightToken;

// The Playwright browser cache can live under a different $HOME than the
// preview process (e.g. /home/daytona vs /root). Pin it so the paired service
// always finds the installed Chromium, mirroring scripts/freebuff-preview.mjs.
function hasChromiumExecutable(cachePath) {
  try {
    return fs.readdirSync(cachePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+/.test(entry.name))
      .some((entry) => ['chrome-linux/chrome', 'chrome-linux64/chrome'].some((relativePath) => fs.existsSync(`${cachePath}/${entry.name}/${relativePath}`)));
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
  return candidates.find(hasChromiumExecutable) || '';
}

function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

let traderSidecar = null;

// A managed preview that only launches Vite never starts the paired Playwright
// service, so the Desktop/Trade workspaces report that the browser cannot
// start. Boot the sidecar from the Vite dev server itself; when the full
// launcher (scripts/freebuff-preview.mjs) already started it, the port check
// skips this and no duplicate process is created.
async function ensureTraderSidecar(server) {
  try {
    if (await portInUse(playwrightPort)) return;
    const browsersPath = resolvePlaywrightBrowsersPath();
    traderSidecar = spawn(process.execPath, ['browserbase-trader/server.js'], {
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        PORT: String(playwrightPort),
        PLAYWRIGHT_TRADER_TOKEN: playwrightToken,
        ALLOW_UNAUTHENTICATED_LOCAL: 'false',
        ...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
      },
      stdio: 'inherit',
    });
    traderSidecar.on('error', (error) => console.warn('[vite] Playwright TradingView sidecar failed to start:', error.message));
    traderSidecar.on('exit', (code) => { if (code) console.warn(`[vite] Playwright TradingView sidecar exited (${code}).`); });
    server.httpServer?.once('close', () => { try { traderSidecar?.kill('SIGTERM'); } catch { /* already gone */ } });
    console.log(`[vite] Playwright TradingView sidecar booting on 0.0.0.0:${playwrightPort}`);
  } catch (error) {
    console.warn('[vite] Could not start the Playwright TradingView sidecar:', error?.message || error);
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'dwella-playwright-sidecar',
      configureServer(server) {
        ensureTraderSidecar(server).catch((error) => {
          console.error('[vite] Sidecar spawn failed:', error?.message || error);
        });
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: false,
    proxy: {
      // Browser previews cannot reach a sidecar through the user's own
      // 127.0.0.1. Keep auth same-origin in the web app, while Electron still
      // uses its direct localhost fallback from src/App.jsx.
      '/auth': {
        target: `http://127.0.0.1:${authPort}`,
        changeOrigin: true,
      },
      '/browser': {
        target: `http://127.0.0.1:${playwrightPort}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('authorization', `Bearer ${playwrightToken}`);
          });
        },
      },
      '/market': {
        target: `http://127.0.0.1:${playwrightPort}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('authorization', `Bearer ${playwrightToken}`);
          });
        },
      },
    },
  },
});
