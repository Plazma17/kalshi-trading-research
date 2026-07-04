// PER-STOCK variant: trade the SPECIFIC ticker the headline is about (not its whole
// sector), using the model's directional call for that ticker's sector. Streams a
// single-config run to the RUNNING tab, then runs the 64-window robustness gauntlet.
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
const STATUS = join(process.env.APPDATA, 'news-trader-app', 'default-workspace', 'running-status.json')

const DIR = z.enum(['bear', 'down', 'neutral', 'up', 'bull'])
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const Lean = z.object({ signals: z.array(z.object({ topic: z.string(), direction: DIR, confidence_pct: z.number().int().min(0).max(100) })) })
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t

function readCsv() {
  return new Promise((res, rej) => {
    const out = []
    Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString(), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej })
  })
}
async function classify(h) {
  const r = await ollama.chat({ model: 'qwen2.5:14b', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: h }], format: zodToJsonSchema(Lean, { $refStrategy: 'none' }), options: { temperature: 0 }, keep_alive: '30m' })
  return Lean.parse(JSON.parse(r.message.content)).signals
}
async function getBars(sym) {
  try { const r = await yf.chart(sym, { period1: '2013-01-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null && q.close != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] }
}

const phash = createHash('md5').update(SYSTEM).digest('hex').slice(0, 8)
const cacheFile = join(here, 'classified-cache.json')
let cache = {}
if (existsSync(cacheFile)) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')) } catch {} }
const articles = (await readCsv()).sort((a, b) => (a.date < b.date ? -1 : 1))
const classified = []
for (const a of articles) { const key = phash + '|' + a.headline; if (!cache[key]) cache[key] = await classify(a.headline); classified.push({ ...a, signals: cache[key] }) }
console.log('fetching prices…')
const bars = {}
for (const s of [...new Set(Object.values(MAP).flat())]) bars[s] = await getBars(s)
const spy = bars['SPY'] || []

const HORIZONS = [1, 3, 5, 10]
const allTrades = []
for (const a of classified) {
  const T = a.ticker, sector = REV[T]; if (!sector) continue
  const sig = a.signals.find((s) => s.topic.toLowerCase() === sector); if (!sig) continue
  const sign = Math.sign(SCORE[sig.direction]); if (sign === 0) continue
  const b = bars[T]; if (!b || !b.length) continue
  const d = a.date.slice(0, 10)
  const entryBar = b.find((x) => x.date > d); if (!entryBar) continue
  const idx = b.findIndex((x) => x.date >= entryBar.date)
  const si = spy.findIndex((x) => x.date >= entryBar.date)
  const fwd = {}, exc = {}
  for (const H of HORIZONS) { const exit = b[idx + H], sx = spy[si + H], se = spy[si]; if (exit) { const r = (exit.close / entryBar.open - 1) * 100; fwd[H] = r; const sm = se && sx ? (sx.close / se.open - 1) * 100 : 0; exc[H] = sign * (r - sm) } }
  allTrades.push({ date: entryBar.date, sign, conf: sig.confidence_pct / 100, fwd, exc, topic: sector, symbol: T, direction: sig.direction })
}
allTrades.sort((a, b) => (a.date < b.date ? -1 : 1))
console.log(`per-stock candidate trades: ${allTrades.length}`)

const byDir = {}
for (const t of allTrades.filter((x) => x.conf >= 0.7 && x.fwd[3] != null)) { const k = t.direction; byDir[k] = byDir[k] || { n: 0, c: 0 }; byDir[k].n++; if (Math.sign(t.fwd[3]) === t.sign) byDir[k].c++ }
console.log('per-stock by direction (3d, conf>=0.7):')
for (const [k, v] of Object.entries(byDir).sort()) console.log(`  ${k.padEnd(8)} n=${String(v.n).padStart(3)} acc=${(100 * v.c / v.n).toFixed(0)}%`)

// ── stream single config (h3 conf0.7 size2%) to the RUNNING tab, paced ──
const SIZE = 0.02, H = 3, MINC = 0.7, INITIAL = 10000
let eq = 1, mneq = 1, n = 0, c = 0
const equity = [], feed = []
const startedAt = new Date().toISOString()
const live = allTrades.filter((t) => t.conf >= MINC && t.fwd[H] != null && t.sign < 0) // SHORT-only
for (let i = 0; i < live.length; i++) {
  const t = live[i]
  const pnl = t.sign * t.fwd[H] - 0.1
  eq *= 1 + SIZE * (pnl / 100); mneq *= 1 + SIZE * (t.exc[H] / 100)
  n++; if (Math.sign(t.fwd[H]) === t.sign) c++
  equity.push({ x: (i + 1) / live.length, v: INITIAL * eq })
  feed.unshift({ date: t.date, topic: t.topic, direction: t.direction, symbol: t.symbol, fwd: t.fwd[H], correct: Math.sign(t.fwd[H]) === t.sign })
  const pnl = (eq - 1) * 100, mn = (mneq - 1) * 100
  const bignums = [
    { label: 'DIRECTIONAL ACCURACY', value: `${(100 * c / n).toFixed(1)}%` },
    { label: 'P&L (SIZED)', value: `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%`, tone: pnl >= 0 ? 'ok' : 'bad' },
    { label: 'MARKET-NEUTRAL', value: `${mn >= 0 ? '+' : ''}${mn.toFixed(1)}%`, tone: mn >= 0 ? 'ok' : 'bad' },
    { label: 'TRADES', value: n.toLocaleString() }
  ]
  writeFileSync(STATUS, JSON.stringify({ active: i < live.length - 1, label: 'PER-STOCK SHORT-ONLY (down/bear calls, h3 conf0.7 size2%)', kind: 'backtest', phase: i < live.length - 1 ? 'scoring' : 'done', message: `Trade ${i + 1}/${live.length}: SHORT ${t.symbol} (${t.direction})`, fraction: (i + 1) / live.length, trades: n, accuracy: c / n, pnlPct: pnl, marketNeutralPct: mn, bignums, chartLabel: 'NET WORTH OVER TIME (sized)', equity: equity.length <= 300 ? equity : equity.filter((_, k) => k % Math.ceil(equity.length / 300) === 0), initialNetWorth: INITIAL, feed: feed.slice(0, 40), startedAt, updatedAt: new Date().toISOString() }))
  await new Promise((r) => setTimeout(r, 20)) // pace it so the curve visibly builds
}
console.log(`single-config: ${n} trades, acc ${((100 * c) / Math.max(n, 1)).toFixed(0)}%, sized P&L ${((eq - 1) * 100).toFixed(1)}%, market-neutral ${((mneq - 1) * 100).toFixed(1)}%`)

// ── 64-window robustness ──
const ds = classified.map((a) => +new Date(a.date)).sort((a, b) => a - b)
const minD = ds[0], maxD = ds[ds.length - 1], DAY = 86400000
const windows = []
for (let i = 0; i < 100; i++) { const len = (60 + Math.floor(Math.random() * 340)) * DAY; const start = minD + Math.floor(Math.random() * Math.max(1, maxD - minD - len)); windows.push([new Date(start).toISOString().slice(0, 10), new Date(start + len).toISOString().slice(0, 10)]) }
function evalSet({ horizon, minConf, size, side }) {
  const f = size / 100, perWin = []
  const sideOk = (t) => (side === 'both' ? true : side === 'short' ? t.sign < 0 : t.sign > 0)
  for (const [w0, w1] of windows) {
    let e = 1, mn = 1, nn = 0, cc = 0
    const ts = allTrades.filter((t) => t.conf >= minConf && sideOk(t) && t.date >= w0 && t.date <= w1 && t.fwd[horizon] != null)
    for (const t of ts) { const pnl = t.sign * t.fwd[horizon] - 0.1; e *= 1 + f * (pnl / 100); mn *= 1 + f * (t.exc[horizon] / 100); nn++; if (Math.sign(t.fwd[horizon]) === t.sign) cc++ }
    if (nn >= 5) perWin.push({ mn: (mn - 1) * 100, acc: cc / nn })
  }
  const profit = perWin.filter((p) => p.mn > 0).length
  const accs = perWin.reduce((s, p) => s + p.acc, 0) / (perWin.length || 1)
  const mns = perWin.map((p) => p.mn).sort((a, b) => a - b)
  return { wins: profit, total: perWin.length, pct: perWin.length ? profit / perWin.length : 0, worst: mns[0] || 0, acc: accs }
}
const grid = []
for (const side of ['short', 'both', 'long']) for (const horizon of [2, 3, 5]) for (const minConf of [0.5, 0.6, 0.7]) grid.push({ horizon, minConf, size: 2, side })
const results = grid.map((g) => ({ ...g, ...evalSet(g) })).sort((a, b) => b.pct - a.pct)
console.log(`\n=== PER-STOCK ROBUSTNESS across 100 random windows (by side) ===`)
console.log('param set                      | % windows profitable | worst  | avg acc')
for (const r of results.slice(0, 12)) console.log(`  ${r.side.padEnd(5)} h=${String(r.horizon).padStart(2)}d conf>=${r.minConf}  |   ${(100 * r.pct).toFixed(0).padStart(3)}% (${r.wins}/${r.total})       | ${r.worst.toFixed(1).padStart(6)}% | ${(100 * r.acc).toFixed(0)}%`)
console.log(`\nBEST per-stock set: profitable in ${(100 * results[0].pct).toFixed(0)}% of windows (need ~80%+ with positive worst-case for a real edge).`)
