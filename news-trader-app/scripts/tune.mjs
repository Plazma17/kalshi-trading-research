// Tuning harness: classify all headlines ONCE, fetch prices once, then score the
// SAME classifications against many (horizon, confidence, entry) combos instantly.
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
const file = process.env.NT_CSV || join(here, '..', '..', 'news-trader-data', 'demo-news.csv')

const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })

const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }

function readCsv() {
  return new Promise((res, rej) => {
    const out = []
    Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => out.push({ headline: r.data.headline, date: new Date(r.data.date).toISOString() }), complete: () => res(out), error: rej })
  })
}
async function classify(headline) {
  const r = await ollama.chat({ model: 'qwen2.5:14b', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: headline }], format: zodToJsonSchema(Lean, { $refStrategy: 'none' }), options: { temperature: 0 }, keep_alive: '30m' })
  return Lean.parse(JSON.parse(r.message.content)).signals
}
async function getBars(sym) {
  try {
    const r = await yf.chart(sym, { period1: '2013-01-01', period2: '2024-07-01', interval: '1d' })
    return (r.quotes ?? []).filter((q) => q.open != null && q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close }))
  } catch { return [] }
}

const phash = createHash('md5').update(SYSTEM).digest('hex').slice(0, 8)
const cacheFile = join(here, 'classified-cache.json')
let cache = {}
if (existsSync(cacheFile)) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')) } catch {} }
const articles = await readCsv()
const classified = []
let didClassify = false
let sinceWrite = 0
for (const a of articles) {
  const key = phash + '|' + a.headline
  if (!cache[key]) {
    console.log('classifying:', a.headline.slice(0, 55))
    cache[key] = await classify(a.headline)
    didClassify = true
    if (++sinceWrite >= 20) { writeFileSync(cacheFile, JSON.stringify(cache)); sinceWrite = 0 } // persist progress (resumable)
  }
  classified.push({ ...a, signals: cache[key] })
}
if (didClassify) writeFileSync(cacheFile, JSON.stringify(cache))
console.log(didClassify ? 'classified (cached for next run)\n' : 'used cached classifications\n')

console.log('fetching prices…')
const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)

function score(arts, { horizon, minConf, entry = 'next_open', includeNeutral = false }) {
  let scored = 0, correct = 0, pnl = 0, excess = 0
  const spy = bars['SPY'] || []
  const dir = {}, topic = {}, bucket = {}
  const add = (m, k, ok) => { m[k] = m[k] || { n: 0, c: 0, pnl: 0 }; m[k].n++; if (ok) m[k].c++ }
  for (const a of arts) {
    for (const s of a.signals) {
      const conf = s.confidence_pct / 100
      if (conf < minConf) continue
      const sign = Math.sign(SCORE[s.direction]); if (sign === 0 && !includeNeutral) continue
      const syms = MAP[s.topic.toLowerCase()]; if (!syms) continue
      for (const sym of syms) {
        const b = bars[sym]; if (!b || !b.length) continue
        const d = a.date.slice(0, 10)
        const entryBar = entry === 'next_open' ? b.find((x) => x.date > d) : b.find((x) => x.date >= d)
        if (!entryBar) continue
        const idx = b.findIndex((x) => x.date >= entryBar.date)
        const exit = b[idx + horizon]; if (!exit) continue
        const px = entry === 'next_open' ? entryBar.open : entryBar.close
        const fwd = (exit.close / px - 1) * 100
        const si = spy.findIndex((x) => x.date >= entryBar.date)
        const se = spy[si], sx = spy[si + horizon]
        const spyMove = se && sx ? (sx.close / se.open - 1) * 100 : 0
        const ok = Math.sign(fwd) === sign
        const tpnl = sign * fwd - (2 * 5) / 100
        scored++; if (ok) correct++; pnl += tpnl; excess += sign * (fwd - spyMove)
        add(dir, s.direction, ok); add(topic, s.topic.toLowerCase(), ok)
        const bk = conf < 0.6 ? '0.5-0.6' : conf < 0.7 ? '0.6-0.7' : conf < 0.8 ? '0.7-0.8' : '0.8-1.0'
        add(bucket, bk, ok); bucket[bk].pnl += tpnl; topic[s.topic.toLowerCase()].pnl += tpnl
      }
    }
  }
  return { scored, accuracy: scored ? correct / scored : 0, pnl, excess, dir, topic, bucket }
}

