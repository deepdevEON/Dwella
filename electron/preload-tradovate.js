// preload-tradovate.js
// Runs inside the Trader.tradovate.com BrowserWindow.
// Hooks fetch() and XMLHttpRequest to intercept Tradovate auth responses
// (accessToken, mdAccessToken) and forwards them to the main process —
// the exact pattern Helios uses with its WKWebView XHR hook.

const { ipcRenderer } = require('electron');

function sendTokens(accessToken, mdAccessToken, env) {
  if (accessToken) {
    ipcRenderer.send('tradovate:tokens', {
      accessToken,
      mdAccessToken: mdAccessToken || '',
      env: env || detectEnv(),
    });
  }
}

function detectEnv() {
  try {
    const host = window.location.hostname;
    return host.includes('live') ? 'LIVE' : 'DEMO';
  } catch {
    return 'DEMO';
  }
}

// ─── Hook fetch() ──────────────────────────────────────────────────
const _origFetch = window.fetch;
window.fetch = async function (...args) {
  const resp = await _origFetch.apply(this, args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    // Clone so the caller can still read the body
    const clone = resp.clone();
    if (url.includes('/auth/accesstokenrequest') || url.includes('/auth/renewAccessToken') || url.includes('/auth/accessToken')) {
      clone.json().then((data) => {
        if (data && data.accessToken) {
          sendTokens(data.accessToken, data.mdAccessToken, detectEnv());
        }
      }).catch(() => {});
    }
  } catch { /* hook is best-effort */ }
  return resp;
};

// ─── Hook XMLHttpRequest ───────────────────────────────────────────
const _origOpen = XMLHttpRequest.prototype.open;
const _origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this._tvUrl = url;
  return _origOpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function (...args) {
  this.addEventListener('load', function () {
    try {
      const url = this._tvUrl || '';
      if (url.includes('/auth/accesstokenrequest') || url.includes('/auth/renewAccessToken') || url.includes('/auth/accessToken')) {
        const data = JSON.parse(this.responseText || '{}');
        if (data && data.accessToken) {
          sendTokens(data.accessToken, data.mdAccessToken, detectEnv());
        }
      }
    } catch { /* hook is best-effort */ }
  });
  return _origSend.apply(this, args);
};

// ─── Hook WebSocket ────────────────────────────────────────────────
// Tradovate's websocket handshake includes the auth token in the first
// message or in headers — we watch for the connect message pattern.
const _OrigWS = window.WebSocket;
window.WebSocket = function (url, protocols) {
  const ws = protocols ? new _OrigWS(url, protocols) : new _OrigWS(url);
  // The first WS message from Tradovate is typically { s: 1, i: 1, t: "url" }
  // followed by an auth exchange. We watch for token patterns in messages.
  const _origOnMessage = ws.onmessage;
  ws.addEventListener('message', function (evt) {
    try {
      const raw = typeof evt.data === 'string' ? evt.data : '';
      // Look for accessToken pattern in WebSocket frames
      if (raw.includes('accessToken')) {
        const parsed = JSON.parse(raw);
        // Tradovate WS responses: { d: { accessToken, mdAccessToken } }
        const d = parsed.d || parsed;
        if (d && d.accessToken) {
          sendTokens(d.accessToken, d.mdAccessToken, detectEnv());
        }
      }
    } catch { /* hook is best-effort */ }
  });
  return ws;
};
window.WebSocket.prototype = _OrigWS.prototype;
window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
window.WebSocket.OPEN = _OrigWS.OPEN;
window.WebSocket.CLOSING = _OrigWS.CLOSING;
window.WebSocket.CLOSED = _OrigWS.CLOSED;

// Signal to the main process that the webview is loaded and ready
ipcRenderer.send('tradovate:ready');
