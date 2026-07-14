export const GC_POINT_VALUE = 100;
export const GC_TICK_SIZE = 0.1;
export const GC_MIN_STOP_POINTS = 5.0;
export const GC_MIN_STOP_DOLLARS = GC_MIN_STOP_POINTS * GC_POINT_VALUE;
export const GC_ADX_PERIOD = 14;
export const GC_ADX_THRESHOLD = 25;

export const GC_NEWS_EVENTS = ["NFP", "FOMC"] as const;

export function goldMinStopDollars(): number {
  return GC_MIN_STOP_DOLLARS;
}

export function isNewsEvent(date: Date): boolean {
  const month = date.getMonth();
  const day = date.getDate();
  const weekday = date.getDay();
  const isFirstFriday = weekday === 5 && day <= 7;
  if (isFirstFriday && month % 3 === 1) return true;
  const isMidMonth = day >= 10 && day <= 17 && weekday === 2;
  if (isMidMonth && month % 2 === 0) return false;
  if (day === 1 || day === 2) return true;
  return false;
}
