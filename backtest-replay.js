#!/usr/bin/env node

/**
 * backtest-replay.js — Bar-by-bar replay backtester for Liquidity Harvesting strategy
 *
 * Usage: node backtest-replay.js [data-file] [--visualize]
 *
 * Walks through MT5 bar data one bar at a time (replay mode), applying
 * liquidity harvesting rules, logging every decision, and generating
 * a full trade journal with reflections.
 */

const fs = require("fs");

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // Strategy parameters (Iteration 0)
  minSwingDistance: 10,       // Minimum points between swings for valid liquidity pool
  confirmationBodyRatio: 0.5, // Confirmation candle body must be >= 50% of prev range
  maxRiskPerTrade: 500,       // $500 max risk on $50k account = 1%
  accountSize: 50000,         // Apex $50k account
  trailingDrawdown: 2500,     // Apex $2500 trailing drawdown
  contracts: 1,               // 1 MNQ contract
  pointValue: 20,            // NQ E-mini = $20 per point (the MT5 bridge returns @ENQ = full NQ)
};

// ── State ────────────────────────────────────────────────────────────────────
class ReplayState {
  constructor(bars) {
    this.bars = bars;           // All bars in chronological order
    this.currentIndex = 0;      // Current bar position in replay
    this.balance = CONFIG.accountSize;
    this.peakBalance = CONFIG.accountSize;
    this.positions = [];        // Open positions
    this.trades = [];           // Completed trades
    this.swingHighs = [];       // { price, barIndex, time }
    this.swingLows = [];        // { price, barIndex, time }
    this.decisions = [];        // Every decision made during replay
    this.dailyPnL = {};        // Track PnL by day for consistency rule
  }

  currentBar() {
    return this.bars[this.currentIndex];
  }

  visibleBars() {
    return this.bars.slice(0, this.currentIndex + 1);
  }

  log(level, message, data = {}) {
    const bar = this.currentBar();
    this.decisions.push({
      barIndex: this.currentIndex,
      time: new Date(bar.t * 1000).toISOString(),
      price: bar.c,
      level,
      message,
      ...data,
    });
  }
}

// ── Swing Detection ──────────────────────────────────────────────────────────
function detectSwings(state) {
  const visible = state.visibleBars();
  const n = visible.length;
  if (n < 5) return;

  const i = n - 3; // Look at bar at index n-3 (needs 2 bars on each side)

  // Swing high: bar's high is higher than 2 bars before and after
  if (
    visible[i].h > visible[i - 1].h &&
    visible[i].h > visible[i - 2].h &&
    visible[i].h > visible[i + 1].h &&
    visible[i].h > visible[i + 2].h
  ) {
    // Check if we already recorded this swing
    const exists = state.swingHighs.some(s => Math.abs(s.price - visible[i].h) < 0.5);
    if (!exists) {
      state.swingHighs.push({
        price: visible[i].h,
        barIndex: i,
        time: new Date(visible[i].t * 1000).toISOString(),
      });
      state.log("SWING", `New swing HIGH at ${visible[i].h.toFixed(1)} (liquidity pool above)`);
    }
  }

  // Swing low: bar's low is lower than 2 bars before and after
  if (
    visible[i].l < visible[i - 1].l &&
    visible[i].l < visible[i - 2].l &&
    visible[i].l < visible[i + 1].l &&
    visible[i].l < visible[i + 2].l
  ) {
    const exists = state.swingLows.some(s => Math.abs(s.price - visible[i].l) < 0.5);
    if (!exists) {
      state.swingLows.push({
        price: visible[i].l,
        barIndex: i,
        time: new Date(visible[i].t * 1000).toISOString(),
      });
      state.log("SWING", `New swing LOW at ${visible[i].l.toFixed(1)} (liquidity pool below)`);
    }
  }
}

