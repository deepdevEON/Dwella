// CumulativeDelta.jsx
// Real cumulative delta bars (aggressive buys vs sells from the real tick
// tape flags). Up bars = buyers (--up), down bars = sellers (--down).

import React, { useMemo } from 'react';

export default function CumulativeDelta({ deltaHistory, height = 120 }) {
  const data = useMemo(() => {
    if (!deltaHistory || deltaHistory.length < 2) return [];
    return deltaHistory.slice(-80).map((d, i) => ({ d, i }));
  }, [deltaHistory]);

  if (!data.length) {
    return <div className="mono p-3" style={{ fontSize: 12, color: 'var(--dim)' }}>Awaiting delta data…</div>;
  }

  const maxAbs = Math.max(8, ...data.map((x) => Math.abs(x.d)));
  const w = 100 / data.length;

  return (
    <div className="w-full" style={{ height }}>
      <svg className="w-full h-full" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
        <line x1="0" y1={height / 2} x2="100" y2={height / 2} stroke="rgba(255,255,255,.12)" strokeWidth="0.4" strokeDasharray="1 1" />
        {data.map(({ d, i }) => {
          const h = (Math.abs(d) / maxAbs) * (height / 2 - 3);
          const y = d >= 0 ? height / 2 - h : height / 2;
          return (
            <rect
              key={i}
              x={i * w}
              y={y}
              width={w * 0.82}
              height={Math.max(1, h)}
              fill={d >= 0 ? 'var(--up)' : 'var(--down)'}
              opacity={0.85}
              rx="0.2"
            />
          );
        })}
      </svg>
    </div>
  );
}
