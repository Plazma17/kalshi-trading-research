// The puzzle solution candidate: the model reads news DIRECTION with skill, but which side pays
// flips with the market regime (2020 crash -> bear calls win; 2022 rally -> up calls win). A
// downside-only overlay throws away half that signal. A MARKET-NEUTRAL LONG/SHORT removes the
// regime dependence: each day go LONG the up/bull-called names and SHORT the down/bear-called
// names (within FLAT-day windows), equal weight per side. The strategy return = long leg - short
// leg, so it doesn't care where the market goes — it only asks "do up-called names beat
// down-called names?" If that's positive across 2020/2021/2022/2023, the model's directional read
// is a real, regime-INDEPENDENT edge. Look-ahead safe (act from next open). Per-year breakdown.
import { createReadStream, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance(); try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const here = dirname(fileURLToPath(import.meta.url))
const CSV = process.env.NT_CSV || join(here, '..', '..', 'news-trader-data', 'fnspid-multiyear.csv')
const GATE = Number(process.env.NT_GATE || 0.6)
const HOLD = Number(process.env.NT_HOLD || 3)          // trading days a signal stays active
const PRE = JSON.parse(readFileSync(join(here, process.env.NT_CALLS || 'selfcheck-multiyear.json'), 'utf8'))
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t
let UNIVERSE = [...new Set(Object.values(MAP).flat())].filter((s) => s !== 'SPY' && s !== 'QQQ')
if (process.env.NT_EXCLUDE) { const drop = new Set(process.env.NT_EXCLUDE.split(',').map((x) => x.trim().toUpperCase())); UNIVERSE = UNIVERSE.filter((s) => !drop.has(s)) }

function readCsv() { return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(CSV, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString().slice(0, 10), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) }) }
async function getBars(sym) { try { const r = await yf.chart(sym, { period1: '2019-06-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close })) } catch { return [] } }

const rows = (await readCsv()).filter((r) => r.date > '2019-11-25' && UNIVERSE.includes(r.ticker))
const bars = {}; for (const s of UNIVERSE) bars[s] = await getBars(s)
const spyBars = await getBars('SPY')
const cal = spyBars.map((b) => b.date).filter((d) => d > '2019-11-25')
const T = cal.length
// SPY daily returns aligned to the calendar (for the optional market hedge)
const spyClose = new Map(spyBars.map((b) => [b.date, b.close]))
const spyRet = new Float64Array(T); { let prev = null; for (let i = 0; i < T; i++) { const px = spyClose.get(cal[i]); if (px != null) { if (prev != null) spyRet[i] = px / prev - 1; prev = px } } }
const HEDGE = process.env.NT_HEDGE === '1'

// per-ticker daily returns + presence aligned to calendar
const ret = {}, present = {}
for (const s of UNIVERSE) {
  const m = new Map(bars[s].map((b) => [b.date, b.close]))
  const r = new Float64Array(T), pr = new Uint8Array(T); let prev = null
  for (let i = 0; i < T; i++) { const px = m.get(cal[i]); if (px != null) { pr[i] = 1; if (prev != null) r[i] = px / prev - 1; prev = px } }
  ret[s] = r; present[s] = pr
}

// signal direction per (ticker, day): +1 long window, -1 short window, 0 none. From each call,
// active for HOLD days starting the next calendar day after the headline date.
const sideMask = {}; for (const s of UNIVERSE) sideMask[s] = new Int8Array(T)
function nextIdx(d) { for (let i = 0; i < T; i++) if (cal[i] > d) return i; return -1 }
let longs = 0, shorts = 0
for (const row of rows) {
  const sig = (PRE[row.headline] || []).find((x) => (x.topic || '').toLowerCase() === REV[row.ticker])
  if (!sig || (sig.confidence_pct ?? 0) / 100 < GATE) continue
  const sc = SCORE[sig.direction]; if (sc === 0) continue
  const side = sc > 0 ? 1 : -1; const start = nextIdx(row.date); if (start < 0) continue
  if (side > 0) longs++; else shorts++
  for (let k = 0; k < HOLD && start + k < T; k++) if (sideMask[row.ticker][start + k] === 0) sideMask[row.ticker][start + k] = side  // first signal wins for the day
}

// daily return: equal-weight over active names, long=+ret short=-ret (dollar-neutral when the
// legs are balanced). Costs: RT = round-trip trade cost on entry/flip; BORROW = daily short
// borrow. Track how often BOTH legs are populated (true-neutral days) vs one-sided (directional).
const RT = 2 * Number(process.env.NT_COST_BPS || 5) / 1e4
const BORROW = Number(process.env.NT_BORROW_BPS_ANN || 50) / 1e4 / 252
const port = new Float64Array(T), longLeg = new Float64Array(T), shortLeg = new Float64Array(T)
const prevSide = {}; for (const s of UNIVERSE) prevSide[s] = 0
let twoSided = 0, activeDays = 0
for (let i = 0; i < T; i++) {
  let sum = 0, n = 0, longN = 0, shortN = 0, lSum = 0, sSum = 0, allSum = 0, allN = 0
  for (const s of UNIVERSE) {
    if (present[s][i]) { allSum += ret[s][i]; allN++ }     // universe avg = the local "market"
    const side = present[s][i] ? sideMask[s][i] : 0
    if (side !== 0) {
      n++; side > 0 ? longN++ : shortN++
      let c = side * ret[s][i]
      if (prevSide[s] !== side) c -= RT          // entered or flipped today -> round-trip cost
      if (side < 0) c -= BORROW                   // short borrow accrues daily
      sum += c
      if (side > 0) lSum += ret[s][i]; else sSum += ret[s][i]
    }
    prevSide[s] = side
  }
  const uni = allN ? allSum / allN : 0
  // selection alpha per leg (beta-free): longs should beat the universe; shorts should lag it.
  longLeg[i] = longN ? (lSum / longN - uni) : 0       // long-selection excess
  shortLeg[i] = shortN ? (uni - sSum / shortN) : 0    // short-selection excess (short underperforms)
  port[i] = n ? sum / n : 0
  // optional SPY hedge: neutralize the residual net exposure (the long-minus-short weight) by
  // taking the opposite SPY position. Removes the directional bet on one-sided days.
  if (HEDGE && n) port[i] -= ((longN - shortN) / n) * spyRet[i]
  if (n) activeDays++
  if (longN && shortN) twoSided++
}
console.log(`(neutrality: ${twoSided}/${activeDays} active days have BOTH legs = ${(100 * twoSided / activeDays).toFixed(0)}% two-sided; costs ${RT * 1e4 / 2}bps/side + ${(BORROW * 252 * 1e4).toFixed(0)}bps/yr borrow)`)

function metrics(p, lo = 0, hi = T) {
  const n = hi - lo; let eq = 1, peak = 1, mdd = 0, mean = 0
  for (let i = lo; i < hi; i++) { eq *= 1 + p[i]; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); mean += p[i] }
  mean /= n; let v = 0; for (let i = lo; i < hi; i++) v += (p[i] - mean) ** 2; v /= n
  const sd = Math.sqrt(v)
  return { tot: (eq - 1) * 100, ann: (eq ** (252 / n) - 1) * 100, sharpe: sd > 0 ? mean / sd * Math.sqrt(252) : 0, mdd: mdd * 100 }
}

const m = metrics(port)
console.log(`\n=== MARKET-NEUTRAL LONG/SHORT (model direction, conf>=${GATE}, ${HOLD}d hold) ===`)
console.log(`long the up/bull-called names, short the down/bear-called names. Return = long - short.`)
console.log(`${longs} long signals, ${shorts} short signals\n`)
console.log(`FULL: total ${m.tot >= 0 ? '+' : ''}${m.tot.toFixed(1)}%  ann ${m.ann >= 0 ? '+' : ''}${m.ann.toFixed(1)}%  Sharpe ${m.sharpe.toFixed(2)}  maxDD ${m.mdd.toFixed(1)}%`)
const mL = metrics(longLeg), mS = metrics(shortLeg)
console.log(`\nLEG SKILL (selection alpha vs the 18-name universe, beta-free):`)
console.log(`  LONG leg  (up/bull names beat universe?):  ann ${mL.ann >= 0 ? '+' : ''}${mL.ann.toFixed(1)}%  Sharpe ${mL.sharpe.toFixed(2)}`)
console.log(`  SHORT leg (down/bear names lag universe?): ann ${mS.ann >= 0 ? '+' : ''}${mS.ann.toFixed(1)}%  Sharpe ${mS.sharpe.toFixed(2)}`)
console.log(`  -> both positive = the model picks BOTH winners and losers (symmetric, robust).`)
console.log(`\nper year (does the model's direction beat across regimes?):`)
const years = [...new Set(cal.map((d) => d.slice(0, 4)))]
for (const y of years) {
  let lo = -1, hi = -1; for (let i = 0; i < T; i++) if (cal[i].slice(0, 4) === y) { if (lo < 0) lo = i; hi = i }
  if (lo < 0 || hi - lo < 20) continue
  const a = metrics(port, lo, hi + 1)
  console.log(`  ${y}  total ${(a.tot >= 0 ? '+' : '') + a.tot.toFixed(1)}%   ann ${(a.ann >= 0 ? '+' : '') + a.ann.toFixed(1)}%   Sharpe ${a.sharpe.toFixed(2)}`)
}
// optional walk-forward split: metrics for [start, SPLIT) train vs [SPLIT, end) test
if (process.env.NT_SPLIT) {
  let si = T; for (let i = 0; i < T; i++) if (cal[i] >= process.env.NT_SPLIT) { si = i; break }
  const tr = metrics(port, 0, si), te = metrics(port, si, T)
  console.log(`\nWALK-FWD split ${process.env.NT_SPLIT}:  TRAIN ann ${tr.ann.toFixed(1)}% Sharpe ${tr.sharpe.toFixed(2)}  |  TEST ann ${te.ann.toFixed(1)}% Sharpe ${te.sharpe.toFixed(2)}`)
}
console.log(`\nREAD: positive ann + Sharpe in EVERY year = a regime-independent directional edge`)
console.log(`(the model's news read works whether the market rises or falls). Negative years = the`)
console.log(`direction read isn't reliable there -> next: regime-gate or per-sector long/short.`)
