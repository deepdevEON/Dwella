const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("dwella", {
  platform: process.platform,
  windowControls:{minimize:()=>ipcRenderer.invoke("window:minimize"),toggleMaximize:()=>ipcRenderer.invoke("window:toggle-maximize"),close:()=>ipcRenderer.invoke("window:close"),isMaximized:()=>ipcRenderer.invoke("window:is-maximized"),onMaxChanged:(cb)=>{const listener=(_,isMax)=>cb(Boolean(isMax));ipcRenderer.on("window:max-changed",listener);return()=>ipcRenderer.off("window:max-changed",listener)}}, hasLocalLogin:()=>ipcRenderer.invoke("auth:has-login"),
  createLocalLogin:(password)=>ipcRenderer.invoke("auth:create",password),
  verifyLocalLogin:(password)=>ipcRenderer.invoke("auth:verify",password),
  clearLocalLogin:()=>ipcRenderer.invoke("auth:clear"),
  getSystemStatus:()=>ipcRenderer.invoke("system:status"),
  startHermes:()=>ipcRenderer.invoke("hermes:start"), stopHermes:()=>ipcRenderer.invoke("hermes:stop"),
  askHermes:(input)=>ipcRenderer.invoke("hermes:ask",input),

  getMarketQuotes:()=>ipcRenderer.invoke("markets:quotes"),
  getMarketBars:(s,tf,count)=>ipcRenderer.invoke("markets:bars",s,tf,count),
  getFuturesBars:(s,tf,count)=>ipcRenderer.invoke("markets:futures-bars",s,tf,count),
  getFuturesChain:(s)=>ipcRenderer.invoke("markets:futures-chain",s),
  getFuturesSpec:(s)=>ipcRenderer.invoke("markets:futures-spec",s),
  getAccount:()=>ipcRenderer.invoke("markets:account"),
  getPositions:()=>ipcRenderer.invoke("markets:positions"),
  placeMarketOrder:(data)=>ipcRenderer.invoke("orders:market",data),
  placeLimitOrder:(data)=>ipcRenderer.invoke("orders:limit",data),
  placeStopOrder:(data)=>ipcRenderer.invoke("orders:stop",data),
  placeStopLimitOrder:(data)=>ipcRenderer.invoke("orders:stop-limit",data),
  placeBracketOrder:(data)=>ipcRenderer.invoke("orders:bracket",data),
  modifyOrder:(data)=>ipcRenderer.invoke("orders:modify",data),
  closeOrder:(data)=>ipcRenderer.invoke("orders:close",data),
  closeAllOrders:()=>ipcRenderer.invoke("orders:close-all"),
  getOrderHistory:()=>ipcRenderer.invoke("orders:history"),
  getTransactionLog:()=>ipcRenderer.invoke("orders:transactions"),
  openExternal:(url)=>ipcRenderer.invoke("shell:open",url),

  // ── Buffy IPC ────────────────────────────────────────────────────────
  buffy: {
    getHistory: () => ipcRenderer.invoke("buffy:history"),
    getSignals: () => ipcRenderer.invoke("buffy:signals"),
    onMessage: (cb) => {
      const listener = (_, msg) => cb(msg);
      ipcRenderer.on("buffy:message", listener);
      return () => ipcRenderer.off("buffy:message", listener);
    },
    onSignal: (cb) => {
      const listener = (_, sig) => cb(sig);
      ipcRenderer.on("buffy:signal", listener);
      return () => ipcRenderer.off("buffy:signal", listener);
    },
  },
  // ── End Buffy IPC ────────────────────────────────────────────────────
});
