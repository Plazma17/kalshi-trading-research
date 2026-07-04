import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  BacktestParamsSchema,
  BacktestRunSchema,
  DIRECTION_SCORE,
  type BacktestParams,
  type BacktestRun,
  type BacktestSignalRow
} from '@shared/schema'
import { getWorkspaceDir } from './state'
import { collectArticles } from './data'
import { listMappings, listTopics } from './topics'
import { classify } from './ollama'
import { barAfterHorizon, getBars, nextBar, barOnOrAfter } from './prices'

export interface BacktestTick {
  topic: string
  direction: string
  symbol: string
  forwardReturnPct: number
  correct: boolean
  entryDate: string
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

function bucket(c: number): string {
  if (c < 0.6) return '0.5-0.6'
  if (c < 0.7) return '0.6-0.7'
  if (c < 0.8) return '0.7-0.8'
  return '0.8-1.0'
}

function backtestsDir(): string {
  return join(getWorkspaceDir(), 'backtests')
}

/** Run a backtest end-to-end, streaming progress, and persist the run + signal rows. */
export async function runBacktest(
  rawParams: BacktestParams,
  onProgress?: (p: BacktestProgress) => void
): Promise<BacktestRun> {
  const params = BacktestParamsSchema.parse(rawParams)
  const id = randomUUID()
  const startedAt = new Date().toISOString()
  const report = (
    phase: string,
    message: string,
    done = 0,
    total = 1,
    running?: BacktestProgress['running']
  ): void =>
    onProgress?.({ phase, message, done, total, fraction: total ? done / total : 0, running })

  try {
    report('loading', 'Loading topic→ticker map…')
    const [topics, mappings] = await Promise.all([listTopics(), listMappings()])
    // label -> symbols
    const labelToSymbols = new Map<string, string[]>()
    for (const t of topics) {
      const syms = mappings.filter((m) => m.topicId === t.id).map((m) => m.symbol)
      labelToSymbols.set(t.label.toLowerCase(), syms)
    }

    report('loading', 'Collecting headlines…')
    const articles = await collectArticles(params.datasetId, {
      from: params.dateFrom,
      to: params.dateTo,
      limit: params.maxArticles
    })
    if (articles.length === 0) {
      throw new Error('no articles in range — check the dataset and date range')
    }

    // Price window covering all entries + horizon slack.
    const dates = articles.map((a) => a.publishedAt.slice(0, 10)).sort()
    const globalFrom = dates[0]
    const toDate = new Date(dates[dates.length - 1])
    toDate.setDate(toDate.getDate() + params.horizonDays * 3 + 10)
    const globalTo = toDate.toISOString().slice(0, 10)

    const benchBars = params.benchmarkSymbol
      ? await getBars(params.benchmarkSymbol, globalFrom, globalTo)
      : []
    const rows: BacktestSignalRow[] = []
    let signalsTotal = 0
    let attempted = 0
    const f = params.positionSizePct / 100 // fraction of equity risked per trade
    let runCorrect = 0
    let runEq = 1
    let sumExcess = 0

    for (let i = 0; i < articles.length; i++) {
      const a = articles[i]
      report(
        'classifying',
        `Classifying ${i + 1}/${articles.length}: ${a.headline.slice(0, 70)}`,
        i,
        articles.length,
        { trades: rows.length, accuracy: rows.length ? runCorrect / rows.length : 0, pnlPct: (runEq - 1) * 100, newRows: [] }
      )
      const { classification } = await classify(a.headline, undefined, { explain: false })

      for (const s of classification.signals) {
        signalsTotal++
        if (s.confidence < params.minConfidence) continue
        const expectedSign = Math.sign(DIRECTION_SCORE[s.direction])
        if (expectedSign === 0 && !params.includeNeutral) continue
        const symbols = labelToSymbols.get(s.topic.toLowerCase())
        if (!symbols || symbols.length === 0) continue

        for (const symbol of symbols) {
          attempted++
          const bars = await getBars(symbol, globalFrom, globalTo)
          if (bars.length === 0) continue
          const entry =
            params.entryRule === 'next_open'
              ? nextBar(bars, a.publishedAt)
              : barOnOrAfter(bars, a.publishedAt)
          if (!entry) continue
          const exit = barAfterHorizon(bars, entry.date, params.horizonDays)
          if (!exit) continue

          const entryPrice = params.entryRule === 'next_open' ? entry.open : entry.close
          const exitPrice = exit.close
          if (!entryPrice) continue
          const fwd = (exitPrice / entryPrice - 1) * 100
          const correct = Math.sign(fwd) === expectedSign
          const pnl = expectedSign * fwd - (2 * params.transactionCostBps) / 100

          // Market-neutral excess: trade return minus the benchmark over the same window.
          let excessPct = 0
          if (benchBars.length) {
            const bi = benchBars.findIndex((x) => x.date >= entry.date)
            const be = benchBars[bi]
            const bx = benchBars[bi + params.horizonDays]
            if (be && bx) {
              const benchEntry = params.entryRule === 'next_open' ? be.open : be.close
              const benchMove = benchEntry ? (bx.close / benchEntry - 1) * 100 : 0
              excessPct = expectedSign * (fwd - benchMove)
            }
          }
          sumExcess += excessPct

          rows.push({
            topic: s.topic,
            direction: s.direction,
            confidence: s.confidence,
            symbol,
            publishedAt: a.publishedAt,
            entryDate: entry.date,
            entryPrice,
            exitDate: exit.date,
            exitPrice,
            forwardReturnPct: fwd,
            expectedSign,
            correct,
            pnlPct: pnl,
            excessPct,
            confidenceBucket: bucket(s.confidence)
          })

          // Stream each scored trade immediately for the live feed.
          runCorrect += correct ? 1 : 0
          runEq *= 1 + f * (pnl / 100)
          report('scoring', `Scoring ${i + 1}/${articles.length}…`, i, articles.length, {
            trades: rows.length,
            accuracy: runCorrect / rows.length,
            pnlPct: (runEq - 1) * 100,
            newRows: [
              {
                topic: s.topic,
                direction: s.direction,
                symbol,
                forwardReturnPct: fwd,
                correct,
                entryDate: entry.date
              }
            ]
          })
        }
      }
    }

    report('aggregating', 'Computing metrics…', articles.length, articles.length)
    const scored = rows.length
    const correctCount = rows.filter((r) => r.correct).length

    const byTopic: Record<string, number> = {}
    const topicTotals: Record<string, number> = {}
    const byBucket: Record<string, number> = {}
    const bucketTotals: Record<string, number> = {}
    for (const r of rows) {
      topicTotals[r.topic] = (topicTotals[r.topic] ?? 0) + 1
      if (r.correct) byTopic[r.topic] = (byTopic[r.topic] ?? 0) + 1
      bucketTotals[r.confidenceBucket] = (bucketTotals[r.confidenceBucket] ?? 0) + 1
      if (r.correct) byBucket[r.confidenceBucket] = (byBucket[r.confidenceBucket] ?? 0) + 1
    }
    const accuracyByTopic: Record<string, number> = {}
    for (const t in topicTotals) accuracyByTopic[t] = (byTopic[t] ?? 0) / topicTotals[t]
    const accuracyByConfidenceBucket: Record<string, number> = {}
    for (const b in bucketTotals)
      accuracyByConfidenceBucket[b] = (byBucket[b] ?? 0) / bucketTotals[b]

    // Compound each trade at the position-size fraction, chronologically (bounded
    // per-trade impact + realistic drawdowns), for both the strategy and the
    // market-neutral (excess) book.
    const equityRows = [...rows].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1))
    let eq = 1
    let mneq = 1
    const equityCurve = equityRows.map((r) => {
      eq *= 1 + f * (r.pnlPct / 100)
      mneq *= 1 + f * (r.excessPct / 100)
      return { date: r.entryDate, cum: (eq - 1) * 100 }
    })
    const wins = rows.filter((r) => r.pnlPct > 0).length

