// scan_worker.js — Node worker-thread scan engine for the Window Analysis tab.
// This is the FALLBACK / always-runnable engine (mirrors the Rust cta_scan query contract exactly).
// It exists because Smart App Control on this machine blocks Electron from spawning the unsigned
// Rust binary; the worker runs inside the already-signed Node/Electron process, off the UI thread.
// It parses the ticklog archive into columnar typed arrays ONCE and caches by path+mtime, so repeated
// queries (pivot/corr/windows/dist) are near-instant after the first load.
'use strict'
const { parentPort, workerData } = require('worker_threads')
const fs = require('fs')

const F32 = [
  'secleft', 'elapsed', 'mid', 'fair', 'dev', 'btc', 'strike', 'zstrike', 'sig', 'calk',
  'ya', 'na', 'yb', 'nb', 'cfmean', 'tfi', 'tvol', 'btcobi', 'btcspread', 'eth', 'sol'
]
// derived + forward columns filled in pass 2
const F32X = ['mid_d1', 'mid_d2', 'tfi_cum', 'mv10', 'mv30', 'mv60', 'mv120', 'mv300', 'settle']

const METRIC_NAMES = [
  't', 'secleft', 'elapsed', 'mid', 'fair', 'dev', 'btc', 'strike', 'zstrike', 'sig', 'calk',
  'ya', 'na', 'yb', 'nb', 'cfmean', 'tfi', 'tvol', 'btcobi', 'btcspread', 'eth', 'sol', 'pf',
  'dist', 'sdist', 'spread', 'mid_d1', 'mid_d2', 'tfi_cum', 'hour', 'weekday', 'mv10', 'mv30',
  'mv60', 'mv120', 'mv300', 'settle', 'settle_bin'
]

let DS = null // { path, mtime, n, cols, t, win, wins:[[s,e]], tkOfWin:[] }

function countLines(buf) {
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
  return n + 1
}

function load(path, qid) {
  const st = fs.statSync(path)
  if (DS && DS.path === path && DS.mtime === st.mtimeMs) return DS
  const buf = fs.readFileSync(path)
  const cap = countLines(buf)
  const cols = {}
  for (const k of F32.concat(F32X)) cols[k] = new Float32Array(cap)
  const t = new Float64Array(cap)
  const win = new Int32Array(cap)
  const tkHash = new Float64Array(cap) // store a numeric hash for grouping
  const tkStr = new Array(cap)         // keep tk string (needed for window catalog); ~cap refs
  let n = 0
  let start = 0
  const total = buf.length
  let nextProg = total / 20
  for (let i = 0; i <= total; i++) {
    if (i === total || buf[i] === 10) {
      if (i > start) {
        let obj = null
        try { obj = JSON.parse(buf.toString('utf8', start, i)) } catch (e) { obj = null }
        if (obj && typeof obj.t === 'number') {
          for (const k of F32) { const v = obj[k]; cols[k][n] = (typeof v === 'number') ? v : NaN }
          t[n] = obj.t
          const tk = typeof obj.tk === 'string' ? obj.tk : ''
          tkStr[n] = tk
          // cheap string hash
          let h = 2166136261
          for (let c = 0; c < tk.length; c++) { h ^= tk.charCodeAt(c); h = Math.imul(h, 16777619) }
          tkHash[n] = h
          n++
        }
      }
      start = i + 1
      if (i >= nextProg) { nextProg += total / 20; if (parentPort) parentPort.postMessage({ id: qid, progress: Math.round((i / total) * 100) }) }
    }
  }
  // windows
  const wins = []
  const tkOfWin = []
  if (n > 0) {
    let cur = 0, wstart = 0, prev = tkHash[0]
    win[0] = 0
    tkOfWin.push(tkStr[0])
    for (let i = 1; i < n; i++) {
      if (tkHash[i] !== prev) {
        wins.push([wstart, i]); cur++; wstart = i; prev = tkHash[i]; tkOfWin.push(tkStr[i])
      }
      win[i] = cur
    }
    wins.push([wstart, n])
  }
  // pass 2: derived + causal forward moves + settle (per window)
  const horizons = [10, 30, 60, 120, 300]
  const mvCols = [cols.mv10, cols.mv30, cols.mv60, cols.mv120, cols.mv300]
  for (const [s, e] of wins) {
    const settle = cols.mid[e - 1]
    let tfiCum = 0
    for (let idx = s; idx < e; idx++) {
      cols.settle[idx] = settle
      if (idx > s) {
        const dt = t[idx] - t[idx - 1]
        cols.mid_d1[idx] = dt > 0 ? (cols.mid[idx] - cols.mid[idx - 1]) / dt : 0
        const tv = cols.tfi[idx]
        if (isFinite(tv) && dt > 0) tfiCum += tv * dt
      } else cols.mid_d1[idx] = 0
      cols.tfi_cum[idx] = tfiCum
    }
    for (let idx = s; idx < e; idx++) {
      if (idx > s) {
        const dt = t[idx] - t[idx - 1]
        cols.mid_d2[idx] = dt > 0 ? (cols.mid_d1[idx] - cols.mid_d1[idx - 1]) / dt : 0
      } else cols.mid_d2[idx] = 0
    }
    for (let hi = 0; hi < horizons.length; hi++) {
      const h = horizons[hi]; const out = mvCols[hi]; let j = s
      for (let idx = s; idx < e; idx++) {
        const target = t[idx] + h
        if (j <= idx) j = idx + 1
        while (j < e && t[j] < target) j++
        out[idx] = j < e ? (cols.mid[j] - cols.mid[idx]) : NaN
      }
    }
  }
  DS = { path, mtime: st.mtimeMs, n, cols, t, win, wins, tkOfWin }
  return DS
}

