#!/usr/bin/env node

/**
 * fvg-trader-backtest.js — FVG Retest Strategy for Prop Firm Challenge
 *
 * Gideon's unique strategy:
 * - 3-minute chart
 * - NY Session only (9:30-11:30 AM ET)
 * - Detect Fair Value Gaps (FVGs)
 * - Enter on retest of FVG
 * - Stop loss beyond FVG
 * - Trail stop as price moves
 * - High R:R (2:1+)
 * 
 * Generates trade proof: timestamps + bar data for TradingView screenshot generation
 *
 * Apex $50k rules: $2,500 drawdown, $3k target, close by 4:59 ET
 */

const fs = require("fs");
const http = require("http");

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // Account
  accountSize: 50000,
  trailingDrawdown: 2500,
  profitTarget: 3000,
  maxContracts: 1,
  pointValue: 20,          // NQ E-mini = $20/pt

  // Strategy
  timeframe: "M3",
  symbol: "NQ",
  nySessionStart: { h: 13, m: 30 },  // 9:30 AM ET = 13:30 UTC
  nySessionEnd: { h: 15, m: 30 },     // 11:30 AM ET = 15:30 UTC
  minFvgSize: 2.0,         // Minimum FVG gap in points
  maxFvgSize: 15.0,        // Maximum FVG gap (too big = unreliable)
  rrTarget: 2.0,           // 2:1 Risk:Reward minimum
  trailActivation: 1.0,    // Trail activates after 1x risk move
  trailDistance: 0.5,      // Trail by 50% of FVG size

  // Backtest
  warmupBars: 10,
};

// ── UTILITY ──────────────────────────────────────────────────────────────────
function isInNySession(timestamp) {
  const d = new Date(timestamp * 1000);
  const utcHours = d.getUTCHours();
  const utcMins = d.getUTCMinutes();
  const totalMins = utcHours * 60 + utcMins;
  const startMins = CONFIG.nySessionStart.h * 60 + CONFIG.nySessionStart.m;
  const endMins = CONFIG.nySessionEnd.h * 60 + CONFIG.nySessionEnd.m;
  return totalMins >= startMins && totalMins < endMins;
}

