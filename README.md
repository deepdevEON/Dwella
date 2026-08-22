# Dwella

Desktop trading app: Electron shell + React/Vite/Tailwind UI, with Python trading sidecars (MT5/TradingView data feeds, scanner, strategy execution, auth server).

**Research only — not financial advice.**

## Layout

| Path | Contents |
|---|---|
| `electron/` | Electron main process (window lifecycle, sidecar spawning, webview wiring) |
| `src/` | React UI (Vite + Tailwind) |
| `public/` | Static assets: PWA manifest, service worker, app icons |
| `mt5/` | Python trading backend: `tv_sidecar.py` (TradingView data/execution), `mt5_live_server.py`, `tradovate_server.py`, `auth_server.py`, `tvdatafeed_service.py`, scanners, and strategy engines (777, confluence, essence, pullback, volume profile, ...) with tests |
| `browserbase-trader/` | Self-hosted Playwright Chromium service powering the embedded TradingView session |
| `backtests/` | Standalone strategy backtests (NQ M5 replay, FVG M15, FVG trader) |
| `launchd/` | macOS launchd agents that keep the sidecars running on the desktop host |
| `docs/` | Trading journal and project notes |
| `scripts/` | Dev tooling — `freebuff-preview.mjs` launches Vite + auth server + Playwright sidecar together |
| `trading/` | Runtime data directory (gitignored) + README |
| `index.html` | UI entry point |

## Run

```bash
bun install            # or: npm install
bun run dev            # Vite + auth server + Playwright sidecar in one process
npm run desktop        # build UI + launch Electron
npm run mt5            # or launch the Python sidecar directly
```

The Electron main process spawns the sidecars (`tv_desktop_sidecar` on port 18814, `auth_server` on 18815) automatically.

## In-app login

Dwella keeps its existing local SQLite/PBKDF2 account login on the desktop sidecar (`auth_server.py`). TradingView is a separate user-controlled session handoff: open **Trade → Sign in to TradingView**, enter credentials only on the official TradingView sign-in page, return to Dwella, and press **Verify session**. Dwella never receives, logs, or stores the TradingView password; it only reads the browser's authenticated status when the local or hosted bridge is available.

## Free Playwright TradingView alternative

For the mobile/cloud version, `browserbase-trader/` now runs a self-hosted Chromium session through Playwright. It has no Browserbase credits or paid browser provider. The Trade tab embeds a protected screenshot-and-input remote view so you can sign in to the real TradingView web app from your phone. Login text and MFA keys travel in protected request bodies, while the persistent profile keeps TradingView's own session cookies on the host.

The Freebuff preview now starts both processes together with `bun run preview:all`: Vite serves Dwella and the launcher starts the Playwright service in the same workspace. The Vite `/browser/*` proxy keeps the remote view on the same preview origin, so no second public port or Browserbase account is needed. The install command is `bun run preview:install`, which installs the nested service, the Chromium OS libraries (`playwright install-deps`), and the Chromium binary. If no token is supplied, the launcher creates a random per-preview token and passes it only to the paired processes. Without `install-deps`, Chromium fails to launch in a minimal Linux container with `error while loading shared libraries: libglib-2.0.so.0`, which is what previously blocked the in-app TradingView web session.

For a separate host, configure `PLAYWRIGHT_TRADER_TOKEN`, `PLAYWRIGHT_USER_DATA_DIR`, and `DWELLA_ORIGIN`, then set `VITE_PLAYWRIGHT_TRADER_URL` and `VITE_PLAYWRIGHT_TRADER_TOKEN` in the Dwella Keys/API keys UI. See [`browserbase-trader/README.md`](browserbase-trader/README.md) for the full setup.

This is free software, but the Playwright process is only available while the Freebuff workspace/service is alive and its profile persists only as long as the workspace storage persists. It is not a 24/7 production host. Live routing remains gated behind Dwella's verified execution-bridge/account/risk checks; the remote TradingView browser session alone is not treated as authorization to place live orders.

## Linux cloud execution bridge (CloudDesktop)

CloudDesktop can host the persistent Linux runtime, but it is a remote-desktop layer—not a trading API. For cloud execution, run the existing Tradovate bridge on the Linux VPS and keep the React app pointed at its HTTPS endpoint:

```text
Dwella web app → HTTPS reverse proxy → mt5/tradovate_server.py → Tradovate API
CloudDesktop (optional) → persistent browser/TradingView viewing session
```

Start the bridge behind a reverse proxy and require a bearer token:

```bash
export DWELLA_TRADING_BRIDGE_TOKEN='<long-random-token>'
export DWELLA_ORIGIN='https://your-dwella-app.example'
python3 mt5/tradovate_server.py --http-host 127.0.0.1 --http-port 18814
```

Do not expose port `18814` directly to the internet. Put it behind HTTPS, restrict the firewall, and keep the bridge process persistent with the VPS process manager. A non-loopback bind without `DWELLA_TRADING_BRIDGE_TOKEN` is intentionally rejected by the bridge.

In the Dwella Keys/API keys settings, configure:

- `VITE_TRADING_BRIDGE_URL` — the HTTPS base URL of the VPS bridge, without a trailing slash.
- `VITE_TRADING_BRIDGE_TOKEN` — the same bridge access token.

These values are read at build time. Without `VITE_TRADING_BRIDGE_URL`, browser sessions never probe the user’s `127.0.0.1`; they remain paper-only. `VITE_TRADING_BRIDGE_TOKEN` is an access guard sent by the browser, not the Tradovate account credential, so the endpoint must still be private and origin-restricted.

The bridge status contract is available at `GET /tv/status` and reports `provider`, `connected`, `account_connected`, and `execution.ready`. The live ticket will not arm until all three checks are true: the bridge is reachable, the Tradovate account is resolved, and the explicit live-risk acknowledgement is selected. A TradingView web login does not authorize broker execution by itself.

CloudDesktop may keep a TradingView browser session alive for viewing and manual sign-in, but it does not make TradingView login automatic and it does not place orders. The live order path uses the supported Tradovate API bridge; keep paper mode enabled while validating the VPS, broker environment, account, contracts, stop/target behavior, and kill-switch procedure.

## TradingView Desktop prerequisite

TradingView Desktop is an external, already-installed prerequisite — Dwella does **not** download, embed, patch, or hide the proprietary app, but it will **open** it for you once it is installed. Before connecting Dwella:

1. Install the official TradingView Desktop app on the same device (one time).
2. In Dwella, open **Trade → Open TradingView**. Dwella starts the installed app with its local Chrome DevTools Protocol endpoint on port `9222` and waits for the session (or set `DWELLA_TV_CDP_PORT`).
3. Sign in to **Tradovate inside TradingView Desktop** and leave that session running.
4. Back in Dwella, press **Verify** again until the account is visible, then save the visible account.
5. Keep live routing off unless you explicitly acknowledge the risk notice and arm the scanner. The existing risk gates still apply.

The web preview cannot inspect or install applications on the host device, so it remains read-only until the local Dwella Desktop bridge is available. Broker and TradingView credentials are never entered into the Dwella web form.

## Notes

- `accounts.json`, auth DB, trade journals, and runtime data are gitignored — never commit account credentials.
- The packaged `.app` (`packaging/`, `build/`, `dist/`) is generated output and not committed.
