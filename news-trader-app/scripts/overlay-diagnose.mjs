// Research diagnostic: what is the self-check model actually doing each YEAR, by DIRECTION?
// For every call, score the 3d forward move (look-ahead-safe) and aggregate by (year, direction).
// Goal: understand WHY 2022 hurt — were the bear calls wrong (model mispredicted the rate-driven
// market), or right-but-the-flat-mechanics-cost-us? And does 'down' (the reliable signal) behave
// differently from 'bear' per year?
import { createReadStream, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance(); try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const here = dirname(fileURLToPath(import.meta.url))
const CSV = join(here, '..', '..', 'news-trader-data', 'fnspid-multiyear.csv')
const GATE = Number(process.env.NT_GATE || 0.6)
const PRE = JSON.parse(readFileSync(join(here, 'selfcheck-multiyear.json'), 'utf8'))
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t

function readCsv() { return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(CSV, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString().slice(0, 10), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) }) }
async function getBars(sym) { try { const r = await yf.chart(sym, { period1: '2019-06-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] } }

const rows = (await readCsv()).filter((r) => r.date > '2019-11-25' && REV[r.ticker])
const syms = [...new Set(rows.map((r) => r.ticker))]
const bars = {}; for (const s of syms) bars[s] = await getBars(s)
function fwd(b, d) { const e = b.find((x) => x.date > d); if (!e) return null; const i = b.findIndex((x) => x.date >= e.date); const x = b[i + 3]; return x ? x.close / e.open - 1 : null }

// agg[year][dir] = {n, correct, signed}
const agg = {}
for (const row of rows) {
  const b = bars[row.ticker]; if (!b?.length) continue
  const sig = (PRE[row.headline] || []).find((x) => (x.topic || '').toLowerCase() === REV[row.ticker])
  if (!sig || (sig.confidence_pct ?? 0) / 100 < GATE) continue
  const dir = sig.direction; const sign = Math.sign(SCORE[dir]); if (sign === 0) continue
  const f = fwd(b, row.date); if (f == null) continue
  const y = row.date.slice(0, 4)
  agg[y] = agg[y] || {}; agg[y][dir] = agg[y][dir] || { n: 0, c: 0, signed: 0 }
  const a = agg[y][dir]; a.n++; a.signed += sign * f; if (Math.sign(f) === sign) a.c++
}

console.log(`\n=== WHAT THE MODEL DID, BY YEAR x DIRECTION (self-check, conf>=${GATE}, 3d) ===`)
console.log(`meanSigned% = avg 3d return IN THE CALLED DIRECTION (positive = the call made money)\n`)
console.log(`year  dir      n    acc    meanSigned%`)
for (const y of Object.keys(agg).sort()) {
  for (const dir of ['bull', 'up', 'down', 'bear']) {
    const a = agg[y][dir]; if (!a) continue
    console.log(`${y}  ${dir.padEnd(6)} ${String(a.n).padStart(4)}  ${(100 * a.c / a.n).toFixed(0).padStart(3)}%   ${(100 * a.signed / a.n >= 0 ? '+' : '') + (100 * a.signed / a.n).toFixed(2)}`)
  }
  // year roll-up for the bearish (down+bear) calls the overlay uses
  const db = ['down', 'bear'].map((d) => agg[y][d]).filter(Boolean)
  if (db.length) { const n = db.reduce((s, a) => s + a.n, 0), c = db.reduce((s, a) => s + a.c, 0), sg = db.reduce((s, a) => s + a.signed, 0); console.log(`${y}  DOWN+BEAR ${String(n).padStart(2)}  ${(100 * c / n).toFixed(0).padStart(3)}%   ${(100 * sg / n >= 0 ? '+' : '') + (100 * sg / n).toFixed(2)}  <- overlay acts on these`) }
  console.log('')
}
