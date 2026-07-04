import { ipcMain, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { app } from 'electron'
import { classify, ollamaStatus } from './ollama'
import { getSettings } from './state'
import {
  deleteTopic,
  listMappings,
  listTopics,
  saveTopic,
  setMappingsForTopic,
  validateTicker
} from './topics'
import { feedbackStats, listFeedback, saveFeedback } from './feedback'
import {
  datasetMissing,
  importDataset,
  listDatasets,
  peekDataset,
  relocateDataset,
  sampleArticles
} from './data'
import { getSignalRows, listRuns, runBacktest } from './backtest'
import {
  activateInstructionSet,
  compileInstructionSet,
  getActivePromptParts,
  listInstructionSets
} from './tuning'
import { SYSTEM } from '@shared/schema'
import { readJsonFile } from './files'
import type { BacktestParams, ColumnMapping, Feedback, Topic } from '@shared/schema'
import {
  createWorkspace,
  exportWorkspace,
  getOrInitCurrentWorkspace,
  importWorkspace,
  openWorkspace,
  updateSettings,
  type WorkspaceState
} from './workspace'
import type { Settings } from '@shared/schema'

/** Register all main-process IPC handlers. The renderer reaches these via window.api. */
export function registerIpc(): void {
  // ── Ollama / classify ──────────────────────────────────────────────────────
  ipcMain.handle('ollama:status', () => ollamaStatus())
  ipcMain.handle('classify:article', (e, text: string, explain?: boolean) =>
    classify(text, (p) => e.sender.send('classify:progress', p), { explain: !!explain })
  )

  // ── settings ───────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', async (e, partial: Partial<Settings>) => {
    const next = await updateSettings(partial)
    // Apply zoom live so the slider/field updates the window immediately.
    BrowserWindow.fromWebContents(e.sender)?.webContents.setZoomFactor(next.zoom)
    return next
  })

  // ── topics & stock mappings ──────────────────────────────────────────────────
  ipcMain.handle('topics:list', () => listTopics())
  ipcMain.handle('mappings:list', () => listMappings())
  ipcMain.handle('topics:save', (_e, t: Partial<Topic>) => saveTopic(t))
  ipcMain.handle('topics:delete', (_e, id: string) => deleteTopic(id))
  ipcMain.handle('mappings:setForTopic', (_e, topicId: string, symbols: string[]) =>
    setMappingsForTopic(topicId, symbols)
  )
  ipcMain.handle('tickers:validate', (_e, raw: string) => validateTicker(raw))

  // ── feedback (human labels) ──────────────────────────────────────────────────
  ipcMain.handle('feedback:save', (_e, fb: Omit<Feedback, 'id' | 'createdAt'>) => saveFeedback(fb))
  ipcMain.handle('feedback:list', () => listFeedback())
  ipcMain.handle('feedback:stats', () => feedbackStats())

  // ── workspace ──────────────────────────────────────────────────────────────
  ipcMain.handle('workspace:current', () => getOrInitCurrentWorkspace())

  ipcMain.handle('workspace:create', async (e): Promise<WorkspaceState | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose an (empty) folder for the new workspace',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return createWorkspace(r.filePaths[0], '')
  })

  ipcMain.handle('workspace:open', async (e): Promise<WorkspaceState | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open a workspace folder',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return openWorkspace(r.filePaths[0])
  })

  ipcMain.handle('workspace:export', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export workspace as zip',
      defaultPath: 'news-trader-workspace.zip',
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePath) return null
    await exportWorkspace(r.filePath)
    return r.filePath
  })

  ipcMain.handle('workspace:import', async (e): Promise<WorkspaceState | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const pick = await dialog.showOpenDialog(win!, {
      title: 'Choose a workspace zip to import',
      filters: [{ name: 'Zip', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (pick.canceled || !pick.filePaths[0]) return null
    const dest = join(app.getPath('documents'), `news-trader-${Date.now()}`)
    return importWorkspace(pick.filePaths[0], dest)
  })

  // ── datasets (news import) ───────────────────────────────────────────────────
  ipcMain.handle('data:pickAndPeek', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const pick = await dialog.showOpenDialog(win!, {
      title: 'Choose a news CSV (must have headline + date columns)',
      filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }],
      properties: ['openFile']
    })
    if (pick.canceled || !pick.filePaths[0]) return null
    const path = pick.filePaths[0]
    const peek = await peekDataset(path)
    return { path, ...peek }
  })
  ipcMain.handle(
    'data:import',
    (_e, path: string, mapping: ColumnMapping, name: string, source: string) =>
      importDataset(path, mapping, name, source)
  )
  ipcMain.handle('data:list', () => listDatasets())
  ipcMain.handle('data:sample', (_e, datasetId: string, n: number) => sampleArticles(datasetId, n))
  ipcMain.handle('data:missing', () => datasetMissing())
  ipcMain.handle('data:relocate', async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const pick = await dialog.showOpenDialog(win!, {
      title: 'Locate the dataset CSV on this machine',
      filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }],
      properties: ['openFile']
    })
    if (pick.canceled || !pick.filePaths[0]) return null
    return relocateDataset(id, pick.filePaths[0])
  })

  // ── backtest ─────────────────────────────────────────────────────────────────
  ipcMain.handle('backtest:run', (e, params: BacktestParams) =>
    runBacktest(params, (p) => e.sender.send('backtest:progress', p))
  )
  ipcMain.handle('backtest:list', () => listRuns())
  ipcMain.handle('backtest:signalRows', (_e, id: string) => getSignalRows(id))

  // Live status of whatever run (incl. assistant-launched analyses) is writing it.
  ipcMain.handle('runStatus:get', () => readJsonFile('running-status.json', null))

  // ── prompt + tuning (instruction set) ────────────────────────────────────────
  ipcMain.handle('prompt:get', () => ({
    systemPrompt: getSettings().systemPrompt,
    activeInstructionSetId: getSettings().activeInstructionSetId,
    defaultPrompt: SYSTEM
  }))
  ipcMain.handle('prompt:save', (_e, systemPrompt: string) => updateSettings({ systemPrompt }))
  ipcMain.handle('prompt:compiled', async () => {
    const p = await getActivePromptParts(false)
    return { system: p.system, fewShotCount: p.fewShot.length / 2 }
  })
  ipcMain.handle('tuning:compile', () => compileInstructionSet())
  ipcMain.handle('tuning:list', () => listInstructionSets())
  ipcMain.handle('tuning:activate', (_e, id: string) => activateInstructionSet(id))
}