// ── Sweep Detection ──────────────────────────────────────────────────────────
function detectSweeps(state) {
  const bar = state.currentBar();
  const recentBars = state.visibleBars().slice(-5); // Last 5 bars

  // Check if any known swing highs were swept in the last 2 bars
  for (const swing of state.swingHighs) {
    // Skip if this swing was already swept
    if (swing._swept) continue;
    // Check if recent bars went above the swing
    const swept = recentBars.some(b => b.h > swing.price);
    if (swept) {
      swing._swept = true;
      swing._sweptAt = state.currentIndex;
      state.log("SWEEP", `⚠️ Liquidity ABOVE swept! Price exceeded swing HIGH at ${swing.price.toFixed(1)}`, {
        swingPrice: swing.price,
        sweptBy: bar.h.toFixed(1),
        direction: "short_setup",
      });
    }
  }

  for (const swing of state.swingLows) {
    if (swing._swept) continue;
    const swept = recentBars.some(b => b.l < swing.price);
    if (swept) {
      swing._swept = true;
      swing._sweptAt = state.currentIndex;
      state.log("SWEEP", `⚠️ Liquidity BELOW swept! Price exceeded swing LOW at ${swing.price.toFixed(1)}`, {
        swingPrice: swing.price,
        sweptBy: bar.l.toFixed(1),
        direction: "long_setup",
      });
    }
  }
}

// ── Entry Decision ───────────────────────────────────────────────────────────
function checkEntry(state) {
  const bar = state.currentBar();
  if (state.positions.length > 0) return; // Already in a trade

  // Look for recent sweeps (within last 10 bars)
  const recentSwingHighs = state.swingHighs.filter(s => s._swept && state.currentIndex - s._sweptAt <= 10);
  const recentSwingLows = state.swingLows.filter(s => s._swept && state.currentIndex - s._sweptAt <= 10);

  // Check if a swept high setup is forming (short opportunity)
  for (const swing of recentSwingHighs) {
    // Requirements for short entry:
    // 1. Price came back below the swept high ✓ (already swept)
    // 2. Current candle shows bearish confirmation
    // 3. Body of confirmation candle > 50% of sweep candle range
    const barOpen = bar.o;
    const barClose = bar.c;
    const barRange = bar.h - bar.l;
    const bodySize = Math.abs(barClose - barOpen);
    const isBearish = barClose < barOpen;

    if (isBearish && bodySize > barRange * CONFIG.confirmationBodyRatio) {
      // Check minimum distance
      const distance = swing.price - barClose;
      if (distance > CONFIG.minSwingDistance) {
        const risk = distance * CONFIG.pointValue * CONFIG.contracts;
        if (risk <= CONFIG.maxRiskPerTrade) {
          state.log("ENTRY", `📉 SHORT signal! Swept high at ${swing.price.toFixed(1)}, bearish confirmation. Entry: ${barClose.toFixed(1)}`);
          state.positions.push({
            type: "short",
            entryPrice: barClose,
            entryBar: state.currentIndex,
            entryTime: new Date(bar.t * 1000).toISOString(),
            stopLoss: swing.price + 5,
            target: barClose - (swing.price - barClose), // 1:1 reward
            swingReference: swing.price,
          });
        } else {
          state.log("SKIP", `⏭️ Short setup at ${swing.price.toFixed(1)} but risk $${risk} exceeds max $${CONFIG.maxRiskPerTrade}`);
        }
      }
    }
  }

  // Check if a swept low setup is forming (long opportunity)
  for (const swing of recentSwingLows) {
    const barOpen = bar.o;
    const barClose = bar.c;
    const barRange = bar.h - bar.l;
    const bodySize = Math.abs(barClose - barOpen);
    const isBullish = barClose > barOpen;

    if (isBullish && bodySize > barRange * CONFIG.confirmationBodyRatio) {
      const distance = barClose - swing.price;
      if (distance > CONFIG.minSwingDistance) {
        const risk = distance * CONFIG.pointValue * CONFIG.contracts;
        if (risk <= CONFIG.maxRiskPerTrade) {
          state.log("ENTRY", `📈 LONG signal! Swept low at ${swing.price.toFixed(1)}, bullish confirmation. Entry: ${barClose.toFixed(1)}`);
          state.positions.push({
            type: "long",
            entryPrice: barClose,
            entryBar: state.currentIndex,
            entryTime: new Date(bar.t * 1000).toISOString(),
            stopLoss: swing.price - 5,
            target: barClose + (barClose - swing.price), // 1:1 R:R
            swingReference: swing.price,
          });
        } else {
          state.log("SKIP", `⏭️ Long setup at ${swing.price.toFixed(1)} but risk $${risk} exceeds max $${CONFIG.maxRiskPerTrade}`);
        }
      }
    }
  }
}

