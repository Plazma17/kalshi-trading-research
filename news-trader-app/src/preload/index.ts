import { contextBridge, ipcRenderer } from 'electron'

/** The ONLY surface the renderer can touch. Mirrors the IPC handlers in main/ipc.ts. */
const api = {
  // Ollama / classify
  ollamaStatus: () => ipcRenderer.invoke('ollama:status'),
  classifyArticle: (text: string, explain?: boolean) =>
    ipcRenderer.invoke('classify:article', text, explain),

  // settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsUpdate: (partial: unknown) => ipcRenderer.invoke('settings:update', partial),

  // workspace
  workspaceCurrent: () => ipcRenderer.invoke('workspace:current'),
  workspaceCreate: () => ipcRenderer.invoke('workspace:create'),
  workspaceOpen: () => ipcRenderer.invoke('workspace:open'),
  workspaceExport: () => ipcRenderer.invoke('workspace:export'),
  workspaceImport: () => ipcRenderer.invoke('workspace:import'),

  // topics & stock mappings
  topicsList: () => ipcRenderer.invoke('topics:list'),
  mappingsList: () => ipcRenderer.invoke('mappings:list'),
  topicSave: (t: unknown) => ipcRenderer.invoke('topics:save', t),
  topicDelete: (id: string) => ipcRenderer.invoke('topics:delete', id),
  mappingsSetForTopic: (topicId: string, symbols: string[]) =>
    ipcRenderer.invoke('mappings:setForTopic', topicId, symbols),
  tickerValidate: (raw: string) => ipcRenderer.invoke('tickers:validate', raw),

  // feedback (human labels)
  feedbackSave: (fb: unknown) => ipcRenderer.invoke('feedback:save', fb),
  feedbackList: () => ipcRenderer.invoke('feedback:list'),
  feedbackStats: () => ipcRenderer.invoke('feedback:stats'),

  // datasets (news import)
  dataPickAndPeek: () => ipcRenderer.invoke('data:pickAndPeek'),
  dataImport: (path: string, mapping: unknown, name: string, source: string) =>
    ipcRenderer.invoke('data:import', path, mapping, name, source),
  dataList: () => ipcRenderer.invoke('data:list'),
  dataSample: (datasetId: string, n: number) => ipcRenderer.invoke('data:sample', datasetId, n),
  dataMissing: () => ipcRenderer.invoke('data:missing'),
  dataRelocate: (id: string) => ipcRenderer.invoke('data:relocate', id),

  // backtest
  backtestRun: (params: unknown) => ipcRenderer.invoke('backtest:run', params),
  backtestList: () => ipcRenderer.invoke('backtest:list'),
  backtestSignalRows: (id: string) => ipcRenderer.invoke('backtest:signalRows', id),
  onBacktestProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('backtest:progress', listener)
    return () => ipcRenderer.removeListener('backtest:progress', listener)
  },

  // prompt + tuning
  promptGet: () => ipcRenderer.invoke('prompt:get'),
  promptSave: (s: string) => ipcRenderer.invoke('prompt:save', s),
  promptCompiled: () => ipcRenderer.invoke('prompt:compiled'),
  tuningCompile: () => ipcRenderer.invoke('tuning:compile'),
  tuningList: () => ipcRenderer.invoke('tuning:list'),
  tuningActivate: (id: string) => ipcRenderer.invoke('tuning:activate', id),

  // live run status (for the RUNNING tab)
  runStatusGet: () => ipcRenderer.invoke('runStatus:get'),

  // live streams
  onGpuStats: (cb: (s: unknown) => void) => {
    const listener = (_e: unknown, s: unknown): void => cb(s)
    ipcRenderer.on('stats:gpu', listener)
    return () => ipcRenderer.removeListener('stats:gpu', listener)
  },
  onClassifyProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('classify:progress', listener)
    return () => ipcRenderer.removeListener('classify:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