function metric(ds, i, name) {
  const c = ds.cols
  switch (name) {
    case 't': return ds.t[i]
    case 'elapsed': case 'time': return c.elapsed[i]
    case 'pf': { const m = c.mid[i]; return Math.max(m, 1 - m) }
    case 'dist': return Math.abs(c.cfmean[i] - c.strike[i])
    case 'sdist': return c.cfmean[i] - c.strike[i]
    case 'spread': return c.ya[i] - c.yb[i]
    case 'imbalance': return c.btcobi[i]
    case 'hour': { const tt = ds.t[i]; return isFinite(tt) ? Math.floor((((tt % 86400) + 86400) % 86400) / 3600) : NaN }
    case 'weekday': { const tt = ds.t[i]; return isFinite(tt) ? (((Math.floor(tt / 86400) + 4) % 7) + 7) % 7 : NaN }
    case 'settle_bin': { const s = c.settle[i]; return isFinite(s) ? (s >= 0.5 ? 1 : 0) : NaN }
    default: { const col = c[name]; return col ? col[i] : NaN }
  }
}

function parseFilters(q) {
  const f = (q && q.filters) || {}
  const g = (k, d) => (typeof f[k] === 'number' ? f[k] : d)
  let oc = -1
  if (f.outcome === 'yes') oc = 1; else if (f.outcome === 'no') oc = 0
  return {
    date_from: g('date_from', -Infinity), date_to: g('date_to', Infinity),
    secleft_min: g('secleft_min', -Infinity), secleft_max: g('secleft_max', Infinity),
    price_min: g('price_min', -Infinity), price_max: g('price_max', Infinity), outcome: oc
  }
}
function passes(ds, i, f) {
  const tt = ds.t[i]
  if (tt < f.date_from || tt > f.date_to) return false
  const sl = ds.cols.secleft[i]
  if (sl < f.secleft_min || sl > f.secleft_max) return false
  const m = ds.cols.mid[i]
  if (m < f.price_min || m > f.price_max) return false
  if (f.outcome >= 0) { const s = ds.cols.settle[i]; if (!isFinite(s)) return false; if ((s >= 0.5 ? 1 : 0) !== f.outcome) return false }
  return true
}

function pearson(xs, ys) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
  const m = Math.min(xs.length, ys.length)
  for (let i = 0; i < m; i++) {
    const x = xs[i], y = ys[i]
    if (isFinite(x) && isFinite(y)) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y }
  }
  if (n < 2) return [NaN, n]
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n
  const d = Math.sqrt(vx * vy)
  return [d <= 0 ? NaN : cov / d, n]
}
function median(v) { if (!v.length) return NaN; v.sort((a, b) => a - b); const n = v.length; return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2 }
function percentile(sorted, p) { if (!sorted.length) return NaN; const idx = Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)); return sorted[idx] }

function qPivot(ds, q, f, t0) {
  const xa = q.x || {}, ya = q.y || {}
  const xm = xa.metric || 'elapsed', ym = ya.metric || 'pf'
  const xbin = Math.max(1e-9, +xa.bin || 30), ybin = Math.max(1e-9, +ya.bin || 0.05)
  let xmin = xa.min, xmax = xa.max, ymin = ya.min, ymax = ya.max
  const auto = [xmin, xmax, ymin, ymax].some(v => typeof v !== 'number')
  if (auto) {
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity
    for (let i = 0; i < ds.n; i++) {
      if (!passes(ds, i, f)) continue
      const x = metric(ds, i, xm), y = metric(ds, i, ym)
      if (isFinite(x)) { if (x < xlo) xlo = x; if (x > xhi) xhi = x }
      if (isFinite(y)) { if (y < ylo) ylo = y; if (y > yhi) yhi = y }
    }
    if (typeof xmin !== 'number') xmin = xlo
    if (typeof xmax !== 'number') xmax = xhi
    if (typeof ymin !== 'number') ymin = ylo
    if (typeof ymax !== 'number') ymax = yhi
  }
  if (!isFinite(xmin)) xmin = 0; if (!isFinite(xmax)) xmax = 1; if (!isFinite(ymin)) ymin = 0; if (!isFinite(ymax)) ymax = 1
  const nx = Math.min(400, Math.max(1, Math.ceil((xmax - xmin) / xbin)))
  const ny = Math.min(400, Math.max(1, Math.ceil((ymax - ymin) / ybin)))
  const agg = q.agg || 'count', zm = q.z || 'mv60'
  // 3D-heatmap HEIGHT: a SECOND per-cell aggregate (color stays `v`, height becomes `h`). Default
  // hagg='count' so hot-but-thin cells show as short bars. When hagg==='count', h == n (no extra reads).
  const hagg = q.hagg || 'count', hzm = q.hz || zm
  const ncell = nx * ny
  const counts = new Float64Array(ncell), sums = new Float64Array(ncell)
  const needMed = agg === 'median'
  const cellvals = needMed ? Array.from({ length: ncell }, () => []) : null
  const hNeed = hagg !== 'count'
  const hNeedMed = hagg === 'median'
  const hsums = (hNeed && !hNeedMed) ? new Float64Array(ncell) : null
  const hcellvals = hNeedMed ? Array.from({ length: ncell }, () => []) : null
  let total = 0
  for (let i = 0; i < ds.n; i++) {
    if (!passes(ds, i, f)) continue
    const x = metric(ds, i, xm), y = metric(ds, i, ym)
    if (!isFinite(x) || !isFinite(y)) continue
    if (x < xmin || x >= xmax + xbin || y < ymin || y >= ymax + ybin) continue
    let ix = Math.floor((x - xmin) / xbin); if (ix < 0) ix = 0; if (ix >= nx) ix = nx - 1
    let iy = Math.floor((y - ymin) / ybin); if (iy < 0) iy = 0; if (iy >= ny) iy = ny - 1
    const ci = iy * nx + ix
    counts[ci]++; total++
    if (agg !== 'count') { const z = metric(ds, i, zm); if (isFinite(z)) { if (needMed) cellvals[ci].push(z); else sums[ci] += z } }
    if (hNeed) { const hz = metric(ds, i, hzm); if (isFinite(hz)) { if (hNeedMed) hcellvals[ci].push(hz); else hsums[ci] += hz } }
  }
  const cells = []
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const ci = iy * nx + ix, nn = counts[ci]
    if (!nn) continue
    let v
    if (agg === 'count') v = nn
    else if (agg === 'median') v = median(cellvals[ci])
    else v = sums[ci] / nn
    let h
    if (!hNeed) h = nn
    else if (hNeedMed) h = median(hcellvals[ci])
    else h = hsums[ci] / nn
    cells.push({ ix, iy, v, n: nn, h })
  }
  return { type: 'pivot', nx, ny, xmin, xmax, ymin, ymax, xbin, ybin, xlabel: xm, ylabel: ym, agg, zlabel: zm, hagg, hzlabel: hzm, total, cells, elapsed_ms: Date.now() - t0 }
}

