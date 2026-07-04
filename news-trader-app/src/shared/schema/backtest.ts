/**
 * Backtest entities. A run replays dataset headlines through the classifier,
 * expands each signal's topic to its tickers, and scores the predicted direction
 * against the ACTUAL forward price move — the honest test of whether there's edge.
 */
import { z } from 'zod'
import { Direction } from './common'

export const EntryRule = z.enum(['next_open', 'same_close'])
export type EntryRule = z.infer<typeof EntryRule>

export const BacktestParamsSchema = z.object({
  datasetId: z.string(),
  dateFrom: z.string().default(''),
  dateTo: z.string().default(''),
  horizonDays: z.number().int().min(1).max(60).default(3),
  entryRule: EntryRule.default('next_open'),
  minConfidence: z.number().min(0).max(1).default(0.7),
  includeNeutral: z.boolean().default(false),
  transactionCostBps: z.number().min(0).max(200).default(5),
  maxArticles: z.number().int().min(1).max(100000).default(200),
  // Benchmark for market-neutral (excess) returns; '' disables it.
  benchmarkSymbol: z.string().default('SPY'),
  // Risk: fraction of equity per trade. Returns compound, so this caps per-trade
  // impact and drawdowns (2% ≈ conservative). The old "sum of % returns" = 100%.
  positionSizePct: z.number().min(0.1).max(100).default(2)
})
export type BacktestParams = z.infer<typeof BacktestParamsSchema>

export const BacktestSignalRowSchema = z.object({
  topic: z.string(),
  direction: Direction,
  confidence: z.number(),
  symbol: z.string(),
  publishedAt: z.string(),
  entryDate: z.string(),
  entryPrice: z.number(),
  exitDate: z.string(),
  exitPrice: z.number(),
  forwardReturnPct: z.number(),
  expectedSign: z.number(), // +1 bullish, -1 bearish
  correct: z.boolean(),
  pnlPct: z.number(),
  excessPct: z.number().default(0), // market-neutral: return vs benchmark over same window
  confidenceBucket: z.string()
})
export type BacktestSignalRow = z.infer<typeof BacktestSignalRowSchema>

export const BacktestMetricsSchema = z.object({
  directionalAccuracy: z.number(),
  accuracyByTopic: z.record(z.number()),
  accuracyByConfidenceBucket: z.record(z.number()),
  countByConfidenceBucket: z.record(z.number()),
  coverage: z.number(), // scored / attempted signals (missing prices excluded)
  simulatedPnlPct: z.number(),
  marketNeutralPnlPct: z.number().default(0), // excess vs benchmark — the honest edge metric
  winRate: z.number(),
  tradeCount: z.number(),
  equityCurve: z.array(z.object({ date: z.string(), cum: z.number() }))
})
export type BacktestMetrics = z.infer<typeof BacktestMetricsSchema>

export const BacktestRunSchema = z.object({
  id: z.string(),
  params: BacktestParamsSchema,
  status: z.enum(['running', 'done', 'error']),
  startedAt: z.string(),
  finishedAt: z.string().default(''),
  counts: z.object({
    articles: z.number(),
    signals: z.number(),
    scoredSignals: z.number()
  }),
  metrics: BacktestMetricsSchema.nullable(),
  errorMessage: z.string().default('')
})
export type BacktestRun = z.infer<typeof BacktestRunSchema>
