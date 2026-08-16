// SakuraPetals.jsx — Seasonal falling particle rain for the boot screen.
// Spring: cherry blossoms (pink petals)
// Summer: sakura (blush petals)
// Autumn: maple leaves (orange/red)
// Winter: snowflakes (white/blue crystals)
// All particles drift downward with gentle horizontal sway.
import React, { useMemo } from 'react';

const SEASONS = {
  spring: {
    label: 'Cherry Blossoms',
    colors: [
      'rgba(255,182,193,0.6)',  // light pink
      'rgba(255,105,140,0.45)', // deep pink
      'rgba(255,200,210,0.5)',  // soft pink
      'rgba(248,160,180,0.4)',  // rose
      'rgba(255,220,230,0.35)', // pale pink
    ],
    shape: 'blossom', // 5-petal flower
  },
  summer: {
    label: 'Sakura Petals',
    colors: [
      'rgba(246,201,211,0.55)', // blush
      'rgba(255,227,234,0.45)', // sakura
      'rgba(226,69,95,0.30)',   // crimson
      'rgba(246,201,211,0.35)', // soft blush
      'rgba(255,227,234,0.25)', // soft sakura
    ],
    shape: 'petal', // single ellipse
  },
  autumn: {
    label: 'Maple Leaves',
    colors: [
      'rgba(220,90,40,0.55)',   // burnt orange
      'rgba(200,50,30,0.45)',   // deep red
      'rgba(230,140,50,0.4)',   // gold
      'rgba(180,60,30,0.35)',   // russet
      'rgba(240,170,60,0.3)',   // amber
    ],
    shape: 'maple', // maple leaf
  },
  winter: {
    label: 'Snowflakes',
    colors: [
      'rgba(220,230,245,0.6)',  // ice white
      'rgba(180,200,230,0.45)', // frost blue
      'rgba(255,255,255,0.5)',  // pure white
      'rgba(200,215,240,0.4)',  // snow
      'rgba(240,245,255,0.35)', // crystal
    ],
    shape: 'snowflake', // 6-pointed crystal
  },
};

function getSeason(month) {
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
}

// ── SVG shapes for each season ─────────────────────────────────────
function BlossomSVG({ color, rotation, size }) {
  // 5-petal cherry blossom
  return (
    <svg viewBox="0 0 12 12" width={size} height={size}>
      <g transform={`rotate(${rotation} 6 6)`}>
        {[0, 72, 144, 216, 288].map((angle) => (
          <ellipse
            key={angle}
            cx="6"
            cy="2.5"
            rx="2.2"
            ry="3"
            fill={color}
            transform={`rotate(${angle} 6 6)`}
          />
        ))}
        <circle cx="6" cy="6" r="1.2" fill="rgba(255,220,100,0.5)" />
      </g>
    </svg>
  );
}

function PetalSVG({ color, rotation, size }) {
  // Single sakura petal (ellipse)
  return (
    <svg viewBox="0 0 10 14" width={size * 0.7} height={size}>
      <ellipse cx="5" cy="7" rx="4" ry="6.5" fill={color} transform={`rotate(${rotation} 5 7)`} />
      <ellipse cx="5" cy="5" rx="2" ry="3" fill="rgba(255,255,255,0.15)" transform={`rotate(${rotation} 5 5)`} />
    </svg>
  );
}

function MapleSVG({ color, rotation, size }) {
  // Simplified maple leaf — a 5-pointed star shape
  return (
    <svg viewBox="0 0 14 14" width={size} height={size}>
      <g transform={`rotate(${rotation} 7 7)`}>
        <polygon
          points="7,1 8.5,5 13,5.5 9.5,8.5 11,13 7,10 3,13 4.5,8.5 1,5.5 5.5,5"
          fill={color}
        />
        <line x1="7" y1="4" x2="7" y2="12" stroke="rgba(0,0,0,0.15)" strokeWidth="0.5" />
      </g>
    </svg>
  );
}

function SnowflakeSVG({ color, rotation, size }) {
  // 6-pointed snowflake crystal
  return (
    <svg viewBox="0 0 12 12" width={size} height={size}>
      <g transform={`rotate(${rotation} 6 6)`} stroke={color} strokeWidth="1" strokeLinecap="round">
        {[0, 60, 120].map((angle) => (
          <g key={angle} transform={`rotate(${angle} 6 6)`}>
            <line x1="6" y1="1.5" x2="6" y2="10.5" />
            <line x1="4" y1="3" x2="6" y2="1.5" />
            <line x1="8" y1="3" x2="6" y2="1.5" />
            <line x1="4" y1="9" x2="6" y2="10.5" />
            <line x1="8" y1="9" x2="6" y2="10.5" />
          </g>
        ))}
      </g>
    </svg>
  );
}

const SHAPE_MAP = {
  blossom: BlossomSVG,
  petal: PetalSVG,
  maple: MapleSVG,
  snowflake: SnowflakeSVG,
};

export default function SakuraPetals({ count = 14, width = 200, height = 260, season: seasonProp }) {
  const month = new Date().getMonth(); // 0-indexed
  const season = seasonProp || getSeason(month);
  const config = SEASONS[season] || SEASONS.summer;
  const ShapeComponent = SHAPE_MAP[config.shape] || PetalSVG;

  const particles = useMemo(() => {
    return Array.from({ length: count }, (_, i) => {
      const seed = (i * 7919 + 104729) % 1000;
      const x = seed % 100;
      const delay = (i * 0.35) % 4;
      // Winter snowflakes fall slower, autumn leaves tumble faster
      const baseDuration = season === 'winter' ? 5 : season === 'autumn' ? 3 : 3.5;
      const duration = baseDuration + (seed % 200) / 100;
      const sway = 15 + (seed % 30);
      const swayDur = 2 + (seed % 150) / 100;
      const size = season === 'snowflake' ? 7 + (seed % 5) : 6 + (seed % 5);
      const rotation = seed % 360;
      const color = config.colors[i % config.colors.length];

      return { x, delay, duration, sway, swayDur, size, rotation, color, id: i };
    });
  }, [count, season, config.colors]);

  return (
    <div style={{ width, height, position: 'relative', overflow: 'hidden', pointerEvents: 'none' }}>
      {particles.map((p) => (
        <div
          key={p.id}
          className="sp-particle"
          style={{
            position: 'absolute',
            left: `${p.x}%`,
            top: -20,
            animation: `petalFall ${p.duration}s linear ${p.delay}s infinite, petalSway ${p.swayDur}s ease-in-out ${p.delay}s infinite alternate`,
            '--sway': `${p.sway}px`,
          }}
        >
          <ShapeComponent color={p.color} rotation={p.rotation} size={p.size} />
        </div>
      ))}
    </div>
  );
}

export { getSeason, SEASONS };