function qCorr(ds, q, f, t0) {
  const am = q.a || 'tfi', bm = q.b || 'mv60'
  const lagMax = Math.round(+q.lag_max || 60), lagStep = Math.max(1, Math.round(+q.lag_step || 1))
  const roll = Math.max(2, Math.round(+q.roll || 300))
  const xs = [], ys = [], ts = []
  for (let i = 0; i < ds.n; i++) {
    if (!passes(ds, i, f)) continue
    xs.push(metric(ds, i, am)); ys.push(metric(ds, i, bm)); ts.push(ds.t[i])
  }
  const [r, n] = pearson(xs, ys)
  const valid = []
  for (let i = 0; i < xs.length; i++) if (isFinite(xs[i]) && isFinite(ys[i])) valid.push(i)
  const stride = Math.max(1, Math.floor(valid.length / 5000))
  const scatter = []
  for (let k = 0; k < valid.length; k += stride) { const i = valid[k]; scatter.push([xs[i], ys[i]]) }
  const lags = []
  for (let lag = -lagMax; lag <= lagMax; lag += lagStep) {
    const ax = [], ay = []
    for (let i = 0; i < xs.length; i++) { const j = i + lag; if (j < 0 || j >= ys.length) continue; ax.push(xs[i]); ay.push(ys[j]) }
    const [lr, ln] = pearson(ax, ay); lags.push({ lag, r: lr, n: ln })
  }
  const rolling = []
  if (xs.length >= roll) {
    const npts = xs.length - roll + 1, rstride = Math.max(1, Math.floor(npts / 800))
    for (let i = 0; i + roll <= xs.length; i += rstride) {
      const [rr] = pearson(xs.slice(i, i + roll), ys.slice(i, i + roll))
      rolling.push([ts[i + roll - 1], rr])
    }
  }
  return { type: 'corr', a: am, b: bm, r, n, scatter, lags, rolling, roll, elapsed_ms: Date.now() - t0 }
}

function qWindows(ds, q, t0) {
  const rows = []
  for (let wi = 0; wi < ds.wins.length; wi++) {
    const [s, e] = ds.wins[wi]; const n = e - s; if (n < 2) continue
    const c = ds.cols
    const tOpen = ds.t[s], tClose = ds.t[e - 1], dur = tClose - tOpen
    let bmin = Infinity, bmax = -Infinity, path = 0, tfiSum = 0, obiSum = 0, obiN = 0, retSq = 0, retN = 0
    for (let i = s; i < e; i++) {
      const b = c.btc[i]
      if (isFinite(b)) { if (b < bmin) bmin = b; if (b > bmax) bmax = b }
      if (isFinite(c.tfi[i])) tfiSum += c.tfi[i]
      if (isFinite(c.btcobi[i])) { obiSum += c.btcobi[i]; obiN++ }
      if (i > s) { const d = c.btc[i] - c.btc[i - 1]; if (isFinite(d)) { path += Math.abs(d); retSq += d * d; retN++ } }
    }
    const net = c.btc[e - 1] - c.btc[s]
    const range = bmax > bmin ? bmax - bmin : 0
    const pathEff = path > 0 ? Math.abs(net) / path : 0
    const rvol = retN > 0 ? Math.sqrt(retSq / retN) : 0
    const settle = c.mid[e - 1]
    rows.push({
      wi, tk: ds.tkOfWin[wi] || '', t0: tOpen, dur, n, range, path_eff: pathEff, rvol, drift: net,
      tfi_sum: tfiSum, obi_mean: obiN > 0 ? obiSum / obiN : NaN, strike: c.strike[s],
      dist_open: Math.abs(c.cfmean[s] - c.strike[s]), dist_close: Math.abs(c.cfmean[e - 1] - c.strike[e - 1]),
      settle, settle_bin: settle >= 0.5 ? 1 : 0
    })
  }
  return { type: 'windows', nwin: ds.wins.length, rows, elapsed_ms: Date.now() - t0 }
}

function qDist(ds, q, f, t0) {
  const m = q.metric || 'mv60'
  const nbins = Math.min(400, Math.max(2, Math.round(+q.bins || 60)))
  const vals = []
  for (let i = 0; i < ds.n; i++) { if (!passes(ds, i, f)) continue; const v = metric(ds, i, m); if (isFinite(v)) vals.push(v) }
  if (!vals.length) return { type: 'dist', metric: m, n: 0, bins: [], elapsed_ms: Date.now() - t0 }
  let dlo = Infinity, dhi = -Infinity
  for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (v < dlo) dlo = v; if (v > dhi) dhi = v }
  let lo = (typeof q.min === 'number') ? q.min : dlo
  let hi = (typeof q.max === 'number') ? q.max : dhi
  if (!(hi > lo)) hi = lo + 1
  const bw = (hi - lo) / nbins
  const counts = new Float64Array(nbins)
  for (const v of vals) { if (v < lo || v > hi) continue; let bi = Math.floor((v - lo) / bw); if (bi < 0) bi = 0; if (bi >= nbins) bi = nbins - 1; counts[bi]++ }
  const sorted = vals.slice().sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((a, b) => a + b, 0) / n
  const std = Math.sqrt(sorted.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n)
  const bins = []
  for (let i = 0; i < nbins; i++) { const blo = lo + i * bw; bins.push({ lo: blo, hi: blo + bw, n: counts[i] }) }
  return { type: 'dist', metric: m, n, min: lo, max: hi, mean, median: sorted[Math.floor(n / 2)], std, p5: percentile(sorted, 0.05), p95: percentile(sorted, 0.95), bins, elapsed_ms: Date.now() - t0 }
}

