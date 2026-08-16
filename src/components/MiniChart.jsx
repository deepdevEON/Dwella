// MiniChart.jsx — Small SVG candlestick chart that renders real M5 candles
// from the TradingView sidecar with a subtle draw-in animation. Used on the boot
// screen left panel as a live terminal preview.
import React, { useMemo } from 'react';

const UP = '#8fe0b2';
const DN = '#ff6d86';
const WICK = 'rgba(255,255,255,.25)';

export default function MiniChart({ candles = [], width = 280, height = 140, barCount = 24 }) {
  const data = useMemo(() => {
    if (!candles.length) return [];
    // Take the last `barCount` candles
    const slice = candles.slice(-barCount);
    return slice;
  }, [candles, barCount]);

  if (!data.length) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
        <text x={width / 2} y={height / 2} textAnchor="middle" fill="rgba(255,255,255,.15)" fontSize="11" fontFamily="var(--mono)">
          Loading candles…
        </text>
      </svg>
    );
  }

  // Compute price range across all visible candles
  const allHighs = data.map((c) => c.high);
  const allLows = data.map((c) => c.low);
  const hi = Math.max(...allHighs);
  const lo = Math.min(...allLows);
  const range = hi - lo || 1;
  const pad = 12; // top/bottom padding in px
  const chartH = height - pad * 2;
  const barW = Math.floor((width - 8) / data.length);
  const gap = Math.max(1, Math.floor(barW * 0.25));
  const bodyW = Math.max(2, barW - gap);

  const yScale = (price) => pad + chartH * (1 - (price - lo) / range);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      {/* Subtle grid lines */}
      {[0.25, 0.5, 0.75].map((frac) => (
        <line
          key={frac}
          x1={0}
          y1={pad + chartH * frac}
          x2={width}
          y2={pad + chartH * frac}
          stroke="rgba(255,255,255,.04)"
          strokeWidth={0.5}
        />
      ))}

      {/* Candles */}
      {data.map((c, i) => {
        const x = 4 + i * barW;
        const cx = x + barW / 2;
        const bull = c.close >= c.open;
        const color = bull ? UP : DN;
        const bodyTop = yScale(Math.max(c.open, c.close));
        const bodyBot = yScale(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBot - bodyTop);
        const wickTop = yScale(c.high);
        const wickBot = yScale(c.low);

        // Staggered animation: each candle fades in slightly after the previous
        const delay = i * 0.04;

        return (
          <g key={i} opacity={0} style={{ animation: `mcFadeIn 0.4s ease ${delay}s forwards` }}>
            {/* Wick */}
            <line x1={cx} y1={wickTop} x2={cx} y2={wickBot} stroke={WICK} strokeWidth={1} />
            {/* Body */}
            <rect
              x={cx - bodyW / 2}
              y={bodyTop}
              width={bodyW}
              height={bodyH}
              rx={1}
              fill={color}
              opacity={0.85}
            />
          </g>
        );
      })}

      {/* Price label */}
      <text
        x={width - 4}
        y={pad + 8}
        textAnchor="end"
        fill="rgba(255,255,255,.35)"
        fontSize="9"
        fontFamily="var(--mono)"
      >
        {hi.toFixed(1)}
      </text>
      <text
        x={width - 4}
        y={height - pad}
        textAnchor="end"
        fill="rgba(255,255,255,.35)"
        fontSize="9"
        fontFamily="var(--mono)"
      >
        {lo.toFixed(1)}
      </text>
    </svg>
  );
}
