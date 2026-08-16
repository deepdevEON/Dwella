// ToastSystem.jsx
// Animated toast notifications for order fills, cancels, and errors.
// Renders at bottom-right, auto-dismisses after 4s.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const ToastContext = createContext(null);

let _id = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, { type = 'info', duration = 4000 } = {}) => {
    const id = ++_id;
    setToasts((prev) => [...prev, { id, msg, type, ts: Date.now() }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, dismiss }}>
      {children}
      <ToastLayer toasts={toasts} dismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext) || { addToast: () => {}, dismiss: () => {} };
}

function ToastLayer({ toasts, dismiss }) {
  if (!toasts.length) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380,
      pointerEvents: 'none',
    }}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

const TYPE_STYLES = {
  fill:    { bg: 'rgba(143,224,178,.12)', border: 'rgba(143,224,178,.35)', color: '#8fe0b2', icon: '✓' },
  paper:   { bg: 'rgba(251,191,36,.10)', border: 'rgba(251,191,36,.30)', color: '#fbbf24', icon: '📝' },
  cancel:  { bg: 'rgba(255,109,134,.10)', border: 'rgba(255,109,134,.30)', color: '#ff6d86', icon: '✕' },
  error:   { bg: 'rgba(226,69,95,.10)', border: 'rgba(226,69,95,.30)', color: '#e2455f', icon: '⚠' },
  info:    { bg: 'rgba(246,201,211,.08)', border: 'rgba(246,201,211,.25)', color: '#f6c9d3', icon: '●' },
  success: { bg: 'rgba(143,224,178,.10)', border: 'rgba(143,224,178,.30)', color: '#8fe0b2', icon: '✓' },
};

function ToastItem({ toast, onDismiss }) {
  const [exiting, setExiting] = useState(false);
  const s = TYPE_STYLES[toast.type] || TYPE_STYLES.info;

  useEffect(() => {
    const t = setTimeout(() => setExiting(true), 3400);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      onClick={onDismiss}
      style={{
        pointerEvents: 'auto',
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 16px', borderRadius: 12,
        background: s.bg, border: `1px solid ${s.border}`,
        backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        boxShadow: '0 12px 40px -12px rgba(0,0,0,.7)',
        fontFamily: 'var(--mono)', fontSize: 11.5,
        color: s.color, cursor: 'pointer',
        animation: exiting ? 'toastOut .3s ease forwards' : 'toastIn .35s cubic-bezier(.2,.7,.2,1)',
        transition: 'opacity .3s',
      }}
    >
      <span style={{ fontSize: 14, flexShrink: 0 }}>{s.icon}</span>
      <span style={{ flex: 1, lineHeight: 1.45 }}>{toast.msg}</span>
      <span style={{ fontSize: 9, color: 'var(--dim)', flexShrink: 0 }}>
        {new Date(toast.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </span>
    </div>
  );
}