function qCorrMatrix(ds, q, f, t0) {
  const metrics = (q.metrics && q.metrics.length) ? q.metrics : ['tfi', 'tvol', 'btcobi', 'mid_d1', 'dev', 'mv60', 'mv300', 'dist']
  const k = metrics.length
  const data = metrics.map(() => [])
  for (let i = 0; i < ds.n; i++) { if (!passes(ds, i, f)) continue; for (let mi = 0; mi < k; mi++) data[mi].push(metric(ds, i, metrics[mi])) }
  const mat = []
  for (let a = 0; a < k; a++) { mat.push(new Array(k)) }
  for (let a = 0; a < k; a++) for (let b = a; b < k; b++) { const [r] = (a === b) ? [1] : pearson(data[a], data[b]); mat[a][b] = r; mat[b][a] = r }
  return { type: 'corrmatrix', metrics, matrix: mat, n: data[0] ? data[0].length : 0, elapsed_ms: Date.now() - t0 }
}

// ============ LAG MATRIX (5s-binned aligned all-metrics cross-correlation) ============
// PERF: bin every metric into fixed 5s bins, laid out contiguously per 15-min window
// (BPW bins/window). A lag L (in bins) shifts one series by L; correlation pairs bin i with
// bin i+L IFF they belong to the SAME window (floor(i/BPW)===floor((i+L)/BPW)) — so a lag
// never bleeds across the 15-min boundary. Build is done ONCE per (archive mtime × filter),
// cached in DSB; each lag recompute is just an integer-shift + vectorized Pearson per pair.
const LAGM_BIN = 5 // seconds per bin (the perf grid). Lags are meaningful only at multiples of this.
// Superset of metrics binned into DSB (axes-view uses the non-forward subset; the 9x9 preset with
// lag needs mv* so they are included here too).
const LAGM_ALL = [
  'mid', 'fair', 'dev', 'pf', 'cfmean', 'btc', 'strike', 'dist', 'sdist', 'spread',
  'zstrike', 'sig', 'calk', 'ya', 'na', 'yb', 'nb', 'tfi', 'tvol', 'btcobi', 'btcspread',
  'mid_d1', 'mid_d2', 'tfi_cum', 'eth', 'sol', 'mv10', 'mv30', 'mv60', 'mv120', 'mv300'
]
// The LAG MATRIX view axes: exclude forward-looking (mv*) columns to avoid trivial self-lag artifacts.
const LAGM_AXES = LAGM_ALL.filter((m) => !/^mv/.test(m))

let DSB = null // binned store cache: { sig, BIN, BPW, nWin, totalBins, metrics, bins:{name:Float64Array}, buildMs }

function filterSig(f) {
  return [f.date_from, f.date_to, f.secleft_min, f.secleft_max, f.price_min, f.price_max, f.outcome].join('|')
}
function buildBins(ds, f) {
  const BIN = LAGM_BIN
  const sig = ds.path + '@' + ds.mtime + '#' + filterSig(f) + '#' + BIN
  if (DSB && DSB.sig === sig) return DSB
  const tb = Date.now()
  const nWin = ds.wins.length
  let maxSpan = 0
  for (const [s, e] of ds.wins) { const sp = ds.t[e - 1] - ds.t[s]; if (sp > maxSpan) maxSpan = sp }
  const BPW = Math.min(400, Math.max(1, Math.ceil(maxSpan / BIN) + 1))
  const totalBins = nWin * BPW
  const M = LAGM_ALL
  const sums = {}, cnts = {}
  for (const k of M) { sums[k] = new Float64Array(totalBins); cnts[k] = new Float64Array(totalBins) }
  for (let w = 0; w < nWin; w++) {
    const s = ds.wins[w][0], e = ds.wins[w][1], t0w = ds.t[s], base = w * BPW
    for (let i = s; i < e; i++) {
      if (!passes(ds, i, f)) continue
      let b = Math.floor((ds.t[i] - t0w) / BIN); if (b < 0) b = 0; if (b >= BPW) b = BPW - 1
      const gi = base + b
      for (let mi = 0; mi < M.length; mi++) { const name = M[mi]; const v = metric(ds, i, name); if (isFinite(v)) { sums[name][gi] += v; cnts[name][gi]++ } }
    }
  }
  const bins = {}
  for (const k of M) { const S = sums[k], C = cnts[k], A = new Float64Array(totalBins); for (let gi = 0; gi < totalBins; gi++) A[gi] = C[gi] > 0 ? S[gi] / C[gi] : NaN; bins[k] = A }
  DSB = { sig, BIN, BPW, nWin, totalBins, metrics: M, bins, buildMs: Date.now() - tb }
  return DSB
}
// Pearson of X[bin] vs Y[bin+L], pairing only WITHIN the same 15-min window (contiguous BPW bins
// per window). Iterates window-by-window so the same-window guard is loop bounds (no per-element
// division/branch) — this is the hot path the slider hits, so it must stay tight.
function pearsonLag(X, Y, L, BPW, nWin) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
  const iLo = L < 0 ? -L : 0                       // first in-window offset with i+L >= 0
  const iHi = L > 0 ? BPW - L : BPW                 // one past last offset with i+L < BPW
  if (iHi <= iLo) return [NaN, 0]
  for (let w = 0; w < nWin; w++) {
    const base = w * BPW, jbase = base + L
    for (let i = iLo; i < iHi; i++) {
      const x = X[base + i], y = Y[jbase + i]
      if (x === x && y === y) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y }
    }
  }
  if (n < 3) return [NaN, n]
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n
  const d = Math.sqrt(vx * vy)
  return [d <= 0 ? NaN : cov / d, n]
}

