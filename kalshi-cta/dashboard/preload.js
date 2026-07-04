const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('cta', {
  onState: (cb) => ipcRenderer.on('state', (_e, data) => cb(data)),
  onHistory: (cb) => ipcRenderer.on('history', (_e, data) => cb(data)),
  onStreams: (cb) => ipcRenderer.on('streams', (_e, data) => cb(data)),
  getHistory: () => ipcRenderer.invoke('get-history'),
  getWindowStreams: (t0) => ipcRenderer.invoke('get-window-streams', t0),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  saveLabel: (label) => ipcRenderer.send('save-label', label),
  delLabel: (ts) => ipcRenderer.send('del-label', ts),
  excludeLabel: (ts) => ipcRenderer.send('exclude-label', ts),
  flipLabel: (ts) => ipcRenderer.send('flip-label', ts),
  getViz: () => ipcRenderer.invoke('get-viz'),
  getAnnotations: () => ipcRenderer.invoke('get-annotations'),
  saveWaveLabel: (o) => ipcRenderer.send('save-wave-label', o),
  saveOracleLabel: (o) => ipcRenderer.send('save-oracle-label', o),
  saveWaveSet: (arr) => ipcRenderer.send('save-wave-set', arr),
  saveOracleSet: (arr) => ipcRenderer.send('save-oracle-set', arr),
  scan: (q) => ipcRenderer.invoke('scan', q),
  scanEngine: () => ipcRenderer.invoke('scan-engine'),
  onScanProgress: (cb) => ipcRenderer.on('scan-progress', (_e, data) => cb(data)),
  rAvailable: () => ipcRenderer.invoke('r-available'),
  rAnalyze: (req) => ipcRenderer.invoke('r-analyze', req)
})
