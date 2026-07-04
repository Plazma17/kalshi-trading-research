// Walk-forward validation: classify the HELD-OUT period (after the train cutoff) with
// a given model (NT_MODEL) and report per-stock accuracy. Run for base vs trained,
// compare. The trained model never saw these headlines, so this is an honest test.
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
const MODEL = process.env.NT_MODEL || 'qwen2.5:14b'
const CUTOFF = process.env.NT_CUTOFF || '2019-11-25'
const STATUS = join(process.env.APPDATA, 'news-trader-app', 'default-workspace', 'running-status.json')
const startedAt = new Date().toISOString()
function status(phase, message, fraction, t) {
  const bignums = [
    { label: 'OVERALL ACCURACY', value: t.n ? `${(100 * t.c / t.n).toFixed(0)}%` : '—', tone: t.n && t.c / t.n >= 0.5 ? 'ok' : 'bad' },
    { label: 'SHORT-SIDE ACCURACY', value: t.sn ? `${(100 * t.sc / t.sn).toFixed(0)}%` : '—', tone: t.sn && t.sc / t.sn >= 0.5 ? 'ok' : 'bad' },
    { label: 'HEADLINES SCORED', value: String(t.n) }
  ]
  writeFileSync(STATUS, JSON.stringify({ active: phase !== 'done', label: `VALIDATION — ${MODEL} (held-out, after ${CUTOFF})`, kind: 'validation', phase, message, fraction, trades: t.n, accuracy: t.n ? t.c / t.n : 0, pnlPct: 0, marketNeutralPct: 0, bignums, equity: [], feed: [], startedAt, updatedAt: new Date().toISOString() }))
}

const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t

function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString(), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) })
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2009-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] }
}
const cacheFile = join(here, 'validate-cache.json')
let cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
let dirty = 0
// NOTE: we use ollama's generic `format: 'json'` (valid-JSON constraint) rather than the
// strict zod->GBNF grammar. The merged fine-tuned model errors on the schema grammar
// ("Unexpected empty grammar stack") due to tokenizer special-token shifts from the import;
// it was TRAINED to emit this exact envelope, so json-mode + lenient parse is reliable. We
// also spell out the envelope so the untrained baselines produce the same keys (fair compare).
const SHAPE = '\n\nOUTPUT FORMAT: respond with ONLY a JSON object {"signals":[{"topic":"<lowercase sector>","direction":"bear|down|neutral|up|bull","confidence_pct":<integer 0-100>}]}. Use an empty array {"signals":[]} when nothing is material. No prose, no markdown.'
// Optional: use classifications precomputed elsewhere (e.g. transformers base+adapter,
// bypassing the broken ollama GGUF export). JSON map { "<headline>": [ {topic,direction,confidence_pct} ] }.
const PRE = process.env.NT_PRECLASSIFIED && existsSync(process.env.NT_PRECLASSIFIED)
  ? JSON.parse(readFileSync(process.env.NT_PRECLASSIFIED, 'utf8')) : null
if (PRE) console.log(`using precomputed classifications from ${process.env.NT_PRECLASSIFIED} (${Object.keys(PRE).length} headlines)`)
async function classify(h) {
  if (PRE) return PRE[h] || []
  const sys = SYSTEM + SHAPE
  const key = createHash('md5').update(MODEL + '|' + sys + '|' + h).digest('hex')
  if (cache[key]) return cache[key]
  let sigs = []
  try {
    // num_predict caps runaway generation (the merged fine-tune lost its EOS on import and
    // won't stop on its own); stop forces the Qwen turn-end token so each call returns fast.
    const r = await ollama.chat({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: h }], format: 'json', options: { temperature: 0, num_predict: 256, stop: ['<|im_end|>', '<|endoftext|>'] }, keep_alive: '30m' })
    sigs = Lean.parse(JSON.parse(r.message.content)).signals
  } catch { sigs = [] } // one malformed response shouldn't kill the whole run
  cache[key] = sigs
  if (++dirty >= 10) { writeFileSync(cacheFile, JSON.stringify(cache)); dirty = 0 }
  return cache[key]
}

const MAX = Number(process.env.NT_MAX || 0) // optional cap on held-out headlines (0 = all)
let rows = (await readCsv()).filter((r) => r.date.slice(0, 10) > CUTOFF)
if (MAX && rows.length > MAX) rows = rows.slice(0, MAX)
console.log(`model=${MODEL}  holdout headlines (after ${CUTOFF}): ${rows.length}`)
const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)

const t = { n: 0, c: 0, sn: 0, sc: 0, signals: 0 }
for (let i = 0; i < rows.length; i++) {
  const row = rows[i]
  const sector = REV[row.ticker]; if (!sector) continue
  const sigs = await classify(row.headline)
  t.signals += sigs.length
  const s = sigs.find((x) => x.topic.toLowerCase() === sector); if (!s) continue
  if (s.confidence_pct / 100 < 0.7) continue
  const sign = Math.sign(SCORE[s.direction]); if (sign === 0) continue
  const b = bars[row.ticker]; if (!b || !b.length) continue
  const d = row.date.slice(0, 10)
  const entry = b.find((x) => x.date > d); if (!entry) continue
  const idx = b.findIndex((x) => x.date >= entry.date)
  const exit = b[idx + 3]; if (!exit) continue
  const fwd = (exit.close / entry.open - 1) * 100
  const ok = Math.sign(fwd) === sign
  t.n++; if (ok) t.c++
  if (sign < 0) { t.sn++; if (ok) t.sc++ }
  if (i % 5 === 0) status('classifying', `${i + 1}/${rows.length} — acc ${t.n ? (100 * t.c / t.n).toFixed(0) : 0}% | short ${t.sn ? (100 * t.sc / t.sn).toFixed(0) : 0}%`, (i + 1) / rows.length, t)
}
writeFileSync(cacheFile, JSON.stringify(cache))
status('done', `done — overall ${t.n ? (100 * t.c / t.n).toFixed(0) : 0}%, short ${t.sn ? (100 * t.sc / t.sn).toFixed(0) : 0}%`, 1, t)
console.log(`\n\n=== VALIDATION (model=${MODEL}, holdout after ${CUTOFF}, 3d, conf>=0.7) ===`)
console.log(`overall accuracy ${t.n ? (100 * t.c / t.n).toFixed(0) : 0}% (${t.c}/${t.n})`)
console.log(`SHORT-side accuracy ${t.sn ? (100 * t.sc / t.sn).toFixed(0) : 0}% (${t.sc}/${t.sn})`)
console.log(`avg signals/headline ${(t.signals / rows.length).toFixed(2)} (materiality: lower = more selective)`)
