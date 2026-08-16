#!/usr/bin/env python3
"""Inject liquid glass design enhancements into dwella-terminal.html"""
import sys

html_path = '/Users/gid/Documents/Flourish/dwella-terminal.html'
html = open(html_path, 'r', encoding='utf-8').read()

# 1. Add Google Fonts import for Instrument Serif after <head>
font_import = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">'
)
html = html.replace('<head>', '<head>\n' + font_import, 1)

# 2. Add Instrument Serif to the serif font variable
html = html.replace(
    "--serif:'Cormorant Garamond',serif;",
    "--serif:'Instrument Serif','Cormorant Garamond',serif;"
)

# 3. Add JetBrains Mono variable
html = html.replace(
    "--sans:'Inter',sans-serif;",
    "--sans:'Inter',sans-serif;\n  --mono:'JetBrains Mono','SF Mono',monospace;"
)

# 4. Liquid glass enhancement CSS
liquid_glass_css = """
/* ========== LIQUID GLASS ENHANCEMENTS ========== */
.liquid-glass {
  background: rgba(255,255,255,0.015);
  background-blend-mode: luminosity;
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid var(--stroke);
  position: relative;
  overflow: hidden;
}
.liquid-glass::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(180deg,
    rgba(255,255,255,0.12) 0%,
    rgba(255,255,255,0.04) 20%,
    transparent 40%,
    transparent 60%,
    rgba(255,255,255,0.04) 80%,
    rgba(255,255,255,0.12) 100%);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

/* ========== AMBIENT RAYS ========== */
.ambient-rays {
  position: fixed;
  inset: -30%;
  z-index: 0;
  pointer-events: none;
  opacity: 0.25;
  mix-blend-mode: screen;
  background:
    conic-gradient(from 200deg at 15% 0%, transparent 0 14deg, rgba(var(--violet-rgb),0.08) 18deg, transparent 24deg),
    conic-gradient(from 30deg at 85% 100%, transparent 0 12deg, rgba(212,175,55,0.05) 16deg, transparent 22deg);
  filter: blur(50px);
  animation: ambientRays 30s ease-in-out infinite alternate;
}
@keyframes ambientRays {
  from { transform: rotate(-2deg) scale(1.04); }
  to { transform: rotate(2deg) scale(1.1); }
}

/* ========== ENHANCED NAV ITEMS ========== */
.nav-item {
  transition: all 0.25s cubic-bezier(0.16,1,0.3,1);
}
.nav-item:hover {
  transform: translateX(2px);
}
.nav-item.active {
  box-shadow: 0 0 20px rgba(var(--violet-rgb),0.15), inset 0 0 12px rgba(var(--violet-rgb),0.06);
}

/* ========== ENHANCED GLASS PANELS ========== */
.glass {
  transition: all 0.3s cubic-bezier(0.16,1,0.3,1);
}
.glass:hover {
  border-color: var(--stroke-2);
  box-shadow: 0 12px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.09);
  transform: translateY(-1px);
}

/* ========== SCROLLBAR ENHANCEMENT ========== */
::-webkit-scrollbar-thumb {
  background: rgba(var(--violet-rgb),0.15);
  border-radius: 4px;
  transition: background 0.2s;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--violet-rgb),0.35);
}

/* ========== SHIMMER EFFECT ========== */
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.shimmer {
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.04), transparent);
  background-size: 200% 100%;
  animation: shimmer 3s linear infinite;
}
"""

# Insert after .glass-soft block
glass_soft_end = html.find('.glass-soft{')
if glass_soft_end > 0:
    depth = 0
    i = glass_soft_end
    while i < len(html):
        if html[i] == '{':
            depth += 1
        elif html[i] == '}':
            depth -= 1
            if depth == 0:
                insert_pos = i + 1
                html = html[:insert_pos] + liquid_glass_css + html[insert_pos:]
                break
        i += 1

open(html_path, 'w', encoding='utf-8').write(html)
print(f'Updated HTML: {len(html)} chars')
print('Added: Instrument Serif, JetBrains Mono, liquid glass, ambient rays, shimmer')
