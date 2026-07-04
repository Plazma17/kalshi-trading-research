// Build a supervised fine-tuning dataset from REAL reactions: each headline ->
// what the stock ACTUALLY did over the next 3 days, in the model's output format.
// Teaches the model the empirical mapping (incl. materiality: small move => no signal).
import { createReadStream, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import YahooFinance from 'yahoo-finance2'
import { SYSTEM } from './_system.mjs'

const yf = new YahooFinance()
try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const OUT = join(here, 'train-data.jsonl')

const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t
const HORIZON = 3

function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => out.push(r.data), complete: () => res(out), error: rej }) })
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2009-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null && q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] }
}
// map the ACTUAL N-day return to the 5-level direction + an honesty-calibrated confidence.
function label(r) {
  if (r > 3) return ['bull', Math.min(92, 70 + Math.round(r))]
  if (r > 0.7) return ['up', 62]
  if (r >= -0.7) return ['neutral', 0]
  if (r >= -3) return ['down', 62]
  return ['bear', Math.min(92, 70 + Math.round(-r))]
}

const rows = (await readCsv()).sort((a, b) => new Date(a.date) - new Date(b.date))
// chronological 70/30 split: train on the first 70%, hold out the last 30% for honest
// walk-forward validation (the trained model must never have seen the test period).
const cutoff = rows[Math.floor(rows.length * 0.7)].date
console.log(`train/test cutoff date: ${cutoff.slice(0, 10)} (train = before, validate = after)`)
const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)

const out = []
const dist = { bull: 0, up: 0, neutral: 0, down: 0, bear: 0 }
const spy = bars['SPY']
for (const row of rows) {
  if (new Date(row.date) > new Date(cutoff)) continue // hold out the last 30%
  const T = (row.ticker || '').trim().toUpperCase()
  const sector = REV[T]; if (!sector) continue
  const b = bars[T]; if (!b || !b.length) continue
  const d = new Date(row.date).toISOString().slice(0, 10)
  const entry = b.find((x) => x.date > d); if (!entry) continue
  const idx = b.findIndex((x) => x.date >= entry.date)
  const exit = b[idx + HORIZON]; if (!exit) continue
  const ret = (exit.close / entry.open - 1) * 100
  // MARKET-NEUTRAL label: excess return vs SPY over the same window. Strips the bull-market
  // beta that made absolute-return labels collapse to "up" (the v1 long-bias). Now "up" means
  // the stock BEAT the market on the news, "down" means it lagged -> balanced, news-conditional.
  const sIdx = spy.findIndex((x) => x.date >= entry.date)
  const sEntry = spy[sIdx], sExit = spy[sIdx + HORIZON]
  if (!sEntry || !sExit) continue
  const excess = ret - (sExit.close / sEntry.open - 1) * 100
  const [dir, conf] = label(excess)
  // materiality: a small (neutral) excess move => the correct output is NO signal
  const signals = dir === 'neutral' ? [] : [{ topic: sector, direction: dir, confidence_pct: conf }]
  dist[dir]++
  out.push({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: row.headline }, { role: 'assistant', content: JSON.stringify({ signals }) }] })
}

writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join('\n'))
console.log(`wrote ${out.length} training examples to ${OUT}`)
console.log(`  label distribution: ${JSON.stringify(dist)}`)
console.log(`  ${out.length - dist.neutral} with a signal, ${dist.neutral} neutral; LONG(up+bull)=${dist.up + dist.bull} SHORT(down+bear)=${dist.down + dist.bear}`)
