import type { StrategyParams } from "../../backtest/engine";

export const NQ_POINT_VALUE = 20;
export const NQ_TICK_SIZE = 0.25;
export const NQ_MARGIN_PER_CONTRACT = 1000;
export const NQ_DECIMALS = 2;

export const NQ_ATR_PERIOD = 14;
export const NQ_RSI_PERIOD = 14;
export const NQ_SMA_TREND_PERIOD = 200;
export const NQ_DAY_HIGH_LOW_LOOKBACK = 1;

export const NQ_MIN_STOP_DOLLARS = NQ_POINT_VALUE * 2;

export type StrategyMode = "conservative" | "aggressive" | "scalping";

export interface ModeConfig {
  label: string;
  atrMultSl: number;
  atrMultTrail: number;
  rsiThreshold: number;
  atrMinMultiplier: number;
  maxHoldBars: number;
  timeExitEnabled: boolean;
  description: string;
}

export const MODE_CONFIGS: Record<StrategyMode, ModeConfig> = {
  conservative: {
    label: "Conservative",
    atrMultSl: 2.0,
    atrMultTrail: 3.0,
    rsiThreshold: 55,
    atrMinMultiplier: 2.5,
    maxHoldBars: 8,
    timeExitEnabled: true,
    description: "Lower risk, fewer trades. Wider stops, stricter trend filter.",
  },
  aggressive: {
    label: "Aggressive",
    atrMultSl: 1.2,
    atrMultTrail: 2.0,
    rsiThreshold: 52,
    atrMinMultiplier: 1.5,
    maxHoldBars: 24,
    timeExitEnabled: true,
    description: "Higher risk, more trades. Tighter stops, relaxed filter.",
  },
  scalping: {
    label: "Scalping",
    atrMultSl: 1.0,
    atrMultTrail: 1.5,
    rsiThreshold: 51,
    atrMinMultiplier: 1.0,
    maxHoldBars: 4,
    timeExitEnabled: true,
    description: "M1-M5 quick profits. Tightest stops, minimal hold.",
  },
};

export function resolveModeParams(mode: StrategyMode | undefined, overrides: Partial<StrategyParams>): StrategyParams {
  const base = MODE_CONFIGS[mode ?? "conservative"];
  return {
    atrMultSl: base.atrMultSl,
    atrMultTrail: base.atrMultTrail,
    rsiThreshold: base.rsiThreshold,
    atrMinMultiplier: base.atrMinMultiplier,
    maxHoldBars: base.maxHoldBars,
    timeExitEnabled: base.timeExitEnabled ? 1 : 0,
    ...overrides,
  };
}

export function resolveModeDefaults(mode: StrategyMode | undefined): StrategyParams {
  return resolveModeParams(mode, {});
}
