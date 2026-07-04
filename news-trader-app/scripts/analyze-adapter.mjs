// Deep breakdown of the trained adapter's held-out calls (reads adapter-classifications.json,
// no model needed) -> calibration by confidence, accuracy by direction, by topic, threshold
// sweep, long vs short. Tells us where the fine-tune's edge is and what to change next round.
import { createReadStream, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance()
try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const CUTOFF = '2019-11-25'
const PRE = JSON.parse(readFileSync(join(here, 'adapter-classifications.json'), 'utf8'))

const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t

function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString(), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) })
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2009-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] }
}
const pct = (c, n) => (n ? (100 * c / n).toFixed(0) + '%' : '—')
function line(label, c, n) { return `  ${label.padEnd(16)} ${pct(c, n).padStart(5)}  (${c}/${n})` }

const rows = (await readCsv()).filter((r) => r.date.slice(0, 10) > CUTOFF)
const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)

// collect every non-neutral, sector-matching call with its forward 3-day return
const trades = []
for (const row of rows) {
  const sector = REV[row.ticker]; if (!sector) continue
  const sigs = PRE[row.headline]; if (!sigs) continue
  const s = sigs.find((x) => (x.topic || '').toLowerCase() === sector); if (!s) continue
  const sign = Math.sign(SCORE[s.direction] ?? 0); if (sign === 0) continue
  const b = bars[row.ticker]; if (!b || !b.length) continue
  const d = row.date.slice(0, 10)
  const entry = b.find((x) => x.date > d); if (!entry) continue
  const idx = b.findIndex((x) => x.date >= entry.date)
  const exit = b[idx + 3]; if (!exit) continue
  const fwd = (exit.close / entry.open - 1) * 100
  trades.push({ conf: (s.confidence_pct ?? 0) / 100, dir: s.direction, topic: sector, sign, fwd, ok: Math.sign(fwd) === sign })
}

const acc = (ts) => [ts.filter((t) => t.ok).length, ts.length]
console.log(`\n=== TRAINED ADAPTER — held-out breakdown (n=${trades.length} non-neutral sector calls, 3d) ===`)

console.log(`\nTHRESHOLD SWEEP (gate on confidence):`)
for (const th of [0.0, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const ts = trades.filter((t) => t.conf >= th)
  const sh = ts.filter((t) => t.sign < 0), lo = ts.filter((t) => t.sign > 0)
  console.log(`  conf>=${th.toFixed(1)}: overall ${pct(...acc(ts))} (${ts.length}) | long ${pct(...acc(lo))} (${lo.length}) | short ${pct(...acc(sh))} (${sh.length})`)
}

console.log(`\nCALIBRATION (confidence bucket -> accuracy):`)
for (const [lo, hi] of [[0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]]) {
  const ts = trades.filter((t) => t.conf >= lo && t.conf < hi)
  console.log(line(`${lo.toFixed(1)}-${hi >= 1 ? '1.0' : hi.toFixed(1)}`, ...acc(ts)))
}

console.log(`\nBY DIRECTION:`)
for (const dir of ['bull', 'up', 'down', 'bear']) console.log(line(dir, ...acc(trades.filter((t) => t.dir === dir))))
console.log(line('— LONG (up/bull)', ...acc(trades.filter((t) => t.sign > 0))))
console.log(line('— SHORT (down/bear)', ...acc(trades.filter((t) => t.sign < 0))))

console.log(`\nBY TOPIC:`)
for (const tp of Object.keys(MAP)) { const ts = trades.filter((t) => t.topic === tp); if (ts.length) console.log(line(tp, ...acc(ts))) }

const avgRet = (ts, dirSign) => ts.length ? (ts.reduce((a, t) => a + dirSign * t.fwd, 0) / ts.length).toFixed(2) : '0'
console.log(`\nMEAN forward 3d return in the called direction: ${avgRet(trades, 1)}% (signed by call) over ${trades.length} trades`)
console.log(`  long calls: ${avgRet(trades.filter((t) => t.sign > 0).map((t) => ({ ...t, fwd: t.fwd })), 1)}%  short calls: ${avgRet(trades.filter((t) => t.sign < 0), -1)}%`)
