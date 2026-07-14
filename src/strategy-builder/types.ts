/**
 * Shared types for the visual strategy builder. A strategy is a directed graph of
 * blocks (conditions, logic gates, actions) connected by edges. The graph compiles
 * down to a runnable `Strategy` consumed by the existing BacktestEngine / runner.
 */

import type { Timeframe } from "../replay-engine";

export type IndicatorId =
  | "SMA"
  | "EMA"
  | "RSI"
  | "MACD"
  | "BOLL"
  | "ATR"
  | "VOL"
  | "VWAP";

export type ComparisonOp =
  | ">"
  | "<"
  | ">="
  | "<="
  | "=="
  | "crossAbove"
  | "crossBelow";

export type PriceField =
  | "open"
  | "high"
  | "low"
  | "close"
  | "volume"
  | "hl2"
  | "ohlc4";

export type Operand =
  | { kind: "const"; value: number }
  | { kind: "price"; field: PriceField }
  | { kind: "indicator"; indicator: IndicatorId; params: Record<string, number>; series: string };

export type PriceActionPattern =
  | "bullishEngulfing"
  | "bearishEngulfing"
  | "doji"
  | "hammer"
  | "shootingStar"
  | "higherHigh"
  | "lowerLow"
  | "insideBar"
  | "outsideBar";

export type TimeConfig = {
  mode: "hour" | "weekday" | "range";
  hour?: number;
  weekday?: number; // 0=Sun .. 6=Sat
  rangeStart?: string; // "HH:MM"
  rangeEnd?: string; // "HH:MM"
  days?: number[]; // allowed weekdays for range mode
};

export type BlockType =
  | "indicator"
  | "priceAction"
  | "time"
  | "custom"
  | "and"
  | "or"
  | "not"
  | "buy"
  | "sell"
  | "close"
  | "modifySLTP";

export type SlTpMode = "none" | "atr" | "ticks" | "rr" | "price";

export interface ModifyLeg {
  mode: "none" | "atr" | "ticks" | "price";
  value: number;
}

export interface StrategyBlock {
  id: string;
  type: BlockType;
  x: number;
  y: number;
  // indicator condition
  indicator?: IndicatorId;
  indicatorParams?: Record<string, number>;
  indicatorSeries?: string;
  comparison?: ComparisonOp;
  operand?: Operand;
  // price action
  pattern?: PriceActionPattern;
  // time
  time?: TimeConfig;
  // custom
  customExpr?: string;
  // action config (buy/sell/modify)
  qty?: number;
  orderType?: "market" | "limit" | "stop";
  limitOffset?: number;
  slMode?: SlTpMode;
  slValue?: number;
  tpMode?: SlTpMode;
  tpValue?: number;
  modify?: { sl?: ModifyLeg; tp?: ModifyLeg };
}

export interface Connection {
  id: string;
  from: string;
  to: string;
}

export interface StrategyGraph {
  version: number;
  name: string;
  description?: string;
  symbol?: string;
  timeframe?: Timeframe;
  blocks: StrategyBlock[];
  connections: Connection[];
}
