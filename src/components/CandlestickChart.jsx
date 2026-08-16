// CandlestickChart.jsx
// SVG candlestick chart with:
//   - candles colored by direction (up = sakura blush, down = crimson)
//   - volume profile histogram on the right side
//   - event markers (iceberg / stop run from real candles)
//   - POC label

import React, { useMemo } from 'react';

const W = 600;
const H = 280;
const PROFILE_W = 70;
const CHART_W = W - PROFILE_W - 10;
const PAD = { top: 16, bottom: 20 };
const UP = '#f6c9d3';
const DOWN = '#e2455f';

export default function CandlestickChart({ candles, profile, events, price, valueArea: valueAreaData = null }) {
  const chart = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const list = candles.slice(-60);
    const hi = Math.max(...list.map((c) => c.high));
    const lo = Math.min(...list.map((c) => c.low));
    let rangeHi = hi;
    let rangeLo = lo;
    if (events?.length) {
      for (const e of events.slice(-15)) {
        const p = e.price ?? e.sweptFrom;
        if (p) {
          rangeHi = Math.max(rangeHi, p);
          rangeLo = Math.min(rangeLo, p);
        }
      }
    }
    const pad = (rangeHi - rangeLo) * 0.08 || 1;
    rangeHi += pad;
    rangeLo -= pad;
    const span = rangeHi - rangeLo || 1;
    const y = (p) => PAD.top + ((rangeHi - p) / span) * (H - PAD.top - PAD.bottom);
    const x = (i) => 8 + (i / Math.max(1, list.length - 1)) * (CHART_W - 16);
    const cw = Math.max(2, ((CHART_W - 16) / list.length) * 0.6);

    return { list, rangeHi, rangeLo, y, x, cw, span };
  }, [candles, events]);

  if (!chart) return <div className="mono p-4" style={{ fontSize: 12, color: 'var(--dim)' }}>Awaiting candle data…</div>;

  const { list, y, x, cw, rangeLo, rangeHi } = chart;
  const maxProfileVol = profile?.length ? Math.max(...profile.map((p) => p.volume)) : 1;

  return (
    <svg className="w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {/* Price labels on right side */}
      {[0, 1, 2, 3, 4, 5].map((g) => {
        const gy = PAD.top + (g / 5) * (H - PAD.top - PAD.bottom);
        const p = rangeHi - ((gy - PAD.top) / (H - PAD.top - PAD.bottom)) * (rangeHi - rangeLo);
        return (
          <text key={g} x={CHART_W + 4} y={gy + 3} fill="#756d68" fontSize="7.5" fontFamily="monospace">
            {p.toFixed(0)}
          </text>
        );
      })}

      {/* Candles */}
      {list.map((c, i) => {
        const up = c.close >= c.open;
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyBot = y(Math.min(c.open, c.close));
        const color = up ? UP : DOWN;
        return (
          <g key={i}>
            <line x1={x(i)} y1={y(c.high)} x2={x(i)} y2={y(c.low)} stroke={color} strokeWidth="0.8" />
            <rect
              x={x(i) - cw / 2}
              y={bodyTop}
              width={cw}
              height={Math.max(1, bodyBot - bodyTop)}
              fill={color}
              opacity={0.9}
              rx="0.5"
            />
          </g>
        );
      })}

      {/* Events */}
      {events?.slice(-15).map((e, i) => {
        const p = e.price ?? e.sweptFrom;
        if (!p) return null;
        const isIce = e.type === 'iceberg';
        const color = isIce ? '#f6c9d3' : '#d9b46c';
        const ey = y(p);
        return (
          <g key={`ev-${i}`}>
            <circle cx={CHART_W - 6} cy={ey} r="2.2" fill={color} opacity="0.9" />
            <circle cx={CHART_W - 6} cy={ey} r="4" fill="none" stroke={color} opacity="0.35" />
          </g>
        );
      })}

      {/* Volume profile histogram */}
      {profile?.length > 0 && (
        <g>
          {profile.map((p, i) => {
            const py = y(p.price);
            const pw = (p.volume / maxProfileVol) * (PROFILE_W - 4);
            return (
              <rect
                key={i}
                x={CHART_W + 2}
                y={py - 1.5}
                width={Math.max(1, pw)}
                height={Math.max(1.5, Math.abs(y(p.price + (p.price - (profile[i + 1]?.price ?? p.price))) - py) || 2)}
                fill={p.price === valueAreaData?.poc ? '#f6c9d3' : 'rgba(246,201,211,0.35)'}
                opacity="0.8"
              />
            );
          })}
          {valueAreaData?.poc != null && (
            <text x={CHART_W + 2} y={y(valueAreaData.poc) - 3} fill="#f0d49a" fontSize="6.5" fontFamily="monospace">
              POC {valueAreaData.poc.toFixed(0)}
            </text>
          )}
        </g>
      )}
    </svg>
  );
}
