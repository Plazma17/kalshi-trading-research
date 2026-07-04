// Stateful, news-driven backtest: a position is held until EITHER a contradicting
// signal arrives (exit + flip) OR a max-hold horizon passes — whichever comes first.
// Compares against the dumb fixed-horizon model. Uses cached classifications (no Ollama).
import { createReadStream, readFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import YahooFinance from 'yahoo-finance2'
import { SYSTEM } from './_system.mjs'

const yf = new YahooFinance()
try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const here = dirname(fileURLToPath(import.meta.url))
const file = process.env.NT_CSV || join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')

const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t
const CONF = 0.7, MAXHOLD = 15, COST = 0.1, SIDE = process.env.NT_SIDE || 'short'

function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString(), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) })
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2009-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] }
}

const phash = createHash('md5').update(SYSTEM).digest('hex').slice(0, 8)
const cacheFile = join(here, 'classified-cache.json')
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
const articles = (await readCsv()).sort((a, b) => (a.date < b.date ? -1 : 1))

// build chronological actionable events for the named ticker
const events = []
for (const a of articles) {
  const sig = cache[phash + '|' + a.headline]; if (!sig) continue
  const sector = REV[a.ticker]; if (!sector) continue
  const s = sig.find((x) => x.topic.toLowerCase() === sector); if (!s) continue
  const sign = Math.sign(SCORE[s.direction])
  if (sign === 0 || s.confidence_pct / 100 < CONF) continue
  if (SIDE === 'short' && sign > 0) continue
  if (SIDE === 'long' && sign < 0) continue
  events.push({ date: a.date.slice(0, 10), ticker: a.ticker, sign })
}
console.log(`${events.length} actionable events (side=${SIDE}, conf>=${CONF})`)

const bars = {}
for (const t of [...new Set(events.map((e) => e.ticker))]) bars[t] = await getBars(t)

const idxAfter = (b, date) => { const e = b.find((x) => x.date > date); return e ? b.findIndex((x) => x.date >= e.date) : -1 }

// ── MANAGED simulation: hold until contradiction OR max-hold ──
const pos = {}, managed = []
function closeNatural(ticker, b, beforeIdx) {
  const cur = pos[ticker]; if (!cur) return
  const natIdx = Math.min(cur.entryIdx + MAXHOLD, b.length - 1)
  if (natIdx < beforeIdx) {
    const ret = cur.sign * (b[natIdx].open / b[cur.entryIdx].open - 1) * 100 - COST
    managed.push({ ret, reason: 'horizon' }); delete pos[ticker]
  }
}
for (const ev of events) {
  const b = bars[ev.ticker]; if (!b || !b.length) continue
  const idx = idxAfter(b, ev.date); if (idx < 0) continue
  closeNatural(ev.ticker, b, idx)
  const cur = pos[ev.ticker]
  if (!cur) pos[ev.ticker] = { sign: ev.sign, entryIdx: idx, entryDate: b[idx].date }
  else if (cur.sign !== ev.sign) {
    const ret = cur.sign * (b[idx].open / b[cur.entryIdx].open - 1) * 100 - COST
    managed.push({ ret, reason: 'contradiction' })
    pos[ev.ticker] = { sign: ev.sign, entryIdx: idx, entryDate: b[idx].date } // flip
  }
}
for (const [ticker, cur] of Object.entries(pos)) {
  const b = bars[ticker]; const natIdx = Math.min(cur.entryIdx + MAXHOLD, b.length - 1)
  managed.push({ ret: cur.sign * (b[natIdx].open / b[cur.entryIdx].open - 1) * 100 - COST, reason: 'final' })
}

// ── FIXED-horizon (3d) baseline on the SAME events (independent trades) ──
const fixed = []
for (const ev of events) {
  const b = bars[ev.ticker]; if (!b || !b.length) continue
  const idx = idxAfter(b, ev.date); if (idx < 0) continue
  const exit = b[idx + 3]; if (!exit) continue
  fixed.push({ ret: ev.sign * (exit.close / b[idx].open - 1) * 100 - COST })
}

const summ = (arr) => {
  const n = arr.length, wins = arr.filter((t) => t.ret > 0).length
  let eq = 1; for (const t of arr) eq *= 1 + 0.02 * (t.ret / 100)
  return `${n} trades, win ${(100 * wins / n).toFixed(0)}%, sized P&L ${((eq - 1) * 100).toFixed(1)}%`
}
const byReason = managed.reduce((m, t) => { m[t.reason] = (m[t.reason] || 0) + 1; return m }, {})
console.log(`\n=== NEWS-MANAGED (exit/flip on contradiction, max-hold ${MAXHOLD}d) ===`)
console.log(`MANAGED   ${summ(managed)}  | exits: ${JSON.stringify(byReason)}`)
console.log(`FIXED-3d  ${summ(fixed)}`)