    const run: BacktestRun = BacktestRunSchema.parse({
      id,
      params,
      status: 'done',
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: { articles: articles.length, signals: signalsTotal, scoredSignals: scored },
      metrics: {
        directionalAccuracy: scored ? correctCount / scored : 0,
        accuracyByTopic,
        accuracyByConfidenceBucket,
        countByConfidenceBucket: bucketTotals,
        coverage: attempted ? scored / attempted : 0,
        simulatedPnlPct: (eq - 1) * 100,
        marketNeutralPnlPct: (mneq - 1) * 100,
        winRate: scored ? wins / scored : 0,
        tradeCount: scored,
        equityCurve
      },
      errorMessage: ''
    })

    await fs.mkdir(backtestsDir(), { recursive: true })
    await fs.writeFile(join(backtestsDir(), `${id}.json`), JSON.stringify(run, null, 2), 'utf8')
    await fs.writeFile(
      join(backtestsDir(), `${id}.signals.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n'),
      'utf8'
    )
    report('done', 'Done', articles.length, articles.length)
    return run
  } catch (e) {
    const run: BacktestRun = BacktestRunSchema.parse({
      id,
      params,
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      counts: { articles: 0, signals: 0, scoredSignals: 0 },
      metrics: null,
      errorMessage: String(e)
    })
    report('error', String(e), 1, 1)
    return run
  }
}

export async function listRuns(): Promise<BacktestRun[]> {
  try {
    const files = await fs.readdir(backtestsDir())
    const runs: BacktestRun[] = []
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.signals.jsonl')) continue
      try {
        const r = BacktestRunSchema.parse(
          JSON.parse(await fs.readFile(join(backtestsDir(), f), 'utf8'))
        )
        runs.push(r)
      } catch {
        /* skip malformed */
      }
    }
    return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  } catch {
    return []
  }
}

export async function getSignalRows(id: string): Promise<BacktestSignalRow[]> {
  try {
    const txt = await fs.readFile(join(backtestsDir(), `${id}.signals.jsonl`), 'utf8')
    return txt
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as BacktestSignalRow)
  } catch {
    return []
  }
}
