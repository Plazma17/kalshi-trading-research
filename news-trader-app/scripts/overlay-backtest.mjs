// Overlay backtest — does the model's ONLY real skill (downside detection) add value as a
// SELL/DE-RISK overlay? Compare, on the held-out period, buy-and-hold of the news universe vs
// the same hold but going FLAT (to cash) on a ticker for N days whenever the model flags it
// down/bear. The honest control: RANDOM-flat the SAME number of ticker-days — if sell-on-bear
// doesn't beat random de-risking, the signal adds nothing beyond cutting exposure.
//
// Uses the precomputed trained-adapter calls (adapter-classifications.json) so it needs no
// ollama. Prices via Yahoo (look-ahead-safe: a signal on date D acts from the NEXT open).
import { createReadStream, readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance()
try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const here = dirname(fileURLToPath(import.meta.url))
const file = process.env.NT_CSV || join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const CUTOFF = process.env.NT_CUTOFF || '2019-11-25'
const GATE = Number(process.env.NT_GATE || 0.6)        // confidence gate
const FLAT = Number(process.env.NT_FLAT_DAYS || 3)     // trading days to sit out after a flag
const BEAR_DIRS = (process.env.NT_BEAR_DIRS || 'down,bear').split(',')  // which calls trigger flat
const CALLS = process.env.NT_CALLS || join(here, 'adapter-classifications.json')
const PRE = JSON.parse(readFileSync(CALLS, 'utf8'))
console.log(`calls source: ${CALLS.split(/[\\/]/).pop()}`)

const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
let UNIVERSE = [...new Set(Object.values(MAP).flat())].filter((s) => s !== 'SPY' && s !== 'QQQ')
if (process.env.NT_TICKERS) { const keep = new Set(process.env.NT_TICKERS.split(',').map((x) => x.trim().toUpperCase())); UNIVERSE = UNIVERSE.filter((s) => keep.has(s)) }

function readCsv() {
  return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString().slice(0, 10), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) })
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2019-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close })) } catch { return [] }
}

// ---- load data ----
const rows = (await readCsv()).filter((r) => r.date > CUTOFF && REV[r.ticker])
const bars = {}
for (const s of UNIVERSE) bars[s] = await getBars(s)
// master trading calendar = SPY dates after cutoff
const cal = (await getBars('SPY')).map((b) => b.date).filter((d) => d > CUTOFF)
const calIdx = new Map(cal.map((d, i) => [d, i]))
const T = cal.length

// per-ticker daily simple returns aligned to the calendar (close/prevClose-1)
const ret = {}            // sym -> Float64Array(T)
const present = {}        // sym -> Uint8Array(T) (has a price that day)
for (const s of UNIVERSE) {
  const m = new Map(bars[s].map((b) => [b.date, b.close]))
  const r = new Float64Array(T), pr = new Uint8Array(T)
  let prev = null
  for (let i = 0; i < T; i++) {
    const px = m.get(cal[i])
    if (px != null) { pr[i] = 1; if (prev != null) r[i] = px / prev - 1; prev = px }
  }
  ret[s] = r; present[s] = pr
}

// ---- build the set of (ticker, startIdx) flat windows from BEARISH model calls ----
// signal on date D -> flat starting the next calendar day, for FLAT trading days.
function nextIdx(d) { for (let i = 0; i < T; i++) if (cal[i] > d) return i; return -1 }
const bearFlags = []      // {sym, start}
let bearCalls = 0
for (const row of rows) {
  if (!present[row.ticker]) continue   // ticker not in traded universe (SPY/QQQ excluded)
  const sector = REV[row.ticker]
  const sigs = PRE[row.headline] || []
  const s = sigs.find((x) => (x.topic || '').toLowerCase() === sector)
  if (!s || (s.confidence_pct ?? 0) / 100 < GATE) continue
  if (!BEAR_DIRS.includes(s.direction)) continue  // configurable bearish trigger set
  bearCalls++
  const start = nextIdx(row.date)
  if (start >= 0) bearFlags.push({ sym: row.ticker, start })
}

// turn flags into a per-ticker "flat" mask
function maskFromFlags(flags) {
  const flat = {}; for (const s of UNIVERSE) flat[s] = new Uint8Array(T)
  for (const f of flags) { if (!flat[f.sym]) continue; for (let k = 0; k < FLAT && f.start + k < T; k++) flat[f.sym][f.start + k] = 1 }
  return flat
}

// transaction cost charged per side (sell to go flat, buy to re-enter) as a fraction.
const COST = Number(process.env.NT_COST_BPS || 5) / 10000

// ---- simulate an equal-weight buy&hold portfolio, optionally going flat per a mask ----
function simulate(flatMask) {
  // each ticker compounds daily; when flat, that day's return is 0 (cash). On each flat<->in
  // TRANSITION the ticker pays COST (the round-trip = 2 transitions). Equal-weight avg across
  // tickers present that day. Returns the portfolio daily-return series.
  const port = new Float64Array(T)
  const prevFlat = {}; for (const s of UNIVERSE) prevFlat[s] = 0
  for (let i = 0; i < T; i++) {
    let day = 0, cnt = 0
    for (const s of UNIVERSE) {
      if (!present[s][i]) continue
      cnt++
      const isFlat = flatMask ? flatMask[s][i] : 0
      let r = isFlat ? 0 : ret[s][i]
      if (flatMask && isFlat !== prevFlat[s]) r -= COST   // pay cost on enter-flat and exit-flat
      prevFlat[s] = isFlat
      day += r
    }
    port[i] = cnt ? day / cnt : 0
  }
  return port
}

