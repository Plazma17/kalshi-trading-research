// Robustness test: score every parameter set across 64 RANDOM time windows of
// varying length. A set that's only profitable in some windows is overfit; we
// want sets profitable across (nearly) all. Reuses cached classifications.
import { createReadStream, readFileSync, existsSync } from 'fs'
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

// load cached classifications (from tune.mjs run)
const phash = createHash('md5').update(SYSTEM).digest('hex').slice(0, 8)
let cache = {}
const cacheFile = join(here, 'classified-cache.json')
if (existsSync(cacheFile)) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')) } catch {} }
const articles = await readCsv()
const classified = []
let missing = 0
for (const a of articles) {
  const key = phash + '|' + a.headline
  if (!cache[key]) { cache[key] = await classify(a.headline); missing++ }
  classified.push({ ...a, signals: cache[key] })
}
console.log(`loaded ${classified.length} classified headlines (${missing} freshly classified)`)

console.log('fetching prices…')
const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)
const spy = bars['SPY'] || []

// pre-expand all trades once (date, sign, conf, fwd@each horizon, excess@each horizon)
const HORIZONS = [1, 3, 5, 10]
const trades = []
for (const a of classified) {
  const d = a.date.slice(0, 10)
  for (const s of a.signals) {
    const sign = Math.sign(SCORE[s.direction]); if (sign === 0) continue
    const conf = s.confidence_pct / 100
    const syms = MAP[s.topic.toLowerCase()]; if (!syms) continue
    for (const sym of syms) {
      const b = bars[sym]; if (!b || !b.length) continue
      const entryBar = b.find((x) => x.date > d); if (!entryBar) continue
      const idx = b.findIndex((x) => x.date >= entryBar.date)
      const si = spy.findIndex((x) => x.date >= entryBar.date)
      const fwd = {}, exc = {}
      for (const H of HORIZONS) {
        const exit = b[idx + H]; const sx = spy[si + H], se = spy[si]
        if (exit) { const r = (exit.close / entryBar.open - 1) * 100; fwd[H] = r; const sm = se && sx ? (sx.close / se.open - 1) * 100 : 0; exc[H] = sign * (r - sm) }
      }
      trades.push({ date: entryBar.date, sign, conf, fwd, exc })
    }
  }
}
console.log(`expanded ${trades.length} candidate trades`)

// 64 random windows of varying length (60-400 days) within the data range
const ds = classified.map((a) => +new Date(a.date)).sort((a, b) => a - b)
const minD = ds[0], maxD = ds[ds.length - 1]
const DAY = 86400000
const windows = []
for (let i = 0; i < 64; i++) {
  const len = (60 + Math.floor(Math.random() * 340)) * DAY
  const start = minD + Math.floor(Math.random() * Math.max(1, maxD - minD - len))
  windows.push([new Date(start).toISOString().slice(0, 10), new Date(start + len).toISOString().slice(0, 10)])
}

function evalSet({ horizon, minConf, size }) {
  const f = size / 100
  const perWin = []
  for (const [w0, w1] of windows) {
    let eq = 1, mneq = 1, n = 0, c = 0
    const ts = trades.filter((t) => t.conf >= minConf && t.date >= w0 && t.date <= w1 && t.fwd[horizon] != null).sort((a, b) => (a.date < b.date ? -1 : 1))
    for (const t of ts) { const pnl = t.sign * t.fwd[horizon] - 0.1; eq *= 1 + f * (pnl / 100); mneq *= 1 + f * (t.exc[horizon] / 100); n++; if (Math.sign(t.fwd[horizon]) === t.sign) c++ }
    if (n >= 5) perWin.push({ mn: (mneq - 1) * 100, acc: c / n, n })
  }
  const mns = perWin.map((p) => p.mn).sort((a, b) => a - b)
  const profit = perWin.filter((p) => p.mn > 0).length
  const med = mns.length ? mns[Math.floor(mns.length / 2)] : 0
  const worst = mns.length ? mns[0] : 0
  const acc = perWin.reduce((s, p) => s + p.acc, 0) / (perWin.length || 1)
  return { wins: profit, total: perWin.length, pct: perWin.length ? profit / perWin.length : 0, med, worst, acc }
}

const grid = []
for (const horizon of HORIZONS) for (const minConf of [0.5, 0.6, 0.7]) for (const size of [2, 5, 10]) grid.push({ horizon, minConf, size })
const results = grid.map((g) => ({ ...g, ...evalSet(g) })).sort((a, b) => b.pct - a.pct || b.worst - a.worst)

console.log(`\n=== ROBUSTNESS across 64 random windows (market-neutral, sized) ===`)
console.log('param set                         | % windows profitable | median | worst  | avg acc')
for (const r of results.slice(0, 12)) {
  console.log(`  h=${String(r.horizon).padStart(2)}d conf>=${r.minConf} size=${String(r.size).padStart(2)}%   |   ${(100 * r.pct).toFixed(0).padStart(3)}% (${r.wins}/${r.total})        | ${r.med.toFixed(1).padStart(6)}% | ${r.worst.toFixed(1).padStart(6)}% | ${(100 * r.acc).toFixed(0)}%`)
}
const best = results[0]
console.log(`\nBEST set is profitable in ${(100 * best.pct).toFixed(0)}% of windows. A real edge would be ~80%+ with positive worst-case.`)