// ── Exit / Management ────────────────────────────────────────────────────────
function managePositions(state) {
  if (state.positions.length === 0) return;

  const bar = state.currentBar();
  const pos = state.positions[0]; // Only 1 position at a time

  // Check stop loss
  if (pos.type === "long" && bar.l <= pos.stopLoss) {
    const pnl = (pos.stopLoss - pos.entryPrice) * CONFIG.pointValue * CONFIG.contracts;
    closeTrade(state, pos, "stop_loss", pos.stopLoss, pnl);
    return;
  }
  if (pos.type === "short" && bar.h >= pos.stopLoss) {
    const pnl = (pos.entryPrice - pos.stopLoss) * CONFIG.pointValue * CONFIG.contracts;
    closeTrade(state, pos, "stop_loss", pos.stopLoss, pnl);
    return;
  }

  // Check target
  if (pos.type === "long" && bar.h >= pos.target) {
    const pnl = (pos.target - pos.entryPrice) * CONFIG.pointValue * CONFIG.contracts;
    closeTrade(state, pos, "target", pos.target, pnl);
    return;
  }
  if (pos.type === "short" && bar.l <= pos.target) {
    const pnl = (pos.entryPrice - pos.target) * CONFIG.pointValue * CONFIG.contracts;
    closeTrade(state, pos, "target", pos.target, pnl);
    return;
  }

  // Trail stop to break-even if price moves favorably
  if (pos.type === "long") {
    const move = bar.c - pos.entryPrice;
    if (move > CONFIG.minSwingDistance * 2 && pos.stopLoss < pos.entryPrice) {
      pos.stopLoss = pos.entryPrice;
      state.log("MANAGE", `🔒 Moving stop to break-even for long`);
    }
  }
  if (pos.type === "short") {
    const move = pos.entryPrice - bar.c;
    if (move > CONFIG.minSwingDistance * 2 && pos.stopLoss > pos.entryPrice) {
      pos.stopLoss = pos.entryPrice;
      state.log("MANAGE", `🔒 Moving stop to break-even for short`);
    }
  }
}

function closeTrade(state, pos, reason, exitPrice, pnl) {
  state.balance += pnl;
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;

  const trade = {
    entryTime: pos.entryTime,
    exitTime: new Date(state.currentBar().t * 1000).toISOString(),
    type: pos.type,
    entry: pos.entryPrice,
    exit: exitPrice,
    pnl,
    reason,
    barsHeld: state.currentIndex - pos.entryBar,
    swingRef: pos.swingReference,
  };

  state.trades.push(trade);
  state.positions = [];

  // Track daily PnL
  const day = trade.exitTime.split("T")[0];
  state.dailyPnL[day] = (state.dailyPnL[day] || 0) + pnl;

  state.log("EXIT", `🔚 ${reason.toUpperCase()}: ${pos.type.toUpperCase()} closed. PnL: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}. Balance: $${state.balance.toFixed(2)}`);
}