// ===== EQUIVALENCE CLASSES (mathematical entanglement) =====
// Raw base channels that are near-collinear at lag 0 (|r|>ENTANGLE_R) are the "same signal" wearing
// different clothes; correlations between two derived channels whose BASES share a class are trivially
// entangled, not real cross-signal structure. We cluster them with a cheap union-find over the lag-0
// base×base matrix (already the thing the LAG MATRIX / MEGA build computes), plus a couple of hard-coded
// STRUCTURAL families that are entangled by construction (the Kalshi order-book mid/ya/na/yb/nb; the BTC
// spot / CF-settlement-index btc/cfmean). The "real signals only" filter darkens same-class pairs so only
// cross-family correlations light up. tfi/tvol/order-flow do NOT correlate >0.9 with price ⇒ stay separate.
const ENTANGLE_R = 0.9
const STRUCT_FAMILIES = [
  ['mid', 'ya', 'na', 'yb', 'nb'], // Kalshi order-book family (bid/ask/mid move together mechanically)
  ['btc', 'cfmean']                // BTC spot / CF settlement-index family (venue-price family)
]
const STRUCT_LABEL = { mid: 'book/price', btc: 'btc-price' } // friendly class name when it contains an anchor
// names: base-metric names; cols: aligned Float64Array bins (same window layout BPW×nWin); thresh: |r| cut.
function computeBaseClasses(names, cols, BPW, nWin, thresh) {
  const n = names.length
  const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  const links = [] // strong measured links, for the legend/caption
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const r = pearsonLag(cols[i], cols[j], 0, BPW, nWin)[0]
    if (r === r && Math.abs(r) > thresh) { uni(i, j); links.push([names[i], names[j], +r.toFixed(3)]) }
  }
  const idx = {}; names.forEach((nm, i) => idx[nm] = i)
  for (const fam of STRUCT_FAMILIES) { let prev = -1; for (const m of fam) { if (idx[m] == null) continue; if (prev >= 0) uni(idx[m], prev); prev = idx[m] } }
  const rootToId = {}, classes = [], classOf = {}
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (rootToId[r] == null) { rootToId[r] = classes.length; classes.push({ id: classes.length, members: [] }) }
    const cid = rootToId[r]; classes[cid].members.push(names[i]); classOf[names[i]] = cid
  }
  for (const c of classes) {
    let lab = null
    for (const m of c.members) if (STRUCT_LABEL[m]) { lab = STRUCT_LABEL[m]; break }
    if (!lab) lab = c.members.length === 1 ? c.members[0] : c.members.slice(0, 4).join('/') + (c.members.length > 4 ? '…' : '')
    c.label = lab; c.multi = c.members.length > 1
  }
  return { classOf, classes, links, thresh }
}

function qLagMatrix(ds, q, f, t0) {
  const db = buildBins(ds, f)
  if (!db.classInfo) db.classInfo = computeBaseClasses(LAGM_AXES, LAGM_AXES.map((m) => db.bins[m]), db.BPW, db.nWin, ENTANGLE_R)
  const BIN = db.BPW ? db.BIN : LAGM_BIN
  const req = (q.metrics && q.metrics.length) ? q.metrics.filter((m) => db.bins[m]) : LAGM_AXES
  const k = req.length
  const cols = req.map((m) => db.bins[m])
  const mode = q.mode === 'peak' ? 'peak' : 'current'
  const base = {
    type: 'lagmatrix', mode, metrics: req, BIN: db.BIN, BPW: db.BPW, nWin: db.nWin,
    totalBins: db.totalBins, build_ms: db.buildMs,
    classOf: db.classInfo.classOf, classes: db.classInfo.classes, classLinks: db.classInfo.links, entangleR: ENTANGLE_R
  }
  if (mode === 'current') {
    // snap requested lag to a whole number of bins (>= bin size)
    const lagSec = Math.round((+q.lag || 0) / db.BIN) * db.BIN
    const L = Math.round(lagSec / db.BIN)
    const mat = [], nmat = []
    for (let a = 0; a < k; a++) { mat.push(new Array(k)); nmat.push(new Array(k)) }
    let npairs = 0
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) { const pr = pearsonLag(cols[a], cols[b], L, db.BPW, db.nWin); mat[a][b] = pr[0]; nmat[a][b] = pr[1]; npairs++ }
    return Object.assign(base, { matrix: mat, nmat, lag: lagSec, npairs, elapsed_ms: Date.now() - t0 })
  }
  // PEAK: for each pair, argmax |r| over the full lag range at the chosen step. Upper triangle only —
  // (a,b) at +L equals (b,a) at -L, so |r| peak is identical and argmax-lag flips sign.
  const stepSec = Math.max(db.BIN, Math.round((+q.peak_step || 30) / db.BIN) * db.BIN)
  const stepB = Math.round(stepSec / db.BIN)
  const lagMaxSec = Math.max(0, Math.round((+q.lag_max || 300) / db.BIN) * db.BIN)
  const Lmax = Math.round(lagMaxSec / db.BIN)
  const mat = [], lagm = [], nmat = []
  for (let a = 0; a < k; a++) { mat.push(new Array(k).fill(NaN)); lagm.push(new Array(k).fill(0)); nmat.push(new Array(k).fill(0)) }
  let nlags = 0; for (let L = -Lmax; L <= Lmax; L += stepB) nlags++
  for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
    let bestAbs = -1, bestR = NaN, bestLag = 0, bestN = 0
    for (let L = -Lmax; L <= Lmax; L += stepB) {
      const pr = pearsonLag(cols[a], cols[b], L, db.BPW, db.nWin)
      const ar = Math.abs(pr[0])
      if (ar === ar && ar > bestAbs) { bestAbs = ar; bestR = pr[0]; bestLag = L * db.BIN; bestN = pr[1] }
    }
    mat[a][b] = bestR; lagm[a][b] = bestLag; nmat[a][b] = bestN
    mat[b][a] = bestR; lagm[b][a] = -bestLag; nmat[b][a] = bestN
  }
  return Object.assign(base, { matrix: mat, lagmat: lagm, nmat, peak_step: stepSec, lag_max: lagMaxSec, nlags, elapsed_ms: Date.now() - t0 })
}

