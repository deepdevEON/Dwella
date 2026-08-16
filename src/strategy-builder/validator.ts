/**
 * StrategyValidator — static analysis of a visual strategy before it runs.
 *
 * Detects structural problems (untriggered actions, cycles, bad logic arity),
 * common runtime hazards (indicator params out of range, division by zero,
 * missing warmup data) and estimates computational cost per bar so the user can
 * keep strategies fast enough for live trading.
 */

import { IndicatorLibrary } from "./indicators";
import { isAction, isCondition, createBlock } from "./editor";
import type { StrategyGraph, StrategyBlock, IndicatorId } from "./types";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  message: string;
  blockId?: string;
}

export interface CostEstimate {
  perBarOps: number;
  rating: "low" | "moderate" | "high";
  note: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  cost: CostEstimate;
  warmupBars: number;
  conditionCount: number;
  actionCount: number;
  reachableActions: number;
}

const NODE_COST: Record<string, number> = {
  MACD: 3,
  BOLL: 2,
  custom: 4,
};

function nodeCost(b: StrategyBlock): number {
  if (b.type === "indicator" && b.indicator) return NODE_COST[b.indicator] ?? 1;
  if (isCondition(b.type)) return NODE_COST[b.type] ?? 1;
  if (isAction(b.type)) return 0;
  return 1;
}

/** Lightweight syntax probe for a custom expression. */
function tryCompileCustom(expr: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function("bars", "index", "cache", "ind", `return !!(${expr});`);
    return true;
  } catch {
    return false;
  }
}

/** Detect obvious division-by-zero risk in a custom expression. */
function customDivByZero(expr: string): { hard: boolean; soft: boolean } {
  const hard = /\/\s*0(\D|$)/.test(expr);
  const soft = /\/\s*(volume|vol\(|vwap)/i.test(expr);
  return { hard, soft };
}

function hasCycle(graph: StrategyGraph): boolean {
  const adj = new Map<string, string[]>();
  for (const b of graph.blocks) adj.set(b.id, []);
  for (const c of graph.connections) adj.get(c.from)?.push(c.to);

  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen,1=in-stack,2=done
  const dfs = (id: string): boolean => {
    state.set(id, 1);
    for (const nxt of adj.get(id) ?? []) {
      const s = state.get(nxt) ?? 0;
      if (s === 1) return true;
      if (s === 0 && dfs(nxt)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const b of graph.blocks) {
    if ((state.get(b.id) ?? 0) === 0 && dfs(b.id)) return true;
  }
  return false;
}

export function validateStrategy(graph: StrategyGraph): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const incoming = (id: string) => graph.connections.filter((c) => c.to === id);

  let warmup = 2;
  let costSum = 0;
  let conditionCount = 0;
  let actionCount = 0;
  let reachableActions = 0;

  for (const b of graph.blocks) {
    costSum += nodeCost(b);

    if (isCondition(b.type)) conditionCount++;
    if (isAction(b.type)) actionCount++;

    if (b.type === "indicator" && b.indicator) {
      const def = IndicatorLibrary.get(b.indicator as IndicatorId);
      warmup = Math.max(warmup, def.minWarmup(b.indicatorParams || {}));
      for (const spec of def.params) {
        const v = Number((b.indicatorParams || {})[spec.key]);
        if (!isFinite(v) || v < spec.min || v > spec.max) {
          errors.push({
            severity: "error",
            message: `${def.id} ${spec.label} must be between ${spec.min} and ${spec.max}.`,
            blockId: b.id,
          });
        }
      }
    }

    if (b.type === "custom") {
      if (!tryCompileCustom(b.customExpr || "")) {
        errors.push({ severity: "error", message: "Custom expression has a syntax error.", blockId: b.id });
      } else {
        const { hard, soft } = customDivByZero(b.customExpr || "");
        if (hard) {
          errors.push({
            severity: "error",
            message: "Custom expression divides by zero — this will break evaluation.",
            blockId: b.id,
          });
        } else if (soft) {
          warnings.push({
            severity: "warning",
            message: "Custom expression may divide by zero (volume/VWAP can be 0). Guard with a check.",
            blockId: b.id,
          });
        }
      }
    }

    if (b.type === "and" || b.type === "or" || b.type === "not") {
      const ins = incoming(b.id).length;
      if (b.type === "not" && ins !== 1) {
        warnings.push({ severity: "warning", message: "NOT expects exactly one input.", blockId: b.id });
      } else if ((b.type === "and" || b.type === "or") && ins === 0) {
        warnings.push({ severity: "warning", message: `${b.type.toUpperCase()} has no inputs.`, blockId: b.id });
      }
    }

    if (isAction(b.type)) {
      const ins = incoming(b.id);
      if (ins.length === 0) {
        warnings.push({
          severity: "warning",
          message: `"${b.type}" action is not connected to any condition — it will never fire.`,
          blockId: b.id,
        });
      } else {
        reachableActions++;
      }
    }
  }

  if (actionCount === 0) {
    errors.push({ severity: "error", message: "Strategy needs at least one action block." });
  }

  if (hasCycle(graph)) {
    errors.push({ severity: "error", message: "Strategy contains a cycle (a block feeds back into itself)." });
  }

  if (warmup > 250) {
    warnings.push({
      severity: "warning",
      message: `This strategy needs ~${warmup} bars of history before it can trade. Ensure your data window is large enough.`,
    });
  }

  const perBarOps = costSum * Math.max(1, reachableActions || actionCount);
  const rating: CostEstimate["rating"] =
    perBarOps <= 12 ? "low" : perBarOps <= 40 ? "moderate" : "high";

  warmup += 3;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    cost: {
      perBarOps,
      rating,
      note:
        rating === "low"
          ? "Lightweight — safe for live ticks."
          : rating === "moderate"
            ? "Reasonable — fine for most instruments."
            : "Heavy — consider fewer indicators or longer timeframes for live use.",
    },
    warmupBars: warmup,
    conditionCount,
    actionCount,
    reachableActions,
  };
}

/** Build a minimal valid starter graph (used by "New" when nothing exists). */
export function starterGraph(): StrategyGraph {
  const buy = createBlock("buy", 420, 120);
  const rsi = createBlock("indicator", 60, 80);
  rsi.indicator = "RSI";
  rsi.indicatorParams = { period: 14 };
  rsi.comparison = "<";
  rsi.operand = { kind: "const", value: 30 };
  return {
    version: 1,
    name: "Untitled Strategy",
    description: "",
    symbol: "NQ",
    timeframe: "M5",
    blocks: [rsi, buy],
    connections: [{ id: "c1", from: rsi.id, to: buy.id }],
  };
}
