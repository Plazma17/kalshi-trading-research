// Run ONE backtest config and stream live status to running-status.json (which the
// app's RUNNING tab polls). Re-classifies with the shared analyst prompt; sized,
// market-neutral, chronological so the equity curve builds correctly.
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import { Ollama } from 'ollama'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import YahooFinance from 'yahoo-finance2'
import { SYSTEM } from './_system.mjs'

const yf = new YahooFinance()
try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const ollama = new Ollama({ host: 'http://localhost:11434' })
const here = dirname(fileURLToPath(import.meta.url))
const file = process.env.NT_CSV || join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const HORIZON = Number(process.env.NT_HORIZON || 3)
const MINCONF = Number(process.env.NT_CONF || 0.7)
const SIZE = Number(process.env.NT_SIZE || 2)
const LABEL = process.env.NT_LABEL || `FNSPID sector strategy (h${HORIZON} conf${MINCONF} size${SIZE}%)`
const STATUS = join(process.env.APPDATA, 'news-trader-app', 'default-workspace', 'running-status.json')

const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }

function readCsv() {
  return new Promise((res, rej) => {
    const out = []
    Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString() }) }, complete: () => res(out), error: rej })
  })
}
async function classify(h) {
  const r = await ollama.chat({ model: 'qwen2.5:14b', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: h }], format: zodToJsonSchema(Lean, { $refStrategy: 'none' }), options: { temperature: 0 }, keep_alive: '30m' })
  return Lean.parse(JSON.parse(r.message.content)).signals
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2013-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null && q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] }
}

const f = SIZE / 100
const INITIAL = 10000
let eq = 1, mneq = 1, trades = 0, correct = 0
const equity = [], feed = []
let lastWrite = 0
function write(phase, message, fraction, force) {
  const t = Date.now()
  if (!force && t - lastWrite < 400) return
  lastWrite = t
  const acc = trades ? correct / trades : 0, pnl = (eq - 1) * 100, mn = (mneq - 1) * 100
  const bignums = [
    { label: 'DIRECTIONAL ACCURACY', value: `${(acc * 100).toFixed(1)}%` },
    { label: 'P&L (SIZED)', value: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`, tone: pnl >= 0 ? 'ok' : 'bad' },
    { label: 'MARKET-NEUTRAL', value: `${mn >= 0 ? '+' : ''}${mn.toFixed(1)}%`, tone: mn >= 0 ? 'ok' : 'bad' },
    { label: 'TRADES', value: trades.toLocaleString() }
  ]
  writeFileSync(STATUS, JSON.stringify({
    active: phase !== 'done' && phase !== 'error', label: LABEL, kind: 'backtest', phase, message, fraction,
    trades, accuracy: acc, pnlPct: pnl, marketNeutralPct: mn, bignums, chartLabel: 'NET WORTH OVER TIME (sized)',
    equity: equity.length <= 300 ? equity : equity.filter((_, k) => k % Math.ceil(equity.length / 300) === 0), initialNetWorth: INITIAL, feed: feed.slice(0, 40), startedAt, updatedAt: new Date().toISOString()
  }))
}
const startedAt = new Date().toISOString()

write('loading', 'Loading headlines + prices…', 0, true)
const articles = (await readCsv()).sort((a, b) => (a.date < b.date ? -1 : 1)) // chronological
const phash = createHash('md5').update(SYSTEM).digest('hex').slice(0, 8)
const cacheFile = join(here, 'classified-cache.json')
let cache = {}
if (existsSync(cacheFile)) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')) } catch {} }

const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)
const spy = bars['SPY'] || []

let cacheDirty = 0
for (let i = 0; i < articles.length; i++) {
  const a = articles[i]
  const key = phash + '|' + a.headline
  if (!cache[key]) {
    write('classifying', `Classifying ${i + 1}/${articles.length}: ${a.headline.slice(0, 60)}`, i / articles.length)
    cache[key] = await classify(a.headline)
    if (++cacheDirty >= 20) { writeFileSync(cacheFile, JSON.stringify(cache)); cacheDirty = 0 }
  }
  const d = a.date.slice(0, 10)
  for (const s of cache[key]) {
    const conf = s.confidence_pct / 100
    if (conf < MINCONF) continue
    const sign = Math.sign(SCORE[s.direction]); if (sign === 0) continue
    const syms = MAP[s.topic.toLowerCase()]; if (!syms) continue
    for (const sym of syms) {
      const b = bars[sym]; if (!b || !b.length) continue
      const entryBar = b.find((x) => x.date > d); if (!entryBar) continue
      const idx = b.findIndex((x) => x.date >= entryBar.date)
      const exit = b[idx + HORIZON]; if (!exit) continue
      const fwd = (exit.close / entryBar.open - 1) * 100
      const si = spy.findIndex((x) => x.date >= entryBar.date)
      const se = spy[si], sx = spy[si + HORIZON]
      const sm = se && sx ? (sx.close / se.open - 1) * 100 : 0
      const pnl = sign * fwd - 0.1
      const ok = Math.sign(fwd) === sign
      eq *= 1 + f * (pnl / 100); mneq *= 1 + f * (sign * (fwd - sm) / 100)
      trades++; if (ok) correct++
      equity.push({ x: i / articles.length, v: INITIAL * eq })
      feed.unshift({ date: entryBar.date, topic: s.topic, direction: s.direction, symbol: sym, fwd, correct: ok })
      write('scoring', `Scoring ${i + 1}/${articles.length}…`, i / articles.length)
    }
  }
}
if (cacheDirty) writeFileSync(cacheFile, JSON.stringify(cache))
write('done', `Done — ${trades} trades, accuracy ${((100 * correct) / Math.max(trades, 1)).toFixed(0)}%`, 1, true)
console.log(`done: ${trades} trades, acc ${((100 * correct) / Math.max(trades, 1)).toFixed(0)}%, sized P&L ${((eq - 1) * 100).toFixed(1)}%, market-neutral ${((mneq - 1) * 100).toFixed(1)}%`)