// ================= MEGA MATRIX (derived-channel factory + fast z-scored dot engine) =================
// Noah's ask: "add averages, integrals, derivatives, 2nd-order, |integrals|, moving averages, averages of
// past n time, everything possible… 500x500 … adjust the lag … look for any possible relation."
//
// Design:
//  1) DERIVED CHANNEL FACTORY — bin the 26 base (non-forward) metrics into MEGA_BIN(10s) per-window bins,
//     then for each base generate 13 transforms (raw · MA30/120/600 · past-mean 60/300 · d1@30/120 · d2@120
//     · demeaned integral 60/300 · |integral300| · std120) → ≈338 channels. Degenerate (constant / too-few
//     finite) channels are dropped. Each channel is z-scored over its finite bins and stored as Float32 with
//     missing bins imputed to 0 (the mean) so a lagged correlation is a pure BLOCKED DOT-PRODUCT.
//  2) FAST LAG CORRELATION — with z-scored, zero-imputed channels, r(a,b,L) ≈ (1/P)·Σ Za[i]·Zb[i+L] over the
//     in-window aligned bins (P = nWin·(BPW−|L|)). We build a boundary-respecting lag-shifted copy of the
//     RIGHT operand (zeros where i+L crosses the 15-min window edge) then a Float32 blocked matmul gives the
//     whole k×k matrix at once. Dense bins ⇒ zero-imputation attenuation is tiny (raw channels match the exact
//     base pearsonLag in sign & ~0.01). PEAK is driven lag-by-lag from the renderer (real progress + cancel).
const MEGA_BIN = 10 // seconds per bin for the mega grid (halves totalBins vs 5s → ~2x faster matmul + less RAM)
const MEGA_BASES = LAGM_AXES.slice() // the 26 non-forward base metrics
const BASE_FAM = { // base-metric family grouping (for the subset selector + group separators)
  price: ['mid', 'fair', 'dev', 'pf', 'spread', 'ya', 'na', 'yb', 'nb'],
  strike: ['cfmean', 'strike', 'dist', 'sdist', 'zstrike'],
  signal: ['sig', 'calk', 'mid_d1', 'mid_d2', 'tfi_cum'],
  flow: ['tfi', 'tvol', 'btcobi', 'btcspread'],
  xasset: ['btc', 'eth', 'sol']
}
const BASE_FAM_ORDER = ['flow', 'signal', 'strike', 'price', 'xasset']
function baseFamOf(m) { for (const fam of BASE_FAM_ORDER) if (BASE_FAM[fam].indexOf(m) >= 0) return fam; return 'other' }
// transform catalog: {suffix, kind, arg(bins at MEGA_BIN), family}. order is the within-base channel order.
const XF = [
  { suffix: '', kind: 'raw', family: 'raw', label: 'raw' },
  { suffix: '.ma30', kind: 'ma', arg: 3, family: 'ma', label: 'MA 30s' },
  { suffix: '.ma120', kind: 'ma', arg: 12, family: 'ma', label: 'MA 120s' },
  { suffix: '.ma600', kind: 'ma', arg: 60, family: 'ma', label: 'MA 600s' },
  { suffix: '.pm60', kind: 'pm', arg: 6, family: 'pastmean', label: 'prior-mean 60s' },
  { suffix: '.pm300', kind: 'pm', arg: 30, family: 'pastmean', label: 'prior-mean 300s' },
  { suffix: '.d1_30', kind: 'd1', arg: 3, family: 'deriv', label: "d1 30s" },
  { suffix: '.d1_120', kind: 'd1', arg: 12, family: 'deriv', label: "d1 120s" },
  { suffix: '.d2_120', kind: 'd2', arg: 12, family: 'deriv', label: "d2 120s" },
  { suffix: '.int60', kind: 'int', arg: 6, family: 'integral', label: 'integral 60s (demeaned)' },
  { suffix: '.int300', kind: 'int', arg: 30, family: 'integral', label: 'integral 300s (demeaned)' },
  { suffix: '.absint300', kind: 'absint', arg: 30, family: 'integral', label: '|integral 300s|' },
  { suffix: '.std120', kind: 'std', arg: 12, family: 'std', label: 'rolling std 120s' }
]
const XF_ORDER = XF.map((x) => x.family).filter((v, i, a) => a.indexOf(v) === i) // [raw,ma,pastmean,deriv,integral,std]

