import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BUILTIN_STRATEGIES } from "./backtest/strategies";
import type { Strategy } from "./backtest/engine";
import { StrategyRunner, type RunnerConfig, type RunnerState } from "./autotrader/runner";
import { OrderExecutor, type PendingOrder } from "./autotrader/executor";
import { RiskManager, type RiskConfig, type RiskState } from "./autotrader/risk";
import { signalBus, type TradeSignal, type SignalEvent } from "./autotrader/signal";
import { syncLivePositions } from "./practice-trading";

const fmtPrice = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const TFS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
const SYMBOLS = ["NQ", "ES", "GC", "MES", "MNQ", "MGCD"];
const INTERVAL_MS: Record<string, number> = {
  M1: 30_000,
  M5: 30_000,
  M15: 60_000,
  M30: 60_000,
  H1: 120_000,
  H4: 300_000,
  D1: 600_000,
};

interface StrategyRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  status: "stopped" | "running" | "paused";
  lastBarTime: number | null;
  signalsGenerated: number;
  ordersPlaced: number;
}

interface Runners {
  [key: string]: {
    runner: StrategyRunner;
    risk: RiskManager;
    executor: OrderExecutor;
  };
}

export default function AutoTraderPanel() {
  const [strategies, setStrategies] = useState<StrategyRow[]>(
    BUILTIN_STRATEGIES.map((s: Strategy) => ({
      id: s.id,
      name: s.name,
      description: s.description || "",
      enabled: false,
      status: "stopped" as const,
      lastBarTime: null,
      signalsGenerated: 0,
      ordersPlaced: 0,
    })),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("NQ");
  const [timeframe, setTimeframe] = useState<RunnerConfig["timeframe"]>("M5");
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [riskConfig, setRiskConfig] = useState<RiskConfig>({
    maxPositionPerSymbol: 5,
    maxTotalExposure: 50000,
    dailyLossLimit: 2000,
    maxDrawdownPct: 10,
    correlatedSymbols: [["NQ", "ES"], ["MNQ", "MES"]],
    defaultContracts: 1,
    riskPerTradePct: 1,
  });
  const [riskState, setRiskState] = useState<RiskState | null>(null);
  const [tradesToday, setTradesToday] = useState(0);
  const [winRate, setWinRate] = useState(0);
  const [totalPnl, setTotalPnl] = useState(0);

  const runnersRef = useRef<Runners>({});
  const riskRef = useRef<RiskManager>(new RiskManager(riskConfig));

  useEffect(() => {
    riskRef.current.setConfig(riskConfig);
  }, [riskConfig]);

  useEffect(() => {
    const unsub = signalBus.subscribe((event: SignalEvent) => {
      if (event.type === "signal" && event.payload && typeof event.payload === "object" && "signal" in event.payload) {
        const sig = (event.payload as { signal: TradeSignal }).signal;
        if (sig) {
          setSignals((prev) => [...prev.slice(-49), sig]);
          setTradesToday((prev) => prev + 1);
        }
      }
      if (event.type === "order_filled") {
        setPendingOrders((prev) =>
          prev
            .map((o): PendingOrder =>
              o.status === "placed" ? { ...o, status: "filled" } : o,
            )
            .filter((o) => o.status !== "filled"),
        );
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const snap = await syncLivePositions();
        if (!active) return;
        riskRef.current.updateAccount(snap.equity, snap.openPositions);
        setRiskState(riskRef.current.getState());
        setTotalPnl(snap.totalPnl);
        if (snap.closedTrades.length > 0) {
          const wins = snap.closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
          setWinRate(snap.closedTrades.length > 0 ? (wins / snap.closedTrades.length) * 100 : 0);
        }
      } catch {}
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const startStrategy = useCallback(
    (id: string) => {
      const strategy = BUILTIN_STRATEGIES.find((s) => s.id === id);
      if (!strategy) return;

      const risk = new RiskManager(riskConfig);
      const executor = new OrderExecutor(
        risk,
        {},
        (orders) => setPendingOrders(orders),
      );
      const config: RunnerConfig = {
        strategyId: id,
        symbol,
        timeframe,
        intervalMs: INTERVAL_MS[timeframe] || 60_000,
        maxBars: 200,
      };
      const runner = new StrategyRunner(
        config,
        risk,
        executor,
        (state: RunnerState) => {
          setStrategies((prev) =>
            prev.map((s) => (s.id === id ? { ...s, ...state, status: state.status } : s)),
          );
        },
        (signal: TradeSignal) => {
          setSignals((prev) => [...prev.slice(-49), signal]);
        },
      );

      runnersRef.current[id] = { runner, risk, executor };
      runner.start();

      setStrategies((prev) =>
        prev.map((s) => (s.id === id ? { ...s, enabled: true, status: "running" as const } : s)),
      );
      setActiveId(id);
    },
    [symbol, timeframe, riskConfig],
  );

  const stopStrategy = useCallback(
    (id: string) => {
      const entry = runnersRef.current[id];
      if (entry) {
        entry.runner.destroy();
        delete runnersRef.current[id];
      }
      setStrategies((prev) =>
        prev.map((s) => (s.id === id ? { ...s, enabled: false, status: "stopped" as const } : s)),
      );
      if (activeId === id) setActiveId(null);
    },
    [activeId],
  );

  const pauseStrategy = useCallback((id: string) => {
    const entry = runnersRef.current[id];
    if (entry) {
      entry.runner.pause();
      setStrategies((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: "paused" as const } : s)),
      );
    }
  }, []);

  const resumeStrategy = useCallback((id: string) => {
    const entry = runnersRef.current[id];
    if (entry) {
      entry.runner.start();
      setStrategies((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: "running" as const } : s)),
      );
    }
  }, []);

  const activeStrategy = strategies.find((s) => s.id === activeId);
  const activeRunner = activeId ? runnersRef.current[activeId] : null;

  return (
    <div className="autotrader-panel">
      <div className="at-top">
        <section className="at-strategies glass">
          <div className="section-head">
            <h3>Strategies</h3>
            <span>{strategies.filter((s) => s.status === "running").length} active</span>
          </div>
          <div className="at-strategy-list">
            {strategies.map((s) => (
              <div className={`at-strategy-row ${s.status}`} key={s.id}>
                <div className="at-strategy-info">
                  <b>{s.name}</b>
                  <small>{s.description}</small>
                  {s.status !== "stopped" && (
                    <span className="at-strategy-meta">
                      {s.signalsGenerated} signals · {s.ordersPlaced} orders
                    </span>
                  )}
                </div>
                <div className="at-strategy-controls">
                  {s.status === "stopped" ? (
                    <button
                      className="at-btn start"
                      disabled={!s.enabled}
                      onClick={() => startStrategy(s.id)}
                    >
                      Start
                    </button>
                  ) : (
                    <>
                      {s.status === "running" ? (
                        <button className="at-btn pause" onClick={() => pauseStrategy(s.id)}>
                          Pause
                        </button>
                      ) : (
                        <button className="at-btn resume" onClick={() => resumeStrategy(s.id)}>
                          Resume
                        </button>
                      )}
                      <button className="at-btn stop" onClick={() => stopStrategy(s.id)}>
                        Stop
                      </button>
                    </>
                  )}
                  <label className="at-toggle">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) =>
                        setStrategies((prev) =>
                          prev.map((x) =>
                            x.id === s.id ? { ...x, enabled: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    <span />
                  </label>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="at-controls glass">
          <div className="section-head">
            <h3>Runner Config</h3>
            <span>
              {activeStrategy?.name || "No active strategy"}
            </span>
          </div>
          <div className="at-config-grid">
            <label>
              <span>Symbol</span>
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={activeId !== null}
              >
                {SYMBOLS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Timeframe</span>
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value as RunnerConfig["timeframe"])}
                disabled={activeId !== null}
              >
                {TFS.map((tf) => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Poll Interval</span>
              <span className="at-readonly">
                {INTERVAL_MS[timeframe] ? `${INTERVAL_MS[timeframe] / 1000}s` : "—"}
              </span>
            </label>
          </div>
        </section>
      </div>

      <div className="at-middle">
        <section className="at-risk glass">
          <div className="section-head">
            <h3>Risk Parameters</h3>
            <span>Enforced per order</span>
          </div>
          <div className="at-risk-grid">
            <label>
              <span>Max Position / Symbol</span>
              <input
                type="number"
                value={riskConfig.maxPositionPerSymbol}
                onChange={(e) =>
                  setRiskConfig((prev) => ({
                    ...prev,
                    maxPositionPerSymbol: Number(e.target.value),
                  }))
                }
                min={1}
                max={20}
              />
            </label>
            <label>
              <span>Max Total Exposure ($)</span>
              <input
                type="number"
                value={riskConfig.maxTotalExposure}
                onChange={(e) =>
                  setRiskConfig((prev) => ({
                    ...prev,
                    maxTotalExposure: Number(e.target.value),
                  }))
                }
                min={1000}
                step={1000}
              />
            </label>
            <label>
              <span>Daily Loss Limit ($)</span>
              <input
                type="number"
                value={riskConfig.dailyLossLimit}
                onChange={(e) =>
                  setRiskConfig((prev) => ({
                    ...prev,
                    dailyLossLimit: Number(e.target.value),
                  }))
                }
                min={100}
                step={100}
              />
            </label>
            <label>
              <span>Max Drawdown %</span>
              <input
                type="number"
                value={riskConfig.maxDrawdownPct}
                onChange={(e) =>
                  setRiskConfig((prev) => ({
                    ...prev,
                    maxDrawdownPct: Number(e.target.value),
                  }))
                }
                min={1}
                max={50}
              />
            </label>
            <label>
              <span>Risk Per Trade %</span>
              <input
                type="number"
                value={riskConfig.riskPerTradePct}
                onChange={(e) =>
                  setRiskConfig((prev) => ({
                    ...prev,
                    riskPerTradePct: Number(e.target.value),
                  }))
                }
                min={0.1}
                max={10}
                step={0.1}
              />
            </label>
            <label>
              <span>Default Contracts</span>
              <input
                type="number"
                value={riskConfig.defaultContracts}
                onChange={(e) =>
                  setRiskConfig((prev) => ({
                    ...prev,
                    defaultContracts: Number(e.target.value),
                  }))
                }
                min={1}
                max={50}
              />
            </label>
          </div>
          {riskState && (
            <div className="at-risk-status">
              <span className={riskState.circuitBreaker ? "neg" : "pos"}>
                Circuit breaker: {riskState.circuitBreaker ? "ACTIVE" : "OK"}
              </span>
              <span>Daily P&L: ${fmtPrice(riskState.dailyPnl)}</span>
              <span>Max DD: {fmtPct(riskState.maxDrawdown)}</span>
              <span>Exposure: ${fmtPrice(riskState.currentExposure)}</span>
            </div>
          )}
        </section>

        <section className="at-metrics glass">
          <div className="section-head">
            <h3>Performance</h3>
            <span>Today</span>
          </div>
          <div className="at-metrics-grid">
            <div className="at-metric">
              <b>{tradesToday}</b>
              <small>Trades</small>
            </div>
            <div className="at-metric">
              <b className={winRate >= 50 ? "pos" : "neg"}>{winRate.toFixed(1)}%</b>
              <small>Win Rate</small>
            </div>
            <div className="at-metric">
              <b className={totalPnl >= 0 ? "pos" : "neg"}>
                {totalPnl >= 0 ? "+" : ""}${fmtPrice(Math.abs(totalPnl))}
              </b>
              <small>P&L</small>
            </div>
          </div>
        </section>
      </div>

      <section className="at-signals glass">
        <div className="section-head">
          <h3>Live Signal Feed</h3>
          <span>{signals.length} total</span>
        </div>
        {pendingOrders.length > 0 && (
          <div className="at-pending">
            {pendingOrders.map((o) => (
              <div className={`at-pending-row ${o.status}`} key={o.signalId}>
                <span className="at-pending-sym">{o.symbol}</span>
                <span className={`at-pending-action ${o.action}`}>{o.action.toUpperCase()}</span>
                <span>{o.quantity}</span>
                <span className={`at-pending-status ${o.status}`}>
                  {o.status.toUpperCase()}
                </span>
                {o.error && <span className="neg">{o.error}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="at-signal-list">
          {signals.length === 0 && (
            <p className="at-empty">No signals yet. Start a strategy to see live signals.</p>
          )}
          <AnimatePresence>
            {signals.slice(-20).reverse().map((s) => (
              <motion.div
                className={`at-signal ${s.action}`}
                key={s.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <div className="at-signal-top">
                  <span className="at-signal-sym">{s.symbol}</span>
                  <span className={`at-signal-action ${s.action}`}>
                    {s.action.toUpperCase()}
                  </span>
                  <span>{s.quantity}</span>
                  <span className="at-signal-time">{fmtTime(s.timestamp)}</span>
                </div>
                {s.reason && <p className="at-signal-reason">{s.reason}</p>}
                <div className="at-signal-levels">
                  {s.stopLoss != null && (
                    <span>
                      <small>Stop</small>
                      <b className="neg">{s.stopLoss.toLocaleString()}</b>
                    </span>
                  )}
                  {s.takeProfit != null && (
                    <span>
                      <small>Target</small>
                      <b className="pos">{s.takeProfit.toLocaleString()}</b>
                    </span>
                  )}
                  <span>
                    <small>Strategy</small>
                    <b>{s.strategyId}</b>
                  </span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </section>
    </div>
  );
}