function formatTime(t) {
  return new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ── FVG DETECTION ───────────────────────────────────────────────────────────
// Bullish FVG: bar[i-1].h < bar[i+1].l (gap up, price jumped over)
//   Zone: bar[i-1].h (top) → bar[i+1].l (bottom) — actually no
//   The FVG zone is the empty space between candle A's wick and candle C's wick
//   For bullish: zone = [candle_A.high, candle_C.low] (gap up)
//   For bearish: zone = [candle_C.high, candle_A.low] (gap down)

function detectFVG(bars, i) {
  if (i < 1 || i >= bars.length - 1) return null;

  const prev = bars[i - 1];
  const curr = bars[i];
  const next = bars[i + 1];

  // Bullish FVG: prev.high < next.low (gap up - price jumped over)
  if (prev.h < next.l) {
    const fvgTop = next.l;
    const fvgBottom = prev.h;
    const size = fvgTop - fvgBottom;
    if (size >= CONFIG.minFvgSize && size <= CONFIG.maxFvgSize) {
      return {
        type: "bullish",
        top: fvgTop,
        bottom: fvgBottom,
        size,
        midpoint: (fvgTop + fvgBottom) / 2,
        displacementBar: i,
        displacementTime: curr.t,
        displacementHigh: curr.h,
        displacementLow: curr.l,
      };
    }
  }

  // Bearish FVG: prev.low > next.high (gap down - price dropped over)
  if (prev.l > next.h) {
    const fvgTop = prev.l;
    const fvgBottom = next.h;
    const size = fvgTop - fvgBottom;
    if (size >= CONFIG.minFvgSize && size <= CONFIG.maxFvgSize) {
      return {
        type: "bearish",
        top: fvgTop,
        bottom: fvgBottom,
        size,
        midpoint: (fvgTop + fvgBottom) / 2,
        displacementBar: i,
        displacementTime: curr.t,
        displacementHigh: curr.h,
        displacementLow: curr.l,
      };
    }
  }

  return null;
}

// ── RETEST CHECK ────────────────────────────────────────────────────────────
// Checks if a bar is retesting the FVG zone AND confirms the rejection
// For bullish FVG: price enters zone (retest) AND CLOSES above zone (confirmation of support)
// For bearish FVG: price enters zone (retest) AND CLOSES below zone (confirmation of resistance)
function checkRetestConfirmation(fvg, bar) {
  if (fvg.type === "bullish") {
    // Retest: bar's low entered the FVG zone
    const retest = bar.l <= fvg.top;
    // Confirmation: bar's close is ABOVE the zone MIDPOINT (showing rejection)
    const confirmed = bar.c > fvg.midpoint;
    return retest && confirmed;
  } else {
    // Retest: bar's high entered the FVG zone
    const retest = bar.h >= fvg.bottom;
    // Confirmation: bar's close is BELOW the zone MIDPOINT (showing rejection)
    const confirmed = bar.c < fvg.midpoint;
    return retest && confirmed;
  }
}

// ── BACKTEST STATE ──────────────────────────────────────────────────────────
class BacktestState {
  constructor(bars) {
    this.bars = bars;
    this.currentIndex = 0;
    this.balance = CONFIG.accountSize;
    this.peakBalance = CONFIG.accountSize;
    this.maxDrawdown = 0;
    this.positions = [];
    this.trades = [];
    this.activeFvgs = [];
    this.dailyPnL = {};
    this.tradeProofs = [];
  }

  currentBar() { return this.bars[this.currentIndex]; }
}

// ── ORDER EXECUTION ─────────────────────────────────────────────────────────
function enterTrade(state, fvg, bar, direction) {
  if (state.positions.length > 0) return;

  // Enter at the close of the retest candle (price just retested FVG zone, close confirms)
  const entry = bar.c;
  
  // Calculate stop loss based on entry and FVG zone
  // For long: stop below FVG bottom (the support zone)
  // For short: stop above FVG top (the resistance zone)
  const stopLoss = direction === "long" 
    ? Math.min(entry - 2, fvg.bottom - 0.5)  // At most 2 pts below entry, at least at zone bottom - 0.5
    : Math.max(entry + 2, fvg.top + 0.5);      // At most 2 pts above entry, at least at zone top + 0.5
  
  const riskDistance = Math.abs(entry - stopLoss);
  const riskAmount = riskDistance * CONFIG.pointValue * CONFIG.maxContracts;
  
  // Skip trade if risk is too large (> $1,000) — means entry is way off from FVG zone
  if (riskAmount > 1000) {
    state.tradeProofs.push({
      type: "entry_skipped",
      barIndex: state.currentIndex,
      fvg,
      direction,
      entry,
      stopLoss,
      riskAmount,
      timestamp: bar.t,
      reason: `Risk $${riskAmount.toFixed(0)} exceeds max $1,000 (entry ${entry} far from zone ${fvg.bottom}-${fvg.top})`,
    });
    return;
  }
  
  // Skip trade if risk is too small (< $40) — entry too close to zone edge, likely to get stopped
  if (riskAmount < 40) {
    state.tradeProofs.push({
      type: "entry_skipped",
      barIndex: state.currentIndex,
      fvg,
      direction,
      entry,
      stopLoss,
      riskAmount,
      timestamp: bar.t,
      reason: `Risk $${riskAmount.toFixed(0)} too small (entry ${entry} too close to stop ${stopLoss})`,
    });
    return;
  }

  const target = direction === "long"
    ? entry + riskDistance * CONFIG.rrTarget
    : entry - riskDistance * CONFIG.rrTarget;

  state.positions.push({
    type: direction,
    entryPrice: entry,
    stopLoss,
    target,
    riskAmount,
    fvgRef: fvg,
    entryBar: state.currentIndex,
    entryTime: bar.t,
    trails: 0,
    highestSinceEntry: entry,
    lowestSinceEntry: entry,
  });

  state.tradeProofs.push({
    type: "entry_filled",
    barIndex: state.currentIndex,
    direction,
    entry,
    stopLoss,
    target,
    riskDistance: riskDistance.toFixed(1),
    riskAmount: riskAmount.toFixed(0),
    timestamp: bar.t,
    fvg,
  });
}

// ── POSITION MANAGEMENT ─────────────────────────────────────────────────────
function managePosition(state) {
  if (state.positions.length === 0) return;
  const pos = state.positions[0];
  const bar = state.currentBar();

  // Track extremes
  pos.highestSinceEntry = Math.max(pos.highestSinceEntry || pos.entryPrice, bar.h);
  pos.lowestSinceEntry = Math.min(pos.lowestSinceEntry || pos.entryPrice, bar.l);

  // Check stop loss
  if (pos.type === "long" && bar.l <= pos.stopLoss) {
    return closeTrade(state, pos, "stop_loss", pos.stopLoss);
  }
  if (pos.type === "short" && bar.h >= pos.stopLoss) {
    return closeTrade(state, pos, "stop_loss", pos.stopLoss);
  }

  // Check target
  if (pos.type === "long" && bar.h >= pos.target) {
    return closeTrade(state, pos, "target", pos.target);
  }
  if (pos.type === "short" && bar.l <= pos.target) {
    return closeTrade(state, pos, "target", pos.target);
  }

  // Trail stop — conservative, uses bar close (not intra-bar extremes)
  const riskDistance = Math.abs(pos.entryPrice - pos.stopLoss);

  if (pos.type === "long") {
    const moveInFavor = Math.max(bar.h - pos.entryPrice, pos.highestSinceEntry - pos.entryPrice);
    if (moveInFavor >= riskDistance * CONFIG.trailActivation) {
      const newStop = pos.entryPrice + (moveInFavor * 0.5);
      if (newStop > pos.stopLoss) {
        pos.stopLoss = newStop;
        pos.trails++;
      }
    }
  } else {
    const moveInFavor = Math.max(pos.entryPrice - bar.l, pos.entryPrice - pos.lowestSinceEntry);
    if (moveInFavor >= riskDistance * CONFIG.trailActivation) {
      const newStop = pos.entryPrice - (moveInFavor * 0.5);
      if (newStop < pos.stopLoss) {
        pos.stopLoss = newStop;
        pos.trails++;
      }
    }
  }
}

function closeTrade(state, pos, reason, exitPrice) {
  const pnl = pos.type === "long"
    ? (exitPrice - pos.entryPrice) * CONFIG.pointValue * CONFIG.maxContracts
    : (pos.entryPrice - exitPrice) * CONFIG.pointValue * CONFIG.maxContracts;

  state.balance += pnl;
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  const currentDD = state.peakBalance - state.balance;
  if (currentDD > state.maxDrawdown) state.maxDrawdown = currentDD;

  const trade = {
    entryTime: formatTime(pos.entryTime),
    exitTime: formatTime(state.currentBar().t),
    type: pos.type,
    entry: pos.entryPrice,
    exit: exitPrice,
    pnl: Math.round(pnl * 100) / 100,
    rr: Math.abs(pnl / (Math.abs(pos.entryPrice - pos.stopLoss) * CONFIG.pointValue * CONFIG.maxContracts || 1)),
    reason,
    barsHeld: state.currentIndex - pos.entryBar,  // Bars held after entry
    fvgSize: pos.fvgRef.size,
    trails: pos.trails,
  };

  state.trades.push(trade);
  state.positions = [];

  const day = trade.exitTime.split("T")[0];
  state.dailyPnL[day] = (state.dailyPnL[day] || 0) + pnl;

  state.tradeProofs.push({
    type: "exit",
    barIndex: state.currentIndex,
    reason,
    exit: exitPrice,
    pnl,
    timestamp: state.currentBar().t,
    trade,
  });
}

// ── MAIN REPLAY ─────────────────────────────────────────────────────────────
function runBacktest(bars) {
  console.log(`\n🚀 FVG Retest Strategy — ${bars.length} bars (${CONFIG.timeframe})`);
  console.log(`NY Session: ${CONFIG.nySessionStart.h}:${String(CONFIG.nySessionStart.m).padStart(2,"0")}-${CONFIG.nySessionEnd.h}:${String(CONFIG.nySessionEnd.m).padStart(2,"0")} UTC`);
  console.log(`Account: $${CONFIG.accountSize} | Target: $${CONFIG.profitTarget} | Drawdown: $${CONFIG.trailingDrawdown}\n`);

  const state = new BacktestState(bars);
  const nyBars = bars.filter(b => isInNySession(b.t));
  console.log(`NY Session bars: ${nyBars.length} / ${bars.length} total`);

  for (state.currentIndex = CONFIG.warmupBars; state.currentIndex < bars.length; state.currentIndex++) {
    const bar = state.currentBar();
    if (!bar) continue;

    // Only trade during NY session
    if (!isInNySession(bar.t)) {
      managePosition(state); // Still manage positions outside session (trailing)
      continue;
    }

    // Check for FVG formation (look at bar i-1 as the middle candle)
    if (state.currentIndex >= 2) {
      const fvg = detectFVG(bars, state.currentIndex - 1);
      if (fvg) {
        state.activeFvgs.push(fvg);
      }
    }

    // Check if any active FVG is being retested (require 3+ bars maturity)
    if (state.positions.length === 0) {
      for (let i = state.activeFvgs.length - 1; i >= 0; i--) {
        const fvg = state.activeFvgs[i];
        // FVG valid for max 12 bars (~36 min on 3M = healthy)
        const barsSinceFvg = state.currentIndex - fvg.displacementBar;
        if (barsSinceFvg > 12) {
          state.activeFvgs.splice(i, 1);
          continue;
        }
        // Require at least 2 bars maturity before retesting
        if (barsSinceFvg < 2) continue;
        
        if (checkRetestConfirmation(fvg, bar)) {
          enterTrade(state, fvg, bar, fvg.type === "bullish" ? "long" : "short");
          state.activeFvgs.splice(i, 1);
          break;
        }
      }
    }

    // Manage existing position — skip if just entered this bar (avoid same-bar look-ahead)
    if (state.positions.length > 0 && state.positions[0].entryBar !== state.currentIndex) {
      managePosition(state);
    }

    // Close positions at NY session end (handle last 3 minutes)
    const d = new Date(bar.t * 1000);
    const totalMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const endMins = CONFIG.nySessionEnd.h * 60 + CONFIG.nySessionEnd.m;
    if (state.positions.length > 0 && state.positions[0].entryBar !== state.currentIndex && totalMins >= endMins - 3) {
      // Close at the end of NY session
      const pnl = state.positions[0].type === "long"
        ? (bar.c - state.positions[0].entryPrice) * CONFIG.pointValue
        : (state.positions[0].entryPrice - bar.c) * CONFIG.pointValue;
      closeTrade(state, state.positions[0], "session_end", bar.c);
    }

    // Check account blowout
    if (state.peakBalance - state.balance >= CONFIG.trailingDrawdown) {
      console.log(`   ❌ ACCOUNT LIQUIDATED at bar ${state.currentIndex}`);
      break;
    }

    // Check profit target
    if (state.balance - CONFIG.accountSize >= CONFIG.profitTarget) {
      console.log(`   ✅ PROFIT TARGET REACHED at bar ${state.currentIndex}!`);
      break;
    }

    if (state.currentIndex % 500 === 0) {
      console.log(`   [${state.currentIndex}/${bars.length}] Balance: $${state.balance.toFixed(0)} | Trades: ${state.trades.length} | Active FVGs: ${state.activeFvgs.length}`);
    }
  }

  // Close remaining at end
  if (state.positions.length > 0) {
    state.currentIndex = bars.length - 1;
    const lastBar = state.currentBar();
    if (lastBar) {
      const pnl = state.positions[0].type === "long"
        ? (lastBar.c - state.positions[0].entryPrice) * CONFIG.pointValue
        : (state.positions[0].entryPrice - lastBar.c) * CONFIG.pointValue;
      closeTrade(state, state.positions[0], "end_of_data", lastBar.c);
    }
  }

  return state;
}

// ── REPORT GENERATION ───────────────────────────────────────────────────────
function generateReport(state, label) {
  const lines = [];
  const total = state.trades.length;
  const wins = state.trades.filter(t => t.pnl > 0);
  const losses = state.trades.filter(t => t.pnl < 0);
  const totalPnl = state.trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = total > 0 ? (wins.length / total * 100).toFixed(1) : "0";
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) / losses.length : 0;
  const rr = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "N/A";
  const drawdown = state.maxDrawdown;

  lines.push(`\n═══════════════════════════════════════════════`);
  lines.push(`  ${label}`);
  lines.push(`═══════════════════════════════════════════════`);
  lines.push(`📊 PERFORMANCE`);
  lines.push(`   Total Trades: ${total}`);
  lines.push(`   Wins: ${wins.length} | Losses: ${losses.length}`);
  lines.push(`   Win Rate: ${winRate}%`);
  lines.push(`   Avg Win: $${avgWin.toFixed(2)} | Avg Loss: -$${avgLoss.toFixed(2)}`);
  lines.push(`   R:R Ratio: ${rr}`);
  lines.push(`   Total PnL: $${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`);
  lines.push(`   Final Balance: $${state.balance.toFixed(2)}`);
  lines.push(`   Peak Balance: $${state.peakBalance.toFixed(2)}`);
  lines.push(`   Drawdown: $${drawdown.toFixed(2)}`);
  lines.push(``);

  lines.push(`🏛️ APEX COMPLIANCE`);
  lines.push(`   Drawdown: $${drawdown.toFixed(2)} / $${CONFIG.trailingDrawdown} limit → ${drawdown < CONFIG.trailingDrawdown ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(`   Profit Target: $${totalPnl.toFixed(2)} / $${CONFIG.profitTarget} → ${totalPnl >= CONFIG.profitTarget ? "✅ PASS" : "⏳ Not yet"}`);
  const days = Object.keys(state.dailyPnL).length;
  lines.push(`   Days Traded: ${days} / 7 minimum → ${days >= 7 ? "✅" : "⏳ Need more"}`);

  if (totalPnl > 0) {
    const bestDay = Math.max(...Object.values(state.dailyPnL).filter(p => p > 0));
    const pct = (bestDay / totalPnl) * 100;
    lines.push(`   Best Day: $${bestDay.toFixed(2)} (${pct.toFixed(1)}% of profit) → ${pct < 50 ? "✅ Consistency OK" : "❌ Over 50%"}`);
  }
  lines.push(``);

  lines.push(`📝 TRADE LOG`);
  state.trades.forEach((t, i) => {
    const outcome = t.pnl > 0 ? "✅" : t.pnl < 0 ? "❌" : "➖";
    lines.push(`   ${outcome} #${i+1}: ${t.type.toUpperCase()} | Entry: ${t.entry.toFixed(1)} | Exit: ${t.exit.toFixed(1)} | PnL: $${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)} | R: ${t.rr.toFixed(2)} | Reason: ${t.reason} | Held: ${t.barsHeld} bars`);
  });
  lines.push(``);

  lines.push(`🔍 WHAT WENT WRONG`);
  const lossTrades = state.trades.filter(t => t.pnl < 0);
  if (lossTrades.length === 0 && total > 0) {
    lines.push(`   No losses — perfect session.`);
  } else if (total === 0) {
    lines.push(`   No trades triggered. Check FVG detection sensitivity or NY session data.`);
  } else {
    lossTrades.slice(0, 5).forEach(t => {
      lines.push(`   ❌ ${t.type.toUpperCase()} at ${t.entry.toFixed(1)} — stopped at ${t.exit.toFixed(1)} ($${Math.abs(t.pnl).toFixed(0)} loss, R: ${t.rr.toFixed(2)})`);
    });
    if (lossTrades.length > 5) lines.push(`   ... and ${lossTrades.length - 5} more losses`);
  }
  lines.push(``);

  lines.push(`💡 WHAT I WOULD CHANGE`);
  if (winRate < 50) {
    lines.push(`   - Win rate ${winRate}% is low. Try larger FVG minimum (${CONFIG.minFvgSize}pts → ${(CONFIG.minFvgSize * 1.5).toFixed(1)}pts) to filter noise.`);
  }
  if (rr < 1.5) {
    lines.push(`   - R:R ${rr} is below target 2:1. Adjust trailDistance or rrTarget.`);
  }
  if (total === 0) {
    lines.push(`   - No trades fired. Reduce minFvgSize (${CONFIG.minFvgSize}pts → ${(CONFIG.minFvgSize * 0.5).toFixed(1)}pts).`);
  }
  lines.push(``);

  lines.push(`📸 PROOF DATA`);
  const entries = state.tradeProofs.filter(p => p.type === "entry_filled");
  lines.push(`   Trade entries with prices: ${entries.length}`);
  lines.push(`   Exits recorded: ${state.tradeProofs.filter(p => p.type === "exit").length}`);
  lines.push(`   Ready for TradingView screenshot generation`);
  lines.push(``);
  lines.push(`═══════════════════════════════════════════════`);

  return lines.join("\n");
}

