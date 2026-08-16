# Dwella

Desktop trading app: Electron shell + React/Vite/Tailwind UI, with Python trading sidecars (MT5/TradingView data feeds, scanner, strategy execution, auth server).

**Research only — not financial advice.**

## Layout

| Path | Contents |
|---|---|
| `electron/` | Electron main process (window lifecycle, sidecar spawning, webview wiring) |
| `src/` | React UI (Vite + Tailwind) |
| `public/` | Static assets |
| `mt5/` | Python trading backend: `tv_sidecar.py` (TradingView data/execution), `mt5_live_server.py`, `tradovate_server.py`, `auth_server.py`, `tvdatafeed_service.py`, scanners, and strategy engines (777, confluence, essence, pullback, volume profile, ...) with tests |
| `trading/` | Runtime data directory (gitignored) + README |
| `index.html`, `dwella-terminal.html` | UI entry points |

## Run

```bash
npm install
npm run desktop        # build UI + launch Electron
npm run mt5            # or launch the Python sidecar directly
```

The Electron main process spawns the sidecars (`tv_sidecar` on port 18814, `auth_server` on 18815) automatically.

## Notes

- `accounts.json`, auth DB, trade journals, and runtime data are gitignored — never commit account credentials.
- The packaged `.app` (`packaging/`, `build/`, `dist/`) is generated output and not committed.
