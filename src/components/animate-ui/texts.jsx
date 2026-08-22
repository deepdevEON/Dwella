// Animated text primitives adapted from Animate UI — https://animate-ui.com
// Source: MIT-licensed open component distribution (github.com/imskyleen/animate-ui).
//
// Adaptations for this codebase:
//   - `motion/react` import -> `framer-motion` (already a dependency here).
//   - `use-is-in-view` hook -> framer-motion's built-in `useInView`.
//   - React 19 `ref` prop -> plain ref + forward-compatible span ref.
//   - Added an optional `format` prop to CountingNumber so values can render
//     with the app's money/price formatters while still animating numerically.

import * as React from 'react';
import { motion, useInView, useMotionValue, useReducedMotion, useSpring } from 'framer-motion';

const DEFAULT_GRADIENT =
  'linear-gradient(90deg, #d9ff4f 0%, #79dec7 25%, #e8bf79 50%, #79dec7 75%, #d9ff4f 100%)';

/**
 * Animated gradient text. The background position sweeps continuously to give
 * headings a slow, tasteful color travel.
 */
export function GradientText({
  text,
  style,
  gradient = DEFAULT_GRADIENT,
  neon = false,
  transition = { duration: 50, repeat: Infinity, ease: 'linear' },
  ...props
}) {
  const reduceMotion = useReducedMotion();
  const baseStyle = {
    backgroundImage: gradient,
    margin: 0,
    color: 'transparent',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    backgroundSize: '700% 100%',
    backgroundPosition: '0% 0%',
  };
  const animatedPosition = reduceMotion ? undefined : { backgroundPosition: '500% 100%' };

  return (
    <span
      data-slot="gradient-text"
      style={{ position: 'relative', display: 'inline-block', ...style }}
      {...props}
    >
      <motion.span
        style={baseStyle}
        initial={reduceMotion ? false : { backgroundPosition: '0% 0%' }}
        animate={animatedPosition}
        transition={transition}
      >
        {text}
      </motion.span>

      {neon && (
        <motion.span
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            mixBlendMode: 'plus-lighter',
            filter: 'blur(8px)',
            ...baseStyle,
          }}
          initial={reduceMotion ? false : { backgroundPosition: '0% 0%' }}
          animate={animatedPosition}
          transition={transition}
        >
          {text}
        </motion.span>
      )}
    </span>
  );
}

/**
 * Animate UI-style shimmer text for status copy that changes during a boot or
 * sync sequence. It falls back to a static label when motion is reduced.
 */
export function ShimmeringText({
  children,
  text,
  style,
  duration = 2.8,
  ...props
}) {
  const reduceMotion = useReducedMotion();
  const shimmerStyle = {
    display: 'inline-block',
    color: 'transparent',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundImage: 'linear-gradient(110deg, var(--ws-muted) 0%, var(--ws-muted) 36%, var(--ws-lime) 50%, var(--ws-muted) 64%, var(--ws-muted) 100%)',
    backgroundSize: '240% 100%',
    backgroundPosition: '100% 0%',
    ...style,
  };

  return (
    <motion.span
      data-slot="shimmering-text"
      style={shimmerStyle}
      initial={reduceMotion ? false : { backgroundPosition: '100% 0%' }}
      animate={reduceMotion ? undefined : { backgroundPosition: '-100% 0%' }}
      transition={reduceMotion ? undefined : { duration, repeat: Infinity, ease: 'linear' }}
      {...props}
    >
      {children ?? text}
    </motion.span>
  );
}

/**
 * Counts from `fromNumber` to `number` with a spring when it enters the
 * viewport (and again whenever `number` changes, e.g. a live price tick).
 */
export function CountingNumber({
  number,
  fromNumber = 0,
  padStart = false,
  decimalSeparator = '.',
  decimalPlaces = 0,
  transition = { stiffness: 90, damping: 50 },
  delay = 0,
  initiallyStable = false,
  inViewMargin = '0px',
  inViewOnce = true,
  format,
  ...props
}) {
  const ref = React.useRef(null);
  const reduceMotion = useReducedMotion();
  const isInView = useInView(ref, { margin: inViewMargin, once: inViewOnce });

  const decimals =
    Number.isFinite(decimalPlaces) && decimalPlaces >= 0
      ? decimalPlaces
      : (() => {
          const str = String(number);
          const idx = str.indexOf('.');
          return idx >= 0 ? str.length - idx - 1 : 0;
        })();

  const motionVal = useMotionValue(initiallyStable || reduceMotion ? number : fromNumber);
  const springVal = useSpring(motionVal, transition);

  // Keep the latest formatter in a ref so the subscription below stays stable
  // even when the parent passes an inline closure (e.g. formatPrice(value, symbol)).
  const formatRef = React.useRef(format);
  formatRef.current = format;

  React.useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (!isInView) return;
      if (reduceMotion) motionVal.jump(number);
      else motionVal.set(number);
    }, delay);
    return () => clearTimeout(timeoutId);
  }, [isInView, number, motionVal, delay, reduceMotion]);

  React.useEffect(() => {
    const unsubscribe = springVal.on('change', (latest) => {
      if (!ref.current) return;
      const rounded = decimals > 0 ? Number(latest.toFixed(decimals)) : Math.round(latest);
      ref.current.textContent = formatRef.current
        ? formatRef.current(rounded)
        : formatNumber(rounded);
    });
    return () => unsubscribe();
  }, [springVal, decimals]);

  const formatNumber = React.useCallback(
    (value) => {
      let out = decimals > 0 ? value.toFixed(decimals) : Math.round(value).toString();
      if (decimals > 0) out = out.replace('.', decimalSeparator);
      if (padStart) {
        const finalIntLength = Math.floor(Math.abs(number)).toString().length;
        const [intPart, fracPart] = out.split(decimalSeparator);
        const paddedInt = (intPart ?? '').padStart(finalIntLength, '0');
        out = fracPart ? `${paddedInt}${decimalSeparator}${fracPart}` : paddedInt;
      }
      return out;
    },
    [decimals, decimalSeparator, padStart, number],
  );

  const zeroText = padStart
    ? '0'.padStart(Math.floor(Math.abs(number)).toString().length, '0') +
      (decimals > 0 ? decimalSeparator + '0'.repeat(decimals) : '')
    : '0' + (decimals > 0 ? decimalSeparator + '0'.repeat(decimals) : '');

  const initialText = format
    ? format(initiallyStable || reduceMotion ? number : fromNumber)
    : initiallyStable || reduceMotion
      ? formatNumber(number)
      : zeroText;

  return (
    <span ref={ref} data-slot="counting-number" {...props}>
      {initialText}
    </span>
  );
}
