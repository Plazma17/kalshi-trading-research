// End-to-end backtest smoke: sample CSV -> classify (lean) -> topic->ticker ->
// real prices -> next-open scoring -> accuracy. Mirrors main/backtest.ts.
import { createReadStream } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import { Ollama } from 'ollama'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance()
try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const ollama = new Ollama({ host: 'http://localhost:11434' })
const here = dirname(fileURLToPath(import.meta.url))

const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })
const SYSTEM = 'You are a markets analyst. Direction is a 5-level scale bear/down/neutral/up/bull. List affected sector/theme groups (lowercase: oil, semiconductors, airlines, gold, banks, crypto, defense, market), their direction, confidence_pct 0-100. Reason about causal direction.'
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], crypto: ['COIN', 'MSTR', 'MARA', 'RIOT'], market: ['SPY', 'QQQ'] }

function readCsv() {
  return new Promise((res, rej) => {
    const out = []
    Papa.parse(createReadStream(join(here, '..', '..', 'news-trader-data', 'demo-news.csv'), 'utf8'), {
      header: true, skipEmptyLines: true,
      step: (r) => out.push({ headline: r.data.headline, date: new Date(r.data.date).toISOString() }),
      complete: () => res(out), error: rej
    })
  })
}
async function classify(headline) {
  const r = await ollama.chat({ model: 'qwen2.5:14b', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: headline }], format: zodToJsonSchema(Lean, { $refStrategy: 'none' }), options: { temperature: 0 }, keep_alive: '30m' })
  return Lean.parse(JSON.parse(r.message.content)).signals
}
async function bars(sym) {
  const r = await yf.chart(sym, { period1: '2021-01-01', period2: '2024-06-01', interval: '1d' })
  return (r.quotes ?? []).filter((q) => q.open != null && q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close }))
}

const articles = await readCsv()
let scored = 0, correct = 0
const cache = {}
for (const a of articles) {
  const sigs = await classify(a.headline)
  for (const s of sigs) {
    if (s.confidence_pct / 100 < 0.5) continue
    const sign = Math.sign(SCORE[s.direction])
    if (sign === 0) continue
    const syms = MAP[s.topic.toLowerCase()]
    if (!syms) continue
    for (const sym of syms) {
      const b = (cache[sym] ??= await bars(sym))
      const d = a.date.slice(0, 10)
      const entry = b.find((x) => x.date > d)
      if (!entry) continue
      const idx = b.findIndex((x) => x.date >= entry.date)
      const exit = b[idx + 3]
      if (!exit) continue
      const fwd = (exit.close / entry.open - 1) * 100
      const ok = Math.sign(fwd) === sign
      scored++; if (ok) correct++
      console.log(`${a.date.slice(0, 10)} ${s.topic}/${s.direction} ${sym}: fwd ${fwd.toFixed(1)}% -> ${ok ? 'OK' : 'X'}`)
    }
  }
}
console.log(`\nscored=${scored}  directional accuracy=${scored ? ((100 * correct) / scored).toFixed(0) : 0}%`)