// per-window transform of a Float64 source array (length totalBins, contiguous BPW-bin window blocks)
function deriveChan(src, BPW, nWin, kind, s) {
  const M = src.length
  if (kind === 'raw') { const o = new Float64Array(M); o.set(src); return o }
  if (kind === 'd2') { return deriveChan(deriveChan(src, BPW, nWin, 'd1', s), BPW, nWin, 'd1', s) }
  if (kind === 'absint') { const o = deriveChan(src, BPW, nWin, 'int', s); for (let i = 0; i < M; i++) { const v = o[i]; o[i] = v === v ? Math.abs(v) : NaN } return o }
  const out = new Float64Array(M)
  for (let w = 0; w < nWin; w++) {
    const base = w * BPW
    if (kind === 'ma') {
      for (let i = 0; i < BPW; i++) { let sm = 0, c = 0; const lo = i - s + 1 < 0 ? 0 : i - s + 1; for (let k = lo; k <= i; k++) { const v = src[base + k]; if (v === v) { sm += v; c++ } } out[base + i] = c ? sm / c : NaN }
    } else if (kind === 'pm') {
      for (let i = 0; i < BPW; i++) { let sm = 0, c = 0; const lo = i - s < 0 ? 0 : i - s; for (let k = lo; k < i; k++) { const v = src[base + k]; if (v === v) { sm += v; c++ } } out[base + i] = c ? sm / c : NaN }
    } else if (kind === 'd1') {
      const dt = s * MEGA_BIN
      for (let i = 0; i < BPW; i++) { if (i < s) { out[base + i] = NaN; continue } const a = src[base + i], b = src[base + i - s]; out[base + i] = (a === a && b === b) ? (a - b) / dt : NaN }
    } else if (kind === 'std') {
      for (let i = 0; i < BPW; i++) { let sm = 0, ss = 0, c = 0; const lo = i - s + 1 < 0 ? 0 : i - s + 1; for (let k = lo; k <= i; k++) { const v = src[base + k]; if (v === v) { sm += v; ss += v * v; c++ } } out[base + i] = c > 1 ? Math.sqrt(Math.max(0, ss / c - (sm / c) * (sm / c))) : NaN }
    } else if (kind === 'int') {
      let wm = 0, wc = 0; for (let i = 0; i < BPW; i++) { const v = src[base + i]; if (v === v) { wm += v; wc++ } } wm = wc ? wm / wc : 0
      for (let i = 0; i < BPW; i++) { let sm = 0, any = 0; const lo = i - s + 1 < 0 ? 0 : i - s + 1; for (let k = lo; k <= i; k++) { const v = src[base + k]; if (v === v) { sm += (v - wm); any = 1 } } out[base + i] = any ? sm : NaN }
    }
  }
  return out
}

let DSM = null // mega store: { sig, BIN, BPW, nWin, totalBins, channels:[{name,base,baseFam,transform,tfFam,label}], Z:[Float32Array], buildMs, dropped }
function buildMega(ds, f, qid) {
  const BIN = MEGA_BIN
  const sig = ds.path + '@' + ds.mtime + '#' + filterSig(f) + '#mega' + BIN
  if (DSM && DSM.sig === sig) return DSM
  const tb = Date.now()
  const nWin = ds.wins.length
  let maxSpan = 0
  for (const [s, e] of ds.wins) { const sp = ds.t[e - 1] - ds.t[s]; if (sp > maxSpan) maxSpan = sp }
  const BPW = Math.min(200, Math.max(1, Math.ceil(maxSpan / BIN) + 1))
  const totalBins = nWin * BPW
  // pass A: bin base metrics (mean per 5s->10s bin), respecting the filter
  const baseSum = {}, baseCnt = {}
  for (const m of MEGA_BASES) { baseSum[m] = new Float64Array(totalBins); baseCnt[m] = new Float64Array(totalBins) }
  for (let w = 0; w < nWin; w++) {
    const s = ds.wins[w][0], e = ds.wins[w][1], t0w = ds.t[s], base = w * BPW
    for (let i = s; i < e; i++) {
      if (!passes(ds, i, f)) continue
      let b = Math.floor((ds.t[i] - t0w) / BIN); if (b < 0) b = 0; if (b >= BPW) b = BPW - 1
      const gi = base + b
      for (let mi = 0; mi < MEGA_BASES.length; mi++) { const name = MEGA_BASES[mi]; const v = metric(ds, i, name); if (isFinite(v)) { baseSum[name][gi] += v; baseCnt[name][gi]++ } }
    }
  }
  const baseRaw = {}
  for (const m of MEGA_BASES) { const S = baseSum[m], C = baseCnt[m], A = new Float64Array(totalBins); for (let gi = 0; gi < totalBins; gi++) A[gi] = C[gi] > 0 ? S[gi] / C[gi] : NaN; baseRaw[m] = A }
  // equivalence classes over the raw base metrics (union-find on the lag-0 base×base matrix + structural)
  const classInfo = computeBaseClasses(MEGA_BASES, MEGA_BASES.map((m) => baseRaw[m]), BPW, nWin, ENTANGLE_R)
  // pass B: generate + z-score + impute each derived channel; drop degenerate
  const channels = [], Z = []
  const minFinite = Math.max(30, Math.round(0.05 * totalBins)) // need enough finite bins to be meaningful
  let dropped = 0
  const totalChan = MEGA_BASES.length * XF.length
  let done = 0, nextProg = totalChan / 20
  for (let bi = 0; bi < MEGA_BASES.length; bi++) {
    const base = MEGA_BASES[bi], src = baseRaw[base], bfam = baseFamOf(base)
    for (let xi = 0; xi < XF.length; xi++) {
      const xf = XF[xi]
      const d = deriveChan(src, BPW, nWin, xf.kind, xf.arg)
      // z-score over finite bins
      let sm = 0, c = 0
      for (let gi = 0; gi < totalBins; gi++) { const v = d[gi]; if (v === v && v !== Infinity && v !== -Infinity) { sm += v; c++ } }
      done++
      if (c < minFinite) { dropped++; if (done >= nextProg) { nextProg += totalChan / 20; if (parentPort && qid != null) parentPort.postMessage({ id: qid, progress: Math.round(done / totalChan * 100), phase: 'mega' }) } continue }
      const mean = sm / c
      let ss = 0
      for (let gi = 0; gi < totalBins; gi++) { const v = d[gi]; if (v === v && v !== Infinity && v !== -Infinity) { const dv = v - mean; ss += dv * dv } }
      const sd = Math.sqrt(ss / c)
      if (!(sd > 1e-9)) { dropped++; if (done >= nextProg) { nextProg += totalChan / 20; if (parentPort && qid != null) parentPort.postMessage({ id: qid, progress: Math.round(done / totalChan * 100), phase: 'mega' }) } continue } // constant → drop
      const inv = 1 / sd, zr = new Float32Array(totalBins)
      for (let gi = 0; gi < totalBins; gi++) { const v = d[gi]; zr[gi] = (v === v && v !== Infinity && v !== -Infinity) ? (v - mean) * inv : 0 }
      channels.push({ name: base + xf.suffix, base, baseFam: bfam, transform: xf.family, tfFam: xf.family, suffix: xf.suffix, label: base + ' · ' + xf.label, finite: c })
      Z.push(zr)
      if (done >= nextProg) { nextProg += totalChan / 20; if (parentPort && qid != null) parentPort.postMessage({ id: qid, progress: Math.round(done / totalChan * 100), phase: 'mega' }) }
    }
  }
  DSM = { sig, BIN, BPW, nWin, totalBins, channels, Z, buildMs: Date.now() - tb, dropped, classInfo }
  return DSM
}