// ── Reflection Engine ────────────────────────────────────────────────────────
function generateReflection(state) {
  const lines = [];
  lines.push("");
  lines.push("═══════════════════════════════════════════════");
  lines.push("  REPLAY SESSION REFLECTION");
  lines.push("═══════════════════════════════════════════════");
  lines.push("");

  const totalTrades = state.trades.length;
  const wins = state.trades.filter(t => t.pnl > 0);
  const losses = state.trades.filter(t => t.pnl < 0);
  const winRate = totalTrades > 0 ? (wins.length / totalTrades * 100).toFixed(1) : "N/A";
  const totalPnl = state.trades.reduce((sum, t) => sum + t.pnl, 0);

  lines.push(`📊 Performance:`);
  lines.push(`   Total Trades: ${totalTrades}`);
  lines.push(`   Wins: ${wins.length} | Losses: ${losses.length}`);
  lines.push(`   Win Rate: ${winRate}%`);
  lines.push(`   Total PnL: $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`);
  lines.push(`   Final Balance: $${state.balance.toFixed(2)}`);
  lines.push(`   Peak Balance: $${state.peakBalance.toFixed(2)}`);
  lines.push(`   Drawdown: $${(state.peakBalance - state.balance).toFixed(2)}`);
  lines.push("");

  // Trade-by-trade reflection
  lines.push(`📝 Trade-by-Trade Reflection:`);
  state.trades.forEach((t, i) => {
    const outcome = t.pnl > 0 ? "✅ WIN" : t.pnl < 0 ? "❌ LOSS" : "➖ BE";
    lines.push(`   Trade ${i + 1}: ${outcome} | ${t.type.toUpperCase()} | Entry: ${t.entry.toFixed(1)} | Exit: ${t.exit.toFixed(1)} | PnL: $${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} | Reason: ${t.reason}`);
  });
  lines.push("");

  // What went wrong
  lines.push(`🔍 What Went Wrong:`);
  const lossTrades = state.trades.filter(t => t.pnl < 0);
  if (lossTrades.length === 0 && totalTrades > 0) {
    lines.push(`   No losing trades this session.`);
  } else if (totalTrades === 0) {
    lines.push(`   No trades taken — need to refine entry detection or wait for clearer setups.`);
  } else {
    lossTrades.forEach(t => {
      lines.push(`   - ${t.type.toUpperCase()} at ${t.entry.toFixed(1)} hit stop at ${t.exit.toFixed(1)} ($${Math.abs(t.pnl).toFixed(0)} loss)`);
    });
  }
  lines.push("");

  // What to change
  lines.push(`💡 What I Would Change:`);
  if (totalTrades > 0) {
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) / losses.length : 0;
    if (avgLoss > 0 && avgWin > 0) {
      const ratio = avgWin / avgLoss;
      if (ratio < 2) {
        lines.push(`   - R:R ratio is ${ratio.toFixed(2)}:1 — needs improvement. Consider wider targets or tighter stops.`);
      }
    }
    if (winRate < 40) {
      lines.push(`   - Win rate ${winRate}% is low — confirmation rule may be too loose.`);
    }
  } else {
    lines.push(`   - Entry detection didn't fire any trades — the confirmation body ratio (${CONFIG.confirmationBodyRatio}) or minimum swing distance (${CONFIG.minSwingDistance}pts) may be too strict.`);
    lines.push(`   - Or: the market was ranging with no clear liquidity sweep + follow-through.`);
  }
  lines.push("");

  // Apex compliance check
  lines.push(`🏛️ Apex Compliance Check:`);
  const drawdownFromPeak = state.peakBalance - state.balance;
  lines.push(`   Drawdown: $${drawdownFromPeak.toFixed(2)} / $${CONFIG.trailingDrawdown} limit`);
  if (drawdownFromPeak >= CONFIG.trailingDrawdown) {
    lines.push(`   ❌ VIOLATION: Account would be liquidated!`);
  } else {
    lines.push(`   ✅ Within drawdown limit`);
  }

  const daysTraded = Object.keys(state.dailyPnL).length;
  lines.push(`   Days Traded: ${daysTraded}`);
  if (daysTraded < 7) {
    lines.push(`   ⚠️ Need ${7 - daysTraded} more trading days for Apex eval minimum`);
  }

  // Consistency check
  const totalProfits = Object.values(state.dailyPnL).filter(p => p > 0);
  if (totalProfits.length > 0 && totalPnl > 0) {
    const bestDay = Math.max(...totalProfits);
    const pctOfTotal = (bestDay / totalPnl) * 100;
    lines.push(`   Best Day: $${bestDay.toFixed(2)} (${pctOfTotal.toFixed(1)}% of total profit)`);
    if (pctOfTotal >= 50) {
      lines.push(`   ❌ Consistency Rule VIOLATED: Best day >50% of total profit`);
    } else {
      lines.push(`   ✅ Consistency Rule: Under 50% threshold`);
    }
  }

  lines.push("");
  lines.push("═══════════════════════════════════════════════");

  return lines.join("\n");
}

