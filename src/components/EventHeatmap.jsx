// EventHeatmap.jsx
// Bookmap-style heatmap of liquidity events — icebergs and stop runs drawn on
// a price/time grid from REAL candle-derived events.

import React, { useMemo } from 'react';

const ICEBERG_COLOR = '#f6c9d3';
const STOPRUN_COLOR = '#d9b46c';

export default function EventHeatmap({ events = [], candles = [], price, height = 200, cols = 60 }) {
  const rows = 18;
  const { min, max } = useMemo(() => {
    if (!events.length && !candles.length) return { min: (price ?? 0) - 2, max: (price ?? 0) + 2 };
    const prices = [
      ...events.map((e) => e.price ?? e.sweptFrom ?? price),
      ...candles.flatMap((c) => [c.high, c.low]),
    ].filter((value) => Number.isFinite(value));
    const lo = Math.min(...prices, price ?? Infinity);
    const hi = Math.max(...prices, price ?? -Infinity);
    const pad = (hi - lo) * 0.15 || 1;
    return { min: lo - pad, max: hi + pad };
  }, [events, price]);

  const volumeCells = useMemo(() => {
    if (!candles.length || max <= min) return [];
    const slice = candles.slice(-cols);
    const maxVolume = Math.max(1, ...slice.map((c) => Number(c.volume) || 0));
    const span = max - min;
    return slice.map((c, i) => {
      const close = Number(c.close);
      const row = Math.max(0, Math.min(rows - 1, Math.round(((max - close) / span) * (rows - 1))));
      return {
        x: (i / Math.min(cols, slice.length)) * 100,
        y: (row / rows) * 100,
        width: 100 / Math.min(cols, slice.length) + 0.5,
        height: 100 / rows * 2.2,
        intensity: Math.min(0.72, 0.12 + ((Number(c.volume) || 0) / maxVolume) * 0.6),
        up: c.close >= c.open,
      };
    });
  }, [candles, max, min, cols, rows]);

  const cells = useMemo(() => {
    if (!events.length || max <= min) return [];
    const span = max - min;
    return events.slice(-cols).map((e, i) => {
      const p = e.price ?? e.sweptFrom ?? price;
      const row = Math.max(0, Math.min(rows - 1, Math.round(((max - p) / span) * (rows - 1))));
      return {
        x: (i / Math.min(cols, events.length)) * 100,
        y: (row / rows) * 100,
        e,
      };
    });
  }, [events, price, min, max, cols, rows]);

  const nowRow = Math.max(0, Math.min(rows - 1, Math.round(((max - price) / (max - min)) * (rows - 1))));

  return (
    <div className="relative w-full rounded-lg overflow-hidden" style={{ height, background: 'rgba(14,14,16,.6)' }}>
      {/* Background grid */}
      <div className="absolute inset-0 grid grid-cols-6" style={{ gridTemplateRows: 'repeat(6, 1fr)' }}>
        {Array.from({ length: 36 }).map((_, i) => (
          <div key={i} className="border border-[rgba(255,255,255,0.03)]" />
        ))}
      </div>

      {/* Current price line */}
      <div
        className="absolute left-0 right-0 border-t border-dashed z-10"
        style={{ top: `${(nowRow / rows) * 100}%`, borderColor: 'rgba(246,201,211,.4)' }}
      />

      {/* Live candle-volume heat */}
      <div className="absolute inset-0" aria-label="Live candle volume heatmap">
        {volumeCells.map((c, i) => (
          <div
            key={`volume-${i}`}
            style={{
              position: 'absolute',
              left: `${c.x}%`,
              top: `${c.y}%`,
              width: `${c.width}%`,
              height: `${c.height}%`,
              background: c.up ? 'rgba(143,224,178,.9)' : 'rgba(255,109,134,.9)',
              opacity: c.intensity,
              filter: 'blur(3px)',
              borderRadius: 4,
            }}
          />
        ))}
      </div>

      {/* Event markers */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {cells.map((c, i) => {
          const isIce = c.e.type === 'iceberg';
          const dir = c.e.dir;
          const fill = isIce ? ICEBERG_COLOR : STOPRUN_COLOR;
          const up = dir === 'bid' || dir === 'up';
          return (
            <g key={i}>
              <circle cx={c.x} cy={c.y} r="1.6" fill={fill} opacity="0.25">
                <animate attributeName="r" values="1.2;2.2;1.2" dur="2s" repeatCount="indefinite" />
              </circle>
              <path
                d={up ? `M ${c.x - 1.1} ${c.y + 0.8} L ${c.x} ${c.y - 0.9} L ${c.x + 1.1} ${c.y + 0.8} Z` : `M ${c.x - 1.1} ${c.y - 0.8} L ${c.x} ${c.y + 0.9} L ${c.x + 1.1} ${c.y - 0.8} Z`}
                fill={fill}
                opacity="0.95"
              />
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="absolute top-1.5 left-1.5 z-20 flex items-center gap-3 mono" style={{ fontSize: 9, color: 'var(--mut)', background: 'rgba(14,14,16,.7)', padding: '4px 8px', borderRadius: 6 }}>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: ICEBERG_COLOR }} /> Iceberg
        </span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: STOPRUN_COLOR }} /> Stop Run
        </span>        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--up)' }} /> Volume
        </span>
      </div>
    </div>
  );
}
