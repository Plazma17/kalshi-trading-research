// Per-ticker news signal: which names actually move predictably on news, and which are noise?
// For each ticker, on the held-out set, measure (a) RESPONSIVENESS — do news days move more
// than a typical 3d window? — and (b) PREDICTABILITY — the self-check model's directional
// accuracy + mean signed 3d return on that ticker's calls. The keepers respond to news AND the
// model calls them right. (Caveat: this data is ~2020-only, so treat as a within-2020 read.)
import { createReadStream, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import Papa from 'papaparse'
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance(); try { yf.suppressNotices?.(['yahooSurvey', 'ripHistorical']) } catch {}
const here = dirname(fileURLToPath(import.meta.url))
const file = process.env.NT_CSV || join(here, '..', '..', 'news-trader-data', 'fnspid-universe.csv')
const CUTOFF = '2019-11-25'
const GATE = Number(process.env.NT_GATE || 0.6)
const PRE = JSON.parse(readFileSync(join(here, process.env.NT_CALLS || 'selfcheck-classifications.json'), 'utf8'))
const SCORE = { bull: 2, up: 1, neutral: 0, down: -1, bear: -2 }
const MAP = { oil: ['XOM', 'CVX', 'OXY', 'SLB'], semiconductors: ['NVDA', 'AMD', 'AMAT', 'MU'], airlines: ['DAL', 'UAL', 'AAL'], defense: ['LMT', 'RTX', 'NOC'], banks: ['JPM', 'BAC', 'GS', 'KRE'], gold: ['NEM', 'GOLD'], market: ['SPY', 'QQQ'] }
const REV = {}; for (const [t, syms] of Object.entries(MAP)) for (const s of syms) REV[s] = t

function readCsv() { return new Promise((res, rej) => { const out = []; Papa.parse(createReadStream(file, 'utf8'), { header: true, skipEmptyLines: true, step: (r) => { const d = new Date(r.data.date); if (!isNaN(d)) out.push({ headline: r.data.headline, date: d.toISOString().slice(0, 10), ticker: (r.data.ticker || '').trim().toUpperCase() }) }, complete: () => res(out), error: rej }) }) }
async function getBars(sym) { try { const r = await yf.chart(sym, { period1: '2019-06-01', period2: '2024-07-01', interval: '1d' }); return (r.quotes ?? []).filter((q) => q.open != null).map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close })) } catch { return [] } }

const rows = (await readCsv()).filter((r) => r.date > CUTOFF && REV[r.ticker])
const syms = [...new Set(rows.map((r) => r.ticker))]
const bars = {}; for (const s of syms) bars[s] = await getBars(s)

// baseline typical 3d move per ticker (abs return over every open->+3 close window)
function baseMove(b) { let s = 0, n = 0; for (let i = 0; i + 3 < b.length; i++) { s += Math.abs(b[i + 3].close / b[i + 1].open - 1); n++ } return n ? s / n : 0 }

const T = {}
for (const s of syms) T[s] = { news: 0, newsMove: 0, call: 0, c: 0, sn: 0, sc: 0, signed: 0, base: baseMove(bars[s]) }
function fwd(b, d) { const e = b.find((x) => x.date > d); if (!e) return null; const i = b.findIndex((x) => x.date >= e.date); const x = b[i + 3]; return x ? x.close / e.open - 1 : null }

for (const row of rows) {
  const b = bars[row.ticker]; if (!b?.length) continue
  const f = fwd(b, row.date); if (f == null) continue
  const t = T[row.ticker]
  t.news++; t.newsMove += Math.abs(f)
  const sig = (PRE[row.headline] || []).find((x) => (x.topic || '').toLowerCase() === REV[row.ticker])
  if (!sig || (sig.confidence_pct ?? 0) / 100 < GATE) continue
  const sign = Math.sign(SCORE[sig.direction]); if (sign === 0) continue
  t.call++; t.signed += sign * f
  if (Math.sign(f) === sign) t.c++
  if (sign < 0) { t.sn++; if (Math.sign(f) === sign) t.sc++ }
}

const out = syms.map((s) => {
  const t = T[s]
  return { s, sector: REV[s], news: t.news, resp: t.news ? (t.newsMove / t.news) / (t.base || 1) : 0,
    call: t.call, acc: t.call ? t.c / t.call : null, shortN: t.sn, shortAcc: t.sn ? t.sc / t.sn : null,
    signed: t.call ? 100 * t.signed / t.call : null }
}).sort((a, b) => (b.signed ?? -99) - (a.signed ?? -99))

console.log(`\nPER-TICKER NEWS SIGNAL (self-check calls, conf>=${GATE}, 3d) — ~2020 data\n`)
console.log(`tkr  sector        news  respX  calls  acc    shortAcc(n)   meanSigned%`)
for (const r of out) {
  const acc = r.acc == null ? '  —' : `${(100 * r.acc).toFixed(0)}%`
  const sa = r.shortAcc == null ? '  —' : `${(100 * r.shortAcc).toFixed(0)}%`
  const sg = r.signed == null ? '  —' : `${r.signed >= 0 ? '+' : ''}${r.signed.toFixed(2)}`
  console.log(`${r.s.padEnd(4)} ${r.sector.padEnd(13)} ${String(r.news).padStart(4)}  ${r.resp.toFixed(2).padStart(5)}  ${String(r.call).padStart(5)}  ${acc.padStart(4)}   ${sa.padStart(4)} (${String(r.shortN).padStart(2)})     ${sg.padStart(7)}`)
}
console.log(`\nrespX = avg |news-day 3d move| / typical |3d move| (>1 = news days move more than usual).`)
console.log(`meanSigned% = avg 3d return in the model's called direction (the per-ticker edge). Positive = the model's calls on this name make money; rank picks the news-tradeable tickers.`)
