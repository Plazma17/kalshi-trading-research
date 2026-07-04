// Classify each article TWICE — headline-only vs headline+full body — and compare
// per-stock directional accuracy. Same prompt, same scoring (3d hold, conf>=0.7).
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
const file = join(here, '..', '..', 'news-trader-data', 'fnspid-articles.csv')
const STATUS = join(process.env.APPDATA, 'news-trader-app', 'default-workspace', 'running-status.json')

const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t
const phash = createHash('md5').update(SYSTEM).digest('hex').slice(0, 8)

const cacheFile = join(here, 'article-cache.json')
let cache = {}
if (existsSync(cacheFile)) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')) } catch {} }
let dirty = 0
async function classify(text) {
  const key = createHash('md5').update(phash + '|' + text).digest('hex')
  if (cache[key]) return cache[key]
  const r = await ollama.chat({ model: 'qwen2.5:14b', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }], format: zodToJsonSchema(Lean, { $refStrategy: 'none' }), options: { temperature: 0 }, keep_alive: '30m' })
  cache[key] = Lean.parse(JSON.parse(r.message.content)).signals
  if (++dirty >= 10) { writeFileSync(cacheFile, JSON.stringify(cache)); dirty = 0 }
  return cache[key]
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2009-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null && q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] }
}
function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => out.push(r.data), complete: () => res(out), error: rej }) })
}

const rows = await readCsv()
console.log(`${rows.length} articles with bodies`)
const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)

function evalSig(signals, ticker, dateIso) {
  const sector = REV[ticker]; if (!sector) return null
  const s = signals.find((x) => x.topic.toLowerCase() === sector); if (!s) return null
  if (s.confidence_pct / 100 < 0.7) return null
  const sign = Math.sign(SCORE[s.direction]); if (sign === 0) return null
  const b = bars[ticker]; if (!b || !b.length) return null
  const d = dateIso.slice(0, 10)
  const entry = b.find((x) => x.date > d); if (!entry) return null
  const idx = b.findIndex((x) => x.date >= entry.date)
  const exit = b[idx + 3]; if (!exit) return null
  const fwd = (exit.close / entry.open - 1) * 100
  return { correct: Math.sign(fwd) === sign, short: sign < 0 }
}

const tally = { headline: { n: 0, c: 0, sn: 0, sc: 0 }, full: { n: 0, c: 0, sn: 0, sc: 0 } }
function add(t, r) { if (!r) return; t.n++; if (r.correct) t.c++; if (r.short) { t.sn++; if (r.correct) t.sc++ } }

for (let i = 0; i < rows.length; i++) {
  const row = rows[i]
  const dateIso = new Date(row.date).toISOString()
  const hSig = await classify(row.headline)
  const fSig = await classify(`${row.headline}\n\n${row.article}`)
  add(tally.headline, evalSig(hSig, row.ticker.toUpperCase(), dateIso))
  add(tally.full, evalSig(fSig, row.ticker.toUpperCase(), dateIso))
  const ha = tally.headline.n ? (100 * tally.headline.c / tally.headline.n).toFixed(0) : '-'
  const fa = tally.full.n ? (100 * tally.full.c / tally.full.n).toFixed(0) : '-'
  const bignums = [
    { label: 'HEADLINE-ONLY ACCURACY', value: `${ha}%` },
    { label: 'FULL-ARTICLE ACCURACY', value: `${fa}%` },
    { label: 'COMPARED', value: `${i + 1}/${rows.length}` }
  ]
  writeFileSync(STATUS, JSON.stringify({ active: i < rows.length - 1, label: 'HEADLINE vs FULL-ARTICLE accuracy test', kind: 'compare', phase: i < rows.length - 1 ? 'classifying' : 'done', message: `${i + 1}/${rows.length}  |  headline acc ${ha}%  vs  full-article acc ${fa}%`, fraction: (i + 1) / rows.length, trades: tally.headline.n + tally.full.n, accuracy: tally.full.n ? tally.full.c / tally.full.n : 0, pnlPct: 0, marketNeutralPct: 0, bignums, equity: [], feed: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
}
writeFileSync(cacheFile, JSON.stringify(cache))
const pc = (t) => `${t.n ? (100 * t.c / t.n).toFixed(0) : 0}% (${t.c}/${t.n})`
const ps = (t) => `${t.sn ? (100 * t.sc / t.sn).toFixed(0) : 0}% (${t.sc}/${t.sn})`
console.log(`\n=== HEADLINE-ONLY vs FULL-ARTICLE (3d hold, conf>=0.7, per-stock) ===`)
console.log(`HEADLINE-ONLY  overall ${pc(tally.headline)}   short-side ${ps(tally.headline)}`)
console.log(`FULL-ARTICLE   overall ${pc(tally.full)}   short-side ${ps(tally.full)}`)