// ── Main Replay Loop ────────────────────────────────────────────────────────
function runReplay(bars, label = "Replay") {
  console.log(`\n🚀 Starting ${label} — ${bars.length} bars`);

  const state = new ReplayState(bars);

  // Phase 1: Initial warm-up (need at least 5 bars for swing detection)
  for (state.currentIndex = 0; state.currentIndex < bars.length; state.currentIndex++) {
    const bar = bars[state.currentIndex];

    // Every bar: check swings, sweeps, entries, manage positions
    detectSwings(state);
    detectSweeps(state);
    checkEntry(state);
    managePositions(state);

    // Log progress every 100 bars
    if (state.currentIndex % 100 === 0) {
      console.log(`   [${state.currentIndex}/${bars.length}] Price: ${bar.c.toFixed(1)} | Trades: ${state.trades.length} | Balance: $${state.balance.toFixed(2)}`);
    }
  }

  // Close any remaining positions at last bar
  if (state.positions.length > 0) {
    state.currentIndex = bars.length - 1; // Fix: point to last bar before closing
    const lastBar = state.currentBar();
    const pos = state.positions[0];
    const pnl = pos.type === "long"
      ? (lastBar.c - pos.entryPrice) * CONFIG.pointValue * CONFIG.contracts
      : (pos.entryPrice - lastBar.c) * CONFIG.pointValue * CONFIG.contracts;
    closeTrade(state, pos, "end_of_data", lastBar.c, pnl);
  }

  // Generate reflection
  const reflection = generateReflection(state);

  return { state, reflection };
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────
const dataFile = process.argv[2] || "/tmp/nq_m5_full.json";

if (!fs.existsSync(dataFile)) {
  // Fall back to the first data file
  const fallback = "/tmp/nq_m5_data.json";
  if (fs.existsSync(fallback)) {
    console.log(`Using fallback data file: ${fallback}`);
    runFromFile(fallback);
  } else {
    console.error("❌ No data file found. Run the MT5 bridge data pull first.");
    console.error("Usage: node backtest-replay.js [data-file.json]");
    process.exit(1);
  }
} else {
  runFromFile(dataFile);
}

function runFromFile(path) {
  console.log(`Loading data from ${path}`);
  const raw = fs.readFileSync(path, "utf8");
  const bars = JSON.parse(raw);

  console.log(`Loaded ${bars.length} bars`);
  console.log(`Range: ${new Date(bars[0].t * 1000).toISOString()} → ${new Date(bars[bars.length - 1].t * 1000).toISOString()}`);

  // ── Run iterations ────────────────────────────────────────────────────
  runIteration(bars, "Iteration 0", {
    minSwingDistance: 10,
    confirmationBodyRatio: 0.5,
    maxRiskPerTrade: 500,
  });

  runIteration(bars, "Iteration 1 — Tighter confirmation, better R:R", {
    minSwingDistance: 15,
    confirmationBodyRatio: 0.65,
    maxRiskPerTrade: 400,
    targetMultiplier: 1.5, // 1.5:1 reward instead of 1:1
    breakEvenAfterPoints: 20,
  });

  runIteration(bars, "Iteration 2 — Tighter stops, wider targets", {
    minSwingDistance: 12,
    confirmationBodyRatio: 0.6,
    maxRiskPerTrade: 450,
    targetMultiplier: 2.0, // 2:1 reward
    breakEvenAfterPoints: 15,
  });

  console.log("\n✅ All iterations complete!");

function runIteration(bars, label, overrides) {
  // Merge overrides into a copy of CONFIG
  const iterConfig = { ...CONFIG, ...overrides };
  
  // Temporarily replace CONFIG for this iteration
  const oldConfig = { ...CONFIG };
  Object.assign(CONFIG, iterConfig);
  
  const result = runReplay(bars, label);
  const ref = result.reflection;
  console.log(ref);

  // Append to journal
  const journalEntry = `
---

## Replay Session — ${new Date().toISOString().split("T")[0]}

**Data Range:** ${new Date(bars[0].t * 1000).toISOString().split("T")[0]} → ${new Date(bars[bars.length - 1].t * 1000).toISOString().split("T")[0]}
**Bars:** ${bars.length} (M5)
**Label:** ${label}

### Config
- minSwingDistance: ${iterConfig.minSwingDistance}
- confirmationBodyRatio: ${iterConfig.confirmationBodyRatio}
- maxRiskPerTrade: $${iterConfig.maxRiskPerTrade}
- targetMultiplier: ${iterConfig.targetMultiplier || 1.0}

${ref}

**Decisions Log:** ${result.state.decisions.length} decisions recorded
`;

  const journalPath = "/Users/gid/Downloads/dwella-desktop 2/trading-journal.md";
  fs.appendFileSync(journalPath, journalEntry);
  
  // Restore old config
  Object.assign(CONFIG, oldConfig);
  
  return result;
}
}
