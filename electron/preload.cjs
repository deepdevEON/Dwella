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
  getAccount:()=>ipcRenderer.invoke("markets:account"),
  getPositions:()=>ipcRenderer.invoke("markets:positions"),
  openExternal:(url)=>ipcRenderer.invoke("shell:open",url),

  mt5: {
    testLogin: (profile:Mt5Profile)=>ipcRenderer.invoke("mt5:test-login",profile),
    login: (profile:Mt5Profile)=>ipcRenderer.invoke("mt5:login",profile),
    logout: ()=>ipcRenderer.invoke("mt5:logout"),
    getProfiles: ()=>ipcRenderer.invoke("mt5:profiles","list"),
    saveProfile: (profile:Mt5Profile)=>ipcRenderer.invoke("mt5:profiles","save",profile),
    deleteProfile: (name:string)=>ipcRenderer.invoke("mt5:profiles","delete",{name}),
    getStatus: ()=>ipcRenderer.invoke("mt5:status"),
    onStatus: (cb:(status:Mt5Status)=>void)=>{
      const listener=(_,status)=>cb(status);
      ipcRenderer.on("mt5:status",listener);
      return()=>ipcRenderer.off("mt5:status",listener);
    },
  },

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