// ---- metrics over an index range [lo,hi) (default whole series) ----
function metrics(port, lo = 0, hi = T) {
  const n = hi - lo
  let eq = 1, peak = 1, mdd = 0, mean = 0
  for (let i = lo; i < hi; i++) { eq *= 1 + port[i]; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); mean += port[i] }
  mean /= n
  let v = 0; for (let i = lo; i < hi; i++) v += (port[i] - mean) ** 2; v /= n
  const sd = Math.sqrt(v)
  return { totalRet: (eq - 1) * 100, ann: (eq ** (252 / n) - 1) * 100, vol: sd * Math.sqrt(252) * 100, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0, mdd: mdd * 100, end: eq }
}

// ---- run: baseline, sell-on-bear, and a random-flat control (same # ticker-days) ----
const base = simulate(null)
const bear = simulate(maskFromFlags(bearFlags))
const flatDays = bearFlags.length * FLAT
// random control: scatter the same number of ticker-days uniformly (seeded-ish via index mix)
function randomFlags(n) {
  const flags = []
  for (let j = 0; j < n; j++) { const sym = UNIVERSE[(j * 7 + 3) % UNIVERSE.length]; const start = (j * 101 + 17) % T; flags.push({ sym, start }) }
  return flags
}
const rand = simulate(maskFromFlags(randomFlags(bearFlags.length)))

const mb = metrics(base), mr = metrics(bear), mc = metrics(rand)

// ---- Monte Carlo control: many random de-risk schedules of the SAME size ----
// where does sell-on-bear's Sharpe / maxDD rank vs pure random exposure-cutting?
const N_MC = Number(process.env.NT_MC || 300)
const mcSharpe = [], mcMdd = []
for (let t = 0; t < N_MC; t++) {
  const flags = []
  for (let j = 0; j < bearFlags.length; j++) flags.push({ sym: UNIVERSE[(Math.random() * UNIVERSE.length) | 0], start: (Math.random() * T) | 0 })
  const m = metrics(simulate(maskFromFlags(flags)))
  mcSharpe.push(m.sharpe); mcMdd.push(m.mdd)
}
const pctRank = (arr, v) => (100 * arr.filter((x) => x <= v).length / arr.length)
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
const pct = (x) => (x >= 0 ? '+' : '') + x.toFixed(1)
console.log(`\n=== OVERLAY BACKTEST — held-out ${CUTOFF}..2024, ${UNIVERSE.length} tickers, ${T} trading days ===`)
console.log(`bearish calls (conf>=${GATE}): ${bearCalls}  ->  ${bearFlags.length} flat-windows x ${FLAT}d = ${flatDays} ticker-days flat  | tx cost ${(COST * 1e4).toFixed(0)}bps/side`)
console.log(`\n%-22s  total    ann     vol    Sharpe   maxDD`.replace('%-22s', 'strategy'.padEnd(22)))
const row = (name, m) => console.log(`${name.padEnd(22)}  ${pct(m.totalRet).padStart(6)}%  ${pct(m.ann).padStart(5)}%  ${m.vol.toFixed(1).padStart(5)}%  ${m.sharpe.toFixed(2).padStart(5)}  ${pct(m.mdd).padStart(6)}%`)
row('buy & hold (base)', mb)
row('sell-on-bear', mr)
row('random-flat (control)', mc)

// ---- per-year sub-period robustness: does the overlay help every regime, or only crashes? ----
console.log(`\n=== SUB-PERIOD (per calendar year) — Sharpe & maxDD, base -> sell-on-bear ===`)
console.log(`year   base_Shp  bear_Shp   base_DD   bear_DD    overlay edge`)
const years = [...new Set(cal.map((d) => d.slice(0, 4)))]
for (const y of years) {
  let lo = -1, hi = -1
  for (let i = 0; i < T; i++) { if (cal[i].slice(0, 4) === y) { if (lo < 0) lo = i; hi = i } }
  if (lo < 0 || hi - lo < 20) continue   // skip stub years
  const a = metrics(base, lo, hi + 1), b = metrics(bear, lo, hi + 1)
  const dShp = b.sharpe - a.sharpe, dDD = b.mdd - a.mdd
  const verdict = (dShp > 0.03 && dDD >= -0.2) ? 'helps' : (dShp < -0.05 ? 'HURTS' : 'flat')
  console.log(`${y}   ${a.sharpe.toFixed(2).padStart(7)}  ${b.sharpe.toFixed(2).padStart(7)}   ${a.mdd.toFixed(1).padStart(7)}%  ${b.mdd.toFixed(1).padStart(7)}%   dShp ${(dShp >= 0 ? '+' : '') + dShp.toFixed(2)} ${verdict}`)
}
console.log(`\n=== MONTE CARLO (${N_MC} random de-risk schedules, same ${flatDays} ticker-days) ===`)
console.log(`random Sharpe: mean ${mean(mcSharpe).toFixed(3)} | sell-on-bear ${mr.sharpe.toFixed(3)} = ${pctRank(mcSharpe, mr.sharpe).toFixed(0)}th pct`)
console.log(`random maxDD:  mean ${mean(mcMdd).toFixed(1)}% | sell-on-bear ${mr.mdd.toFixed(1)}% = ${pctRank(mcMdd, mr.mdd).toFixed(0)}th pct (higher pct = shallower DD = better)`)
console.log(`\nREAD: a real downside signal lands in the TOP tail of BOTH (high Sharpe-pct AND high`)
console.log(`shallow-DD-pct). Mid-pack (~50th) => the overlay is just cutting exposure, not skill.`)