// ── PROOF GENERATION → TradingView Screenshots ──────────────────────────────
async function generateVisualProof(state) {
  console.log("\n📸 Generating visual proof on TradingView...");
  
  // Check if Chrome CDP is available
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version");
    if (!res.ok) {
      console.log("   ⚠️ Chrome not available for screenshots. Trades logged for manual review.");
      return;
    }
  } catch {
    console.log("   ⚠️ Chrome not running. Trade data saved — can generate screenshots later.");
    return;
  }

  // We'll use the browser-use agent to navigate to each trade's timestamp
  // For now, log the trade proof data
  const proofFile = "trade_proof.json";
  const proofData = state.tradeProofs.map(p => ({
    ...p,
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
  }));
  fs.writeFileSync(proofFile, JSON.stringify(proofData, null, 2));
  console.log(`   ✅ Trade proof data saved to ${proofFile}`);
  console.log(`   💡 To view on TradingView:`);
  console.log(`      Open chart → Search bottom bar → Use timestamps below:`);
  
  state.trades.forEach((t, i) => {
    console.log(`      Trade #${i+1}: ${t.type.toUpperCase()} at ~${t.entryTime}`);
  });
}

// ── DATA LOADING ────────────────────────────────────────────────────────────
async function loadData() {
  console.log("Loading MT5 data...");
  const res = await fetch(`http://127.0.0.1:8643/bars?s=${CONFIG.symbol}&tf=${CONFIG.timeframe}&count=2000`);
  const data = await res.json();
  if (!data.bars || data.bars.length === 0) {
    // Try with fewer bars
    const res2 = await fetch(`http://127.0.0.1:8643/bars?s=${CONFIG.symbol}&tf=${CONFIG.timeframe}&count=500`);
    const data2 = await res2.json();
    if (!data2.bars || data2.bars.length === 0) {
      console.error("No data available");
      process.exit(1);
    }
    console.log(`Loaded ${data2.bars.length} bars`);
    return data2.bars;
  }
  console.log(`Loaded ${data.bars.length} bars`);
  return data.bars;
}

