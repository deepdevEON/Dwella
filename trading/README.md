# Trading

Central workspace for trading-related assets in the Flourish desktop app.

| Folder      | Purpose                                              |
|-------------|------------------------------------------------------|
| `data/`     | Market data, candle history, downloaded datasets      |
| `strategies/` | Strategy definitions, configs, and backtest scripts |
| `logs/`     | Runtime logs, trade execution logs, audit trails      |
| `exports/`  | Generated reports, CSV/JSON exports, screenshots      |

## Live MT5 connection

Flourish connects directly to your Wine-hosted MetaTrader 5 terminal through the
`mt5/` bridge (same setup as your Tokyo Reversal research):

```
MetaTrader 5 ──mt5linux/RPyC (18812)──▶ mt5/mt5_live_server.py (HTTP 18814) ──▶ Electron renderer
```

- **Run it:** `npm run mt5` (or let the app spawn it automatically on launch — it
  skips if port 18814 is already serving).
- **Live data:** real M5 candles + bid/ask/last ticks for `@ENQ`, `@MES`, `@GCE`,
  refreshed every ~4s, consumed at `http://127.0.0.1:18814`.
- **Honest limits:** MT5 exposes no level-2 depth over this bridge, so the DOM
  ladder, cumulative delta and MBO-style iceberg radar stay simulated. The chart,
  ATR, value area, bias and setup scanner switch to the real MT5 candles, and the
  UI labels everything clearly (`· sim`).
- **Read-only:** the sidecar never places orders.
- **Logs:** `logs/mt5-sidecar.log` (auto-created by the app).
