const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paperbookNative', {
  platform: 'desktop',
  oauth: {
    login: (cfg) => ipcRenderer.invoke('oauth:login', cfg),
    token: (cfg) => ipcRenderer.invoke('oauth:token', cfg),
    logout: () => ipcRenderer.invoke('oauth:logout'),
  },
  fetch: (url) => ipcRenderer.invoke('net:fetch', url),
  takeOpenFiles: () => ipcRenderer.invoke('files:take'),
  onOpenFiles: (cb) => ipcRenderer.on('files:ready', () => cb()),
});
