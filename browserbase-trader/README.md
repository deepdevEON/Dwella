# Dwella free Playwright TradingView session

This Node service runs the real TradingView web app in **open-source Chromium through Playwright**. It has no Browserbase account, browser credits, or metered session provider. The directory keeps its historical `browserbase-trader` name for repository compatibility, but the implementation is now Playwright-only.

The service runs Chromium headlessly and exposes a protected mobile remote view backed by screenshots and touch/keyboard events. TradingView credentials are entered into the remote page; text/key input is accepted only in POST bodies and is not stored or logged by the service.

## Run

From this directory:

```bash
npm install
npx playwright install-deps chromium   # installs Chromium's OS libraries (apt-get; needs root)
npx playwright install chromium
npm start
```

**Important:** Chromium needs system libraries that are not present in a minimal Linux container. If the service reports `browserType.launch: Target page, context or browser has been closed` with `error while loading shared libraries: libglib-2.0.so.0`, the OS deps are missing — run `npx playwright install-deps chromium` (requires root) and retry.

The service listens on `0.0.0.0:$PORT` (default `8646`). The Playwright browser process exists only while the Node service is alive. The persistent profile is stored in `.playwright-tradingview/` by default so cookies can survive service restarts within the same workspace.

For the Freebuff preview, use the root command `bun run preview:all`. Its launcher starts Vite and this service together, assigns the service an internal port (`8646` by default), and exposes `/browser/*` through the Vite same-origin proxy. The install command `bun run preview:install` installs this package, the Chromium OS libraries (`playwright install-deps`), and the Chromium binary before the preview starts.

All `/browser/*` endpoints accept GET and POST. The browser-facing app uses GET for status/start and non-sensitive pointer events; text and key events are sent as protected POST JSON bodies (never URL query parameters) so TradingView passwords and MFA codes are not exposed in request URLs. Direct or separately hosted callers may use POST with JSON bodies for every endpoint. If no token is present, the launcher generates a random token for that paired preview automatically. Freebuff workspaces are still ephemeral: they may stop the processes, clear the workspace, or remove the profile when the workspace is recycled. This is not a 24/7 production trading host.

## Environment

| Variable | Default | Purpose |
|---|---:|---|
| `PLAYWRIGHT_TRADER_TOKEN` | — | Bearer token required by browser endpoints |
| `PLAYWRIGHT_USER_DATA_DIR` | `.playwright-tradingview` | Persistent Chromium profile directory |
| `PLAYWRIGHT_TRADER_PUBLIC_URL` | derived from request | Public HTTPS URL used for the embedded view |
| `DWELLA_ORIGIN` | `*` | Comma-separated Dwella origins allowed by CORS; restrict in production |
| `TRADINGVIEW_URL` | `https://www.tradingview.com/accounts/signin/` | Initial TradingView page; an existing signed-in profile may redirect to its chart |
| `PLAYWRIGHT_SESSION_TIMEOUT` | `21600` | Maximum session lifetime in seconds |
| `PLAYWRIGHT_VIEWPORT_WIDTH` | `390` | Remote mobile viewport width |
| `PLAYWRIGHT_VIEWPORT_HEIGHT` | `844` | Remote mobile viewport height |
| `PORT` | `8646` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |

For a private local-only preview, `ALLOW_UNAUTHENTICATED_LOCAL=true` can disable the bearer requirement. Do not use that setting on a public host.

## Dwella app variables

Set these in the Dwella app's Keys/API keys settings:

- `VITE_PLAYWRIGHT_TRADER_URL` — HTTPS URL of a separately hosted service, without a trailing slash. Leave it unset for the combined Freebuff preview; Dwella uses its own origin and the `/browser/*` proxy.
- `VITE_PLAYWRIGHT_TRADER_TOKEN` — the same token used by a separately hosted service. The combined preview injects one automatically.

Vite variables are shipped to the browser, so the token is a workspace access guard, not a replacement for real user authentication. Restrict CORS and keep this service private wherever possible.

## Mobile flow

1. Open the **Trade** tab; Dwella automatically starts the paired Playwright browser.
2. If the browser is not already running, tap **Sign in to TradingView** to retry it.
3. Dwella opens the Playwright remote view inside the app.
4. Tap the remote page and type normally to complete TradingView login and MFA.
5. The service keeps a persistent Chromium profile while the workspace remains available. That profile stores TradingView's own session cookies on the VPS; Dwella never stores, prints, or receives the password itself.
6. Dwella polls the service and shows `SIGNED IN` when the TradingView page exposes an authenticated session.

The Playwright session is a manual remote browser. It does not automatically enable live order routing; Dwella still requires its separate verified execution bridge/account/risk gates before any live route can be considered. Signing in to TradingView proves only the web session, not broker authorization.
