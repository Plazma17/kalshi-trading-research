// Prompt A/B sweep: score several BASE-model prompt variants head-to-head on held-out
// directional accuracy (overall / long / short, since long is noise and short is the part
// that matters). No 'already priced in' reasoning (per user: the model is weak at it and
// fresh live news isn't priced in yet). Caches per (variant|headline) -> resumable, and
// adding a variant only classifies the new one.
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import { Ollama } from 'ollama'
import { z } from 'zod'
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance(); try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const ollama = new Ollama({ host: 'http://localhost:11434' })
const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const MODEL = process.env.NT_MODEL || 'qwen2.5:14b'
const CUTOFF = '2019-11-25'
const GATE = Number(process.env.NT_GATE || 0.6)
const SAMPLE = Number(process.env.NT_SAMPLE || 500)

const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t

const SECTORS = 'oil, semiconductors, airlines, defense, banks, gold, market'
const SHAPE = `\n\nRespond with ONLY: {"signals":[{"topic":"<lowercase sector>","direction":"bear|down|neutral|up|bull","confidence_pct":<int 0-100>}]}. Empty = {"signals":[]}. No prose.`
const SHAPE_SC = `\n\nRespond with ONLY: {"disruption_check":"<one sentence>","signals":[{"topic":"<lowercase sector>","direction":"bear|down|neutral|up|bull","confidence_pct":<int 0-100>}]}. Empty = {"disruption_check":"...","signals":[]}. No prose.`

const VARIANTS = [
  { name: 'playbook', shape: SHAPE, system:
`You are a markets analyst for a news-driven equities bot. You read one news item and decide which sector/theme groups it moves and how strongly. Direction is a 5-level conviction scale: bull, up, neutral, down, bear. confidence_pct is an integer 0-100. Reason about the CAUSAL relationship — does the event help or hurt each group? Companies on opposite sides of the same event move opposite ways.
PLAYBOOK: Fed hike/hot inflation -> banks up, growth/gold/housing down (cuts: reverse). Oil supply shock (OPEC cut, Mideast conflict, chokepoint) -> oil bull, airlines/shippers down, defense up, market down. Company fraud/SEC-DOJ probe/lawsuit -> that company bear. Pharma breakthrough/FDA approval -> company+peers bull; failure/recall -> down. War escalation -> defense+oil+gold bull, market down. Bank stress/contagion -> banks bear. China chip curbs -> semis down; AI/data-center boom -> semis bull. Earnings beat+raise -> up; miss+cut -> down.
MATERIALITY: only emit a non-neutral signal for a LARGE, material move (multiple percent) — billions, regulation, supply shocks, M&A, bankruptcies, big surprises. Trivial/celebrity/novelty news -> neutral. Most news is neutral; when in doubt, empty.
Topics: ${SECTORS}.` },

  { name: 'lean', shape: SHAPE, system:
`You read one news item and decide which sector groups it moves and how strongly. Direction is a 5-level scale: bull, up, neutral, down, bear. confidence_pct is an integer 0-100. Reason about the CAUSAL effect — does the event help or hurt each group, and how hard? Only emit a non-neutral signal for a LARGE, material move (multiple percent). Most news is neutral; when in doubt, emit nothing. Topics: ${SECTORS}.` },

  { name: 'selfcheck', shape: SHAPE_SC, system:
`You are a risk analyst for a news-driven equities bot. For each news item, FIRST judge: will this specific event REALLY disrupt markets — cause a LARGE, multi-day price move in a stock or sector? Most news will not; routine updates, analyst ratings, opinions, and vague or speculative items do not.
STEP 1 disruption_check: in ONE sentence, will this genuinely move a sector multiple percent over the next few days? Name the concrete mechanism, or state why it will not.
STEP 2: ONLY if your honest answer is YES, emit signal(s); otherwise empty.
Reason about the CAUSAL direction on a 5-level scale (bull/up/neutral/down/bear). A concrete NEGATIVE catalyst (guidance cut, earnings miss, SEC/DOJ probe, fraud, downgrade, bankruptcy/liquidity risk, recall, lost contract, sanctions, cost/supply shock) -> down or bear. A concrete POSITIVE catalyst -> up or bull. Topics: ${SECTORS}.` },

  { name: 'catalyst', shape: SHAPE, system:
`You read one financial news item and decide which sector it moves and how hard. React ONLY to CONCRETE, MATERIAL catalysts — events that by themselves cause a multi-percent, multi-day move: earnings beats/misses with guidance, supply shocks, regulatory or legal actions, M&A, bankruptcies, major contracts won/lost, sanctions, demand collapses, product recalls, fraud. For anything else — opinions, analyst ratings, routine updates, vague or speculative news — emit nothing. Direction is 5-level (bull/up/neutral/down/bear); reason about causal help vs hurt. Topics: ${SECTORS}.` },
]