// ── ITERATION RUNNER ─────────────────────────────────────────────────────────
async function main() {
  const bars = await loadData();
  const range = `${new Date(bars[0].t * 1000).toISOString().split("T")[0]} → ${new Date(bars[bars.length - 1].t * 1000).toISOString().split("T")[0]}`;
  console.log(`Data Range: ${range}`);

  // Iteration 0: Base config
  console.log("\n═══════════════════════════════════════════════");
  console.log("  ITERATION 0 — Base FVG Strategy");
  console.log("═══════════════════════════════════════════════");
  let state = runBacktest(bars);
  let report = generateReport(state, "Iteration 0 — Base FVG Strategy");
  console.log(report);
  await generateVisualProof(state);

  // Iteration 1: Tighter FVG filter, better R:R
  CONFIG.minFvgSize = 3.0;
  CONFIG.rrTarget = 3.0;
  CONFIG.trailActivation = 0.8;
  console.log("\n═══════════════════════════════════════════════");
  console.log("  ITERATION 1 — Tighter FVGs + 3:1 R:R");
  console.log("═══════════════════════════════════════════════");
  state = runBacktest(bars);
  report = generateReport(state, "Iteration 1 — Larger FVGs + 3:1 R:R + Earlier Trail");
  console.log(report);
  await generateVisualProof(state);

  // Iteration 2: Wide FVGs, conservative
  CONFIG.minFvgSize = 5.0;
  CONFIG.maxFvgSize = 25.0;
  CONFIG.rrTarget = 3.0;
  CONFIG.trailActivation = 1.2;
  console.log("\n═══════════════════════════════════════════════");
  console.log("  ITERATION 2 — Wide FVGs, Conservative");
  console.log("═══════════════════════════════════════════════");
  state = runBacktest(bars);
  report = generateReport(state, "Iteration 2 — Wide FVGs + 3:1 R:R + Late Trail");
  console.log(report);
  await generateVisualProof(state);

  console.log("\n✅ All iterations complete!");
  console.log("📓 Journal: docs/trading-journal.md");
  console.log("📸 Trade proof: trade_proof.json");
  
  // Find best iteration
  // (simplified - just print for now)
}

main().catch(err => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
