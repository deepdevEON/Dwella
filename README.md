# Dwella Desktop for macOS

> **⚠️ Status: Proof of Concept (POC)**
>
> **Dwella is currently a POC.** It is an early-stage prototype and is **not production-ready**. APIs, UI surfaces, and execution paths may change without warning. Do **not** rely on it for live trading without substantial additional hardening, auditing, and risk controls. The author (deepdevEon) is publishing this code as a working starting point, not as a finished product.

Dwella is a fully local Electron desktop application. The interface is bundled inside the app; it does not load the hosted website. Native operations are isolated behind Electron's preload bridge.

## Included

- Premium Dwella overview dashboard
- Native macOS window with hidden inset title bar
- Local Hermes discovery, health checks, start/stop, and task console
- Localhost-only Hermes API integration (`127.0.0.1:8642`)
- Zo Computer connection test
- Zo access-token encryption with Electron `safeStorage` (macOS Keychain-backed)
- Context isolation, renderer sandbox, and disabled Node access in the UI
- Paper-trading UI boundary; no live broker execution is implemented
- macOS DMG/ZIP packaging configuration

## Run on a Mac

Requirements: macOS, Node.js 22+, npm.

```bash
npm install
npm run dev
```

## Install Hermes locally

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup
```

In `~/.hermes/.env`, enable its localhost API:

```env
API_SERVER_ENABLED=true
API_SERVER_KEY=replace-with-a-long-random-local-key
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

Dwella reads the local key from this file only in the native process. The renderer cannot access it.

## Build the macOS application

On macOS:

```bash
npm install
npm run dist:mac
```

Artifacts appear under `release/` or `dist/`, depending on the active electron-builder version. An unsigned build can be opened locally after approving it in macOS Privacy & Security. Public distribution requires an Apple Developer ID certificate and notarization.

## Zo Computer

Create a Zo token from **Settings → Advanced**. Enter it in Dwella's Agent Core. It is encrypted by macOS secure storage and never written into the renderer bundle.

The app currently uses Zo's official `POST /zo/ask` endpoint for connection verification. Broader Zo actions should be allowlisted before they are exposed in Dwella.

## Important safety boundary

This project intentionally does not automate live brokerage orders. Add paper-trading adapters first, audit every command, require explicit confirmation for order submission, and never store broker passwords in the renderer or Hermes prompts.