function readCsv() { return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString().slice(0, 10), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) }) }
async function getBars(sym) { try { const r = await yf.chart(sym, { period1: '2019-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] } }

const cacheFile = join(here, 'prompt-ab-cache.json')
let cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
let dirty = 0
async function classify(v, h) {
  const key = createHash('md5').update(v.name + '|' + MODEL + '|' + h).digest('hex')
  if (cache[key]) return cache[key]
  let sigs = []
  try {
    const r = await ollama.chat({ model: MODEL, messages: [{ role: 'system', content: v.system + v.shape }, { role: 'user', content: h }], format: 'json', options: { temperature: 0, num_predict: 256, stop: ['<|im_end|>'] }, keep_alive: '30m' })
    sigs = Lean.parse({ signals: (JSON.parse(r.message.content).signals) || [] }).signals
  } catch { sigs = [] }
  cache[key] = sigs
  if (++dirty >= 20) { writeFileSync(cacheFile, JSON.stringify(cache)); dirty = 0 }
  return sigs
}

// sample: first SAMPLE held-out rows that map to a sector
let rows = (await readCsv()).filter((r) => r.date > CUTOFF && REV[r.ticker])
rows = rows.slice(0, SAMPLE)
const bars = {}; for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)
console.log(`prompt A/B — model=${MODEL}, ${rows.length} held-out headlines, gate>=${GATE}, 3d\n`)

const results = []
for (const v of VARIANTS) {
  const t = { n: 0, c: 0, ln: 0, lc: 0, sn: 0, sc: 0, emit: 0, sigs: 0 }
  for (const row of rows) {
    const sector = REV[row.ticker]
    const out = await classify(v, row.headline)
    t.sigs += out.length; if (out.length) t.emit++
    const s = out.find((x) => (x.topic || '').toLowerCase() === sector)
    if (!s || (s.confidence_pct ?? 0) / 100 < GATE) continue
    const sign = Math.sign(SCORE[s.direction]); if (sign === 0) continue
    const b = bars[row.ticker]; if (!b?.length) continue
    const entry = b.find((x) => x.date > row.date); if (!entry) continue
    const idx = b.findIndex((x) => x.date >= entry.date); const exit = b[idx + 3]; if (!exit) continue
    const ok = Math.sign(exit.close / entry.open - 1) === sign
    t.n++; if (ok) t.c++
    if (sign > 0) { t.ln++; if (ok) t.lc++ } else { t.sn++; if (ok) t.sc++ }
  }
  writeFileSync(cacheFile, JSON.stringify(cache))
  results.push({ name: v.name, ...t })
  const pc = (c, n) => n ? `${(100 * c / n).toFixed(0)}% (${c}/${n})` : '—'
  console.log(`${v.name.padEnd(10)} overall ${pc(t.c, t.n).padEnd(13)} long ${pc(t.lc, t.ln).padEnd(12)} short ${pc(t.sc, t.sn).padEnd(12)} | emit ${(100 * t.emit / rows.length).toFixed(0)}% avg ${(t.sigs / rows.length).toFixed(2)} sig/headline`)
}
console.log(`\nREAD: 'short' is the column that matters (the de-risk overlay only acts on down/bear).`)
console.log(`A prompt 'wins' if it lifts SHORT accuracy while staying selective (low emit% = fewer false flags).`)
