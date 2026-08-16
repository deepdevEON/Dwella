/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        dark: {
          void: '#050507',
          deep: '#0a0a0f',
          surface: '#101018',
          elevated: '#16161f',
          card: '#1a1a25',
        },
        accent: {
          DEFAULT: '#d4a843',
          bright: '#f0cc6b',
          dim: '#8a7033',
          glow: 'rgba(212, 168, 67, 0.15)',
        },
        profit: {
          DEFAULT: '#34d399',
          dim: 'rgba(52, 211, 153, 0.12)',
        },
        loss: {
          DEFAULT: '#f87171',
          dim: 'rgba(248, 113, 113, 0.12)',
        },
      },
      fontFamily: {
        display: ['Instrument Serif', 'Georgia', 'serif'],
        body: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        'glass': '12px',
        'glass-lg': '16px',
        'glass-xl': '20px',
      },
      backdropBlur: {
        'glass': '20px',
        'glass-heavy': '24px',
      },
      boxShadow: {
        'glass': '0 4px 20px rgba(0, 0, 0, 0.4)',
        'glass-lg': '0 8px 40px rgba(0, 0, 0, 0.5)',
        'glow': '0 0 30px rgba(212, 168, 67, 0.1)',
        'glow-profit': '0 0 20px rgba(52, 211, 153, 0.2)',
        'glow-loss': '0 0 20px rgba(248, 113, 113, 0.2)',
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.5s ease-out',
        'pulse-glow': 'pulseGlow 2s infinite',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
        pulseGlow: {
          '0%': { boxShadow: '0 0 0 0 rgba(52, 211, 153, 0.5)' },
          '70%': { boxShadow: '0 0 0 8px rgba(52, 211, 153, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(52, 211, 153, 0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
