/** Candlestick chart (SVG) extracted from App.tsx so Replay panel can reuse the same rendering
 *  and overlay horizontal markers (entry / SL / TP) at specific price levels. */

export interface MarketBar {
  t: number; // unix ms (existing App.tsx contract) OR unix seconds — both work, see shape
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ChartMarker {
  price: number;
  color: string;
  label?: string;
  /** Optional dash pattern override. Default: "5 4" dashed. */
  dashArray?: string;
}

export default function CandleChart({
  bars,
  markers = [],
  width = 820,
  height = 290,
}: {
  bars: MarketBar[];
  markers?: ChartMarker[];
  width?: number;
  height?: number;
}) {
  if (!bars.length) {
    return <div className="chart-empty">Waiting for MT5 bars…</div>;
  }
  const P = 10;
  const R = 54;
  const lo = Math.min(...bars.map(b => b.l), ...markers.map(m => m.price));
  const hi = Math.max(...bars.map(b => b.h), ...markers.map(m => m.price));
  const span = (hi - lo) || 1;
  const y = (v: number) => P + (height - 2 * P) * (1 - (v - lo) / span);
  const step = (width - R) / bars.length;
  const bw = Math.max(1.6, step * 0.55);
  const last = bars[bars.length - 1].c;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="candles" preserveAspectRatio="none">
      {[hi, lo + span / 2, lo].map(v => (
        <g key={v}>
          <line className="grid" x1={0} x2={width - R} y1={y(v)} y2={y(v)} />
          <text x={width - R + 6} y={y(v) + 3}>
            {v.toLocaleString("en-US", { maximumFractionDigits: 1 })}
          </text>
        </g>
      ))}
      {bars.map((b, i) => {
        const x = i * step + step / 2;
        const up = b.c >= b.o;
        return (
          <g key={b.t} className={up ? "up" : "down"}>
            <line x1={x} x2={x} y1={y(b.h)} y2={y(b.l)} />
            <rect
              x={x - bw / 2}
              y={y(Math.max(b.o, b.c))}
              width={bw}
              height={Math.max(1.4, Math.abs(y(b.o) - y(b.c)))}
            />
          </g>
        );
      })}
      {/* Optional horizontal markers — entry, SL, TP, etc. Drawn above candles, below the
          "last price" line. */}
      {markers.map((m, i) => (
        <g key={`m-${i}`}>
          <line
            x1={0}
            x2={width - R}
            y1={y(m.price)}
            y2={y(m.price)}
            stroke={m.color}
            strokeWidth={1}
            strokeDasharray={m.dashArray ?? "5 4"}
            opacity={0.85}
          />
          {m.label && (
            <text
              x={6}
              y={y(m.price) - 3}
              fill={m.color}
              fontSize={9}
              fontWeight={600}
              style={{ pointerEvents: "none" }}
            >
              {m.label}
            </text>
          )}
        </g>
      ))}
      <line
        className="last"
        x1={0}
        x2={width - R}
        y1={y(last)}
        y2={y(last)}
      />
      <text className="last-label" x={width - R + 6} y={y(last) + 3}>
        {last.toLocaleString("en-US", { maximumFractionDigits: 1 })}
      </text>
    </svg>
  );
}