// fast z-scored dot correlation for a selected channel subset at a single lag L (in bins)
function megaCorr(db, selIdx, L) {
  const k = selIdx.length, BPW = db.BPW, nWin = db.nWin, M = db.totalBins, Z = db.Z
  const aL = L < 0 ? -L : 0
  const P = nWin * Math.max(0, BPW - (L < 0 ? -L : L))
  const mat = []
  for (let a = 0; a < k; a++) mat.push(new Float32Array(k).fill(NaN))
  if (P <= 0) return { matrix: mat, P: 0 }
  const iLo = L < 0 ? -L : 0, iHi = L > 0 ? BPW - L : BPW
  // build boundary-respecting lag-shifted RIGHT operand for the selected channels (zeros across window edge)
  const RS = new Array(k)
  for (let bi = 0; bi < k; bi++) {
    const src = Z[selIdx[bi]], d = new Float32Array(M)
    for (let w = 0; w < nWin; w++) { const base = w * BPW; for (let i = iLo; i < iHi; i++) d[base + i] = src[base + i + L] }
    RS[bi] = d
  }
  const invP = 1 / P
  for (let a = 0; a < k; a++) {
    const LA = Z[selIdx[a]], row = mat[a]
    for (let b = 0; b < k; b++) {
      const RB = RS[b]; let s = 0
      let gi = 0; const M4 = M - (M & 3)
      for (; gi < M4; gi += 4) { s += LA[gi] * RB[gi] + LA[gi + 1] * RB[gi + 1] + LA[gi + 2] * RB[gi + 2] + LA[gi + 3] * RB[gi + 3] }
      for (; gi < M; gi++) s += LA[gi] * RB[gi]
      row[b] = s * invP
    }
  }
  // at lag 0 the diagonal is self-correlation = 1 by definition (the dot/P estimate reads the bin-fill
  // fraction because missing bins are zero-imputed; anchor it so the colour scale + tooltip are honest)
  if (L === 0) for (let a = 0; a < k; a++) mat[a][a] = 1
  return { matrix: mat, P }
}

function qMegaFields(ds, q, f, t0) {
  const db = buildMega(ds, f, q._qid)
  return {
    type: 'megafields', channels: db.channels.map((c) => ({ name: c.name, base: c.base, baseFam: c.baseFam, tfFam: c.tfFam, label: c.label })),
    baseFams: BASE_FAM_ORDER.slice(), tfFams: XF_ORDER.slice(), finalCount: db.channels.length, dropped: db.dropped,
    classOf: db.classInfo.classOf, classes: db.classInfo.classes, classLinks: db.classInfo.links, entangleR: ENTANGLE_R,
    totalPossible: MEGA_BASES.length * XF.length, nWin: db.nWin, totalBins: db.totalBins, BIN: db.BIN, BPW: db.BPW, build_ms: db.buildMs, elapsed_ms: Date.now() - t0
  }
}
function qMegaMatrix(ds, q, f, t0) {
  const db = buildMega(ds, f, q._qid)
  const idxOf = {}; for (let i = 0; i < db.channels.length; i++) idxOf[db.channels[i].name] = i
  let names = (q.sel && q.sel.length) ? q.sel.filter((n) => idxOf[n] != null) : db.channels.map((c) => c.name)
  const selIdx = names.map((n) => idxOf[n])
  const lagSec = Math.round((+q.lag || 0) / db.BIN) * db.BIN
  const L = Math.round(lagSec / db.BIN)
  const { matrix, P } = megaCorr(db, selIdx, L)
  return {
    type: 'megamatrix', metrics: names, matrix, lag: lagSec, P, nWin: db.nWin, totalBins: db.totalBins,
    BIN: db.BIN, BPW: db.BPW, build_ms: db.buildMs, finalCount: db.channels.length, elapsed_ms: Date.now() - t0
  }
}

function run(q) {
  const t0 = Date.now()
  const type = q.type || 'fields'
  if (type === 'fields') return { type: 'fields', metrics: METRIC_NAMES }
  const path = q.file || workerData.ticklog
  const ds = load(path, q._qid)
  const f = parseFilters(q)
  if (type === 'pivot') return qPivot(ds, q, f, t0)
  if (type === 'corr') return qCorr(ds, q, f, t0)
  if (type === 'corrmatrix') return qCorrMatrix(ds, q, f, t0)
  if (type === 'lagmatrix') return qLagMatrix(ds, q, f, t0)
  if (type === 'megafields') return qMegaFields(ds, q, f, t0)
  if (type === 'megamatrix') return qMegaMatrix(ds, q, f, t0)
  if (type === 'windows') return qWindows(ds, q, t0)
  if (type === 'dist') return qDist(ds, q, f, t0)
  if (type === 'bench') return { type: 'bench', ticks: ds.n, windows: ds.wins.length, elapsed_ms: Date.now() - t0, path }
  return { error: 'unknown type: ' + type }
}

parentPort.on('message', (msg) => {
  const { id, query } = msg
  try {
    query._qid = id
    const result = run(query)
    parentPort.postMessage({ id, ok: true, result })
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e && e.stack || e) })
  }
})
