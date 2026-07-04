/// <reference types="vite/client" />
import type {
  Classification,
  Settings,
  WorkspaceManifest,
  Topic,
  StockTopicMapping,
  Feedback,
  FeedbackStats,
  Article,
  DatasetRef,
  ColumnMapping,
  BacktestParams,
  BacktestRun,
  BacktestSignalRow,
  InstructionSet
} from '@shared/schema'

export interface DatasetPeek {
  path: string
  headers: string[]
  rows: Record<string, string>[]
}

export interface BacktestTick {
  topic: string
  direction: string
  symbol: string
  forwardReturnPct: number
  correct: boolean
  entryDate: string
}

export interface RunStatus {
  active: boolean
  label: string
  phase: string
  message: string
  fraction: number
  trades: number
  accuracy: number
  pnlPct: number
  marketNeutralPct: number
  initialNetWorth?: number
  kind?: string
  bignums?: { label: string; value: string; tone?: 'ok' | 'bad' }[]
  chartLabel?: string
  equity: { x: number; v: number }[]
  feed: { date: string; topic: string; direction: string; symbol: string; fwd: number; correct: boolean }[]
  startedAt: string
  updatedAt: string
}

export interface BacktestProgress {
  phase: string
  message: string
  done: number
  total: number
  fraction: number
  running?: {
    trades: number
    accuracy: number
    pnlPct: number
    newRows: BacktestTick[]
  }
}

export interface WorkspaceState {
  dir: string
  manifest: WorkspaceManifest
  settings: Settings
}

export interface ClassifyMetrics {
  tokensPerSec: number
  evalCount: number
  promptEvalCount: number
  totalDurationMs: number
  loadDurationMs: number
}

export interface ClassifyResult {
  classification: Classification
  latencyMs: number
  model: string
  metrics: ClassifyMetrics
}

export interface GpuStats {
  ok: boolean
  name?: string
  utilization?: number
  memUsedMb?: number
  memTotalMb?: number
  tempC?: number
  powerW?: number
  error?: string
}

export type ClassifyPhase = 'connecting' | 'loading' | 'generating' | 'parsing' | 'done' | 'error'

export interface ClassifyProgress {
  phase: ClassifyPhase
  message: string
  tokens: number
  fraction: number
}

export interface NewsTraderApi {
  ollamaStatus: () => Promise<{ ok: boolean; models: string[]; host: string; error?: string }>
  classifyArticle: (text: string, explain?: boolean) => Promise<ClassifyResult>
  settingsGet: () => Promise<Settings>
  settingsUpdate: (partial: Partial<Settings>) => Promise<Settings>
  workspaceCurrent: () => Promise<WorkspaceState>
  workspaceCreate: () => Promise<WorkspaceState | null>
  workspaceOpen: () => Promise<WorkspaceState | null>
  workspaceExport: () => Promise<string | null>
  workspaceImport: () => Promise<WorkspaceState | null>
  topicsList: () => Promise<Topic[]>
  mappingsList: () => Promise<StockTopicMapping[]>
  topicSave: (t: Partial<Topic>) => Promise<Topic>
  topicDelete: (id: string) => Promise<void>
  mappingsSetForTopic: (topicId: string, symbols: string[]) => Promise<StockTopicMapping[]>
  tickerValidate: (raw: string) => Promise<{ ok: boolean; symbol?: string; error?: string }>
  feedbackSave: (fb: Omit<Feedback, 'id' | 'createdAt'>) => Promise<Feedback>
  feedbackList: () => Promise<Feedback[]>
  feedbackStats: () => Promise<FeedbackStats>
  dataPickAndPeek: () => Promise<DatasetPeek | null>
  dataImport: (
    path: string,
    mapping: ColumnMapping,
    name: string,
    source: string
  ) => Promise<DatasetRef>
  dataList: () => Promise<DatasetRef[]>
  dataSample: (datasetId: string, n: number) => Promise<Article[]>
  dataMissing: () => Promise<string[]>
  dataRelocate: (id: string) => Promise<DatasetRef[] | null>
  backtestRun: (params: BacktestParams) => Promise<BacktestRun>
  backtestList: () => Promise<BacktestRun[]>
  backtestSignalRows: (id: string) => Promise<BacktestSignalRow[]>
  onBacktestProgress: (cb: (p: BacktestProgress) => void) => () => void
  promptGet: () => Promise<{ systemPrompt: string; activeInstructionSetId: string; defaultPrompt: string }>
  promptSave: (s: string) => Promise<Settings>
  promptCompiled: () => Promise<{ system: string; fewShotCount: number }>
  tuningCompile: () => Promise<InstructionSet>
  tuningList: () => Promise<InstructionSet[]>
  tuningActivate: (id: string) => Promise<void>
  runStatusGet: () => Promise<RunStatus | null>
  onGpuStats: (cb: (s: GpuStats) => void) => () => void
  onClassifyProgress: (cb: (p: ClassifyProgress) => void) => () => void
}

declare global {
  interface Window {
    api: NewsTraderApi
  }
}