const P = (x) => `${(x * 100).toFixed(0)}%`
const base = score(classified, { horizon: 3, minConf: 0.5 })
console.log(`\n=== BASELINE (horizon 3d, minConf 0.5, next-open) ===`)
console.log(`trades=${base.scored}  accuracy=${P(base.accuracy)}  total P&L=${base.pnl.toFixed(1)}%  MARKET-NEUTRAL(vs SPY)=${base.excess.toFixed(1)}%`)
console.log('\nby direction:'); for (const [k, v] of Object.entries(base.dir).sort()) console.log(`  ${k.padEnd(8)} n=${String(v.n).padStart(3)}  acc=${P(v.c / v.n)}`)
console.log('\nby confidence bucket (calibration):'); for (const [k, v] of Object.entries(base.bucket).sort()) console.log(`  ${k}  n=${String(v.n).padStart(3)}  acc=${P(v.c / v.n)}  pnl=${v.pnl.toFixed(1)}%`)
console.log('\nby topic:'); for (const [k, v] of Object.entries(base.topic).sort((a, b) => b[1].pnl - a[1].pnl)) console.log(`  ${k.padEnd(15)} n=${String(v.n).padStart(3)}  acc=${P(v.c / v.n)}  pnl=${v.pnl.toFixed(1)}%`)

console.log(`\n=== HORIZON SWEEP (minConf 0.5) ===`)
for (const h of [1, 2, 3, 5, 10]) { const r = score(classified, { horizon: h, minConf: 0.5 }); console.log(`  ${String(h).padStart(2)}d  acc=${P(r.accuracy)}  pnl=${r.pnl.toFixed(1)}%  market-neutral=${r.excess.toFixed(1)}%`) }
console.log(`\n=== CONFIDENCE SWEEP (horizon 3) ===`)
for (const c of [0.5, 0.6, 0.7, 0.8]) { const r = score(classified, { horizon: 3, minConf: c }); console.log(`  >=${c}  trades=${r.scored}  acc=${P(r.accuracy)}  pnl=${r.pnl.toFixed(1)}%  market-neutral=${r.excess.toFixed(1)}%`) }
console.log(`\n=== ENTRY RULE (horizon 3, minConf 0.5) ===`)
for (const e of ['next_open', 'same_close']) { const r = score(classified, { horizon: 3, minConf: 0.5, entry: e }); console.log(`  ${e.padEnd(11)}  acc=${P(r.accuracy)}  pnl=${r.pnl.toFixed(1)}%`) }

// ── WALK-FORWARD: tune/look on TRAIN (early), judge on TEST (later, unseen) ──
const sorted = [...classified].sort((a, b) => (a.date < b.date ? -1 : 1))
const k = Math.floor(sorted.length * 0.6)
const splitDate = sorted[k].date.slice(0, 10)
const train = sorted.slice(0, k)
const test = sorted.slice(k)
console.log(`\n=== WALK-FORWARD (split ${splitDate}: ${train.length} train / ${test.length} test headlines, horizon 3) ===`)
console.log('  the TEST column is the honest out-of-sample number:')
for (const c of [0.5, 0.7, 0.8]) {
  const tr = score(train, { horizon: 3, minConf: c })
  const te = score(test, { horizon: 3, minConf: c })
  console.log(`  conf>=${c}  TRAIN acc=${P(tr.accuracy)} mn=${tr.excess.toFixed(0)}%  |  TEST acc=${P(te.accuracy)} mn=${te.excess.toFixed(0)}% (n=${te.scored})`)
}
