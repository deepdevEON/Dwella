const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  platform: process.platform,
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  // Dwella trading data persistence (trading/ folder)
  loadJournal: () => ipcRenderer.invoke('journal:load'),
  saveJournal: (entries) => ipcRenderer.invoke('journal:save', entries),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getDataPath: () => ipcRenderer.invoke('app:data-path'),

  // Fake Sleep: keep macOS awake while the display is explicitly off
  fakeSleepStart: () => ipcRenderer.invoke('fake-sleep:start'),
  fakeSleepAuthorize: () => ipcRenderer.invoke('fake-sleep:authorize'),
  fakeSleepRestore: () => ipcRenderer.invoke('fake-sleep:restore'),
  fakeSleepStop: () => ipcRenderer.invoke('fake-sleep:stop'),
  fakeSleepStatus: () => ipcRenderer.invoke('fake-sleep:status'),

  // TradingView connection status
  tvStatus: () => ipcRenderer.invoke('tv:status'),
  onTvStatus: (cb) => ipcRenderer.on('tv:status', (_e, data) => cb(data)),
});
