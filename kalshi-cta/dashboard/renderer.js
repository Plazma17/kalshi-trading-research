// ---- theme toggle (night = black bg + dark-gray text/accents) ----
;(function () {
  const apply = (t) => {
    const lbl = document.getElementById('theme-label')
    if (t === 'night') { document.documentElement.setAttribute('data-theme', 'night'); if (lbl) lbl.textContent = 'NIGHT' }
    else { document.documentElement.removeAttribute('data-theme'); if (lbl) lbl.textContent = 'DAY' }
  }
  apply(localStorage.getItem('cta-theme') || 'night')
  const btn = document.getElementById('themebtn')
  if (btn) btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'night' ? 'day' : 'night'
    localStorage.setItem('cta-theme', cur); apply(cur)
  })
  const fs = document.getElementById('fsbtn')
  if (fs && window.cta && window.cta.toggleFullscreen) fs.addEventListener('click', () => window.cta.toggleFullscreen())
  const wo = document.getElementById('wonly-toggle')
  if (wo) wo.addEventListener('click', () => { wOnly = !wOnly; if (wOnly) { nnOnly = false; localStorage.setItem('cta-nnonly', '0') } localStorage.setItem('cta-wonly', wOnly ? '1' : '0'); if (lastState) render(lastState) })
  // NN-ONLY mode toggle (mutually exclusive with W-ONLY) — shows the neural-net readiness cards
  const nn = document.getElementById('nnonly-toggle')
  if (nn) nn.addEventListener('click', () => {
    nnOnly = !nnOnly; if (nnOnly) { wOnly = false; localStorage.setItem('cta-wonly', '0') }
    _nnSig = ''; _nnLastAt = 0; _nnDetailSig = ''; _nnDetailLastAt = 0   // force an immediate NN rebuild on toggle (don't wait out the throttle)
    localStorage.setItem('cta-nnonly', nnOnly ? '1' : '0'); if (lastState) render(lastState)
  })
  // STRATEGY STATUS panel toggle. The panel (#evolve-board) is HIDDEN BY DEFAULT (localStorage 'cta-strategy',
  // default '0'); this button shows/hides it and persists the choice. _syncStrategyToggle keeps the button's
  // label/colour in sync with the actual panel visibility (also called from the panel's own dbl-click-hide).
  const sb = document.getElementById('strategy-toggle')
  if (sb) sb.addEventListener('click', () => {
    const on = localStorage.getItem('cta-strategy') === '1'
    const next = !on
    localStorage.setItem('cta-strategy', next ? '1' : '0')
    const el = document.getElementById('evolve-board'); if (el) el.style.display = next ? '' : 'none'
    _syncStrategyToggle()
  })
  _syncStrategyToggle()
})()
// reflect the STRATEGY panel's persisted on/off state in the ribbon button (label dot + colour)
function _syncStrategyToggle() {
  const sb = document.getElementById('strategy-toggle'); if (!sb) return
  const on = localStorage.getItem('cta-strategy') === '1'
  sb.textContent = on ? 'STRATEGY ●' : 'STRATEGY ▪'
  sb.style.color = on ? '#ff3fc4' : 'var(--dim)'
}

const $ = (id) => document.getElementById(id)
// ── Eastern-time formatting (US/Eastern, DST-aware via Intl). All DISPLAYED clock
// times in this dashboard render in Eastern with an "ET" suffix. Relative durations
// (T-minus countdowns, sec_left) are NOT touched — only absolute wall-clock times.
const _etTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  hour: '2-digit', minute: '2-digit', second: '2-digit'
})
// d: Date | epoch-ms | ISO/parseable string. Returns "HH:MM:SS ET" (or '—' if invalid).
function etTime(d) {
  const dt = (d instanceof Date) ? d : new Date(d)
  if (isNaN(dt.getTime())) return '—'
  try { return _etTimeFmt.format(dt) + ' ET' } catch (e) { return '—' }
}
const px = (p, d = 2) => (p == null ? '—' : Number(p).toFixed(d))
const usd = (p) => (p == null ? '—' : '$' + Number(p).toLocaleString(undefined, { maximumFractionDigits: 0 }))
let selectedBot = null, lastState = null, closeEpoch = null, hoverV = null, hoverE = null, lastTicker = null, selectedTrade = null, lastHeavy = 0, capPeak = 0
let wOnly = localStorage.getItem('cta-wonly') === '1'   // W-ONLY view: show only wave bots (variants + W_neural)
let nnOnly = localStorage.getItem('cta-nnonly') === '1' // NN-ONLY view: show only the neural-net bots as readiness cards
let selectedNN = null                                    // which NN's detail overlay is open (tag or null)
let nnCompare = false                                    // detail-view A/B compare overlay toggle
// ===== BOT PINNING ==========================================================
// Pinned bots sort FIRST within every sortable bot column (leaderboard, window-ROI list,
// family-card bot lists, NN cards). Keyed by bot NAME/tag (stable across restarts) and
// persisted in localStorage — Electron keeps this dashboard's localStorage in the profile
// dir across app restarts (same store already used for theme / view toggles / ACC / backtest
// lines), so no main.js IPC / JSON-file fallback is needed here. Stale pins (a retired bot no
// longer in the set) simply no-op: isPinned() is a Set lookup, pinnedFirst() sorts on it, and
// nothing dereferences the name — so an unknown pinned name never crashes a render.
const PIN_LSKEY = 'cta-pinned-bots'
let _pinned = (function () {
  try { const a = JSON.parse(localStorage.getItem(PIN_LSKEY)); return new Set(Array.isArray(a) ? a : []) } catch (e) { return new Set() }
})()
function _savePins() { try { localStorage.setItem(PIN_LSKEY, JSON.stringify(Array.from(_pinned))) } catch (e) {} }
function isPinned(name) { return !!name && _pinned.has(name) }
function togglePin(name) {
  if (!name) return
  if (_pinned.has(name)) _pinned.delete(name); else _pinned.add(name)
  _savePins()
  if (lastState) render(lastState)   // pin change → re-render so the pinned-first sort + marker apply immediately
}
// Stable pinned-first reorder: pinned kept in their prior relative order, unpinned likewise
// (Array.prototype.sort is stable in modern V8/Electron). Apply AFTER the column's own sort.
function pinnedFirst(arr, nameOf) {
  const f = nameOf || function (x) { return x && x.name }
  return arr.slice().sort(function (a, b) { return (isPinned(f(b)) ? 1 : 0) - (isPinned(f(a)) ? 1 : 0) })
}
// The clickable pushpin toggle for a bot row/card. data-pin carries the bot name; the delegated
// click handlers (#lb / #bot-cards / #nn-cards) stopPropagation on it so pinning never opens the
// detail overlay or selects the bot.
function pinGlyph(name) {
  return '<span class="pin-toggle' + (isPinned(name) ? ' on' : '') + '" data-pin="' + name +
    '" title="' + (isPinned(name) ? 'unpin' : 'pin to top') + '">📌</span>'
}
// PERF gates: rebuild the heavy SVG/NN DOM at most a few times/sec, and skip entirely when the underlying
// data signature is unchanged since the last build (the feed only advances ~every 0.25s).
let _vtraceLastAt = 0, _vtraceSig = ''                   // drawVtrace throttle + content-signature
// DATA STREAMS overlay: latest per-window stream payload (from main's 'streams' channel) + which stream ids are
// toggled on (persisted in localStorage, same pattern as 'cta-pinned-bots'). Rendered as thin normalized overlays
// on the live #vtrace chart by drawVtrace, and listed with live values in the streams panel.
let streamData = null
let streamSel = (() => { try { return JSON.parse(localStorage.getItem('cta-streams-sel') || '{}') || {} } catch (e) { return {} } })()
let _nnLastAt = 0, _nnSig = ''                           // renderNNCards/Detail throttle + signature
let _strikeSig = ''                                      // drawStrikeBar content-signature (skip innerHTML rebuild on no-move ticks)
// FREEZE FIX: current-window slice cache for drawVtrace. state.trace is the whole-session append-only array
// (capped only at 20000 in main), and drawVtrace previously re-`filter`ed the ENTIRE array to the current
// 15-min window on every redraw (~4x/sec) — so per-draw cost climbed all session (the "laggier the longer it
// runs" freeze). Because trace is append-only and sorted by t, the current window is always a contiguous SUFFIX
// of trace; we remember the window's start index and only scan the small tail of NEW rows each draw.
let _vwCache = { winOpen: -1, startIdx: 0, len: 0, cur: null }
const VTRACE_MIN_MS = 230                                 // chart redraws ≤ ~4x/sec
const NN_MIN_MS = 700                                     // NN cards/detail rebuild ≤ ~1.4x/sec (readiness changes on seconds)
function closeToEpoch(closeStr) {  // "18:15:00Z" -> fixed absolute close epoch (ms), handles UTC-midnight roll
  if (!closeStr) return null
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(closeStr)
  if (!m) return null
  const n = new Date()
  let e = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), +m[1], +m[2], +m[3])
  if (e < Date.now() - 120000) e += 86400000
  return e
}

function drawStrikeBar(state) {   // VERTICAL BTC-vs-strike strip (sits to the right of the main chart)
  const svg = document.getElementById('strikebar'); if (!svg) return
  const w = state.window || {}
  const btc = w.btc, strike = w.strike, open = w.btc_open, sig = w.sigma || 0.00046
  if (btc == null || strike == null) { if (_strikeSig !== '∅') { svg.innerHTML = ''; _strikeSig = '∅' } return }
  const night = document.documentElement.getAttribute('data-theme') === 'night'
  // FREEZE FIX: drawStrikeBar was the one un-gated innerHTML SVG rebuild on the hot per-tick path (render()
  // runs in full ~3.3x/sec). On idle-but-live ticks where BTC didn't move, rebuild nothing. Signature covers
  // every input the SVG depends on (btc/strike/open/sigma + theme).
  { const ssig = btc + '|' + strike + '|' + open + '|' + sig + '|' + (night ? 1 : 0)
    if (ssig === _strikeSig) return
    _strikeSig = ssig }
  const W = 66, H = 340, cx = W / 2, cy = H / 2, ZMAX = 2.5, scale = (H / 2 - 22) / ZMAX
  const zOf = (p) => (p && strike) ? Math.log(p / strike) / (sig * Math.sqrt(15)) : 0
  const Y = (z) => cy - Math.max(-ZMAX, Math.min(ZMAX, z)) * scale   // up = above strike
  const C_AX = night ? '#444' : '#6b786b', C_STRK = night ? '#9aa' : '#4fd0e0'
  let s = ''
  // trade-zone band (|z| <= 1) as a horizontal slab
  s += `<rect x="${cx - 11}" y="${Y(1).toFixed(1)}" width="22" height="${(Y(-1) - Y(1)).toFixed(1)}" fill="rgba(62,196,109,0.13)" stroke="rgba(62,196,109,0.4)" stroke-width="0.5"/>`
  s += `<line x1="${cx}" y1="6" x2="${cx}" y2="${H - 6}" stroke="${C_AX}" stroke-width="1"/>`        // vertical axis
  s += `<line x1="6" y1="${cy}" x2="${W - 6}" y2="${cy}" stroke="${C_STRK}" stroke-width="1.5"/>`      // strike (horizontal)
  if (open != null) {
    const yo = Y(zOf(open))
    s += `<line x1="8" y1="${yo.toFixed(1)}" x2="${W - 8}" y2="${yo.toFixed(1)}" stroke="#e0b020" stroke-width="1.2" stroke-dasharray="2 2"/>`
  }
  const yn = Y(zOf(btc)), above = btc >= strike, col = above ? '#3ec46d' : '#ff5555'
  s += `<polygon points="${cx},${yn.toFixed(1)} ${(cx - 9)},${(yn - 4).toFixed(1)} ${(cx - 9)},${(yn + 4).toFixed(1)}" fill="${col}"/>`
  s += `<text x="${cx}" y="${above ? (yn - 6).toFixed(1) : (yn + 12).toFixed(1)}" fill="${col}" font-size="9" font-weight="bold" font-family="monospace" text-anchor="middle">${btc - strike >= 0 ? '+' : '−'}$${Math.abs(Math.round(btc - strike))}</text>`
  svg.innerHTML = s
}
// STRATEGY STATUS — curated research-conclusion board (replaces the old WAVE EVOLUTION panel).
// Two FORWARD strategies auto-compute their badge from live forward-bot status; the rest are static
// research verdicts. Same fixed bottom-right corner styling / dbl-click-hide as the old board.
function renderStrategyBoard(state) {
  let el = document.getElementById('evolve-board')
  if (!el) {
    el = document.createElement('div'); el.id = 'evolve-board'
    el.style.cssText = 'position:fixed;right:8px;bottom:8px;width:355px;max-height:46vh;overflow:auto;z-index:50;background:rgba(8,12,8,0.95);border:1px solid #ff3fc4;border-radius:4px;padding:6px 8px;font:10px/1.4 monospace;color:#cdd'
    // HIDDEN BY DEFAULT (persisted in localStorage; the ribbon STRATEGY button toggles it). dbl-click still hides.
    el.style.display = (localStorage.getItem('cta-strategy') === '1') ? '' : 'none'
    el.title = 'double-click to hide'; el.addEventListener('dblclick', () => { el.style.display = 'none'; localStorage.setItem('cta-strategy', '0'); _syncStrategyToggle() })
    document.body.appendChild(el)
  }
  // status → {label, color, rank} (rank: lower = nearer the top; dead sinks to the bottom + dims)
  const ST = {
    GOOD:   { color: 'var(--up)',   rank: 0 },
    COND:   { color: 'var(--cyan)', rank: 1 },   // CONDITIONAL/WEAK live
    NEEDS:  { color: 'var(--amber)',rank: 2 },   // NEEDS DATA
    WEAK:   { color: 'var(--cyan)', rank: 3 },
    DEAD:   { color: 'var(--down)', rank: 9 }
  }
  // auto-compute a forward strategy's badge from its live status object
  const fwd = (s) => {
    const n = (s && s.n_trades != null) ? s.n_trades : 0
    const net = (s && s.net != null) ? s.net : 0
    if (n >= 30 && net > 0) return { st: 'GOOD', label: 'GOOD ✓' }
    if (n >= 50 && net < 0) return { st: 'WEAK', label: `WEAK (n=${n})` }
    return { st: 'NEEDS', label: `NEEDS DATA (n=${n})` }
  }
  const cc = fwd(state.c_chop_tp_status)
  const cs = fwd(state.c_slowcreep_short_status)
  const STRATEGIES = [
    { name: 'Slow-creep short',        st: cs.st, label: cs.label, note: 'buy NO on clean creep→0.30 · backtest passed martingale (+5.2c, only one) · GOOD if n≥30 & net+' },
    { name: 'Chop take-profit',        st: cc.st, label: cc.label, note: 'buy .30 / sell .55 on doubly-choppy · backtest +5.18c held-out, underpowered · GOOD if n≥30 & net+' },
    { name: 'BRTI imbalance (Φ-amp)',  st: 'NEEDS', label: 'NEEDS DATA', note: 'cons_obi→Kalshi-mid late-window-flank · looked strong (AUC .646) but was a NO-night artifact · needs multi-day both-trend 5-venue data (banking 24/7)' },
    { name: 'BRTI price-lead',         st: 'WEAK', label: 'WEAK', note: 'constituent book lead · null twice on broken feeds · clean re-test pending, looking weak' },
    { name: 'W_neural (NN taker)',     st: 'DEAD', label: 'DEAD', note: 'cost-walled flat martingale · research only, not a profitable taker' },
    { name: 'Drift-persist/smoothness',st: 'DEAD', label: 'DEAD', note: 'symmetry-killed (sign inversion long+17 / short−6)' },
    { name: 'Polynomial fits',         st: 'DEAD', label: 'DEAD', note: 'mid-coupled — the mid in disguise (Φ-audit collapses it)' },
    { name: 'Strike-reversion',        st: 'DEAD', label: 'DEAD', note: 'killed on 66 days (−0.68c) — single-regime artifact' },
    { name: 'World Cup / overround',   st: 'DEAD', label: 'DEAD', note: 'cost-walled (fee floor > overround); bot dark' },
    { name: 'Maker (chop / LIP)',      st: 'DEAD', label: 'DEAD/PARKED', note: 'chop-maker price-improvement-walled; LIP parked' }
  ]
  // GOOD/CONDITIONAL/NEEDS-DATA on top, DEAD at the bottom; stable within rank
  STRATEGIES.forEach((s, i) => { s._i = i })
  STRATEGIES.sort((a, b) => ((ST[a.st] || ST.DEAD).rank - (ST[b.st] || ST.DEAD).rank) || (a._i - b._i))
  let h = `<b style="color:#ff3fc4">STRATEGY STATUS</b><span style="float:right;opacity:.45">dbl-clk hide</span>`
  h += '<table style="width:100%;border-collapse:collapse;margin-top:4px">'
  STRATEGIES.forEach((s) => {
    const meta = ST[s.st] || ST.DEAD
    const dim = s.st === 'DEAD' ? 'opacity:.5;' : ''
    h += `<tr style="${dim}vertical-align:top">`
      + `<td style="padding:2px 4px 2px 0;white-space:nowrap;color:#cdd6cd">${s.name}</td>`
      + `<td style="padding:2px 4px;white-space:nowrap;color:${meta.color};font-weight:700">${s.label}</td>`
      + `</tr>`
      + `<tr style="${dim}"><td colspan="2" style="padding:0 0 5px 0;color:#7a93a0;font-size:9px;line-height:1.35">${s.note}</td></tr>`
  })
  el.innerHTML = h + '</table>'
}
function drawWNeural(state) {   // W_neural learning curve (W-only mode): rolling win% + confidence over time
  const svg = document.getElementById('eqchart'); if (!svg) return
  const h = (state.w_neural_history || []).filter(Boolean)
  const W = 900, H = 300, PADL = 34, PADR = 12, PADT = 24, PADB = 20
  const night = document.documentElement.getAttribute('data-theme') === 'night'
  if (h.length < 2) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#6b786b" font-size="13" text-anchor="middle">W_neural learning curve — collecting data…</text>`; return }
  const t0 = h[0].t, span = Math.max(1, h[h.length - 1].t - t0)
  const X = (t) => PADL + (t - t0) / span * (W - PADL - PADR)
  const Y = (v) => PADT + (1 - v / 100) * (H - PADT - PADB)
  let s = ''
  for (const g of [0, 25, 50, 75, 100]) { const y = Y(g); s += `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="${g === 50 ? (night ? '#333' : '#2a3a2a') : (night ? '#161616' : '#1c241c')}" stroke-width="1"${g === 50 ? ' stroke-dasharray="3 3"' : ''}/><text x="${PADL - 4}" y="${(y + 3).toFixed(1)}" fill="#6b786b" font-size="9" text-anchor="end">${g}</text>` }
  const line = (key, color) => { let d = ''; h.forEach((r) => { const v = r[key]; if (v == null) return; d += (d ? 'L' : 'M') + X(r.t).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ' }); return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8"/>` : '' }
  s += line('conf', '#4fd0e0') + line('rwin', '#3ec46d')
  const L = h[h.length - 1]
  s += `<text x="${PADL}" y="${(PADT - 8).toFixed(1)}" fill="${night ? '#999' : '#cdd6cd'}" font-size="11" font-weight="bold">trained ${L.trained} · ${L.n} trades · win <tspan fill="${L.win >= 37 ? '#3ec46d' : '#ff5555'}">${L.win}%</tspan> · net <tspan fill="${L.net >= 0 ? '#3ec46d' : '#ff5555'}">${L.net >= 0 ? '+' : ''}$${L.net.toFixed(2)}</tspan>  <tspan fill="#3ec46d">━ roll win%</tspan> <tspan fill="#4fd0e0">━ confidence%</tspan></text>`
  svg.innerHTML = s
}
// ============================================================================
// ===== NN-ONLY MODE: readiness cards + full-history detail view ==============
// ============================================================================
const NN_VIOLET = '#9b6bff'
const clamp01 = (x) => Math.max(0, Math.min(1, x))

// ===== NN-mode TIME-RANGE selector (global + per-graph override) =============
// Every NN graph (card sparklines + detail panels) is filtered on the row `t` epoch BEFORE
// rendering, so cards + detail cover the same span. A GLOBAL range applies to all graphs at
// once; any single graph may carry its own OVERRIDE that ignores the global. Persisted in
// localStorage like the other NN-mode toggles.
const NN_RANGES = [
  { id: 'window', label: 'last window' },
  { id: 'hour', label: 'past hour' },
  { id: 'day', label: 'past day' },
  { id: 'week', label: 'past week' },
  { id: 'all', label: 'all time' }
]
const NN_RANGE_SECS = { hour: 3600, day: 86400, week: 604800 }
let nnRange = localStorage.getItem('cta-nn-range') || 'day'            // GLOBAL default = past day
if (!NN_RANGES.some((r) => r.id === nnRange)) nnRange = 'day'
let nnRangeOverrides = {}                                              // { graphKey: rangeId|'global' } — per-graph override
try { nnRangeOverrides = JSON.parse(localStorage.getItem('cta-nn-range-ov')) || {} } catch (e) { nnRangeOverrides = {} }
function nnSaveOverrides() { try { localStorage.setItem('cta-nn-range-ov', JSON.stringify(nnRangeOverrides)) } catch (e) {} }
// resolve the effective range id for a graph (its override, else the global)
function nnEffRange(graphKey) {
  const ov = graphKey != null ? nnRangeOverrides[graphKey] : null
  return (ov && ov !== 'global' && NN_RANGES.some((r) => r.id === ov)) ? ov : nnRange
}
// SHARED filter on `t` (epoch seconds). rangeId resolved by caller. Never throws on empty input.
//  - 'window' = the most-recent 15-min window present in the rows (floor(t/900) of the latest row);
//  - 'hour|day|week' = t >= now − {3600|86400|604800}s;
//  - 'all' = identity.
function nnFilterByRange(rows, rangeId) {
  if (!Array.isArray(rows) || !rows.length) return rows || []
  if (rangeId === 'all') return rows
  if (rangeId === 'window') {
    let maxT = -Infinity
    for (const r of rows) { const t = r && r.t; if (typeof t === 'number' && t > maxT) maxT = t }
    if (!isFinite(maxT)) return rows
    const w = Math.floor(maxT / 900)
    return rows.filter((r) => r && typeof r.t === 'number' && Math.floor(r.t / 900) === w)
  }
  const secs = NN_RANGE_SECS[rangeId]
  if (!secs) return rows
  const cut = Date.now() / 1000 - secs
  return rows.filter((r) => r && typeof r.t === 'number' && r.t >= cut)
}
// convenience: filter a graph's rows by its effective (override-or-global) range
function nnRows(rows, graphKey) { return nnFilterByRange(rows, nnEffRange(graphKey)) }

// ─── CUSTOM DROPDOWN (replaces native <select>) ──────────────────────────────
// WHY: the NN-mode DOM (cards + detail) is rebuilt via innerHTML on EVERY state
// push (~8×/s, main.js setInterval(push,120)). A native <select>'s popup is torn
// down with the element the instant the next tick fires, so it can never stay open
// — that is the "cannot use the drop down menus" bug. This custom dropdown renders
// the option list in a body-level popup (so it survives outside the grid), and while
// a popup is open we set nnDropdownOpen=true which suppresses the NN re-render
// (see render()) so nothing is destroyed mid-interaction.
let nnDropdownOpen = false       // true while any custom dropdown popup is open → pause NN re-render
let nnOpenPopupEl = null         // the currently-open popup element (body-level)
let nnOpenBtn = null             // the button that owns the open popup (for same-button toggle)
function nnCloseDropdown() {
  if (nnOpenPopupEl && nnOpenPopupEl.parentNode) nnOpenPopupEl.parentNode.removeChild(nnOpenPopupEl)
  nnOpenPopupEl = null; nnOpenBtn = null; nnDropdownOpen = false
}
// global outside-click / escape closers (installed once)
document.addEventListener('mousedown', (e) => {
  if (nnOpenPopupEl && !nnOpenPopupEl.contains(e.target) && !(e.target.classList && e.target.classList.contains('nn-dd-btn'))) nnCloseDropdown()
}, true)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nnDropdownOpen) nnCloseDropdown() })
// open the option popup for a given button. items = [{value,label}]; cur = selected value;
// onPick(value) fires on selection. The button itself carries data-* so re-renders restore label.
function nnOpenPopup(btn, items, cur, onPick) {
  nnCloseDropdown()
  const r = btn.getBoundingClientRect()
  const pop = document.createElement('div')
  pop.className = 'nn-dd-pop'
  pop.style.cssText = `position:fixed;z-index:99999;background:#0a0e0a;border:1px solid ${NN_VIOLET};` +
    `box-shadow:0 4px 18px rgba(0,0,0,0.6);font:11px monospace;min-width:${Math.max(96, r.width)}px;` +
    `max-height:260px;overflow:auto;`
  items.forEach((it) => {
    const row = document.createElement('div')
    const sel = it.value === cur
    row.textContent = (sel ? '✓ ' : '  ') + it.label
    row.style.cssText = `padding:4px 10px;cursor:pointer;color:${sel ? NN_VIOLET : 'var(--text)'};white-space:nowrap;` + (sel ? 'font-weight:700;' : '')
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(155,107,255,0.18)' })
    row.addEventListener('mouseleave', () => { row.style.background = '' })
    row.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const v = it.value; nnCloseDropdown(); onPick(v) })
    pop.appendChild(row)
  })
  document.body.appendChild(pop)
  // position below the button, flipping up / clamping into the viewport if needed
  let top = r.bottom + 2, left = r.left
  const ph = pop.offsetHeight, pw = pop.offsetWidth
  if (top + ph > window.innerHeight - 4) top = Math.max(4, r.top - ph - 2)
  if (left + pw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - pw - 4)
  pop.style.top = top + 'px'; pop.style.left = left + 'px'
  nnOpenPopupEl = pop; nnOpenBtn = btn; nnDropdownOpen = true
}
// build the GLOBAL selector markup (top of the NN view) — custom dropdown button
function nnGlobalSelectorHTML(idSuffix = '') {
  const curLbl = (NN_RANGES.find((r) => r.id === nnRange) || { label: nnRange }).label
  return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;width:100%;">
    <span style="font-size:11px;color:${NN_VIOLET};font-weight:700;">⏱ TIME RANGE (all graphs)</span>
    <button type="button" class="nn-dd-btn nn-range-global${idSuffix}" data-kind="global" style="background:#0a0e0a;color:var(--text);border:1px solid ${NN_VIOLET};font:11px monospace;padding:2px 8px;cursor:pointer;min-width:96px;text-align:left;">${curLbl} ▾</button>
    <span style="font-size:10px;color:#6b786b;">per-graph override via the ▾ on each chart · default past day</span>
  </div>`
}
// small per-graph OVERRIDE button (value 'global' tracks the global; any id pins that graph)
function nnOverrideSelectHTML(graphKey) {
  const cur = nnRangeOverrides[graphKey] || 'global'
  const pinned = cur !== 'global'
  const lbl = pinned ? (NN_RANGES.find((r) => r.id === cur) || { label: cur }).label : '↧ global'
  return `<button type="button" class="nn-dd-btn nn-range-ov" data-gk="${graphKey}" title="per-graph time range (overrides global)" style="background:#0a0e0a;color:${pinned ? NN_VIOLET : '#6b786b'};border:1px solid ${pinned ? NN_VIOLET : 'var(--border)'};font:9px monospace;padding:1px 4px;cursor:pointer;max-width:96px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${lbl} ▾</button>`
}
// wire up the GLOBAL dropdown button(s) inside a container
function nnWireGlobal(container, onChange) {
  if (!container) return
  container.querySelectorAll('.nn-dd-btn[data-kind="global"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      if (nnDropdownOpen && nnOpenBtn === btn) { nnCloseDropdown(); return }   // same button → toggle closed
      nnOpenPopup(btn, NN_RANGES.map((r) => ({ value: r.id, label: r.label })), nnRange, (v) => {
        nnRange = v; try { localStorage.setItem('cta-nn-range', nnRange) } catch (e) {}
        if (onChange) onChange()
      })
    })
  })
}
// wire up all per-graph OVERRIDE dropdown buttons inside a container (call after innerHTML set)
function nnWireOverrides(container, onChange) {
  if (!container) return
  container.querySelectorAll('.nn-range-ov').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      // stop the click from bubbling to the card (which would open the detail overlay)
      e.preventDefault(); e.stopPropagation()
      if (nnDropdownOpen && nnOpenBtn === btn) { nnCloseDropdown(); return }   // same button → toggle closed
      const gk = btn.getAttribute('data-gk')
      const cur = nnRangeOverrides[gk] || 'global'
      const items = [{ value: 'global', label: '↧ global' }].concat(NN_RANGES.map((r) => ({ value: r.id, label: r.label })))
      nnOpenPopup(btn, items, cur, (v) => {
        if (v === 'global') delete nnRangeOverrides[gk]; else nnRangeOverrides[gk] = v
        nnSaveOverrides(); if (onChange) onChange()
      })
    })
  })
}

// LIVE-MONEY-READINESS SCORE (LMRS) 0..100 — two hard gates x weighted sum of 9 sub-scores.
// Reads the data-contract fields off the status object; every absent field degrades gracefully.
function bandFor(score) {
  if (score < 40) return { band: 'NOT READY', color: '#ff5555' }
  if (score < 70) return { band: 'PROMISING', color: '#e0b020' }
  if (score < 90) return { band: 'STRONG', color: '#3ec46d' }
  return { band: 'LIVE-CANDIDATE', color: '#4fa8ff' }
}
function computeLMRS(stRaw) {
  if (!stRaw) return { score: 0, band: 'NO DATA', color: '#444', subs: {}, gate: 1 }
  // FIELD-NAME FIX: the bot nests the LMRS inputs under `lmrs_inputs` and ships the already-computed
  // score in `lmrs` (gate*weighted, identical formula). Flatten lmrs_inputs onto the status object so
  // the dashboard reads the SAME fields the bot used; if the bot also shipped a `lmrs` score, trust it
  // (authoritative, computed at the source) and only fall back to client-side recompute when absent.
  const st = (stRaw.lmrs_inputs && typeof stRaw.lmrs_inputs === 'object') ? { ...stRaw, ...stRaw.lmrs_inputs } : stRaw
  const botScore = (typeof stRaw.lmrs === 'number' && isFinite(stRaw.lmrs)) ? stRaw.lmrs : null
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d
  // hard gates
  const leak = st.leak_free_pass !== false           // default-pass unless explicitly false
  const surv = st.survivorship_clean !== false
  const gate = (leak && surv) ? 1.0 : 0.40
  // EV vs ~4c cost wall (OOS, never in-sample).
  // HARDENED (QC#3): only the genuine HELD-OUT EV may credit S_ev. If the bot has not emitted
  // net_ev_heldout_c we DEGRADE S_ev to 0 rather than substituting the optimistic in-sample mean
  // (own_net/own_n) — a missing held-out number is "unproven", not "good".
  const haveHeldoutEV = (typeof st.net_ev_heldout_c === 'number' && isFinite(st.net_ev_heldout_c))
  const ev = haveHeldoutEV ? st.net_ev_heldout_c : 0
  const evForOOS = haveHeldoutEV ? ev : num(st.oos_ev_c, 0)   // used by S_oos fallbacks below
  const S_ev = clamp01(ev / 8.0)
  // statistical confidence: bootstrap P(>0) + CI lower-bound distance from 0
  const p_term = clamp01((num(st.p_mean_gt0, 0.5) - 0.5) / 0.45)
  const ci_term = clamp01(num(st.ci_low_c, 0) / 4.0)
  const S_conf = 0.5 * p_term + 0.5 * ci_term
  // out-of-sample stability
  const hold_term = clamp01(num(st.oos_ev_c, evForOOS) / 4.0)
  const kfold_term = st.kfold_passed ? 1.0 : 0.0
  const transfer = clamp01(1 - Math.max(0, num(st.train_ev_c, evForOOS) - num(st.oos_ev_c, evForOOS)) / 6.0)
  const S_oos = 0.45 * hold_term + 0.30 * kfold_term + 0.25 * transfer
  // sample size (effective independent draws, saturating at ~400)
  const n_eff = num(st.n_eff_trades, num(st.own_n, 0))
  const S_n = clamp01(Math.log10(Math.max(1, n_eff)) / Math.log10(400))
  // regime count
  const nr = num(st.n_regimes, 1)
  const S_regime = nr <= 1 ? 0.15 : nr === 2 ? 0.55 : Math.min(1, 0.90 + 0.05 * clamp01((nr - 3) / 3))
  // arm-rate health + drift toward the 0.68 inversion point
  const INVERSION = 0.68, TARGET = 0.80
  // HARDENED (QC#4): default arm-rate to 0 pre-data so S_arm shows NO credit until the bot
  // actually emits a realized live arm-rate (was defaulting to arm_rate/0.80 target = optimistic).
  const armLive = num(st.arm_rate_live, 0)
  const level_term = clamp01((armLive - INVERSION) / (TARGET - INVERSION))
  const drift_pen = clamp01(1 - Math.max(0, num(st.arm_rate_drift_per_day, 0)) / 0.04)
  const S_arm = 0.6 * level_term + 0.4 * drift_pen
  // profitable-window rate (friend #1 window guard)
  const pwr = num(st.profitable_window_rate, num(st.pwin_rate, 0) / 100)
  const S_winwin = clamp01((pwr - 0.50) / 0.40) * (num(st.window_guard_permutation_p, 1) < 0.01 ? 1.0 : 0.5)
  // dry-run == live fidelity (0 until a live block exists)
  let S_fidelity = 0
  if (st.dryrun_live_fidelity_known && st.live_ev_c != null) {
    S_fidelity = clamp01(1 - Math.abs(num(st.dryrun_ev_c, 0) - num(st.live_ev_c, 0)) / 4.0) * (st.live_fill_rate_ok ? 1.0 : 0.5)
  }
  // unsolved-tail penalty (friend #6 conviction monitor)
  const S_tail = (st.tail_guard_present ? 0.6 : 0.0) + 0.4 * clamp01(1 - Math.abs(num(st.worst_trade_c, 0)) / 50.0)
  const WEIGHTED = 100 * (0.22 * S_ev + 0.20 * S_conf + 0.12 * S_oos + 0.10 * S_n + 0.08 * S_regime + 0.08 * S_arm + 0.08 * S_winwin + 0.07 * S_fidelity + 0.05 * S_tail)
  const localScore = Math.round(gate * WEIGHTED)
  // Trust the bot's authoritative score when it shipped one (same formula at the source); else recompute.
  const score = (botScore != null) ? botScore : localScore
  // Prefer the bot's shipped sub-scores for the WHY breakdown when present (else our recompute).
  const botSubs = (stRaw.lmrs_subscores && typeof stRaw.lmrs_subscores === 'object') ? stRaw.lmrs_subscores : null
  const subs = botSubs || { S_ev, S_conf, S_oos, S_n, S_regime, S_arm, S_winwin, S_fidelity, S_tail }
  const { band, color } = bandFor(score)
  return { score, band, color, gate, subs }
}

// generic full-history line-chart helper: panels=[{key|fn,color,label}], optional log scale
function nnLineSVG(rows, panels, opt) {
  opt = opt || {}
  const W = opt.W || 420, H = opt.H || 200, PADL = 38, PADR = 10, PADT = 18, PADB = 18
  const night = document.documentElement.getAttribute('data-theme') === 'night'
  if (!rows || rows.length < 2) return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;"><text x="${W / 2}" y="${H / 2}" fill="#6b786b" font-size="11" text-anchor="middle">${opt.title || ''} — collecting…</text></svg>`
  const t0 = rows[0].t, span = Math.max(1, rows[rows.length - 1].t - t0)
  const valOf = (r, p) => (p.fn ? p.fn(r) : r[p.key])
  let mn = opt.min != null ? opt.min : Infinity, mx = opt.max != null ? opt.max : -Infinity
  if (opt.min == null || opt.max == null) {
    rows.forEach((r) => panels.forEach((p) => { const v = valOf(r, p); if (v == null || !isFinite(v)) return; if (opt.min == null && v < mn) mn = v; if (opt.max == null && v > mx) mx = v }))
  }
  if (!isFinite(mn)) mn = 0; if (!isFinite(mx)) mx = 1
  if (mx - mn < 1e-9) { mx += 0.5; mn -= 0.5 }
  const useLog = opt.log && mn > 0
  const tr = (v) => useLog ? Math.log10(Math.max(1e-9, v)) : v
  const lo = tr(mn), hi = tr(mx), rng = (hi - lo) || 1
  const X = (t) => PADL + (t - t0) / span * (W - PADL - PADR)
  const Y = (v) => PADT + (1 - (tr(v) - lo) / rng) * (H - PADT - PADB)
  let s = ''
  // gridlines (3) + zero/baseline
  for (let g = 0; g <= 3; g++) { const vv = mn + (mx - mn) * g / 3, y = Y(vv); s += `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="${night ? '#161616' : '#1c241c'}" stroke-width="1"/><text x="${PADL - 4}" y="${(y + 3).toFixed(1)}" fill="#6b786b" font-size="8" text-anchor="end">${(opt.fmt ? opt.fmt(vv) : vv.toFixed(1))}</text>` }
  if (opt.baseline != null && opt.baseline >= mn && opt.baseline <= mx) { const yb = Y(opt.baseline); s += `<line x1="${PADL}" y1="${yb.toFixed(1)}" x2="${W - PADR}" y2="${yb.toFixed(1)}" stroke="#888" stroke-width="1" stroke-dasharray="3 3"/>` }
  panels.forEach((p) => {
    let d = ''
    rows.forEach((r) => { const v = valOf(r, p); if (v == null || !isFinite(v)) return; d += (d ? 'L' : 'M') + X(r.t).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ' })
    if (d) s += `<path d="${d}" fill="none" stroke="${p.color}" stroke-width="${p.w || 1.6}" opacity="${p.op != null ? p.op : 1}"/>`
  })
  // legend
  let lx = PADL + 2
  panels.filter((p) => p.label).forEach((p) => { s += `<text x="${lx}" y="${PADT - 6}" fill="${p.color}" font-size="9" font-weight="bold">━ ${p.label}</text>`; lx += (p.label.length * 6 + 22) })
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;">${s}</svg>`
}

// the highlighted NET-WORTH mini-chart: green fill above $10, red fill below, dashed baseline at 10.
function nnNetWorthSVG(rows, key, opt) {
  opt = opt || {}
  const W = opt.W || 420, H = opt.H || 90, PADL = 30, PADR = 8, PADT = 8, PADB = 12, BASE = 10.0
  if (!rows || rows.length < 2) return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;"><text x="${W / 2}" y="${H / 2}" fill="#6b786b" font-size="10" text-anchor="middle">net worth — collecting…</text></svg>`
  const pts = rows.map((r) => [r.t, r[key]]).filter((p) => p[1] != null && isFinite(p[1]))
  if (pts.length < 2) return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);"></svg>`
  const t0 = pts[0][0], span = Math.max(1, pts[pts.length - 1][0] - t0)
  let mn = BASE, mx = BASE
  pts.forEach((p) => { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1] })
  const pad = (mx - mn) * 0.12 || 0.5; mn -= pad; mx += pad
  const X = (t) => PADL + (t - t0) / span * (W - PADL - PADR)
  const Y = (v) => PADT + (1 - (v - mn) / (mx - mn)) * (H - PADT - PADB)
  const yb = Y(BASE)
  const line = pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1))
  // two clipped fills via clipPaths above/below baseline
  const uid = 'nw' + Math.random().toString(36).slice(2, 7)
  const areaPts = `${X(pts[0][0]).toFixed(1)},${yb.toFixed(1)} ${line.join(' ')} ${X(pts[pts.length - 1][0]).toFixed(1)},${yb.toFixed(1)}`
  const last = pts[pts.length - 1][1], stroke = last >= BASE ? '#3ec46d' : '#ff5555'
  let s = `<defs>
    <clipPath id="${uid}g"><rect x="0" y="0" width="${W}" height="${yb.toFixed(1)}"/></clipPath>
    <clipPath id="${uid}r"><rect x="0" y="${yb.toFixed(1)}" width="${W}" height="${(H - yb).toFixed(1)}"/></clipPath>
  </defs>`
  s += `<polygon points="${areaPts}" fill="rgba(62,196,109,0.20)" clip-path="url(#${uid}g)"/>`
  s += `<polygon points="${areaPts}" fill="rgba(255,85,85,0.20)" clip-path="url(#${uid}r)"/>`
  s += `<line x1="${PADL}" y1="${yb.toFixed(1)}" x2="${W - PADR}" y2="${yb.toFixed(1)}" stroke="#888" stroke-width="1" stroke-dasharray="3 3"/>`
  s += `<text x="${PADL - 3}" y="${(yb + 3).toFixed(1)}" fill="#888" font-size="8" text-anchor="end">$10</text>`
  s += `<polyline fill="none" stroke="${stroke}" stroke-width="1.8" points="${line.join(' ')}"/>`
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;">${s}</svg>`
}

// small ROI sparkline (one scale)
function nnSparkSVG(rows, key) {
  const W = 130, H = 44, P = 4
  const pts = (rows || []).map((r) => [r.t, r[key]]).filter((p) => p[1] != null && isFinite(p[1]))
  if (pts.length < 2) return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);"></svg>`
  const t0 = pts[0][0], span = Math.max(1, pts[pts.length - 1][0] - t0)
  let mn = 0, mx = 0; pts.forEach((p) => { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1] })
  if (mx - mn < 1) { mx += 0.5; mn -= 0.5 }
  const X = (t) => P + (t - t0) / span * (W - 2 * P)
  const Y = (v) => P + (1 - (v - mn) / (mx - mn)) * (H - 2 * P)
  const last = pts[pts.length - 1][1], col = last >= 0 ? '#3ec46d' : '#ff5555'
  const y0 = Y(0)
  let s = `<line x1="${P}" y1="${y0.toFixed(1)}" x2="${W - P}" y2="${y0.toFixed(1)}" stroke="#1c241c" stroke-dasharray="2 2"/>`
  s += `<polyline fill="none" stroke="${col}" stroke-width="1.5" points="${pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}"/>`
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;">${s}</svg>`
}

// ============================================================================
// ===== BOT-FAMILY CARDS + FORWARD-BOT TRADE PARSING =========================
// ============================================================================
// Normalize a forward-bot trade log into {t, side, entry, exit, pnl, closed} rows. The forward bots'
// trade-log schema isn't fully pinned (files sync at runtime), so accept the several plausible field
// names: type:'entry'/'exit' (w_neural style) OR a single closed row carrying pnl. Never throws on junk.
const _fwdNormCache = new WeakMap()   // MEMO: parsed trade-log array -> normalized rows. Keyed on the array
// REFERENCE (WeakMap), so it parses each log at most once per render pass no matter how many consumers ask
// (leaderboard push + card stats + markers + vtrace count + detail overlay = 4-5 calls/bot/tick, ~60 bots).
// main.js hands the SAME array instance to every consumer in a pass and only builds a fresh array when the
// mirror file actually changes — so appends AND in-place 'corrected':'kalshi_api' edits (same length, changed
// pnl) both invalidate correctly by identity. GC'd automatically when the state is replaced. No stale reads.
function fwdNormTrades(rows) {
  if (!Array.isArray(rows)) return []
  const _cached = _fwdNormCache.get(rows); if (_cached) return _cached
  const out = []
  // QA (2026-07-02): normalize side casing. The NS grid bots (C_ns_*) log side:"YES" UPPERCASE while every
  // creep/chop bot logs lowercase; every consumer compares `q.side === 'yes'` (table class, open-mark exit-bid
  // selection, chart marker color, detail-overlay color), so an uppercase side rendered a YES trade as NO
  // (red, marked against the NO bid). Lowercase here once; displays already .toUpperCase() for text.
  const _side = (r) => (typeof r.side === 'string' ? r.side.toLowerCase() : r.side)
  // REAL schema (slowcreep/chop_tp): two rows per trade, a 'entry' then an 'exit',
  // sharing the window ticker `tk`; the EXIT row is self-complete (entry_px + exit_px + pnl).
  // Pair by `tk`. Also accept single closed rows carrying pnl/net.
  // NOTE (L_nearstrike-style live logs): rows with type 'fill' / 'cancel_attempt' / 'kill_skip' (and the
  // creep bots' 'skip'/'skip_settle') carry NO pnl/net field, so they fall through every branch below and
  // are silently ignored — no phantom open/closed rows. Do NOT widen the last branch to pnl-less types.
  // ---------------------------------------------------------------------------------------------------
  // TOLERANT FIELD RESOLVERS (2026-07-03): the paper arms deployed in the last 24h log IN/OUT/P&L under NEW
  // field names the old fixed reads (entry_px/exit_px/pnl) didn't map → rows rendered "undefined" for IN,
  // OUT, and P&L. Map every plausible name so each arm's canonical field still wins FIRST (additive; the old
  // arms — fav_gate/absorb/creep/ns/chop/btcd — carry entry_px/exit_px/pnl, so their output is byte-identical):
  //   bothsides (C_bothsides/_osc/_bm): entry `price`; the EXIT row carries only pnl_opt/pnl_pess + final_mid +
  //     settle_yes (NO entry_px/exit_px/pnl) → IN backfilled from the paired ENTRY row by tk; OUT=final_mid.
  //   xtrack (C_xtrack): entry `price`; exit pnl_opt/pnl_pess + exit_kind (cancels → OUT genuinely absent, '·').
  //   csflight (C_csflight): OPEN entry has taker_ask/maker_bid/mid (no entry_px); exit has entry_px+pnl but no
  //     exit_px → OUT resolves from final_mid.
  // 0 is a valid price/pnl, so every chain tests `!= null` (never truthiness). The last (single-closed-row)
  // branch keeps its ORIGINAL pnl/net-only gate — resolvers change field VALUES, not which rows emit (still
  // no phantom rows from pnl-less 'fill'/'skip'/'abstain'/'trigger'/'event' types).
  const _pick = (...vals) => { for (const v of vals) if (v != null) return v; return null }
  const _inPx = (r) => _pick(r.entry_px, r.entry, r.ask, r.price, r.taker_ask, r.maker_bid, r.mid)
  const _outPx = (r) => _pick(r.exit_px, (typeof r.exit === 'number' ? r.exit : null), r.settle_px, r.exit_price, r.final_mid, r.mark_mid, r.settle_yes)
  const _pnlOf = (r) => _pick(r.pnl, r.pnl_settle, r.pnl_opt, r.net)
  // ---------------------------------------------------------------------------------------------------
  // BOTH-SIDES SPLIT (2026-07-03, Noah): the both-sides arms (C_bothsides / _ng / _osc / _bm) buy BOTH the
  // YES and the NO leg of ONE window and log a SINGLE combined record per window — the ENTRY row carries
  // legs:["YES","NO"] + arm:"bothsides*" + price (per-leg cost, ~.35); the EXIT row carries settle_yes +
  // opt:{cat,pnl,yes_ft,no_ft} + pnl_opt/pnl_pess and has NO per-leg entry_px/exit_px. Noah wants TWO rows
  // per window — a YES-leg row and a NO-leg row — each with its own IN/OUT/fill-status/pnl, so the ONE-LEG-
  // ADVERSE case (only one leg ever filled) is visible instead of hidden inside a netted number.
  // DETECTION: the exit row itself carries no arm/legs, so we key off the paired ENTRY row's legs/arm
  //   signature; defensively we ALSO split any exit row that carries opt.yes_ft/opt.no_ft (the bothsides
  //   exit fingerprint) even if its entry row hasn't synced.
  // RECONCILIATION (VERIFIED on the real C_bothsides*/_ng/_osc logs, both+oneN+oneY): leg cost = entry price;
  //   a leg is FILLED iff its opt.<side>_ft != null; a filled leg PAYS 1.0 if that side WON else 0; so
  //   leg_pnl = filled ? (won?1:0) − cost : 0. YES wins iff settle_yes==1, NO wins iff settle_yes==0 →
  //   yes_pnl + no_pnl == pnl_opt EXACTLY. UNFILLED leg: entry=null (renders "—"), pnl 0, unfilled:true.
  // Every EMITTED row gains bothleg:true + unfilled + pnl_pess (pessimistic-fill per-leg pnl, surfaced subtly
  //   downstream). ALL OTHER arms are untouched — this branch fires ONLY on the bothsides signature.
  const _legsAreBoth = (e) => !!e && Array.isArray(e.legs) && e.legs.length === 2 &&
    e.legs.map((x) => String(x).toUpperCase()).sort().join(',') === 'NO,YES'
  const _isBothEntry = (e) => _legsAreBoth(e) || (!!e && typeof e.arm === 'string' && e.arm.indexOf('bothsides') === 0)
  const _isBothExit = (r) => !!r && r.opt && typeof r.opt === 'object' && ('yes_ft' in r.opt || 'no_ft' in r.opt)
  // Emit the 2 leg display rows. `ex` = combined EXIT row (null ⇒ still OPEN); `ent` = paired ENTRY row (cost).
  const _pushBothLegs = (ex, ent) => {
    const cost = (ent && ent.price != null) ? ent.price : (ent ? _inPx(ent) : (ex && ex.price != null ? ex.price : 0.35))
    const t = ex ? ex.t : (ent ? ent.t : null)
    const tk = ex ? ex.tk : (ent ? ent.tk : null)
    if (!ex) {
      // OPEN both-sides position (entry synced, exit not yet): fill outcome is unknown until settle, so show
      // both legs at the intended cost with pnl/exit pending — no unfilled marker yet (nothing has resolved).
      out.push({ t, tk, side: 'yes', entry: cost, exit: null, pnl: null, pnl_pess: null, closed: false, bothleg: true, unfilled: false })
      out.push({ t, tk, side: 'no', entry: cost, exit: null, pnl: null, pnl_pess: null, closed: false, bothleg: true, unfilled: false })
      return
    }
    const opt = (ex.opt && typeof ex.opt === 'object') ? ex.opt : {}
    const pess = (ex.pess && typeof ex.pess === 'object') ? ex.pess : null
    const yesWon = (ex.settle_yes === 1 || ex.settle_yes === true)
    const legPnl = (filled, won) => filled ? ((won ? 1 : 0) - cost) : 0
    const yesFilled = opt.yes_ft != null, noFilled = opt.no_ft != null
    // pess = pessimistic fill assumption (its own fill times) → per-leg pess pnl, surfaced subtly downstream.
    const yesFilledP = pess ? (pess.yes_ft != null) : yesFilled, noFilledP = pess ? (pess.no_ft != null) : noFilled
    out.push({ t, tk, side: 'yes', entry: yesFilled ? cost : null, exit: yesWon ? 1 : 0, pnl: legPnl(yesFilled, yesWon), pnl_pess: legPnl(yesFilledP, yesWon), closed: true, bothleg: true, unfilled: !yesFilled })
    out.push({ t, tk, side: 'no', entry: noFilled ? cost : null, exit: yesWon ? 0 : 1, pnl: legPnl(noFilled, !yesWon), pnl_pess: legPnl(noFilledP, !yesWon), closed: true, bothleg: true, unfilled: !noFilled })
  }
  const exitByTk = {}, entryByTk = {}
  rows.forEach((r) => {
    if (!r || r.tk == null) return
    if (r.type === 'exit') exitByTk[r.tk] = r
    else if (r.type === 'entry') entryByTk[r.tk] = r
  })
  rows.forEach((r) => {
    if (!r) return
    if (r.type === 'exit') {
      const ent = entryByTk[r.tk]
      // BOTH-SIDES settled window → split into a YES-leg + a NO-leg row (see _pushBothLegs). Detect via the
      // paired entry's legs/arm signature OR the exit's own opt.*_ft fingerprint (entry may not have synced).
      if (_isBothEntry(ent) || _isBothExit(r)) { _pushBothLegs(r, ent); return }
      // IN: prefer a price on the exit row itself; else backfill from the paired ENTRY row (bothsides/xtrack
      // log the fill price only on the entry row, so the self-complete exit row has no IN of its own).
      const inSelf = _inPx(r)
      out.push({ t: r.t, tk: r.tk, side: _side(r), entry: inSelf != null ? inSelf : (ent ? _inPx(ent) : null), exit: _outPx(r), pnl: _pnlOf(r), closed: true })
    } else if (r.type === 'entry') {
      // entry-price fallback chain (see _inPx): entry_px → entry → ask → price → taker_ask → maker_bid → mid.
      // BTCD hourly bots log the fill only in `ask`; bothsides/xtrack in `price`; csflight in `taker_ask`.
      if (exitByTk[r.tk] == null) {
        // BOTH-SIDES open position (entry synced, no exit yet) → 2 open leg rows instead of one combined row.
        if (_isBothEntry(r)) { _pushBothLegs(null, r); return }
        out.push({ t: r.t, tk: r.tk, side: _side(r), entry: _inPx(r), exit: null, pnl: null, closed: false })
      }
    } else if (r.pnl != null || r.net != null) {
      out.push({ t: r.t != null ? r.t : r.t_in, tk: r.tk, side: _side(r), entry: _inPx(r), exit: _outPx(r), pnl: _pnlOf(r), closed: true })
    }
  })
  const _res = out.sort((a, b) => (a.t || 0) - (b.t || 0))
  _fwdNormCache.set(rows, _res)
  return _res
}
// Build a per-window cumulative-P&L `series` ([[windowIdx, cumCents], …]) from normalized forward trades,
// so the bot draws on #eqchart (drawROI auto-scales) and gets a card sparkline. cumCents = $ net × 100.
// Falls back to a flat-then-end synthetic 2-pt series from the status `net_total` when no trade rows exist
// (so a status-only forward bot still shows SOMETHING on its sparkline instead of "collecting…").
function fwdSeriesFromTrades(norm, status, widx) {
  const closed = (norm || []).filter((q) => q.closed && q.pnl != null)
  if (closed.length) {
    const byWin = {}
    closed.forEach((q) => { const w = Math.floor((q.t || 0) / 900); byWin[w] = (byWin[w] || 0) + q.pnl })
    const ws = Object.keys(byWin).map(Number).sort((a, b) => a - b)
    let cum = 0; const ser = []
    ws.forEach((w) => { cum += byWin[w]; ser.push([w, cum * 100]) })   // cents
    return ser
  }
  // status-only fallback: a short flat line ending at the cumulative net (in cents)
  const nt = status && status.net_total != null ? status.net_total : null
  if (nt != null && widx != null) return [[Math.max(0, (widx || 0) - 1), 0], [widx || 0, nt * 100]]
  return []
}
// Build a per-window cumulative-P&L `series` ([[windowIdx, cumCents], …]) from RAW trade rows that carry a
// pnl on their CLOSE/exit row (NN: type:'exit' rows with .pnl + exit time .t; E_fade: type:'exit' with
// .exit.pnl; M_maker: type:'exit' with .pnl). `pnlOf` extracts the per-trade $ pnl, returning null to skip a
// row. Same shape/units as fwdSeriesFromTrades (cents = $ × 100) so these draw on #eqchart identically.
function pnlSeriesFromRows(rows, pnlOf) {
  const byWin = {}
  ;(rows || []).forEach((r) => {
    if (!r) return
    const p = pnlOf(r); if (p == null) return
    const t = r.t != null ? r.t : r.entry_t; if (t == null) return
    const w = Math.floor(t / 900); byWin[w] = (byWin[w] || 0) + p
  })
  const ws = Object.keys(byWin).map(Number).sort((a, b) => a - b)
  let cum = 0; const ser = []
  ws.forEach((w) => { cum += byWin[w]; ser.push([w, cum * 100]) })   // cents
  return ser
}
// Capital-at-risk (deployed $) for a forward dry-run bot, so its ROI can be a TRUE return %
// (net $ / capital × 100) consistent with the evolution / E_fade / M_maker bots — NOT raw cents.
// Prefer the actual trade rows (sum of entry_px over CLOSED round-trips = $ put at risk); when the
// box hasn't synced trade rows yet, fall back to status: n_trades × entry-price. Returns 0 when no base.
function fwdCapBase(norm, status) {
  const closed = (norm || []).filter((q) => q.closed && q.entry != null)
  if (closed.length) return closed.reduce((s, q) => s + (q.entry || 0), 0)
  if (status && status.n_trades && status.entry != null) return status.n_trades * status.entry
  return 0
}
// AUTO-DISCOVER forward bots: enumerate every `c_*_status` key main.js attached to state (one per synced
// C_*_status.json) and DERIVE each card's label / params / family from the bot name — so a brand-new creep
// variant (c_creep75_status, c_creep80_ng_status, …) appears as a card with NO per-bot wiring. Returns a list
// of { statusKey, tradesKey, name, strat, params, idp } in a stable order (chop first, then slow-creep by
// gated→ungated × ascending NN). Parsing rules mirror the old hardcoded _fwdDefs:
//   chop_tp            -> Chop_TP         · strat 'C'  (FORWARD family, NOT slow-creep)
//   slowcreep_short    -> SlowCreep_NO    · strat 'SC' · ungated NO~.71
//   slowcreep_gated    -> SlowCreep_gated · strat 'SC' · gated   NO~.71
//   creep<NN>          -> creep<NN>·gated · strat 'SC' · gated   NO~.<NN>
//   creep<NN>_ng       -> creep<NN>·ung   · strat 'SC' · ungated NO~.<NN>
function fwdBotDefs(state) {
  const out = []
  for (const k of Object.keys(state || {})) {
    if (!/^c_[a-z0-9_]+_status$/.test(k)) continue
    const body = k.slice(2, -7)                 // strip 'c_' prefix + '_status' suffix
    const tradesKey = 'c_' + body + '_trades'
    const idp = body.replace(/_/g, '')          // table-row id prefix (unique per bot)
    let name, strat, params, sortA = 9, sortB = 999
    if (body === 'chop_tp') { name = 'Chop_TP'; strat = 'C'; params = 'buy30/sell55'; sortA = 0 }
    // NearStrike is a STRIKE bot: strat 'NS' like its C_ns_* grid siblings (was 'C', which orphaned it in
    // the FORWARD family with a pink outline while the grid cells got NS/blue — now consistent).
    else if (body === 'nearstrike') { name = 'NearStrike'; strat = 'NS'; params = 'buy cheap<.41 · BTC±$5 of strike · 3-15min · hold-settle (DRY)'; sortA = 0 }
    else if (/^ns_c\d+_d\d+$/.test(body)) { const g = /^ns_c(\d+)_d(\d+)$/.exec(body); name = 'NS .' + g[1] + '/$' + parseInt(g[2], 10); strat = 'NS'; params = 'cheap<.' + g[1] + ' · BTC±$' + parseInt(g[2], 10) + ' of strike · 3-15min · hold-settle (DRY)'; sortA = 0; sortB = parseInt(g[1], 10) * 100 + parseInt(g[2], 10) }
    // QA (2026-07-02): NEARSTRIKE-family CONTROL/combo cells (were falling into the generic 'C' forward
    // family — wrong family card, no NS outline/grouping). ns_nb = the A/B control twin of the canonical
    // c41/$5 cell with the no-repeat-strike ban + fairness-divergence gates REMOVED; ns_combo = the
    // stop-loss(180-660s)+fairdiv≥.178 combo cell. Both are strike bots → strat 'NS', sorted after the grid.
    else if (body === 'ns_nb') { name = 'NS ctrl·nb'; strat = 'NS'; params = 'CONTROL · c41/$5 · no-ban/no-fairdiv · hold-settle (DRY)'; sortA = 0; sortB = 9000 }
    else if (body === 'ns_combo') { name = 'NS combo'; strat = 'NS'; params = 'combo · stop 180-660s · fairdiv≥.178 · hold-settle (DRY)'; sortA = 0; sortB = 9001 }
    else if (body === 'slowcreep_short') { name = 'SlowCreep_NO'; strat = 'SC'; params = 'creep→buyNO · NO~.71 · ungated'; sortA = 1; sortB = 71 }
    else if (body === 'slowcreep_gated') { name = 'SlowCreep_gated'; strat = 'SC'; params = 'creep→buyNO · NO~.71 · gated'; sortA = 1; sortB = 71 }
    // QA (2026-07-02): NOWCAST A/B bots (C_nc_agree/C_nc_dis/C_nc_ctl, deployed today) + the BTCD hourly-cadence
    // bots (C_btcd_snipe/C_btcd_ctl). Both previously fell into the generic 'C' fallback → raw body name
    // ("nc_agree"), generic params, and lumped into the FORWARD/creep-fleet groups (wrong). Give each its own
    // strat/family: nc_* -> 'NC' (NOWCAST family), btcd_* -> 'BD' (BTCD hourly family). strat 'NC'/'BD' are wired
    // into botAllTrades' forward-log resolver + FAMILY_DEFS. New per-row fields (wf/agree/basis) are ignored by
    // fwdNormTrades (extra keys), so trade parsing is unaffected. Standard c_<body>_trades pairing still applies.
    else if (/^nc_(agree|dis|ctl)$/.test(body)) { const g = /^nc_(agree|dis|ctl)$/.exec(body)[1]; name = 'NC ' + g; strat = 'NC'; params = 'nowcast A/B · ' + ({ agree: 'trade when wf-nowcast AGREES w/ mid', dis: 'trade when wf-nowcast DISAGREES', ctl: 'CONTROL (no nowcast gate)' }[g]) + ' · final 60s (PAPER)'; sortA = 4; sortB = ({ agree: 0, dis: 1, ctl: 2 }[g]) }
    else if (/^btcd_(snipe|ctl)$/.test(body)) { const g = /^btcd_(snipe|ctl)$/.exec(body)[1]; name = 'BTCD ' + g; strat = 'BD'; params = 'BTCD HOURLY · ' + (g === 'snipe' ? 'P≥.995 ask[50,94]c wf-nowcast snipe' : 'CONTROL flat ask[85,94]c NO gate') + ' (PAPER)'; sortA = 5; sortB = (g === 'snipe' ? 0 : 1) }
    // BOTH-SIDES arms (C_bothsides / _ng / _osc / _bm): buy BOTH the YES and NO leg per window, hold to settle.
    // Friendly label only — strat stays 'C' (FORWARD family + botAllTrades 'C' branch); the per-window record
    // is split into 2 leg rows downstream by fwdNormTrades (legs:["YES","NO"] signature), not here.
    else if (/^bothsides(_ng|_osc|_bm)?$/.test(body)) { const g = /^bothsides(_ng|_osc|_bm)?$/.exec(body)[1] || ''; name = 'BothSides' + ({ '': '', '_ng': '·ng', '_osc': '·osc', '_bm': '·bm' }[g]); strat = 'C'; params = 'buy BOTH legs @.35 · hold-settle · ' + ({ '': 'baseline', '_ng': 'no-gate', '_osc': 'oscillation-gated', '_bm': 'big-move-gated' }[g]) + ' (PAPER)'; sortA = 6; sortB = ({ '': 0, '_ng': 1, '_osc': 2, '_bm': 3 }[g]) }
    else {
      // QA (2026-07-02): widened from /^creep(\d+)(_ng)?$/ — the LONG-side twins (creep60_long, creep71_long,
      // ×_ng) and the new flat-$5-stop A/B CONTROL bots (creep55_t5, creep71_long_t5) matched nothing and fell
      // into the generic 'C' forward family (wrong family card, excluded from the SLOW-CREEP group). Plain
      // creepNN / creepNN_ng bodies produce byte-identical name/params/sort to before (no regression).
      const m = /^creep(\d+)(_long)?(_ng)?(_t5)?$/.exec(body)
      if (m) {
        const nn = m[1], long = !!m[2], ung = !!m[3], t5 = !!m[4]
        name = 'creep' + nn + (long ? 'L' : '') + (ung ? '·ung' : '·gated') + (t5 ? '·t5' : '')
        strat = 'SC'
        params = 'creep→buy' + (long ? 'YES · YES~.' : 'NO · NO~.') + nn + ' · ' + (ung ? 'ungated' : 'gated') + (t5 ? ' · flat-1 $5-stop CONTROL' : '')
        sortA = ung ? 3 : 2; sortB = (parseInt(nn, 10) || 999) + (long ? 0.5 : 0) + (t5 ? 0.25 : 0)
      } else {
        // unknown C_ forward bot: still show it generically (auto-discover never drops a synced bot)
        name = body; strat = 'C'; params = body; sortA = 8
      }
    }
    out.push({ statusKey: k, tradesKey, name, strat, params, idp, sortA, sortB })
  }
  out.sort((a, b) => (a.sortA - b.sortA) || (a.sortB - b.sortB) || a.name.localeCompare(b.name))
  return out
}
// inline P&L sparkline for a family/top-3 bot row. `series` = [[x, cumPnlCents], …]; auto-scales,
// dashed zero line, green/red by final sign. Compact (used inside cards). Reuses the dark-terminal look.
function botSparkSVG(series, w, h) {
  const W = w || 120, H = h || 34, P = 3
  const pts = (series || []).filter((p) => Array.isArray(p) && p[1] != null && isFinite(p[1]))
  if (pts.length < 2) return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:${W}px;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;"><text x="${W / 2}" y="${H / 2 + 3}" fill="#3a463a" font-size="8" text-anchor="middle">no P&amp;L yet</text></svg>`
  const x0 = pts[0][0], span = Math.max(1e-6, pts[pts.length - 1][0] - x0)
  let mn = 0, mx = 0; pts.forEach((p) => { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1] })
  if (mx - mn < 1) { mx += 0.5; mn -= 0.5 }
  const X = (x) => P + (x - x0) / span * (W - 2 * P)
  const Y = (v) => P + (1 - (v - mn) / (mx - mn)) * (H - 2 * P)
  const last = pts[pts.length - 1][1], col = last >= 0 ? '#3ec46d' : '#ff5555'
  const y0 = Y(0)
  let s = `<line x1="${P}" y1="${y0.toFixed(1)}" x2="${W - P}" y2="${y0.toFixed(1)}" stroke="#1c241c" stroke-dasharray="2 2"/>`
  s += `<polyline fill="none" stroke="${col}" stroke-width="1.5" points="${pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}"/>`
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:${W}px;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;">${s}</svg>`
}

// the NN bots: {tag, status, history, trades, weights}. `real:true` => LIVE real-money bot (distinct red card).
function nnBots(state) {
  return [
    { tag: 'W_neural', status: state.w_neural_status, history: state.w_neural_history || [], trades: state.w_neural_trades || [], weights: state.w_neural_weights || [] },
    { tag: 'W_neural_nobox', status: state.w_neural_nobox_status, history: state.w_neural_nobox_history || [], trades: state.w_neural_nobox_trades || [], weights: state.w_neural_nobox_weights || [] },
    { tag: 'W_neural_v2', status: state.w_neural_v2_status, history: state.w_neural_v2_history || [], trades: state.w_neural_v2_trades || [], weights: state.w_neural_v2_weights || [] },
    { tag: 'W_neural_REAL', real: true, status: state.w_neural_real_status, history: state.w_neural_real_history || [], trades: state.w_neural_real_trades || [], weights: [], account: state.w_neural_real_account || null }
  ]
}
// REAL-money accent (red) — used to make the live-money card unmistakable vs the violet paper cards.
const NN_REALRED = '#ff3b30'

function renderNNCards(state, force) {
  const grid = $('nn-cards'); if (!grid) return
  const bots = pinnedFirst(nnBots(state), function (b) { return b.tag })   // pinned NN cards float to the front (keyed by tag)
  // PERF GATE: the violet NN card grid is the single heaviest synchronous innerHTML rebuild (sparklines +
  // net-worth SVGs per card). NN readiness changes on the order of seconds, so rebuilding ~8x/sec is what
  // wedges the dropdowns/interaction. Throttle + signature-skip when nothing material changed.
  // `force` (selector/click callbacks) always rebuilds for instant feedback.
  if (!force) {
    const sig = bots.map((b) => { const st = b.status
      return b.tag + ':' + (st ? (st.trained || 0) + ',' + (st.exit_trained || 0) + ',' + (st.own_n || 0) + ',' + (st.ready ? 1 : 0) + ',' + (b.history ? b.history.length : 0) + ',' + (st.roi8 != null ? st.roi8.toFixed(2) : '_') + ',' + (st.nw8 != null ? st.nw8.toFixed(2) : '_') + ',' + ((b.account && b.account.wall) || 0) : 'x') }).join('|')
    const now = Date.now()
    // FREEZE FIX: a quiescent NN view must cost ZERO per tick. Previously the unchanged-content branch was
    // time-boxed to 5s, after which a static grid paid a full sparkline/net-worth innerHTML rebuild every
    // ~700ms forever. Now: if the content signature is unchanged, return as a TRUE no-op regardless of elapsed
    // time. The NN_MIN_MS throttle still brakes the changed-content path.
    if (sig === _nnSig) return                             // unchanged content — keep existing DOM, no rebuild
    if (now - _nnLastAt < NN_MIN_MS) return                // throttle the changed-content path: ≤ ~1.4x/sec
    _nnLastAt = now; _nnSig = sig
  }
  const card = (b) => {
    const st = b.status
    const accent = b.real ? NN_REALRED : NN_VIOLET   // REAL bot = red accent (live money), paper bots = violet
    if (!st) return `<div class="${isPinned(b.tag) ? 'pinned-row ' : ''}" style="width:440px;background:var(--panel);border:1px solid ${b.real ? '#4a1f1f' : '#2a2440'};border-top:3px solid ${accent};padding:12px;color:#6b786b;">${pinGlyph(b.tag)}● ${b.tag}<br><span style="font-size:11px">no status yet — bot not emitting ${b.tag === 'W_neural_nobox' ? 'w_neural_nobox_status.json (nobox twin not deployed?)' : (b.tag === 'W_neural_v2' ? 'w_neural_v2_status.json (WN2 guard bot not deployed?)' : (b.real ? 'w_neural_real_status.json (REAL bot not syncing?)' : 'w_neural_status.json'))}…</span></div>`
    const hAll = b.history.filter(Boolean)
    // per-graph override keys (per bot, so each card's two graphs filter independently)
    const gkRoi = 'card.roi.' + b.tag, gkNw = 'card.nw.' + b.tag
    const hRoi = nnRows(hAll, gkRoi), hNw = nnRows(hAll, gkNw)
    const lm = computeLMRS(st)
    const ready = !!st.ready
    const roiC = (v) => (v != null && v >= 0) ? '#3ec46d' : '#ff5555'
    const nw8 = st.nw8 != null ? st.nw8 : 10
    const arm = st.arm_rate != null ? (st.arm_rate * 100) : null
    // REAL-money badges + P&L/cap line (only on the live-money card)
    const realBadge = b.real ? `<span style="font-size:9px;font-weight:800;color:#fff;background:${NN_REALRED};padding:1px 5px;border-radius:3px;margin-left:4px;">$ REAL${st.live ? ' · LIVE' : ' · DRY'}</span>` : ''
    const pnlC = (v) => (v != null && v >= 0) ? '#3ec46d' : '#ff5555'
    const money = (v) => v == null ? '—' : (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)
    // ── GROUND TRUTH from the real Kalshi account (read-only poller) — the AUTHORITATIVE headline ──
    const acct = b.real ? b.account : null
    const acctAge = acct && acct.wall ? (Date.now() / 1000 - acct.wall) : null
    const acctStale = acctAge != null && acctAge > 120
    const realHeadline = b.real ? (acct ? `<div style="margin:4px 0 8px;padding:6px 8px;background:#1a0d0d;border:1px solid #4a1f1f;color:var(--text);">
        <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:9px;color:#ff7a6b;font-weight:800;letter-spacing:.5px;margin-bottom:4px;">
          <span>● GROUND TRUTH · KALSHI ACCOUNT</span><span style="color:${acctStale ? '#ffb020' : '#6b786b'};font-weight:600;">${acctStale ? 'STALE ' + Math.round(acctAge) + 's' : 'live'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;">
          <span>realized P&L <b style="color:${pnlC(acct.realized_pnl)};font-size:13px;">${money(acct.realized_pnl)}</b></span>
          <span>balance <b>$${acct.balance != null ? acct.balance.toFixed(2) : '—'}</b></span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#9aa39a;margin-top:3px;">
          <span>settled ${acct.settled_count != null ? acct.settled_count : '—'} <span style="color:#3ec46d;">${acct.settled_wins != null ? acct.settled_wins + 'W' : ''}</span>${acct.settled_losses != null ? '/<span style="color:#ff5555;">' + acct.settled_losses + 'L</span>' : ''}</span>
          <span>open ${acct.open_count != null ? acct.open_count : '—'}${(acct.open_positions && acct.open_positions[0]) ? ' · ' + (acct.open_positions[0].side || '?') + ' ' + (acct.open_positions[0].count != null ? acct.open_positions[0].count : '—') + ' @' + Math.round((acct.open_positions[0].avg_entry || 0) * 100) + 'c' + (acct.open_positions[0].mark != null ? ' mk' + Math.round(acct.open_positions[0].mark * 100) + 'c' : '') : ''}</span>
        </div>
      </div>` : `<div style="margin:4px 0 8px;padding:6px 8px;background:#1a0d0d;border:1px solid #4a1f1f;color:#9a8a8a;font-size:10px;">● GROUND TRUTH · KALSHI ACCOUNT — waiting for w_neural_real_account.json (poller not syncing yet)…</div>`) : ''
    // ── SECONDARY: bot internal sim/paper-twin + cap safeguard (NOT the headline) ──
    const realRow = b.real ? `<div style="display:flex;justify-content:space-between;font-size:10px;margin:0 0 8px;padding:4px 7px;background:#0e0a0a;border:1px solid #2e1c1c;color:#9aa39a;">
        <span style="color:#6b786b;font-weight:700;">bot-internal</span>
        <span>sim P&L <b style="color:${pnlC(st.real_pnl)}">${money(st.real_pnl)}</b></span>
        <span>n <b>${st.real_n != null ? st.real_n : '—'}</b></span>
        <span>cap left <b style="color:${pnlC((st.cap_remaining || 0) - 0.01)}">$${st.cap_remaining != null ? st.cap_remaining.toFixed(2) : '—'}</b></span>
        <span>${st.cap_latched ? '<b style="color:#ff5555">LATCHED</b>' : (st.killed ? '<b style="color:#ff5555">KILLED</b>' : (st.halted ? '<b style="color:#ffb020">HALT</b>' : '<b style="color:#3ec46d">armed</b>'))}</span>
      </div>` : ''
    return `<div class="nn-card${isPinned(b.tag) ? ' pinned-row' : ''}" data-nntag="${b.tag}" style="width:440px;background:var(--panel);border:1px solid ${b.real ? '#4a1f1f' : '#2a2440'};border-top:3px solid ${accent};${b.real ? 'box-shadow:0 0 0 1px #4a1f1f inset;' : ''}padding:12px;cursor:pointer;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div style="font-weight:700;font-size:14px;">${pinGlyph(b.tag)}<span style="color:${accent}">●</span> ${st.tag || b.tag} <span class="tag">NN</span>${realBadge}</div>
        <div style="font-size:12px;font-weight:700;color:${ready ? '#3ec46d' : '#6b786b'}">${ready ? '✓ LIVE' : 'learning'} · ${lm.score}/100</div>
      </div>
      <div style="font-size:11px;color:#6b786b;margin:2px 0 8px;">trained ${(st.trained || 0).toLocaleString()} · exit ${(st.exit_trained || 0).toLocaleString()} · ${st.own_n || 0} trades · size ${st.size != null ? st.size : '—'}</div>
      ${realHeadline}
      ${realRow}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
        <span style="font-size:9px;color:var(--cyan);font-weight:700;">ROI sparklines</span>${nnOverrideSelectHTML(gkRoi)}
      </div>
      <div style="display:flex;gap:6px;">
        ${[['roi1', '1×'], ['roi3', '3×'], ['roi8', '8×']].map(([k, lbl]) => `<div style="flex:1;">
          <div style="font-size:9px;color:var(--cyan);font-weight:700;">ROI — ${lbl}</div>
          ${nnSparkSVG(hRoi, k)}
          <div style="font-size:11px;font-weight:700;color:${roiC(st[k])};text-align:center;">${st[k] != null ? (st[k] >= 0 ? '+' : '') + st[k].toFixed(1) + '%' : '—'}</div>
        </div>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;margin:8px 0;color:var(--text);">
        <span>win <b>${st.own_win != null ? st.own_win : '—'}%</b></span>
        <span>prof-win <b>${st.pwin_rate != null ? st.pwin_rate : '—'}%</b></span>
        <span>arm <b>${arm != null ? arm.toFixed(1) : '—'}%</b></span>
        <span>conf <b>${st.conf != null ? st.conf : '—'}%</b></span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
        <span style="font-size:9px;color:var(--cyan);font-weight:700;">NET WORTH (8× acct, $10 start) <span style="color:${roiC(nw8 - 10)}">$${nw8.toFixed(2)}</span></span>${nnOverrideSelectHTML(gkNw)}
      </div>
      ${nnNetWorthSVG(hNw, 'nw8')}
      <div style="display:flex;justify-content:space-between;font-size:9px;font-weight:700;margin:8px 0 3px;"><span style="color:${lm.color}">READINESS · ${lm.band}</span><span>${lm.score}/100</span></div>
      <div style="height:14px;background:#070b07;border:1px solid var(--border);position:relative;overflow:hidden;">
        <div style="position:absolute;left:0;top:0;bottom:0;width:${lm.score}%;background:linear-gradient(90deg,${accent},${lm.color});"></div>
      </div>
    </div>`
  }
  grid.innerHTML = nnGlobalSelectorHTML() + bots.map(card).join('')
  // GLOBAL selector — changing it re-renders every card AND the open detail overlay
  nnWireGlobal(grid, () => {
    if (lastState) { renderNNCards(lastState, true); if (selectedNN) renderNNDetail(lastState, selectedNN, true) }
  })
  // per-card override selects (re-render cards only; don't reopen detail)
  nnWireOverrides(grid, () => { if (lastState) renderNNCards(lastState, true) })
  grid.querySelectorAll('.nn-card').forEach((el) => el.addEventListener('click', () => {
    selectedNN = el.getAttribute('data-nntag'); if (lastState) renderNNDetail(lastState, selectedNN, true)
  }))
}

let _nnDetailLastAt = 0, _nnDetailSig = ''
function renderNNDetail(state, tag, force) {
  // PERF GATE: the detail overlay rebuilds 13 SVG panels (incl. nnWeightsSVG drawing ~97 paths). It must NOT
  // re-run ~8x/sec. Throttle + skip when the selected bot's data signature is unchanged. `force` (open/select/
  // compare-toggle/range-change callbacks) always rebuilds for instant feedback.
  if (!force) {
    const bb = nnBots(state).find((x) => x.tag === tag)
    const st = bb && bb.status
    const sig = tag + ':' + (nnCompare ? 1 : 0) + ':' + nnRange + ':' + (st ? (st.trained || 0) + ',' + (st.exit_trained || 0) + ',' + (st.own_n || 0) + ',' + (bb.history ? bb.history.length : 0) + ',' + (bb.weights ? bb.weights.length : 0) + ',' + ((bb.account && bb.account.wall) || 0) : 'x')
    const now = Date.now()
    if (sig === _nnDetailSig && now - _nnDetailLastAt < 5000) return
    if (now - _nnDetailLastAt < NN_MIN_MS) return
    _nnDetailLastAt = now; _nnDetailSig = sig
  }
  let dt = $('nn-detail')
  if (!dt) {
    dt = document.createElement('div'); dt.id = 'nn-detail'
    dt.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(4,4,8,0.97);overflow:auto;padding:16px;'
    dt.addEventListener('dblclick', (e) => { if (e.target === dt) { selectedNN = null; dt.style.display = 'none' } })
    // QA FIX: a single click on the dark backdrop (not on any inner control) also dismisses the overlay.
    // Previously only dblclick or the ✕ button closed it, so a natural single backdrop-click did nothing
    // and the full-viewport overlay kept eating clicks meant for the page underneath.
    dt.addEventListener('click', (e) => { if (e.target === dt) { selectedNN = null; dt.style.display = 'none' } })
    document.body.appendChild(dt)
  }
  dt.style.display = 'block'
  const bots = nnBots(state)
  const b = bots.find((x) => x.tag === tag); if (!b) { dt.style.display = 'none'; selectedNN = null; return }
  const other = bots.find((x) => x.tag !== tag)
  const hFull = b.history.filter(Boolean), wtFull = b.weights.filter(Boolean), st = b.status || {}
  const ohFull = (other && other.history || []).filter(Boolean)
  const cmpOn = nnCompare && ohFull.length > 1
  const lm = computeLMRS(st)
  // panel builder — each panel carries a per-graph override (data-gk) shown as a ▾ select in its header.
  // `gk` namespaced by tag so the two bots' detail panels filter independently.
  const panel = (title, svg, gkSuffix) => {
    const gk = 'detail.' + tag + '.' + gkSuffix
    return `<div style="background:var(--panel);border:1px solid #2a2440;padding:6px 8px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;gap:6px;"><div style="font-size:10px;color:var(--cyan);font-weight:700;">${title}</div>${nnOverrideSelectHTML(gk)}</div>${svg}</div>`
  }
  // rows for a graph, filtered by THAT graph's effective range; for compare panels, filter both bots
  // by the same effective range before the index-aligned merge so the overlay stays consistent.
  const rowsFor = (gkSuffix) => nnRows(hFull, 'detail.' + tag + '.' + gkSuffix)
  const mergedFor = (gkSuffix, key, mk) => {
    const eff = nnEffRange('detail.' + tag + '.' + gkSuffix)
    const hh = nnFilterByRange(hFull, eff)
    return cmpOn ? mergeRows(hh, nnFilterByRange(ohFull, eff), key, mk) : hh
  }
  const wtFor = (gkSuffix) => nnRows(wtFull, 'detail.' + tag + '.' + gkSuffix)
  let charts = ''
  // 1 net worth all scales
  charts += panel('NET WORTH — 1× / 3× / 8× ($10 start)', nnLineSVG(rowsFor('nw'), [{ key: 'nw1', color: '#4fd0e0', label: '1×' }, { key: 'nw3', color: '#e0b020', label: '3×' }, { key: 'nw8', color: NN_VIOLET, label: '8×' }], { baseline: 10, fmt: (v) => '$' + v.toFixed(1) }), 'nw')
  // 2 ROI all scales (+compare nobox 8×)
  charts += panel('ROI % — 1× / 3× / 8×' + (cmpOn ? ' · +nobox 8×' : ''), nnLineSVG(mergedFor('roi', 'roi8', 'roi8b'), cmpOn ? [{ key: 'roi1', color: '#4fd0e0', label: '1×' }, { key: 'roi3', color: '#e0b020', label: '3×' }, { key: 'roi8', color: NN_VIOLET, label: '8×' }, { key: 'roi8b', color: '#ff5fa2', label: 'nobox 8×', w: 1.2, op: 0.6 }] : [{ key: 'roi1', color: '#4fd0e0', label: '1×' }, { key: 'roi3', color: '#e0b020', label: '3×' }, { key: 'roi8', color: NN_VIOLET, label: '8×' }], { baseline: 0, fmt: (v) => v.toFixed(0) + '%' }), 'roi')
  // 3 roi/hr
  charts += panel('ROI per hour', nnLineSVG(rowsFor('roihr'), [{ key: 'roi_hr', color: '#3ec46d', label: 'roi/hr' }], { baseline: 0 }), 'roihr')
  // 4 win-rate (+compare)
  charts += panel('WIN-RATE % over time' + (cmpOn ? ' · +nobox' : ''), nnLineSVG(mergedFor('win', 'win', 'win2'), cmpOn ? [{ key: 'win', color: '#3ec46d', label: tag }, { key: 'win2', color: '#ff5fa2', label: 'nobox' }] : [{ key: 'win', color: '#3ec46d', label: 'win%' }], { min: 0, max: 100, baseline: 50 }), 'win')
  // 5 profitable-window rate
  charts += panel('PROFITABLE-WINDOW RATE %', nnLineSVG(rowsFor('pwin'), [{ key: 'pwin_rate', color: '#9b6bff', label: 'prof-win%' }], { min: 0, max: 100, baseline: 50 }), 'pwin')
  // 6 confidence + rolling win
  charts += panel('CONFIDENCE / p_win % (overlay rolling win)', nnLineSVG(rowsFor('conf'), [{ key: 'conf', color: '#4fd0e0', label: 'conf' }, { key: 'rwin', color: '#3ec46d', label: 'roll-win' }], { min: 0, max: 100, baseline: 50 }), 'conf')
  // 7 readiness
  charts += panel('READINESS 0–100 over time', nnLineSVG(rowsFor('ready'), [{ key: 'readiness', color: lm.color, label: 'readiness' }], { min: 0, max: 100 }), 'ready')
  // 8 training data-points (dual, log)
  charts += panel('TRAINING data-points (entry + exit net, log)', nnLineSVG(rowsFor('train'), [{ key: 'trained', color: '#e0b020', label: 'entry' }, { key: 'exit_trained', color: '#4fd0e0', label: 'exit' }], { log: true, fmt: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0) }), 'train')
  // 9 trades vs profitable
  charts += panel('TRADES total vs profitable', nnLineSVG(rowsFor('trades'), [{ key: 'n', color: '#6b786b', label: 'total' }, { fn: (r) => (r.n != null && r.win != null) ? Math.round(r.win / 100 * r.n) : null, color: '#3ec46d', label: 'wins' }], { min: 0 }), 'trades')
  // 10 arm-rate
  charts += panel('ARM-RATE over time', nnLineSVG(rowsFor('arm'), [{ key: 'arm_rate', color: '#9b6bff', label: 'arm-rate' }], { baseline: 0.68 }), 'arm')
  // 11 NN weights — all 97 (W1 80 + b1 8 + W2 8 + b2 1) thin + summary bold
  charts += panel('ENTRY-NET WEIGHTS (all 97, summary bold)', nnWeightsSVG(wtFor('weights')), 'weights')
  // 12 input normalization drift (10 feature means)
  charts += panel('INPUT NORMALIZATION DRIFT (10 feature means)', nnInMeanSVG(wtFor('inmean')), 'inmean')
  // 13 NN net P&L (+compare nobox net)
  charts += panel('NN net P&L over time (net + rolling rnet)' + (cmpOn ? ' · +nobox net' : ''), nnLineSVG(mergedFor('pnl', 'net', 'netb'), cmpOn ? [{ key: 'net', color: '#3ec46d', label: 'net' }, { key: 'rnet', color: '#e0b020', label: 'rnet' }, { key: 'netb', color: '#ff5fa2', label: 'nobox net', w: 1.2, op: 0.6 }] : [{ key: 'net', color: '#3ec46d', label: 'net' }, { key: 'rnet', color: '#e0b020', label: 'rnet' }], { baseline: 0 }), 'pnl')

  const sub = `trained ${(st.trained || 0).toLocaleString()} · exit ${(st.exit_trained || 0).toLocaleString()} · ${st.own_n || 0} trades · win ${st.own_win != null ? st.own_win + '%' : '—'} · nw8 $${(st.nw8 != null ? st.nw8 : 10).toFixed(2)} · readiness ${lm.score}/100 (${lm.band})`
  // ── GROUND TRUTH account section (REAL bot only): balance + per-settled-trade P&L + open positions ──
  let acctSection = ''
  if (b.real) {
    const acct = b.account
    const m = (v) => v == null ? '—' : (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)
    const pc = (v) => (v != null && v >= 0) ? '#3ec46d' : '#ff5555'
    if (acct) {
      const age = acct.wall ? Math.round(Date.now() / 1000 - acct.wall) : null
      const stale = age != null && age > 120
      const settled = (acct.settled || []).slice().reverse()   // newest first
      const settRows = settled.map((s) => {
        const tm = s.settled_time ? etTime(s.settled_time) : '—'
        const win = (s.ticker || '').replace('KXBTC15M-', '')
        return `<tr>
          <td style="color:#9aa39a;">${tm}</td>
          <td>${win}</td>
          <td style="text-align:center;color:${s.result === 'yes' ? '#3ec46d' : '#ff7a6b'};font-weight:700;">${(s.result || '—').toUpperCase()}</td>
          <td style="text-align:right;">${s.bot_fills}</td>
          <td style="text-align:right;">$${s.cost != null ? s.cost.toFixed(2) : '—'}</td>
          <td style="text-align:right;">$${s.payout != null ? s.payout.toFixed(2) : '—'}</td>
          <td style="text-align:right;">$${s.fees != null ? s.fees.toFixed(2) : '—'}</td>
          <td style="text-align:right;font-weight:700;color:${pc(s.realized_pnl)};">${m(s.realized_pnl)}</td>
        </tr>`
      }).join('') || '<tr><td colspan="8" style="color:#6b786b;">no settled windows yet…</td></tr>'
      const openRows = (acct.open_positions || []).map((p) => `<span style="margin-right:12px;">${(p.ticker || '').replace('KXBTC15M-', '')} <b style="color:${p.side === 'yes' ? '#3ec46d' : '#ff7a6b'};">${(p.side || '?').toUpperCase()}×${p.count != null ? p.count : '—'}</b> @${Math.round((p.avg_entry || 0) * 100)}c${p.mark != null ? ' · mark ' + Math.round(p.mark * 100) + 'c (val $' + (p.value != null ? p.value.toFixed(2) : '—') + ')' : ''}</span>`).join('') || '<span style="color:#6b786b;">flat — no open position</span>'
      acctSection = `<div style="background:#140b0b;border:1px solid #4a1f1f;border-left:3px solid ${NN_REALRED};padding:8px 10px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
          <div style="font-size:12px;font-weight:800;color:#ff7a6b;letter-spacing:.5px;">● GROUND TRUTH · REAL KALSHI ACCOUNT <span style="font-size:9px;color:#9aa39a;font-weight:500;">(read-only poll · ${stale ? '<span style="color:#ffb020;">STALE ' + age + 's</span>' : 'live ' + (age != null ? age + 's' : '') + ' ago'})</span></div>
          <div style="font-size:13px;">realized P&L <b style="color:${pc(acct.realized_pnl)};">${m(acct.realized_pnl)}</b> · balance <b>$${acct.balance != null ? acct.balance.toFixed(2) : '—'}</b></div>
        </div>
        <div style="font-size:10px;color:#9aa39a;margin-bottom:6px;">open now: ${openRows}</div>
        <div style="font-size:10px;color:#6b786b;margin-bottom:3px;">SETTLED TRADES — what each window settled at + how much it made (cumulative realized = ${m(acct.realized_pnl_settled_only)} settled ${acct.cur_event_realized != null ? '+ ' + m(acct.cur_event_realized).replace('+$', '$') + ' open-event' : ''})</div>
        <table style="width:100%;font-size:10px;border-collapse:collapse;color:var(--text);">
          <thead><tr style="color:#9aa39a;text-align:left;border-bottom:1px solid #2e1c1c;">
            <th>settled</th><th>window</th><th style="text-align:center;">result</th><th style="text-align:right;">fills</th><th style="text-align:right;">cost</th><th style="text-align:right;">payout</th><th style="text-align:right;">fees</th><th style="text-align:right;">P&L</th>
          </tr></thead>
          <tbody>${settRows}</tbody>
        </table>
        <div style="font-size:9px;color:#6b786b;margin-top:5px;">This is the AUTHORITATIVE Kalshi number (settlement-inclusive). The charts below are the bot's internal sim/paper twin + decision-quote-vs-real-fill fidelity (paper-vs-live comparison).</div>
      </div>`
    } else {
      acctSection = `<div style="background:#140b0b;border:1px solid #4a1f1f;border-left:3px solid ${NN_REALRED};padding:8px 10px;margin-bottom:10px;font-size:11px;color:#9a8a8a;">● GROUND TRUTH · REAL KALSHI ACCOUNT — waiting for w_neural_real_account.json (kalshi_account_poll not syncing yet).</div>`
    }
  }
  dt.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="font-size:16px;font-weight:700;color:${NN_VIOLET};">● ${tag} <span style="font-size:12px;color:#6b786b;font-weight:400;">${sub}</span></div>
      <div style="display:flex;gap:14px;align-items:center;">
        <span style="font-size:11px;color:${NN_VIOLET};display:flex;align-items:center;gap:5px;"><span style="font-weight:700;">⏱ TIME RANGE</span>
          <button type="button" class="nn-dd-btn nn-range-global-d" data-kind="global" style="background:#0a0e0a;color:var(--text);border:1px solid ${NN_VIOLET};font:11px monospace;padding:2px 8px;cursor:pointer;min-width:96px;text-align:left;">${(NN_RANGES.find((r) => r.id === nnRange) || { label: nnRange }).label} ▾</button></span>
        <label style="font-size:11px;color:#6b786b;cursor:pointer;"><input type="checkbox" id="nn-cmp"${cmpOn ? ' checked' : ''} style="vertical-align:middle;"> compare vs ${other ? other.tag : 'other'}</label>
        <span id="nn-close" style="cursor:pointer;color:#f0a000;border:1px solid #f0a000;padding:3px 12px;font-weight:700;">✕ close</span>
      </div>
    </div>
    <div style="font-size:10px;color:#6b786b;margin-bottom:8px;">double-click background to dismiss · global range applies to all graphs · each chart's ▾ overrides it independently</div>
    ${acctSection}
    ${b.real ? '<div style="font-size:10px;color:#6b786b;font-weight:700;margin:2px 0 6px;letter-spacing:.5px;">SECONDARY · BOT SIM/PAPER TWIN + DECISION-QUOTE-vs-REAL-FILL FIDELITY (paper-vs-live)</div>' : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:10px;">${charts}</div>`
  const cb = $('nn-cmp'); if (cb) cb.addEventListener('change', () => { nnCompare = cb.checked; if (lastState) renderNNDetail(lastState, tag, true) })
  const cl = $('nn-close'); if (cl) cl.addEventListener('click', () => { selectedNN = null; dt.style.display = 'none' })
  // GLOBAL selector inside the overlay — re-renders the detail AND the cards behind it
  nnWireGlobal(dt, () => { if (lastState) { renderNNDetail(lastState, tag, true); renderNNCards(lastState, true) } })
  // per-graph override selects in the detail overlay
  nnWireOverrides(dt, () => { if (lastState) renderNNDetail(lastState, tag, true) })
}

// merge two histories by nearest-t for the compare overlay (simple: index align on shorter)
function mergeRows(a, b, ak, bk) {
  return a.map((r, i) => { const o = { ...r }; const bb = b[Math.min(i, b.length - 1)]; o[bk] = bb ? bb[ak] : null; return o })
}

// entry-net weights: every weight as a faint line + bold summary l2/absmean lines
function nnWeightsSVG(wt) {
  const W = 420, H = 200, PADL = 38, PADR = 10, PADT = 18, PADB = 18
  if (!wt || wt.length < 2) return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);"><text x="${W / 2}" y="${H / 2}" fill="#6b786b" font-size="11" text-anchor="middle">weights — collecting (5-min snapshots)…</text></svg>`
  const flat = (r) => { const out = []; if (Array.isArray(r.W1)) r.W1.forEach((row) => Array.isArray(row) && row.forEach((w) => out.push(w))); if (Array.isArray(r.W2)) r.W2.forEach((w) => out.push(w)); if (Array.isArray(r.b1)) r.b1.forEach((w) => out.push(w)); if (typeof r.b2 === 'number') out.push(r.b2); return out }
  const series = wt.map(flat)
  const nW = Math.max(...series.map((s) => s.length))
  const t0 = wt[0].t, span = Math.max(1, wt[wt.length - 1].t - t0)
  let mn = Infinity, mx = -Infinity
  series.forEach((s) => s.forEach((v) => { if (v < mn) mn = v; if (v > mx) mx = v }))
  wt.forEach((r) => { ['w1_l2', 'w2_l2', 'w1_absmean'].forEach((k) => { if (typeof r[k] === 'number') { if (r[k] < mn) mn = r[k]; if (r[k] > mx) mx = r[k] } }) })
  if (!isFinite(mn)) { mn = -1; mx = 1 }
  if (mx - mn < 1e-6) { mx += 0.5; mn -= 0.5 }
  const X = (t) => PADL + (t - t0) / span * (W - PADL - PADR)
  const Y = (v) => PADT + (1 - (v - mn) / (mx - mn)) * (H - PADT - PADB)
  let s = ''
  for (let g = 0; g <= 3; g++) { const vv = mn + (mx - mn) * g / 3, y = Y(vv); s += `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="#161616"/><text x="${PADL - 4}" y="${(y + 3).toFixed(1)}" fill="#6b786b" font-size="8" text-anchor="end">${vv.toFixed(2)}</text>` }
  for (let wi = 0; wi < nW; wi++) {
    let d = ''
    wt.forEach((r, i) => { const v = series[i][wi]; if (v == null || !isFinite(v)) return; d += (d ? 'L' : 'M') + X(r.t).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ' })
    if (d) s += `<path d="${d}" fill="none" stroke="#7a6bb0" stroke-width="0.4" opacity="0.22"/>`
  }
  const bold = (k, c, lbl, lx) => { let d = ''; wt.forEach((r) => { const v = r[k]; if (v == null || !isFinite(v)) return; d += (d ? 'L' : 'M') + X(r.t).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ' }); return d ? `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.8"/><text x="${lx}" y="${PADT - 6}" fill="${c}" font-size="9" font-weight="bold">━ ${lbl}</text>` : '' }
  s += bold('w1_l2', '#4fd0e0', 'w1 L2', PADL + 2) + bold('w2_l2', '#e0b020', 'w2 L2', PADL + 60) + bold('w1_absmean', '#3ec46d', 'w1 |mean|', PADL + 120)
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;">${s}</svg>`
}

// input normalization drift: one line per feature mean (in_mean[0..9])
function nnInMeanSVG(wt) {
  const W = 420, H = 200, PADL = 38, PADR = 10, PADT = 18, PADB = 18
  const rows = (wt || []).filter((r) => Array.isArray(r.in_mean) && r.in_mean.length)
  if (rows.length < 2) return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);"><text x="${W / 2}" y="${H / 2}" fill="#6b786b" font-size="11" text-anchor="middle">input means — collecting…</text></svg>`
  const NF = Math.max(...rows.map((r) => r.in_mean.length))
  const t0 = rows[0].t, span = Math.max(1, rows[rows.length - 1].t - t0)
  let mn = Infinity, mx = -Infinity
  rows.forEach((r) => r.in_mean.forEach((v) => { if (v < mn) mn = v; if (v > mx) mx = v }))
  if (!isFinite(mn)) { mn = -1; mx = 1 }
  if (mx - mn < 1e-6) { mx += 0.5; mn -= 0.5 }
  const X = (t) => PADL + (t - t0) / span * (W - PADL - PADR)
  const Y = (v) => PADT + (1 - (v - mn) / (mx - mn)) * (H - PADT - PADB)
  const hue = (i) => `hsl(${Math.round(i / NF * 320)},70%,60%)`
  let s = ''
  for (let g = 0; g <= 3; g++) { const vv = mn + (mx - mn) * g / 3, y = Y(vv); s += `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="#161616"/><text x="${PADL - 4}" y="${(y + 3).toFixed(1)}" fill="#6b786b" font-size="8" text-anchor="end">${vv.toFixed(2)}</text>` }
  for (let f = 0; f < NF; f++) { let d = ''; rows.forEach((r) => { const v = r.in_mean[f]; if (v == null || !isFinite(v)) return; d += (d ? 'L' : 'M') + X(r.t).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ' }); if (d) s += `<path d="${d}" fill="none" stroke="${hue(f)}" stroke-width="1.1" opacity="0.85"/>` }
  s += `<text x="${PADL + 2}" y="${PADT - 6}" fill="#6b786b" font-size="9">${NF} feature means</text>`
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;background:#070b07;border:1px solid var(--border);display:block;">${s}</svg>`
}

// LIVE WINDOW panel values + the primary BTC/Kalshi window chart (#vtrace) + strike strip (#strikebar).
// Factored out so it can run in BOTH the normal evolution view AND NN-ONLY mode (where the rest of the
// evolution body is hidden but the main live chart stays visible alongside the #nn-cards grid).
function drawMainWindow(state) {
  const w = state.window || {}
  $('m-btc').textContent = usd(w.btc)
  $('m-btc').className = 'bnval ' + (w.btc != null && w.strike != null ? (w.btc >= w.strike ? 'ok' : 'bad') : 'dim')
  $('m-fair').textContent = w.fair == null ? '—' : (w.fair * 100).toFixed(1) + '%'
  $('m-mid').textContent = w.mid == null ? '—' : (w.mid * 100).toFixed(1) + '%'
  const dev = w.deviation
  $('m-dev').textContent = dev == null ? '—' : (dev > 0 ? '+' : '') + (dev * 100).toFixed(1) + 'pp'
  $('m-dev').className = 'bnval sm ' + (dev == null ? 'dim' : dev < -0.02 ? 'ok' : dev > 0.02 ? 'bad' : 'dim')
  if (w.ticker !== lastTicker) { lastTicker = w.ticker; closeEpoch = Date.now() + (w.sec_left || 0) * 1000 }  // anchor once per window, then let the local clock tick
  $('live-elapsed').textContent = w.elapsed != null ? `${Math.floor(w.elapsed / 60)}m in` : ''
  drawVtrace(state)
  drawStrikeBar(state)
}

// ===== FREEZE FIX (NN-only ribbon): the always-visible top ribbon (#r-status/#r-btc/#r-cd/#r-calib/…) was
// written ONLY in render() AFTER the NN-only early-return, so in NN-only mode it froze at its last values (or
// the initial '…' placeholders when launched straight into NN mode). Factor those writes into a helper that
// BOTH render paths (normal + NN-only + nnDropdownOpen) call, so the ribbon stays live regardless of mode.
function updateRibbon(state) {
  const now = Date.now()
  const age = state.ts ? (now - new Date(state.ts).getTime()) / 1000 : 999
  const st = $('r-status')
  if (st) { if (age < 8) { st.textContent = 'LIVE'; st.className = 'live' } else { st.textContent = 'STALE ' + Math.round(age) + 's'; st.className = 'stale' } }

  const w = state.window || {}
  if ($('r-win')) $('r-win').textContent = (w.ticker || '—').replace('KXBTC15M-', '')
  if ($('r-widx')) $('r-widx').textContent = 'w' + (state.widx ?? 0)
  if ($('r-btc')) $('r-btc').textContent = usd(w.btc)
  if ($('r-strike')) $('r-strike').textContent = usd(w.strike)
  if ($('r-sig')) $('r-sig').textContent = (w.sigma != null ? w.sigma.toFixed(5) : '—') + (w.calk != null ? ` ×${w.calk}` : '')
  const sl = w.sec_left || 0
  const cd = `${String(Math.floor(sl / 60)).padStart(2, '0')}:${String(sl % 60).padStart(2, '0')}`
  if ($('r-cd')) $('r-cd').textContent = cd
  if ($('r-bots')) $('r-bots').textContent = state.n_bots ?? (state.bots || []).length
  { const cs = state.calib_status, ce = $('r-calib')   // fair-model calibration gate (bots paused if not calibrated)
    if (ce) {
      if (!cs || cs.calibrated == null) { ce.textContent = '—'; ce.style.color = 'var(--dim)'; ce.title = 'no calibration status' }
      else if (cs.calibrated) { ce.textContent = '✓ OK' + (cs.drift != null ? ` ${(cs.drift * 100).toFixed(1)}c` : ''); ce.style.color = 'var(--up)'; ce.style.fontWeight = '700'; ce.title = 'fair tracks the market — bots trading' }
      else { ce.textContent = '✗ PAUSED'; ce.style.color = '#ff3b3b'; ce.style.fontWeight = '700'; ce.title = 'BOTS PAUSED — ' + (cs.reason || 'not calibrated') } }
  }
  if ($('r-upd')) $('r-upd').textContent = state.ts ? etTime(state.ts) : '—'
}

// ===== SHARED per-trade helpers (single source of truth) =====================================
// Kalshi taker fee for ONE leg at price p (fraction of $1), ceil'd to the cent. Was 4 identical
// inline copies (_kfn/kfee/_kf/kf) — consolidated so the fee math can never drift between them.
const kalshiFee = (p) => (p != null && p > 0 && p < 1) ? Math.ceil(0.07 * p * (1 - p) * 100) / 100 : 0
// m:ss into the 15-min window. Math.floor FIRST — injected bot rows carry fractional box epochs
// (t=…67.89), and the old inline table copy rendered "3:7.8899999" for those (renderTraining's
// copy already floored; this is the reconciled version both now use).
const winTimeOf = (t) => { const ts = Math.floor((t || 0) % 900); return `${Math.floor(ts / 60)}:${String(ts % 60).padStart(2, '0')}` }
// per-bot row/marker outline (Noah 2026-07-02): STRIKE bots (strat 'NS') = subtle blue; CREEP bots
// (strat 'SC') = NO outline; every other injected/wave bot keeps the pink identifier. Shared by the
// OPEN/SETTLED tables AND the leaderboard rows (which previously had their own inline pink ternary).
const outlineOf = (q) => q.strat === 'NS' ? 'outline:1px solid rgba(90,160,255,0.45);outline-offset:-1px;' : (q.strat === 'SC' ? '' : (q.wave ? 'outline:1px solid rgba(255,63,196,0.35);outline-offset:-1px;' : ''))
// ===== UNIFIED injected-trade list for ONE 15-min window (curW = floor(epochSec/900)) ========
// Single source of truth consumed by BOTH the OPEN/SETTLED tables (updateCurrentWindowTrades) AND
// the #vtrace marker pass (drawVtrace). Previously the chart only knew trades_log / snap_labels /
// w_neural_trades — so WaveBot, E_fade, M_maker and EVERY auto-discovered forward bot (Chop_TP,
// slow-creep fleet, NearStrike + the 20 C_ns_* grid cells) showed rows in the tables but drew NO
// triangle on the main graph (the marker path predated fwdBotDefs auto-discovery). Rows are pushed
// in the exact order the table used to unshift them, so table ordering is byte-identical. Every
// field access is guarded — a missing/null field yields undefined, never a throw.
function injectedWindowTrades(state, curW) {
  const out = []
  // [N] YOUR trades: closed realtime labels (settled) + your open YES/NO legs (live unrealized)
  ;(state.snap_labels || []).forEach((L) => {
    if (!L || L.kind !== 'realtime' || L.buy_px == null || L.sell_px == null || Math.floor((L.buy_t || 0) / 900) !== curW) return
    out.push({ id: L.labeled_at, bot: 'Noah_Real_Trades', strat: 'N', side: L.side, t_in: L.buy_t, status: 'closed', entry: L.buy_px, exit: L.sell_px, pnl: +((L.sell_px - L.buy_px) - kalshiFee(L.buy_px) - kalshiFee(L.sell_px)).toFixed(3) })
  })
  // WAVE bot trades (paper_trades.jsonl)
  const _wEx = {}; (state.paper_trades || []).forEach((r) => { if (r && r.type === 'exit') _wEx[r.entry_t] = r })
  ;(state.paper_trades || []).forEach((r) => {
    if (!r || r.type !== 'entry' || Math.floor((r.t || 0) / 900) !== curW) return
    const ex = _wEx[r.t], e = ex && ex.ds ? ex.ds : null
    out.push({ id: 'w-' + r.t, bot: 'WaveBot', strat: 'W', side: r.side, t_in: r.t, wave: true,
      status: e ? 'closed' : 'open', entry: r.entry_px, exit: e ? e.px : undefined, pnl: e ? e.pnl : undefined })
  })
  // W_NEURAL trades (w_neural_trades.jsonl)
  const _nEx = {}; (state.w_neural_trades || []).forEach((r) => { if (r && r.type === 'exit') _nEx[r.entry_t] = r })
  ;(state.w_neural_trades || []).forEach((r) => {
    if (!r || r.type !== 'entry' || Math.floor((r.t || 0) / 900) !== curW) return
    const ex = _nEx[r.t]
    out.push({ id: 'wn-' + r.t, bot: 'W_neural', strat: 'WN', side: r.side, t_in: r.t, wave: true,
      status: ex ? 'closed' : 'open', entry: r.entry_px, exit: ex ? ex.exit_px : undefined, pnl: ex ? ex.pnl : undefined })
  })
  // E_FADE trades (e_trades.jsonl — exit data nested under .exit)
  const _eEx = {}; (state.e_trades || []).forEach((r) => { if (r && r.type === 'exit') _eEx[r.entry_t] = r })
  ;(state.e_trades || []).forEach((r) => {
    if (!r || r.type !== 'entry' || Math.floor((r.t || 0) / 900) !== curW) return
    const ex = _eEx[r.t]
    out.push({ id: 'e-' + r.t, bot: 'E_fade', strat: 'E', side: r.side, t_in: r.t, wave: true,
      status: ex ? 'closed' : 'open', entry: r.entry_px, exit: ex && ex.exit ? ex.exit.px : undefined, pnl: ex && ex.exit ? ex.exit.pnl : undefined })
  })
  // M_MAKER trades (m_trades.jsonl) — was on the leaderboard but NEVER injected into the tables or
  // chart (second-class citizen). Same entry/exit pairing pattern; both flat and nested exit-price
  // field shapes tolerated. If m_trades carries no 'entry' rows, nothing injects (exactly as before).
  const _mEx = {}; (state.m_trades || []).forEach((r) => { if (r && r.type === 'exit' && r.entry_t != null) _mEx[r.entry_t] = r })
  ;(state.m_trades || []).forEach((r) => {
    if (!r || r.type !== 'entry' || Math.floor((r.t || 0) / 900) !== curW) return
    const ex = _mEx[r.t]
    out.push({ id: 'm-' + r.t, bot: 'M_maker', strat: 'M', side: r.side, t_in: r.t, wave: true,
      status: ex ? 'closed' : 'open', entry: r.entry_px != null ? r.entry_px : r.entry,
      exit: ex ? (ex.exit_px != null ? ex.exit_px : (typeof ex.exit === 'number' ? ex.exit : undefined)) : undefined, pnl: ex ? ex.pnl : undefined })
  })
  // FORWARD bots (Chop_TP / SlowCreep / every creepNN / NearStrike + the C_ns_* grid): AUTO-DISCOVER
  // via fwdBotDefs so any future variant injects automatically — no hardcoded per-bot list.
  fwdBotDefs(state).forEach((_d) => {
    fwdNormTrades(state[_d.tradesKey]).forEach((q) => {
      if (Math.floor((q.t || 0) / 900) !== curW) return
      // BOTH-SIDES legs share a window `t`; suffix the id with the side so the YES/NO leg rows have DISTINCT
      // data-tids (click-highlight + marker). Single-leg arms keep their byte-identical `idp-t` id.
      out.push({ id: _d.idp + '-' + q.t + (q.bothleg ? '-' + q.side : ''), bot: _d.name, strat: _d.strat, side: q.side, t_in: q.t, wave: true,
        status: q.closed ? 'closed' : 'open', entry: q.entry, exit: q.closed ? q.exit : undefined, pnl: q.closed ? q.pnl : undefined,
        unfilled: q.unfilled, bothleg: q.bothleg, pnl_pess: q.pnl_pess })
    })
  })
  if (yesPos && Math.floor(yesPos.t / 900) === curW) out.push({ id: 'n-yes', bot: 'Noah_Real_Trades', strat: 'N', side: 'yes', t_in: yesPos.t, status: 'open', entry: yesPos.px })
  if (noPos && Math.floor(noPos.t / 900) === curW) out.push({ id: 'n-no', bot: 'Noah_Real_Trades', strat: 'N', side: 'no', t_in: noPos.t, status: 'open', entry: noPos.px })
  return out
}

// ===== FREEZE FIX (NN-only trade tables): #main-window-row is .keep-in-nn (kept visible in NN mode), but the
// OPEN/SETTLED/BOT-ROI tables + #m-capital inside it were populated ONLY in render()'s heavy block AFTER the
// NN-only return, so they showed stale/empty content (even the 'none open' placeholder never rendered when
// launched directly into NN mode). Factor that population here so the NN-only path can refresh it too.
// (Self-gated by `heavy` exactly like the original site, so per-tick cost is unchanged.)
function updateCurrentWindowTrades(state, heavy) {
  if (!heavy) return
  const w = state.window || {}
  const curW = Math.floor(Date.now() / 900000)
  const ctr = (state.trades_log || []).filter((q) => Math.floor(q.t_in / 900) === curW).slice().reverse()
  // inject EVERY bot's current-window trades from the UNIFIED list (same list drawVtrace uses for
  // chart markers, so tables and main-graph triangles can never disagree again).
  injectedWindowTrades(state, curW).forEach((q) => ctr.unshift(q))
  const tmOf = (q) => winTimeOf(q.t_in)
  const sd = (q) => `<td class="r ${q.side === 'yes' ? 'up' : 'down'}">${(q.side || '?')[0].toUpperCase()}</td>`
  const selOf = (q) => String(selectedTrade) === String(q.id) ? ' class="sel"' : ''   // type-agnostic: q.id is string for injected W/WN/E/N rows, number for trades_log
  // OPEN (holding) — unrealized mark
  let unreal = 0
  const kfee = kalshiFee
  const openTr = ctr.filter((q) => q.status !== 'closed' && (!wOnly || q.wave))
  const openRows = openTr.map((q) => {
    // mark at the BID the bot would actually SELL into, NET of the round-trip taker fee = the REAL capturable P&L (not the optimistic gross mid mark)
    const exitBid = q.side === 'yes' ? (w.yb != null ? w.yb : (w.mid != null ? w.mid - 0.01 : null)) : (w.nb != null ? w.nb : (w.mid != null ? 1 - w.mid - 0.01 : null))
    const up = exitBid != null ? (exitBid - q.entry) - kfee(q.entry) - kfee(exitBid) : null
    let pTxt = '—', pC = 'dim'
    if (up != null) { unreal += up; pTxt = (up >= 0 ? '+' : '') + up.toFixed(3); pC = up > 0 ? 'up' : up < 0 ? 'down' : 'dim' }
    const di = q.depth_in, doo = q.depth_out
    const depthTxt = di == null ? '—' : (di + (doo != null ? '→' + doo : ''))
    const depthC = (di != null && di < 1) ? 'down' : 'dim'
    const pairG = q.bothleg ? '<span title="both-sides leg" style="color:#5aa0ff;">⋈</span> ' : ''
    return `<tr data-tid="${q.id}"${selOf(q)} style="cursor:pointer;${outlineOf(q)}" title="${q.bot} [${q.strat}] holding"><td>${tmOf(q)}</td><td>${pairG}<span class="cyan">[${q.strat}]</span> ${(q.bot || '').slice(0, 11)}</td>${sd(q)}<td class="r">${q.entry != null ? q.entry : '·'}</td><td class="r ${pC}">${pTxt}</td><td class="r ${depthC}">${depthTxt}</td></tr>`
  }).join('')
  if ($('ct-open-tbody')) $('ct-open-tbody').innerHTML = openRows || '<tr><td colspan="6" class="dim">none open</td></tr>'
  if ($('ct-open-sub')) $('ct-open-sub').innerHTML = `${openTr.length} · net-if-sold-now <b class="${unreal >= 0 ? 'up' : 'down'}">${unreal >= 0 ? '+' : ''}${unreal.toFixed(3)}</b>`
  // paper capital actually deployed in open contracts right now (cost = entry x SIZE per position) — gauge for a live test
  const SIZE = state.size || 1
  const deployed = openTr.reduce((sum, q) => sum + (q.entry || 0) * SIZE, 0)
  if (deployed > capPeak) capPeak = deployed
  if ($('m-capital')) $('m-capital').textContent = '$' + deployed.toFixed(2)
  if ($('m-capital-lbl')) $('m-capital-lbl').textContent = `IN CONTRACTS · ${openTr.length} open · pk $${capPeak.toFixed(2)}`
  // SETTLED — green if net-positive after fees, red if negative
  let realized = 0
  const setTr = ctr.filter((q) => q.status === 'closed' && (!wOnly || q.wave))
  const setRows = setTr.map((q) => {
    realized += q.pnl || 0
    const pTxt = (q.pnl >= 0 ? '+' : '') + (q.pnl != null ? q.pnl.toFixed(3) : '—')
    const pC = q.pnl > 0 ? 'up' : q.pnl < 0 ? 'down' : 'dim'
    const rowBg = String(selectedTrade) === String(q.id) ? '' : (q.pnl > 0 ? 'background:rgba(62,196,109,0.16);' : (q.pnl < 0 ? 'background:rgba(255,85,85,0.16);' : ''))
    // BOTH-SIDES leg tagging: ⋈ pair glyph groups the YES/NO legs of one window; ⊘nofill flags a leg that
    // never filled (IN "—", pnl 0 — the one-leg-adverse case). pess pnl surfaced subtly in the row tooltip.
    const pairG = q.bothleg ? '<span title="both-sides leg" style="color:#5aa0ff;">⋈</span> ' : ''
    const nofG = q.unfilled ? ' <span class="down" title="this leg never filled — one-leg adverse">⊘nofill</span>' : ''
    const inTxt = q.unfilled ? '<span class="down" title="leg never filled">—</span>' : (q.entry != null ? q.entry : '·')
    const pessT = q.pnl_pess != null ? ` · pess ${q.pnl_pess >= 0 ? '+' : ''}${q.pnl_pess.toFixed(3)}` : ''
    return `<tr data-tid="${q.id}"${selOf(q)} style="cursor:pointer;${rowBg}${outlineOf(q)}" title="${q.bot} [${q.strat}] sold @${q.exit}${pessT}"><td>${tmOf(q)}</td><td>${pairG}<span class="cyan">[${q.strat}]</span> ${(q.bot || '').slice(0, 11)}${nofG}</td>${sd(q)}<td class="r">${inTxt}</td><td class="r">${q.exit != null ? q.exit : '·'}</td><td class="r ${pC}">${pTxt}</td></tr>`
  }).join('')
  if ($('ct-settled-tbody')) $('ct-settled-tbody').innerHTML = setRows || '<tr><td colspan="6" class="dim">none settled yet</td></tr>'
  if ($('ct-settled-sub')) $('ct-settled-sub').innerHTML = `${setTr.length} · realized <b class="${realized >= 0 ? 'up' : 'down'}">${realized >= 0 ? '+' : ''}${realized.toFixed(3)}</b>`
}

let _renderSig = ''
function render(state) {
  if (!state) { $('r-status').textContent = 'NO DATA'; $('r-status').className = 'stale'; return }
  // PERF(FREEZE): cheap whole-state + interaction signature. main.js pushes ~3.3x/sec and re-parses the live
  // JSON every push, but in quiet periods the parsed payload is byte-identical to the last one — so the full
  // render prologue (the two querySelectorAll('.hide-in-nn') DOM sweeps, drawMainWindow, ribbon writes) would
  // repeat for zero change. Early-return when the data signature AND every interaction flag that affects the
  // output are unchanged. Interaction handlers call render(lastState) directly; those flips change the sig so
  // the forced redraw still goes through. The live-update path always changes state.ts so it never short-circuits.
  const _wsec = (state.window || {}).sec_left
  // FREEZE FIX (TRAINING tab): a ×/⇄/excl edit can change label FIELDS (side/train/sell_px) without changing
  // the label COUNT, so when the TRAINING tab is open include a cheap content fingerprint of just those editable
  // fields — otherwise an in-place edit could be swallowed by the count-based short-circuit. Computed ONLY when
  // the tab is visible so idle ticks on other tabs stay free.
  const _vtdOpen = (() => { const v = document.getElementById('view-training'); return v && v.style.display !== 'none' })()
  const _labSig = _vtdOpen ? (state.snap_labels || []).map((L) => '' + L.labeled_at + (L.side || '') + (L.train === false ? 'x' : '') + (L.sell_px == null ? '' : L.sell_px)).join(',') : ''
  const _sig = [state.ts, state.widx, (state.window || {}).ticker, (state.window || {}).btc, _wsec,
    (state.trace || []).length, (state.trades_log || []).length, (state.snap_labels || []).length, _labSig,
    (state.bots || []).length, state.calib_status && state.calib_status.calibrated,
    // interaction/view flags (a toggle/selection must defeat the short-circuit even when state is identical):
    wOnly, nnOnly, sigOnly, selectedBot, selectedTrade, selectedLabel, histWin && histWin.t0,
    nnDropdownOpen, selectedNN, vLo, vHi, vYLo, vYHi].join('|')
  if (_sig === _renderSig) return   // nothing material changed since the last render — skip this idle tick entirely
  _renderSig = _sig
  lastState = state
  { const wt = $('wonly-toggle'); if (wt) { wt.textContent = wOnly ? 'W-ONLY ●' : 'W-ONLY ▪'; wt.style.color = wOnly ? '#ff3fc4' : 'var(--dim)' }
    const wc = $('wroi-col'); if (wc) wc.style.display = wOnly ? 'none' : ''
    const rh = $('roi-head'); if (rh && rh.firstChild) rh.firstChild.nodeValue = wOnly ? 'W_NEURAL · LEARNING ' : 'ROI OVER TIME — EVERY BOT ' }
  // ===== NN-ONLY MODE: replace the main evolution body with the neural-net readiness card grid =====
  { const nt = $('nnonly-toggle'); if (nt) { nt.textContent = nnOnly ? 'NN ●' : 'NN ▪'; nt.style.color = nnOnly ? '#9b6bff' : 'var(--dim)' } }
  { const vm = $('view-main')
    if (vm && vm.style.display !== 'none') {
      const grid = $('nn-cards')
      if (nnOnly) {
        vm.querySelectorAll('.hide-in-nn').forEach((e) => { e.style.display = 'none' })
        // KEEP the main live-window chart VISIBLE in NN-only mode (Noah's request): #main-window-row
        // is marked .keep-in-nn (NOT .hide-in-nn) so the sweep above leaves it alone; force-show it
        // in case a prior render left it hidden.
        const mw = $('main-window-row'); if (mw) mw.style.display = ''
        if (grid) grid.style.display = 'flex'
        // PAUSE the NN-cards re-render while a custom time-range dropdown is open: the NN DOM is rebuilt
        // via innerHTML on every state push (~8×/s), which would otherwise destroy the open dropdown
        // button/popup mid-click. We still keep the main chart live during this pause (it doesn't own the
        // dropdown), then skip the rest of this tick; the next push after close redraws the cards.
        // FREEZE FIX: the ribbon (.term child, never hidden) + the kept-visible OPEN/SETTLED/#m-capital tables
        // (#main-window-row is .keep-in-nn) were frozen in NN mode because their writes lived AFTER this early
        // return. Drive them from the same helpers the normal path uses so they stay live in NN-only mode.
        const _nnHeavy = Date.now() - lastHeavy > 900
        if (_nnHeavy) lastHeavy = Date.now()
        if (nnDropdownOpen) { updateRibbon(state); updateCurrentWindowTrades(state, _nnHeavy); drawMainWindow(state); return }
        updateRibbon(state)
        renderNNCards(state)
        if (selectedNN) renderNNDetail(state, selectedNN)
        updateCurrentWindowTrades(state, _nnHeavy)   // keep OPEN/SETTLED/#m-capital live in NN mode
        drawMainWindow(state)   // draw/refresh the main live window chart ALONGSIDE the NN cards
        return   // NN-ONLY shows the NN cards + the main live chart; the rest of the evolution body stays hidden
      } else {
        if (grid) grid.style.display = 'none'
        vm.querySelectorAll('.hide-in-nn').forEach((e) => { e.style.display = '' })
        const dt = $('nn-detail'); if (dt) dt.style.display = 'none'
      }
    }
  }
  // ribbon (#r-status/#r-btc/#r-cd/#r-calib/…) — factored into updateRibbon so NN-only mode keeps it live too
  updateRibbon(state)
  const w = state.window || {}

  // live window (LIVE WINDOW panel values + #vtrace chart + #strikebar) — shared with NN-ONLY mode
  drawMainWindow(state)

  const heavy = Date.now() - lastHeavy > 900   // chart + live values update EVERY push; the all-bots UI only ~1/sec (it's 159KB of bots)
  if (heavy) lastHeavy = Date.now()

  // current-window trades, split OPEN vs SETTLED (click a row to highlight its marker on the chart)
  // factored into updateCurrentWindowTrades so NN-only mode (where #main-window-row stays visible) refreshes them too
  updateCurrentWindowTrades(state, heavy)

  // strike-z gate indicator (B faders only) — cheap, runs every push (ungated)
  const zs = (state.window || {}).zstrike, ns = (state.window || {}).near_strike
  $('r-zstrike').textContent = zs == null ? '—' : zs.toFixed(2)
  $('r-gate').textContent = ns ? 'B-FADE▸ON' : 'B-FADE▪OFF'
  $('r-gate').className = ns ? 'live' : 'stale'

  // PERF(FREEZE): the [N] bot synthesis below COPIES the ~159KB bots array + filters/reduces/sorts all
  // snap_labels, and its only consumers are the leaderboard / wroi / ROI-chart blocks — all of which are
  // heavy-gated. Running it on every push (~4x/sec) threw away ~3 of 4 ticks of O(bots+labels) work on the
  // UI thread. Gate the whole synthesis + leaderboard together so it runs ~1x/sec instead.
  if (heavy) {
  // [N] Noah_Real_Trades — YOUR actual ↑↓ trades as a ranked bot. Honest fills (bought at ask, sold at bid) + both fees. ALL trades count toward ROI (exclude only affects [G] training).
  const _kf = kalshiFee
  const _myT = (state.snap_labels || []).filter((L) => L.kind === 'realtime' && L.buy_px != null && L.sell_px != null)
  const _curW = (state.trace && state.trace.length) ? Math.floor(state.trace[state.trace.length - 1][0] / 900) : Infinity
  let _np = 0, _ncb = 0, _nwins = 0; const _nwin = {}
  _myT.forEach((t) => { const pnl = (t.sell_px - t.buy_px) - _kf(t.buy_px) - _kf(t.sell_px); _np += pnl; _ncb += t.buy_px; if (pnl > 0) _nwins++; const w = Math.floor(t.buy_t / 900); _nwin[w] = (_nwin[w] || 0) + pnl })
  const _nser = []; let _nc = 0
  Object.keys(_nwin).map(Number).sort((a, b) => a - b).forEach((w) => { if (w < _curW) { _nc += _nwin[w]; _nser.push([w, _ncb > 0 ? _nc / _ncb * 100 : 0]) } })
  const nBot = { name: 'Noah_Real_Trades', strat: 'N', gen: 0, parent: null, born_widx: _myT.length ? Math.floor(_myT[0].buy_t / 900) : (state.widx || 0), roi: _ncb > 0 ? _np / _ncb * 100 : 0, nw: 1 + _np, trades: _myT.length, wins: _nwins, params: {}, series: _nser, maxdep: 0, regime: '', regime_n: 0, disabled: false }
  const bots = (state.bots || []).slice()
  { let _i = bots.findIndex((b) => (b.roi || 0) < nBot.roi); if (_i < 0) _i = bots.length; bots.splice(_i, 0, nBot) }   // insert [N] in ROI order
  // population summary
  const leader = bots.length ? bots[0] : null  // already sorted by nw desc
  if ($('p-best')) {   // POPULATION panel removed from layout — guard if still present
    $('p-best').textContent = leader ? (leader.roi > 0 ? '+' : '') + leader.roi.toFixed(2) + '%' : '—'
    $('p-best').className = 'bnval ' + (leader && leader.roi > 0 ? 'ok' : leader && leader.roi < 0 ? 'bad' : 'dim')
    $('p-bestname').textContent = leader ? leader.name.slice(0, 28) : 'BEST ROI'
    $('p-count').textContent = bots.filter((b) => b.disabled).length + ' / ' + bots.length
    $('p-gen').textContent = bots.reduce((m, b) => Math.max(m, b.gen), 0) + 1
  }

  // every bot's ROI THIS window (= live cumulative roi − roi at the last window close)
  const wroiOf = (b) => b.roi - (b.series && b.series.length ? b.series[b.series.length - 1][1] : 0)
  const wlist = pinnedFirst(bots.map((b) => ({ name: b.name, strat: b.strat, wr: wroiOf(b), tot: b.roi, off: b.disabled })).sort((a, b) => b.wr - a.wr))
  const wsum = wlist.reduce((s, r) => s + r.wr, 0)
  const nOff = wlist.filter((r) => r.off).length
  $('wroi-sub').textContent = `${bots.length - nOff} active · ${nOff} benched · Σ ${wsum >= 0 ? '+' : ''}${wsum.toFixed(1)}%`
  $('wroi-tbody').innerHTML = wlist.map((r, i) =>
    `<tr class="${isPinned(r.name) ? 'pinned-row' : ''}" style="${r.off ? 'opacity:0.4' : ''}"><td class="dim">${i + 1}</td><td>${pinGlyph(r.name)}${r.off ? '⊘ ' : ''}${r.name.slice(0, 17)} <span class="dim">[${r.strat}]</span></td><td class="r ${r.wr > 0 ? 'up' : r.wr < 0 ? 'down' : 'dim'}">${r.wr > 0 ? '+' : ''}${r.wr.toFixed(2)}%</td><td class="r dim">${r.tot > 0 ? '+' : ''}${r.tot.toFixed(1)}%</td></tr>`
  ).join('')

  if (wOnly) drawWNeural(state); else drawROI(state, bots)

  // merge the wave evolution variants into the leaderboard (pink-outlined) instead of a separate panel.
  // their stats are overall (net $, avg c/trade) — shown in the shared columns; no per-window series so they skip the ROI chart.
  const _eb = state.evolve_board
  if (_eb && _eb.pop) _eb.pop.forEach((v) => {
    const p = v.p || {}
    // ROI BUGFIX: the old roi = v.avg was avg CENTS/trade, NOT a return %. Make it a TRUE cost-basis %
    // (net $ / capital × 100) like every other bot. The board carries no per-trade entry prices, so
    // approximate capital = n_trades × PXMAX (the bot's per-trade price ceiling). No PXMAX ⇒ '—' (roiNA).
    const _wvCap = (v.n || 0) * (p.PXMAX || 0)
    bots.push({ name: 'Wave_v' + v.id, strat: 'W',
      roi: _wvCap > 0 ? (v.net || 0) / _wvCap * 100 : 0, roiNA: !(_wvCap > 0), nw: 1 + (v.net || 0), trades: v.n || 0,
      wins: Math.round((v.win || 0) / 100 * (v.n || 0)),
      params: `dip${Math.round((p.DIP || 0) * 100)} px${Math.round((p.PXMAX || 0) * 100)} dev${Math.round((p.DEV || 0) * 100)} al${Math.round((p.ALIGN || 0) * 100)}`,
      gen: v.gen || 0, disabled: false, series: [], maxdep: _wvCap, born_widx: state.widx || 0, wave: true })
  })
  // ALL the neural-net bots (was only W_neural — bug: nobox + v2 were never pushed). w_neural + nobox are
  // live on the box; w_neural_v2 was offloaded to the laptop so its box status may read stale. Each gets a
  // true cost-basis ROI % (net $ / Σentry_px); nw = 1 + net $.
  const _nnDefs = [
    { st: state.w_neural_status, tr: state.w_neural_trades, name: 'W_neural' },
    { st: state.w_neural_nobox_status, tr: state.w_neural_nobox_trades, name: 'W_neural_nobox' },
    { st: state.w_neural_v2_status, tr: state.w_neural_v2_trades, name: 'W_neural_v2' },
  ]
  _nnDefs.forEach((_d) => {
    const _wn = _d.st
    if (!_wn || _wn.own_n == null) return
    const _wnNet = _wn.own_net || 0
    const _wnCap = (_d.tr || []).reduce((s, r) => s + ((r && r.type === 'exit' && r.entry_px != null) ? r.entry_px : 0), 0)
    // per-window cumulative-P&L line from the NN's own exit rows (own-trade pnl) so it draws on #eqchart.
    const _wnSer = pnlSeriesFromRows(_d.tr, (r) => (r.type === 'exit' && r.pnl != null) ? r.pnl : null)
    bots.push({ name: _d.name, strat: 'WN',
      roi: _wnCap > 0 ? _wnNet / _wnCap * 100 : 0, roiNA: !(_wnCap > 0), nw: 1 + _wnNet, trades: _wn.own_n || 0,
      wins: Math.round((_wn.own_win || 0) / 100 * (_wn.own_n || 0)),
      params: `trained ${_wn.trained || 0} · ${_wn.ready ? 'LIVE' : 'learning'}`, gen: 0, disabled: false, series: _wnSer, maxdep: _wnCap, born_widx: _wnSer.length ? _wnSer[0][0] : (state.widx || 0), wave: true })
  })
  { const _et = (state.e_trades || []).filter((r) => r.type === 'exit' && r.exit)
    if (_et.length) { const _enet = _et.reduce((s, r) => s + (r.exit.pnl || 0), 0), _ecb = _et.reduce((s, r) => s + (r.entry_px || 0), 0)
      const _eSer = pnlSeriesFromRows(state.e_trades, (r) => (r.type === 'exit' && r.exit && r.exit.pnl != null) ? r.exit.pnl : null)
      bots.push({ name: 'E_fade', strat: 'E', roi: _ecb > 0 ? _enet / _ecb * 100 : 0, nw: 1 + _enet, trades: _et.length,
        wins: _et.filter((r) => r.exit.pnl > 0).length, params: 'extreme-fade · dry-run', gen: 0, disabled: false, series: _eSer, maxdep: 0, born_widx: _eSer.length ? _eSer[0][0] : (state.widx || 0), wave: true }) } }
  { const _mt = (state.m_trades || []).filter((r) => r.type === 'exit')   // [M] signal-gated maker (realistic-fill dry-run)
    if (_mt.length) { const _mnet = _mt.reduce((s, r) => s + (r.pnl || 0), 0), _mcb = _mt.reduce((s, r) => s + (r.entry || 0), 0)
      const _mSer = pnlSeriesFromRows(state.m_trades, (r) => (r.type === 'exit' && r.pnl != null) ? r.pnl : null)
      bots.push({ name: 'M_maker', strat: 'M', roi: _mcb > 0 ? _mnet / _mcb * 100 : 0, nw: 1 + _mnet, trades: _mt.length,
        wins: _mt.filter((r) => r.pnl > 0).length, params: 'signal-maker · dry-run', gen: 0, disabled: false, series: _mSer, maxdep: 0, born_widx: _mSer.length ? _mSer[0][0] : (state.widx || 0), wave: true }) } }
  // forward dry-run bots (status synced from box; net=avg c/trade, net_total=$ cumulative, win_rate=0..1).
  // NOW WIRED: trade logs (C_*_trades.jsonl) build a cumulative-P&L `series` (cents) so they draw on #eqchart.
  // ROI BUGFIX: `roi` must be a TRUE return % (net $ / capital-at-risk × 100), matching every other
  // synthesized bot — NOT net_total×100 (which was raw cumulative CENTS, e.g. −47 instead of ≈ −26%).
  // Capital-at-risk = sum of entry_px over closed trades (fallback n_trades×entry). When there's no
  // capital base, mark roiNA so the column shows '—' rather than a misleading 0.
  // ALL forward dry-run bots: Chop_TP + the 8 slow-creep variants (gated/ungated × creep55/60/65, plus the two
  // original NO~0.71 short bots). Each is pushed identically — a TRUE return % (net $ / capital-at-risk × 100),
  // a per-window cumulative-P&L series (via fwdSeriesFromTrades, falling back to net_total when trades haven't
  // synced yet), and strat 'C' so they group under the FORWARD family card. Variants with status but no trades
  // (creep55/60/65) still draw a status-only sparkline + appear on the ROI chart. The 8 slow-creep variants share
  // strat 'SC' so they group under a dedicated SLOW-CREEP family card (see FAMILY_DEFS).
  // AUTO-DISCOVER: enumerate all c_*_status keys main.js attached (one per synced C_*_status.json) and parse
  // each card's label/family from the bot name — so creep75/80/85 (×gated/ungated) and any future creepNN
  // appear here automatically, identically to the original 9 (true cost-basis ROI + per-window series + stats).
  const _fwdDefs = fwdBotDefs(state)
  _fwdDefs.forEach((_d) => {
    const _st = state[_d.statusKey]
    if (!_st || _st.n_trades == null) return
    const _nrm = fwdNormTrades(state[_d.tradesKey]), _ser = fwdSeriesFromTrades(_nrm, _st, state.widx)
    // DATA-INTEGRITY FIX (2026-07-02): derive the headline stats (net $, n_trades, wins) from the SYNCED TRADES
    // LOG as the SOURCE OF TRUTH — NOT status.json. The C_* paper bots recompute lifetime_pnl/n_trades from ZERO
    // at process start, while C_*_trades.jsonl is append-only and persists forever; the strike fleet restarted
    // 3× today (settle-basis fixes), so status net_total/n_trades/win_rate UNDER-REPORT (e.g. C_ns_c45_d15 status
    // showed n=7/−$0.07 while the log holds n=45/−$6.06). In-place 'corrected':'kalshi_api' rows are a SINGLE exit
    // row per window → fwdNormTrades emits one closed trade → no double-count; the corrected pnl flows straight in.
    // status.json is now used ONLY for liveness/heartbeat/params/open-position (+ a fallback below for a brand-new
    // bot that has synced a status but no trade rows yet, so its card isn't blank).
    const _closed = _nrm.filter((q) => q.closed && q.pnl != null)
    const _haveLog = _closed.length > 0
    const _logNet = _closed.reduce((s, q) => s + q.pnl, 0)
    const _net = _haveLog ? _logNet : (_st.net_total != null ? _st.net_total : 0)
    const _nTr = _haveLog ? _closed.length : (_st.n_trades || 0)
    const _wins = _haveLog ? _closed.filter((q) => q.pnl > 0).length : Math.round((_st.win_rate || 0) * (_st.n_trades || 0))
    const _cap = fwdCapBase(_nrm, _st)
    // QA (2026-07-02): ZOMBIE-CARD tag. The box→local sync never deletes a mirror, so a bot RETIRED box-side
    // (e.g. C_nearstrike_status.json renamed *.retired on the box) leaves a local status file frozen at its
    // last write — the card/row then looks ALIVE with day-old numbers forever. Every C_* status carries a box
    // epoch `t`; if it hasn't been rewritten in >2h (live ones rewrite ≤15min), prefix the params with a STALE
    // tag + age. Display-text only — the bot stays listed (never hide data), all stats/series untouched.
    const _ageS = (_st.t != null && isFinite(_st.t)) ? (Date.now() / 1000 - _st.t) : null
    const _staleTag = (_ageS != null && _ageS > 7200) ? ('⚠ STALE ' + Math.round(_ageS / 3600) + 'h · ') : ''
    // DIVERGENCE indicator: status's own net vs the log-truth net. An epoch reset (process restart) or an
    // in-place correction leaves status net_total drifting from the log sum; surface it as a subtle Δlog tag
    // (>1c) so the mismatch is VISIBLE rather than silently masked — the reset is the story, not a bug to hide.
    const _stNet = _st.net_total != null ? _st.net_total : null
    const _divTag = (_haveLog && _stNet != null && Math.abs(_stNet - _logNet) > 0.01)
      ? ('Δlog ' + (_logNet - _stNet >= 0 ? '+' : '−') + Math.abs((_logNet - _stNet) * 100).toFixed(0) + 'c · ') : ''
    bots.push({ name: _d.name, strat: _d.strat,
      roi: _cap > 0 ? _net / _cap * 100 : 0, roiNA: !(_cap > 0), nw: 1 + _net, maxdep: _cap, trades: _nTr,
      wins: _wins,
      params: _staleTag + _divTag + 'dry-run fwd · ' + _d.params, gen: 0, disabled: false, series: _ser,
      born_widx: _ser.length ? _ser[0][0] : (state.widx || 0), wave: true })
  })

  // leaderboard
  const _lbShown = pinnedFirst((wOnly ? bots.filter((b) => b.wave) : bots).filter((b) => !b.disabled))
  $('lb-sub').textContent = `${_lbShown.length} bots`
  $('lb').innerHTML = _lbShown.map((b, i) => {
    const roiC = b.roi > 0.01 ? 'up' : b.roi < -0.01 ? 'down' : 'dim'
    const color = b.roi > 0.01 ? '#3ec46d' : b.roi < -0.01 ? '#ff5555' : '#6b786b'
    const wr = b.trades ? Math.round(100 * b.wins / b.trades) + '%' : '—'
    const ageWin = Math.max((state.widx ?? 0) - (b.born_widx ?? 0), 1)
    const roiHr = b.roi / (ageWin * 0.25)   // 4 windows = 1 hour
    const roiHrC = roiHr > 0.01 ? 'up' : roiHr < -0.01 ? 'down' : 'dim'
    // roiNA bots (no meaningful capital base) show '—' rather than a misleading 0%/0%/hr
    const roiTxt = b.roiNA ? '—' : (b.roi > 0 ? '+' : '') + b.roi.toFixed(2) + '%'
    const roiHrTxt = b.roiNA ? '—' : (roiHr > 0 ? '+' : '') + roiHr.toFixed(2) + '%'
    const ser = b.series || []
    let pw = 0, tw = 0
    for (let j = 1; j < ser.length; j++) { tw++; if (ser[j][1] - ser[j - 1][1] >= -0.001) pw++ }   // window net-positive-or-neutral
    const posW = tw ? Math.round(100 * pw / tw) + '%' : '—'
    return `<tr class="gen${b.gen}${b.name === selectedBot ? ' sel' : ''}${isPinned(b.name) ? ' pinned-row' : ''}" data-bot="${b.name}" style="cursor:pointer;${b.disabled ? 'opacity:0.42' : ''}${outlineOf(b)}">
      <td class="dim">${b.name === selectedBot ? '▶' : i + 1}</td>
      <td>${pinGlyph(b.name)}<span class="swatch" style="background:${color}"></span>${b.disabled ? '⊘ ' : ''}${b.name}</td>
      <td class="cyan">${b.strat}</td>
      <td class="dim">${b.params}</td>
      <td class="r ${b.roiNA ? 'dim' : roiC}">${roiTxt}</td>
      <td class="r ${b.roiNA ? 'dim' : roiHrC}">${roiHrTxt}</td>
      <td class="r">$${b.nw.toFixed(2)}</td>
      <td class="r dim" title="max capital ever deployed at once (peak $ this bot needs)">$${(b.maxdep || 0).toFixed(2)}</td>
      <td class="r">${b.trades}</td>
      <td class="r">${wr}</td>
      <td class="r">${posW}</td>
      <td class="r dim">${b.gen}</td>
      <td class="r dim">w${b.born_widx}</td>
    </tr>`
  }).join('')
  // NEW: family-grouped CARDS + a TOP-3 row (replaces the flat list as the primary view).
  // Reuses the same `_lbShown` bot set so the W-only + dead-bot filters carry through unchanged.
  renderBotCards(state, _lbShown)
  renderCreepDiagnostics(state, _lbShown)   // fleet-level breadth-vs-luck graphs (Graph 2 scatter + Graph 3 block strip)
  // Expose the FULL synthesized bot set (evolution pop + injected NN/forward/slow-creep/E/M/N bots) so the
  // detail overlay can resolve a clicked card by name. On heavy ticks we set it on the state object AND cache
  // it module-side (_allBots): non-heavy ticks send a fresh state whose .bots is just the raw evolution pop, so
  // the cache is what keeps a clicked slow-creep/forward card resolvable between heavy rebuilds. Renderer-side
  // only; never written to disk. (drawROI already received this same `bots` array above.)
  state.bots = bots
  _allBots = bots
  }
  if (selectedBotDetail) renderBotDetail(state, selectedBotDetail)   // keep the open detail overlay live
  renderLive(state)
  renderStrategyBoard(state)   // corner STRATEGY STATUS panel — re-renders each push
  // FREEZE FIX (TRAINING tab): drive the label table from the state-push path so it repaints whenever
  // snap_labels changes — e.g. after a ×/⇄/excl click whose IPC write lands in the NEXT push. renderTraining
  // early-returns when #view-training is hidden, so this is a no-op on every other tab.
  renderTraining(state)
}

// ===== PAPER vs LIVE tab =====
function drawPLtrace(pPts, rPts) {
  const el = $('pltrace'); if (!el) return
  const W = 900, H = 320, pad = 34
  if (pPts.length < 2) { el.innerHTML = `<text x="450" y="160" fill="#6b786b" text-anchor="middle" font-size="14">waiting for the selected bots to complete a round-trip…</text>`; return }
  const all = pPts.concat(rPts, [0])
  const lo = Math.min(...all), hi = Math.max(...all), rng = (hi - lo) || 1
  const n = pPts.length
  const X = (i) => pad + (W - 2 * pad) * (n > 1 ? i / (n - 1) : 0)
  const Y = (v) => H - pad - (H - 2 * pad) * (v - lo) / rng
  const poly = (pts, c, w) => `<polyline fill="none" stroke="${c}" stroke-width="${w}" vector-effect="non-scaling-stroke" points="${pts.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ')}"/>`
  const y0 = Y(0)
  let s = `<line x1="${pad}" y1="${y0.toFixed(1)}" x2="${W - pad}" y2="${y0.toFixed(1)}" stroke="#1c241c" stroke-dasharray="3 3"/>`
  s += poly(pPts, '#4fd0e0', 1.6) + poly(rPts, '#3ec46d', 1.8)
  el.innerHTML = s
}
function renderLive(state) {
  if (!$('view-live') || $('view-live').style.display === 'none') return   // only render when the tab is open
  const all = state.live_trades || []
  const lt = all.filter((t) => t.closed && !t.skipped)
  const skips = all.filter((t) => t.skipped)
  let pCum = 0, rCum = 0; const pPts = [], rPts = []
  let anyLive = false
  lt.forEach((t) => {
    pCum += (t.paper_pnl || 0); rCum += (t.real_pnl != null ? t.real_pnl : 0)
    pPts.push(pCum); rPts.push(rCum)
    if (t.live) anyLive = true
  })
  if (skips.some((t) => t.live)) anyLive = true
  const gap = rCum - pCum
  const set = (id, v, cls) => { const e = $(id); if (e) { e.textContent = v; if (cls != null) e.className = 'bnval' + (id === 'pl-real' ? '' : ' sm') + ' ' + cls } }
  set('pl-real', (rCum >= 0 ? '+' : '') + '$' + rCum.toFixed(2), rCum > 0 ? 'ok' : rCum < 0 ? 'bad' : 'dim')
  set('pl-paper', (pCum >= 0 ? '+' : '') + '$' + pCum.toFixed(2), 'dim')
  set('pl-slip', (gap >= 0 ? '+' : '') + '$' + gap.toFixed(2), gap >= 0 ? 'ok' : 'bad')
  $('pl-n').textContent = lt.length
  const tot = lt.length + skips.length
  $('pl-deployed').textContent = skips.length + (tot ? ` (${Math.round(100 * lt.length / tot)}% fill)` : '')
  $('pl-mode').textContent = anyLive ? 'LIVE 💵' : 'DRY-RUN'
  $('pl-mode').className = 'bnval sm ' + (anyLive ? 'bad' : 'dim')
  // current pairing (2026-07-02): L_nearstrike ↔ C_ns_c41_d05 is the ONLY live pair; the creep71/55 live
  // bots were taken off real money 2026-07-01 — their rows in this table are historical.
  $('pl-sub').textContent = `${lt.length} filled · ${skips.length} skipped (coord/stop/no-fill) · LIVE pair: L_nearstrike ↔ C_ns_c41_d05 (creep pairs historical, off real money)`
  drawPLtrace(pPts, rPts)
  $('pl-tbody').innerHTML = lt.slice().reverse().map((t) => {
    const ri = t.real_entry_cents != null ? t.real_entry_cents + 'c' : '—'
    const ro = t.real_exit_no_cents != null ? t.real_exit_no_cents + 'c' : '—'
    const rp = t.real_pnl != null ? t.real_pnl : null
    const d = rp != null ? (rp - (t.paper_pnl || 0)) : null
    const c = (v) => v > 0 ? 'up' : v < 0 ? 'down' : 'dim'
    return `<tr><td>${(t.bot || '').slice(0, 16)}</td><td class="r">${Math.round((t.paper_entry || 0) * 100)}c</td><td class="r cyan">${ri}</td><td class="r">${Math.round((t.paper_exit || 0) * 100)}c</td><td class="r cyan">${ro}</td><td class="r ${c(t.paper_pnl)}">${(t.paper_pnl >= 0 ? '+' : '') + (t.paper_pnl != null ? t.paper_pnl.toFixed(3) : '—')}</td><td class="r ${rp != null ? c(rp) : 'dim'}">${rp != null ? (rp >= 0 ? '+' : '') + rp.toFixed(3) : '—'}</td><td class="r ${d != null ? c(d) : 'dim'}">${d != null ? (d >= 0 ? '+' : '') + d.toFixed(3) : '—'}</td></tr>`
  }).join('') || '<tr><td colspan="8" class="dim">waiting for the selected bots to complete a round-trip…</td></tr>'
}
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const v = tab.getAttribute('data-view')
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t === tab
      t.style.color = on ? 'var(--amber)' : 'var(--dim)'
      t.style.borderBottom = '2px solid ' + (on ? 'var(--amber)' : 'transparent')
      t.style.background = on ? '#0a0e0a' : '#050805'
    })
    $('view-main').style.display = v === 'main' ? '' : 'none'
    $('view-live').style.display = v === 'live' ? '' : 'none'
    const _vtd = $('view-training'); if (_vtd) _vtd.style.display = v === 'training' ? '' : 'none'
    const _vbt = $('view-backtest'); if (_vbt) _vbt.style.display = v === 'backtest' ? '' : 'none'
    const _van = $('view-analysis'); if (_van) _van.style.display = v === 'analysis' ? '' : 'none'
    // QA FIX: leaving the EVOLUTION tab while the NN detail overlay (inset:0, z-index:9000) is open
    // used to strand that full-viewport overlay on top of the newly-selected tab — every click in the
    // new tab was eaten by the invisible backdrop. Always tear it down (and close any open custom
    // dropdown) on a tab switch away from main, so the destination tab is fully interactive.
    if (v !== 'main') {
      const _dt = $('nn-detail'); if (_dt) _dt.style.display = 'none'
      selectedNN = null
      if (typeof nnCloseDropdown === 'function') nnCloseDropdown()
      // also un-fullscreen the live chart (#vtrace.fs is position:fixed/inset:0 — would strand over the new tab)
      const _vt = $('vtrace'); if (_vt && _vt.classList.contains('fs')) { _vt.classList.remove('fs'); const _x = $('fs-exit'); if (_x) _x.remove() }
    }
    if (lastState) { renderLive(lastState); renderTraining(lastState) }
    if (v === 'backtest' && window.initBacktest) window.initBacktest()
    if (v === 'analysis' && window.initAnalysis) window.initAnalysis()
  })
})
function renderTraining(state) {
  const tb = document.getElementById('td-tbody'); if (!tb) return
  const view = document.getElementById('view-training'); if (!view || view.style.display === 'none') return   // only when the tab is open
  const kf = kalshiFee
  const labs = (state.snap_labels || []).slice().sort((a, b) => (b.labeled_at || 0) - (a.labeled_at || 0))
  const tmOf = winTimeOf
  let nbuy = 0, nno = 0, ntr = 0, npnl = 0
  tb.innerHTML = labs.map((L) => {
    const kind = L.kind === 'avoid' ? '🔴 no-trade' : L.kind === 'realtime' ? '🟢 trade' : '🟡 buy-box'
    if (L.kind === 'avoid') nno++; else if (L.kind === 'realtime') ntr++; else nbuy++
    const sideTxt = L.side ? '<span class="' + (L.side === 'yes' ? 'up' : 'down') + '">' + (L.side === 'yes' ? 'YES' : 'NO') + '</span>' : '—'
    const sideCell = L.kind === 'realtime' ? '<td class="r" data-flip="' + L.labeled_at + '" style="cursor:pointer" title="click to flip YES/NO (misclick fix)">' + sideTxt + ' ⇄</td>' : '<td class="r">' + sideTxt + '</td>'
    let detail = '—', pnl = '', pnlC = 'dim'
    if (L.kind === 'realtime' && L.sell_px != null) { const p = (L.sell_px - L.buy_px) - kf(L.buy_px) - kf(L.sell_px); npnl += p; detail = Math.round(L.buy_px * 100) + 'c→' + Math.round(L.sell_px * 100) + 'c'; pnl = (p >= 0 ? '+' : '') + p.toFixed(3); pnlC = p > 0 ? 'up' : p < 0 ? 'down' : 'dim' }
    else if (L.opt_edge != null) detail = 'edge ' + Math.round(L.opt_edge * 100) + 'c'
    const trCell = L.kind === 'realtime'
      ? '<td data-train="' + L.labeled_at + '" style="cursor:pointer" class="' + (L.train === false ? 'down' : 'up') + '">' + (L.train === false ? '✗ excl' : '✓') + '</td>'
      : '<td class="' + (L.train === false ? 'dim' : 'up') + '">' + (L.train === false ? '—' : '✓') + '</td>'
    return '<tr data-sel="' + L.labeled_at + '" style="cursor:pointer' + (selectedLabel === L.labeled_at ? ';background:rgba(240,160,0,0.18)' : '') + '"><td>' + (L.buy_t != null ? tmOf(L.buy_t) : '—') + '</td><td>' + kind + '</td>' + sideCell + '<td class="r dim">' + detail + '</td><td class="r ' + pnlC + '">' + (pnl || '—') + '</td>' + trCell + '<td data-del="' + L.labeled_at + '" style="cursor:pointer" class="down">×</td></tr>'
  }).join('') || '<tr><td colspan="7" class="dim">no labels yet — press X for a buy-box, C for a no-trade zone, up/down to trade</td></tr>'
  const sub = document.getElementById('td-sub'); if (sub) sub.textContent = labs.length + ' labels · ' + nbuy + ' buy · ' + nno + ' no-trade · ' + ntr + ' trades · [N] net ' + (npnl >= 0 ? '+' : '') + npnl.toFixed(2)
}
{ const _tdb = document.getElementById('td-tbody')
  if (_tdb) _tdb.addEventListener('click', (e) => {
    const delEl = e.target.closest('[data-del]'), trnEl = e.target.closest('[data-train]'), flipEl = e.target.closest('[data-flip]')
    if (delEl) { const id = Number(delEl.getAttribute('data-del')); const u = ((lastState && lastState.snap_labels) || []).find((x) => x.labeled_at === id); if (u) undoStack.push(u); window.cta.delLabel(id); return }
    if (flipEl) { window.cta.flipLabel(Number(flipEl.getAttribute('data-flip'))); return }
    if (trnEl) { window.cta.excludeLabel(Number(trnEl.getAttribute('data-train'))); return }
    const row = e.target.closest('tr'); const sel = row && row.getAttribute('data-sel')
    if (sel) { selectedLabel = Number(sel); if (lastState) { drawVtrace(lastState, true); renderTraining(lastState) } }
  })
}

function drawVtrace(state, force) {
  const svg = $('vtrace')
  const tr = state.trace || []
  // PERF GATE: skip the full #vtrace SVG rebuild when nothing that affects it changed since last draw.
  // Signature = cheap fingerprint of the trace tail + every overlay/interaction input the SVG depends on.
  // `force` (theme/hover/zoom/scrubber/label callers) always rebuilds. Throttle caps render-path redraws.
  if (!force) {
    const _last = tr.length ? tr[tr.length - 1] : null
    const sig = [
      tr.length, _last ? _last[0] : 0, _last ? _last[1] : 0, _last ? _last[3] : 0,
      (state.trades_log || []).length, (state.snap_labels || []).length, (state.w_neural_trades || []).length,
      // injected-marker sources (WaveBot/E_fade/M_maker + all auto-discovered forward bots): a new row in
      // ANY of them must defeat the signature so its triangle appears within one throttle tick, not the 4s refresh
      (state.paper_trades || []).length, (state.e_trades || []).length, (state.m_trades || []).length,
      fwdBotDefs(state).reduce((n, d) => n + ((state[d.tradesKey] || []).length), 0),
      histWin ? (histWin.t0 + ':' + (histWin.pts ? histWin.pts.length : 0)) : 0,
      selectedTrade, selectedLabel, hoverV, hoverVy, vLo, vHi, vYLo, vYHi, sigOnly,
      boxDrag ? (boxDrag.el0 + ':' + boxDrag.el1) : 0,
      yesPos ? yesPos.t : 0, noPos ? noPos.t : 0,
      document.documentElement.getAttribute('data-theme')
    ].join('~')
    const now = Date.now()
    if (sig === _vtraceSig && now - _vtraceLastAt < 4000) return   // identical inputs — keep existing SVG (allow an occasional refresh)
    if (now - _vtraceLastAt < VTRACE_MIN_MS) return                // throttle: ≤ ~4x/sec
    _vtraceLastAt = now; _vtraceSig = sig
  }
  const W = 900, H = 340, PADL = 30, PADR = 10, PADT = 8, PADB = 16
  if (!histWin && tr.length < 2) { svg.innerHTML = '<text x="10" y="20" fill="#6b786b" font-size="10" font-family="monospace">recording…</text>'; return }
  const night = document.documentElement.getAttribute('data-theme') === 'night'
  const C_MID = night ? '#7c7c7c' : '#f0a000', C_FAIR = night ? '#5f6a6a' : '#4fd0e0', C_DIFF = night ? '#8a6a8a' : '#d070d0', C_PINK = night ? '#9a4a6a' : '#ff5fa2', C_GRID = night ? '#141414' : '#1c241c', C_AX = night ? '#444444' : '#6b786b'
  const nowEp = tr.length ? tr[tr.length - 1][0] : 0   // live "now" (for the NOW marker); 0 when scrubbing/no live data
  let curWin, winOpen, cur
  if (histWin) { cur = histWin.pts || []; winOpen = histWin.t0; curWin = Math.floor(winOpen / 900) }   // SCRUBBER: render a selected past window
  else {
    curWin = Math.floor(nowEp / 900); winOpen = curWin * 900
    // FREEZE FIX: instead of `tr.filter(...)` over the WHOLE session array every draw, find the window's start
    // index once (trace is append-only + sorted by t, so the window is a contiguous suffix) and reuse it. On
    // subsequent draws we only need to confirm the cached start row still belongs to this window; trace only
    // ever appends, so the start index is stable until the window rolls. We then slice the suffix directly.
    const c = _vwCache
    let startIdx
    if (c.winOpen === winOpen && c.startIdx <= tr.length && tr[c.startIdx] && Math.floor(tr[c.startIdx][0] / 900) === curWin
        && (c.startIdx === 0 || !tr[c.startIdx - 1] || Math.floor(tr[c.startIdx - 1][0] / 900) !== curWin)) {
      startIdx = c.startIdx                                   // cache hit: window start unchanged
    } else {
      // (re)locate the window start. Walk back from the tail (cheap — current window is a short suffix) so cost
      // is O(window length) not O(session length). New window -> this runs once, then the cache holds.
      startIdx = tr.length
      while (startIdx > 0 && Math.floor(tr[startIdx - 1][0] / 900) === curWin) startIdx--
      _vwCache = { winOpen, startIdx, len: 0, cur: null }
    }
    cur = tr.slice(startIdx)
    _vwCache.len = tr.length; _vwCache.cur = cur
  }
  if (cur.length < 1) { svg.innerHTML = '<text x="10" y="20" fill="#6b786b" font-size="10" font-family="monospace">new window…</text>'; return }
  viewWinOpen = winOpen; viewPts = cur
  // X = elapsed seconds in window (0..900) LINEAR (constant rate); Y = YES probability
  const X = (el) => PADL + (el - vLo) / (vHi - vLo) * (W - PADL - PADR)   // vLo..vHi = zoom window (default 0..900)
  const Y = (v) => { const f = (v - vYLo) / (vYHi - vYLo); return PADT + (H - PADT - PADB) * (1 - Math.max(0, Math.min(1, f))) }
  let s = ''
  // GREEN/RED boxes scored at the prediction's actual horizon. Metrics PERSIST across reloads (ACC in localStorage),
  // each box counted once by its timestamp. Full-width summary lines = largest (solid) + average (dashed), per colour.
  { const MV = 0.0025, SIG = 0.05, BZ = (H - PADT - PADB) * 0.42; let i = 0
    while (i < cur.length) {
      const pr = cur[i][3]
      if (pr == null) { i++; continue }
      const call = pr - cur[i][1]
      if (Math.abs(call) < MV) { i++; continue }
      const Hz = (cur[i][4] != null) ? cur[i][4] : 0.5
      let je = -1
      for (let j = i + 1; j < cur.length; j++) { if (cur[j][0] - cur[i][0] >= Hz) { je = j; break } }
      if (je < 0) { i++; continue }
      const actual = cur[je][1] - cur[i][1]
      if (actual === 0) { i = je + 1; continue }
      const moveAbs = Math.abs(actual), correct = Math.sign(actual) === Math.sign(call)
      if (cur[i][0] > ACC.lastT) {   // count each box ONCE -> survives reloads + accumulates across windows
        ACC.lastT = cur[i][0]; const big = moveAbs >= SIG
        if (correct) { ACC.g++; ACC.mg += moveAbs; if (moveAbs > ACC.maxg) ACC.maxg = moveAbs; if (big) { ACC.gb++; ACC.mgb += moveAbs } }
        else { ACC.r++; ACC.mr += moveAbs; if (moveAbs > ACC.maxr) ACC.maxr = moveAbs; if (big) { ACC.rb++; ACC.mrb += moveAbs } }
      }
      if (sigOnly && moveAbs < SIG) { i = je + 1; continue }  // big-moves filter = DISPLAY only (metrics still count all)
      const x1 = X(cur[i][0] - winOpen), bw = Math.max(1.5, X(cur[je][0] - winOpen) - x1), rgb = correct ? '62,196,109' : '255,85,85'
      const barH = Math.min(moveAbs / 0.12, 1) * BZ
      s += `<rect x="${x1.toFixed(1)}" y="${(H - PADB - barH).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" fill="rgba(${rgb},0.32)"/>`
      s += `<rect x="${x1.toFixed(1)}" y="${PADT}" width="${bw.toFixed(1)}" height="${(H - PADT - PADB).toFixed(1)}" fill="rgba(${rgb},0.05)" stroke="rgba(${rgb},0.16)" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`
      i = je + 1
    }
    _persistACC()   // PERF(FREEZE): debounced off the hot redraw path — was a synchronous localStorage write every draw
    const lineY = (mv) => H - PADB - Math.min(mv / 0.12, 1) * BZ
    const fwl = (mv, rgb, dash) => mv > 0 ? `<line x1="${PADL}" y1="${lineY(mv).toFixed(1)}" x2="${(W - PADR).toFixed(1)}" y2="${lineY(mv).toFixed(1)}" stroke="rgba(${rgb},0.85)" stroke-width="1.1"${dash ? ' stroke-dasharray="4 3"' : ''} vector-effect="non-scaling-stroke"/>` : ''
    s += fwl(ACC.maxg, '62,196,109', false) + fwl(ACC.g ? ACC.mg / ACC.g : 0, '62,196,109', true)
    s += fwl(ACC.maxr, '255,85,85', false) + fwl(ACC.r ? ACC.mr / ACC.r : 0, '255,85,85', true)
    const G = sigOnly ? ACC.gb : ACC.g, R = sigOnly ? ACC.rb : ACC.r, MG = sigOnly ? ACC.mgb : ACC.mg, MR = sigOnly ? ACC.mrb : ACC.mr
    const accEl = document.getElementById('m-predacc'); const tot = G + R
    if (accEl) {
      if (tot >= 3) { const pct = Math.round(100 * G / tot); accEl.textContent = pct + '% (' + G + '/' + tot + ')' + (sigOnly ? ' ▦big' : ''); accEl.className = 'bnval sm ' + (pct >= 55 ? 'ok' : pct <= 45 ? 'bad' : '') }
      else { accEl.textContent = '—'; accEl.className = 'bnval sm dim' }
      const pe = state.pred   // hover -> the predictor ENSEMBLE (every model + live accuracy, champion ★) + champion ALL-TIME
      accEl.title = (pe && pe.ens && pe.ens.length) ? ('PREDICTOR MODELS — live directional accuracy:\n' + pe.ens.map((v, k) => (k === 0 ? '★ ' : '   ') + '#' + v.id + '  ' + v.acc + '   [' + v.feats.join('+') + '] h' + v.h).join('\n') + (pe.at != null ? '\n\nchampion ALL-TIME: ' + pe.at + '%  (n=' + (pe.n_at || 0) + ')' : '')) : 'predictor ensemble loading…'
    }
    const magEl = document.getElementById('m-magacc'); const magT = MG + MR
    if (magEl) {
      if (magT > 0.02) { const mp = Math.round(100 * MG / magT); magEl.textContent = mp + '% ($' + MG.toFixed(2) + '/$' + MR.toFixed(2) + ')'; magEl.className = 'bnval sm ' + (mp >= 55 ? 'ok' : mp <= 45 ? 'bad' : '') }
      else { magEl.textContent = '—'; magEl.className = 'bnval sm dim' }
    }
  }
  const _yr = vYHi - vYLo, _ys = _yr > 0.6 ? 0.25 : _yr > 0.25 ? 0.1 : _yr > 0.1 ? 0.05 : 0.02   // adaptive probability ticks
  for (let _v = Math.ceil(vYLo / _ys) * _ys; _v <= vYHi + 1e-9; _v += _ys) {
    const v = +_v.toFixed(4)
    s += `<line x1="${PADL}" y1="${Y(v)}" x2="${W - PADR}" y2="${Y(v)}" stroke="${C_GRID}" stroke-width="${Math.abs(v - 0.5) < 1e-9 ? 1 : 0.5}" vector-effect="non-scaling-stroke"/>`
    s += `<text x="2" y="${(Y(v) - 2).toFixed(1)}" fill="${C_AX}" font-size="8" font-family="monospace">${(v * 100).toFixed(0)}%</text>`
  }
  ;[0, 3, 6, 9, 12, 15].forEach((m) => {
    const x = X(m * 60)
    s += `<line x1="${x.toFixed(1)}" y1="${PADT}" x2="${x.toFixed(1)}" y2="${H - PADB}" stroke="${C_GRID}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`
    s += `<text x="${x.toFixed(1)}" y="${H - 3}" fill="${C_AX}" font-size="8" font-family="monospace" text-anchor="middle">${m}m</text>`
  })
  const poly = (pts, color, w) => pts.length > 1 ? `<polyline fill="none" stroke="${color}" stroke-width="${w}" vector-effect="non-scaling-stroke" points="${pts.join(' ')}"/>` : ''
  const pMid = [], pFair = [], pDiff = [], pPred = [], pPink = []
  cur.forEach((row) => {
    const t = row[0], mid = row[1], fair = row[2], pred = row[3]
    const x = X(t - winOpen).toFixed(1)
    pMid.push(x + ',' + Y(mid).toFixed(1)); pFair.push(x + ',' + Y(fair).toFixed(1)); pDiff.push(x + ',' + Y(0.5 + (row[5] || 0)).toFixed(1))   // purple = LARGEST red-vs-orange (pred-mid) gap this 1/3s period, centred on 0.5
    pPink.push(x + ',' + Y(0.5 + (row[6] || 0)).toFixed(1))   // pink = LARGEST market-vs-fair deviation this 1/3s period (the fade / mean-reversion signal), centred on 0.5
    if (pred != null) pPred.push(x + ',' + Y(pred).toFixed(1))
  })
  s += poly(pDiff, C_DIFF, 1) + poly(pPink, C_PINK, 1) + poly(pFair, C_FAIR, 1.3) + poly(pMid, C_MID, 1.3) + poly(pPred, '#ff3b3b', 1.2)
  // STALE-DATA gaps: where the feed lagged (>2s between samples), grey out the interpolated jump (mid+fair)
  for (let i = 1; i < cur.length; i++) {
    if (cur[i][0] - cur[i - 1][0] > 2) {
      const x1 = X(cur[i - 1][0] - winOpen), x2 = X(cur[i][0] - winOpen)
      s += `<line x1="${x1.toFixed(1)}" y1="${Y(cur[i - 1][1]).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${Y(cur[i][1]).toFixed(1)}" stroke="#666" stroke-width="1.5" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`
      s += `<line x1="${x1.toFixed(1)}" y1="${Y(cur[i - 1][2]).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${Y(cur[i][2]).toFixed(1)}" stroke="#666" stroke-width="1.5" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`
    }
  }
  // NOW line + flags (move right as the window progresses)
  const nx = X(nowEp - winOpen)
  const wd = state.window || {}
  const curFair = wd.fair != null ? wd.fair : cur[cur.length - 1][2]
  const curMid = wd.mid != null ? wd.mid : cur[cur.length - 1][1]
  // NOW vertical line removed (it covered the most recent data)
  const flag = (v, color) => {
    if (v == null) return ''
    const y = Y(v)
    return `<polygon points="${nx.toFixed(1)},${y.toFixed(1)} ${(nx + 8).toFixed(1)},${(y - 5).toFixed(1)} ${(nx + 8).toFixed(1)},${(y + 5).toFixed(1)}" fill="${color}"/>`
      + `<text x="${(nx + 10).toFixed(1)}" y="${(y + 3).toFixed(1)}" fill="${color}" font-size="9" font-weight="bold" font-family="monospace">${(v * 100).toFixed(1)}</text>`
  }
  s += flag(curFair, C_FAIR) + flag(curMid, C_MID)
  if (hoverV != null) {
    if (hoverVy != null) {
      s += `<line x1="${PADL}" y1="${hoverVy.toFixed(1)}" x2="${(W - PADR).toFixed(1)}" y2="${hoverVy.toFixed(1)}" stroke="#bbbbbb" stroke-width="0.7" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`
      s += `<line x1="${hoverV.toFixed(1)}" y1="${PADT}" x2="${hoverV.toFixed(1)}" y2="${(H - PADB).toFixed(1)}" stroke="#bbbbbb" stroke-width="0.7" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>`
    }
    const el = vLo + (hoverV - PADL) / (W - PADL - PADR) * (vHi - vLo)
    let best = null, bd = 1e9
    cur.forEach(([t, mid, fair]) => { const d = Math.abs((t - winOpen) - el); if (d < bd) { bd = d; best = { t, mid, fair } } })
    if (best) {
      const xx = X(best.t - winOpen)
      // (snapped vertical removed — the free mouse crosshair below replaces it; value labels kept)
      const lab = (v, color) => `<circle cx="${xx.toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.6" fill="${color}"/><text x="${(xx + 5).toFixed(1)}" y="${(Y(v) - 3).toFixed(1)}" fill="${color}" font-size="9" font-weight="bold" font-family="monospace">${(v * 100).toFixed(1)}</text>`
      s += lab(best.fair, C_FAIR) + lab(best.mid, C_MID)
      s += `<text x="${xx.toFixed(1)}" y="${(PADT + 9).toFixed(1)}" fill="${C_AX}" font-size="8" font-family="monospace" text-anchor="middle">${((best.t - winOpen) / 60).toFixed(1)}m</text>`
    }
  }
  // PERF(FREEZE): trades_log / snap_labels / w_neural_trades are append-only session arrays (capped only at
  // 20000) but only rows in the CURRENT 15-min window render here. Pre-filter each ONCE to curWin and reuse the
  // small filtered list for both the count and the marker loop — instead of O(20000) sweeps per draw (twice, for
  // w_neural_trades, which previously called .filter(type==='entry') for the count AND again in the loop).
  const tl = (state.trades_log || []).filter((q) => Math.floor(q.t_in / 900) === curWin)
  const yb = H - PADB + 1
  tl.forEach((q) => {
    const x = X(q.t_in - winOpen), sel = String(selectedTrade) === String(q.id)
    const col = sel ? '#ffffff' : (q.side === 'yes' ? '#3ec46d' : '#ff5555'), sz = sel ? 5 : 3
    const ex = q.status === 'closed' ? `SOLD @${q.exit} (${q.pnl >= 0 ? '+' : ''}${q.pnl})` : `holding · will sell at bid +${q.hold}s`
    const tip = `${q.bot} [${q.strat}] BUY ${(q.side || '').toUpperCase()} @${q.entry} · ${ex} · mid ${q.mid}/fair ${q.fair}/BTC $${q.btc} · ${etTime(q.t_in * 1000)}`
    s += `<polygon data-tid="${q.id}" style="cursor:pointer" points="${x.toFixed(1)},${yb} ${(x - sz).toFixed(1)},${(yb + sz * 2)} ${(x + sz).toFixed(1)},${(yb + sz * 2)}" fill="${col}" opacity="0.92"><title>${tip}</title></polygon>`
  })
  // INJECTED bot trades (WaveBot / E_fade / M_maker / EVERY auto-discovered forward bot incl. Chop_TP,
  // the slow-creep fleet, NearStrike and the 20 C_ns_* grid cells): SAME entry-triangle markers as the
  // evolution trades_log above — so every bot whose rows appear in the OPEN/SETTLED tables now also
  // marks the main graph (this is the "no triangle for some bots" fix; the marker path predated the
  // fwdBotDefs auto-discovery and only knew trades_log/snap_labels/w_neural_trades). Skipped here to
  // avoid double markers: 'WN' (W_neural keeps its richer pink box rendering below) and 'N' (Noah's
  // trades already draw as label boxes / position lines). data-tid keeps click-to-highlight in sync
  // with the table rows, exactly like trades_log markers.
  injectedWindowTrades(state, curWin).forEach((q) => {
    if (!q || q.strat === 'WN' || q.strat === 'N' || q.t_in == null) return
    const x = X(q.t_in - winOpen), sel = String(selectedTrade) === String(q.id)
    const col = sel ? '#ffffff' : (q.side === 'yes' ? '#3ec46d' : '#ff5555'), sz = sel ? 5 : 3
    const ex = q.status === 'closed' ? `SOLD @${q.exit != null ? q.exit : '?'} (${q.pnl != null ? (q.pnl >= 0 ? '+' : '') + q.pnl : '—'})` : 'holding'
    const tip = `${q.bot} [${q.strat}] BUY ${(q.side || '').toUpperCase()} @${q.entry != null ? q.entry : '?'} · ${ex} · ${etTime(q.t_in * 1000)}`
    s += `<polygon data-tid="${q.id}" style="cursor:pointer" points="${x.toFixed(1)},${yb} ${(x - sz).toFixed(1)},${(yb + sz * 2)} ${(x + sz).toFixed(1)},${(yb + sz * 2)}" fill="${col}" opacity="0.92"><title>${tip}</title></polygon>`
  })
  // LABELS: box = buy(left)→sell(right). yellow=buy(X) · red=avoid(Z) · green=your live Space trade. dots = OPTIMAL inside. click × to delete.
  ;(state.snap_labels || []).filter((L) => L && L.buy_t != null && Math.floor(L.buy_t / 900) === curWin).forEach((L) => {
    const col = L.kind === 'momentum' ? '#aaff00' : L.kind === 'avoid' ? '#ff5555' : L.kind === 'realtime' ? '#3ec46d' : '#ffd600'
    const xa = X(L.buy_t - winOpen), xb = X(L.sell_t - winOpen)
    s += `<rect x="${Math.min(xa, xb).toFixed(1)}" y="${PADT}" width="${Math.abs(xb - xa).toFixed(1)}" height="${(H - PADT - PADB).toFixed(1)}" fill="${col}18" stroke="${L.labeled_at === selectedLabel ? '#ffffff' : col}" stroke-width="${L.labeled_at === selectedLabel ? '1.8' : '0.8'}" pointer-events="none" ${L.kind === 'avoid' ? 'stroke-dasharray="2 2"' : ''}/>`
    if (L.side && L.kind !== 'avoid') s += `<text x="${(Math.min(xa, xb) + 3).toFixed(1)}" y="${(PADT + 11)}" fill="${L.side === 'yes' ? '#3ec46d' : '#ff5555'}" font-size="11" font-weight="bold" pointer-events="none">${L.side === 'yes' ? 'Y' : 'N'}</text>`
    if (L.opt_buy_t != null) s += `<circle cx="${X(L.opt_buy_t - winOpen).toFixed(1)}" cy="${Y(L.opt_buy_mid).toFixed(1)}" r="2.2" fill="${col}" pointer-events="none"/>`
    if (L.opt_sell_t != null) s += `<circle cx="${X(L.opt_sell_t - winOpen).toFixed(1)}" cy="${Y(L.opt_sell_mid).toFixed(1)}" r="2.2" fill="none" stroke="${col}" stroke-width="1" pointer-events="none"/>`
    { const _cx = Math.max(xa, xb) - 6, _cy = PADT + 7   // bigger click target so deleting a box isn't finicky
      s += `<circle cx="${_cx.toFixed(1)}" cy="${_cy}" r="7" fill="${col}" opacity="0.35" data-lbl="${L.labeled_at}" style="cursor:pointer"><title>delete this box</title></circle><text x="${_cx.toFixed(1)}" y="${(_cy + 3.5)}" text-anchor="middle" fill="#000" font-size="11" font-weight="bold" pointer-events="none">×</text>` }
  })
  if (boxDrag) {
    const xa = X(boxDrag.el0), xb = X(boxDrag.el1), c = labelKind === 'avoid' ? '#ff5555' : labelKind === 'momentum' ? '#aaff00' : '#ffd600'
    s += `<rect x="${Math.min(xa, xb).toFixed(1)}" y="${PADT}" width="${Math.abs(xb - xa).toFixed(1)}" height="${(H - PADT - PADB).toFixed(1)}" fill="${c}33" stroke="${c}" stroke-width="1" stroke-dasharray="3 2" pointer-events="none"/>`
    if (labelKind !== 'avoid' && cur && cur.length) {   // live auto-side detection as you drag (matches the save logic: best YES vs best NO move)
      const a = Math.min(boxDrag.el0, boxDrag.el1), b = Math.max(boxDrag.el0, boxDrag.el1)
      const bx = cur.filter((p) => { const el = p[0] - winOpen; return el >= a && el <= b })
      if (bx.length >= 2) {
        let mn = bx[0][1], mx = bx[0][1], bY = 0, bN = 0
        for (let i = 1; i < bx.length; i++) { const m = bx[i][1]; if (m - mn > bY) bY = m - mn; if (mx - m > bN) bN = mx - m; if (m < mn) mn = m; if (m > mx) mx = m }
        const sd = bY >= bN ? 'yes' : 'no'
        s += `<text x="${(Math.min(xa, xb) + 3).toFixed(1)}" y="${(PADT + 11)}" fill="${sd === 'yes' ? '#3ec46d' : '#ff5555'}" font-size="11" font-weight="bold" pointer-events="none">${sd === 'yes' ? 'Y' : 'N'}</text>`
      }
    }
  }
  if (yesPos && Math.floor(yesPos.t / 900) === curWin) { const px = X(yesPos.t - winOpen); s += `<line x1="${px.toFixed(1)}" y1="${PADT}" x2="${px.toFixed(1)}" y2="${(H - PADB).toFixed(1)}" stroke="#3ec46d" stroke-width="1.5" stroke-dasharray="2 2" pointer-events="none"/>` }
  if (noPos && Math.floor(noPos.t / 900) === curWin) { const px = X(noPos.t - winOpen); s += `<line x1="${px.toFixed(1)}" y1="${PADT}" x2="${px.toFixed(1)}" y2="${(H - PADB).toFixed(1)}" stroke="#ff5555" stroke-width="1.5" stroke-dasharray="2 2" pointer-events="none"/>` }
  // W_NEURAL trades — PINK (the learning bot's dry-run trades). box = held period, ▲/▼ = entry, ○ = exit, label = P&L.
  { const pt = state.w_neural_trades || [], PINK = '#ff3fc4'
    // PERF(FREEZE): single O(n) pass instead of three full-array sweeps (was: pex forEach + _pe.filter +
    // _pc.filter + render forEach). Count all entries (for the headline total), collect only THIS window's
    // entries (the only ones rendered), and build the exit map keyed by entry_t for just those entries.
    let _peLen = 0; const _ent = [], _exByEntryT = {}
    for (const p of pt) {
      if (!p) continue
      if (p.type === 'exit') { _exByEntryT[p.entry_t] = p; continue }
      if (p.type === 'entry') { _peLen++; if (Math.floor(p.t / 900) === curWin) _ent.push(p) }
    }
    const _pc = _ent.length
    s += `<text x="${(W - PADR - 96).toFixed(1)}" y="${(PADT + 8)}" fill="${PINK}" font-size="9" font-weight="bold" pointer-events="none">W_neural:${_peLen} here:${_pc}</text>`
    _ent.forEach((e) => {
      if (!cur.length) return
      const ex = _exByEntryT[e.t], xa = X(e.t - winOpen)
      const xb = ex ? X(ex.t - winOpen) : X(cur[cur.length - 1][0] - winOpen)
      const up = e.side === 'yes', ey = Y(e.mid)
      s += `<rect x="${Math.min(xa, xb).toFixed(1)}" y="${PADT}" width="${Math.max(2, Math.abs(xb - xa)).toFixed(1)}" height="${(H - PADT - PADB).toFixed(1)}" fill="${PINK}12" stroke="${PINK}" stroke-width="1.5" pointer-events="none"/>`
      s += up
        ? `<polygon points="${xa.toFixed(1)},${(ey - 4).toFixed(1)} ${(xa - 4).toFixed(1)},${(ey + 4).toFixed(1)} ${(xa + 4).toFixed(1)},${(ey + 4).toFixed(1)}" fill="${PINK}" pointer-events="none"/>`
        : `<polygon points="${xa.toFixed(1)},${(ey + 4).toFixed(1)} ${(xa - 4).toFixed(1)},${(ey - 4).toFixed(1)} ${(xa + 4).toFixed(1)},${(ey - 4).toFixed(1)}" fill="${PINK}" pointer-events="none"/>`
      let lbl = (e.side || '').toUpperCase() + ' open' + (e.p_win != null ? ` p${Math.round(e.p_win * 100)}` : '')
      if (ex) { const p = ex.pnl; lbl = (e.side || '').toUpperCase() + ' ' + (p >= 0 ? '+' : '') + Math.round((p || 0) * 100) + 'c'
        const _exm = cur.find((c) => c[0] >= ex.t) || cur[cur.length - 1]
        s += `<circle cx="${xb.toFixed(1)}" cy="${Y(_exm[1]).toFixed(1)}" r="3.2" fill="none" stroke="${PINK}" stroke-width="1.6" pointer-events="none"/>` }
      s += `<text x="${(Math.min(xa, xb) + 2).toFixed(1)}" y="${(PADT + 8)}" fill="${PINK}" font-size="9" font-weight="bold" pointer-events="none">${lbl}</text>`
    })
  }
  // ===== DATA-STREAM OVERLAYS (opt-in) =====
  // Each selected stream is drawn thin + subtle. Line streams are INDEPENDENTLY min-max normalized to the full
  // plot height (shape is what matters, not absolute scale — the honest [min..max] range is shown in the panel).
  // Discrete/rate streams (kind 'bar') render as thin columns in the bottom 15% so they don't obscure the price
  // lines. Works for BOTH the live window (streamData, pushed ~1x/s) AND a SCRUBBED past window (histWin.streamData,
  // fetched once per scrub via get-window-streams). `ov` is whichever matches THIS window's open epoch; the
  // renderer + normalization below are identical for either source. Selection (streamSel) applies to both.
  const ov = histWin
    ? ((histWin.streamData && Array.isArray(histWin.streamData.streams) && Math.abs((histWin.streamData.t0 || 0) - winOpen) < 1) ? histWin.streamData : null)
    : ((streamData && Array.isArray(streamData.streams) && Math.abs((streamData.t0 || 0) - winOpen) < 1) ? streamData : null)
  if (ov) {
    const plotH = H - PADT - PADB, BAND = plotH * 0.15, BASE = H - PADB
    const sel = ov.streams.filter((st) => streamSel[st.id] && st.present && st.pts && st.pts.length > 1)
    // bars first (behind the lines), each 0..max normalized within the bottom band
    sel.filter((st) => st.kind === 'bar').forEach((st) => {
      const mx = st.max > 0 ? st.max : 1, bw = Math.max(0.6, (W - PADL - PADR) / st.pts.length * 0.7)
      st.pts.forEach(([el, v]) => {
        if (el < vLo || el > vHi) return
        const x = X(el), bh = Math.max(0, Math.min(1, v / mx)) * BAND
        s += `<rect x="${(x - bw / 2).toFixed(1)}" y="${(BASE - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${st.color}" opacity="0.26"/>`
      })
    })
    // then line streams, thin (1px) + low-alpha, labeled at their right end
    sel.filter((st) => st.kind !== 'bar').forEach((st) => {
      const rng = (st.max - st.min) || 1, pp = []
      st.pts.forEach(([el, v]) => { if (el < vLo - 6 || el > vHi + 6) return; pp.push(X(el).toFixed(1) + ',' + (PADT + plotH * (1 - (v - st.min) / rng)).toFixed(1)) })
      if (pp.length < 2) return
      s += `<polyline fill="none" stroke="${st.color}" stroke-width="1" stroke-opacity="0.5" vector-effect="non-scaling-stroke" points="${pp.join(' ')}"/>`
      const lp = pp[pp.length - 1].split(',')
      s += `<text x="${Math.min(+lp[0] + 2, W - 1).toFixed(1)}" y="${(+lp[1] - 1).toFixed(1)}" fill="${st.color}" font-size="7" font-family="monospace" opacity="0.92" pointer-events="none">${st.id}</text>`
    })
  }
  // ===== Δ-STRIKE HISTORY (Noah 2026-07-02): the strikebar's BTC-vs-strike distance as a time-series on the
  // main chart. SYMLOG Y both ways from the strike: center dashed line = strike; y = sign(d)·log10(1+|d|)
  // normalized to log10(1+DMAX) of half-height — ±$1 visible near the strike, ±$200 stays on-plot. Always on.
  if (ov) {
    const stB = ov.streams.find((s0) => s0.id === 'btc')
    const K = histWin ? histWin.strike : wd.strike
    if (stB && stB.present && stB.pts && stB.pts.length > 1 && K) {
      const DMAX = 200, half = (H - PADT - PADB) / 2, cy0 = PADT + half, LG = Math.log10(1 + DMAX)
      const SY = (d) => cy0 - Math.sign(d) * Math.min(1, Math.log10(1 + Math.abs(d)) / LG) * half
      const DBLUE = 'rgba(90,160,255,'
      const pp = []
      stB.pts.forEach(([el, v]) => { if (el < vLo - 6 || el > vHi + 6 || v == null) return; pp.push(X(el).toFixed(1) + ',' + SY(v - K).toFixed(1)) })
      if (pp.length > 1) {
        s += `<line x1="${PADL}" y1="${cy0.toFixed(1)}" x2="${W - PADR}" y2="${cy0.toFixed(1)}" stroke="${DBLUE}0.35)" stroke-width="0.7" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`
        ;[1, 10, 100].forEach((v) => { [v, -v].forEach((d) => {
          const y = SY(d)
          s += `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${PADL + 4}" y2="${y.toFixed(1)}" stroke="${DBLUE}0.45)" stroke-width="0.7"/>`
          s += `<text x="${PADL + 6}" y="${(y + 2.5).toFixed(1)}" fill="${DBLUE}0.5)" font-size="7" font-family="monospace">${d > 0 ? '+' : '−'}$${v}</text>`
        }) })
        s += `<polyline fill="none" stroke="${DBLUE}0.6)" stroke-width="1" vector-effect="non-scaling-stroke" points="${pp.join(' ')}"/>`
        const lpD = pp[pp.length - 1].split(','), dl = stB.pts[stB.pts.length - 1][1] - K
        s += `<text x="${lpD[0]}" y="${(+lpD[1] - 3).toFixed(1)}" fill="${DBLUE}0.9)" font-size="8" font-weight="bold" font-family="monospace" text-anchor="end">Δstrike ${dl >= 0 ? '+' : '−'}$${Math.abs(dl).toFixed(0)}</text>`
      }
    }
  }
  svg.innerHTML = s
}
// DATA STREAMS panel: dynamically-built floating list of every catalogued stream (grouped), each with a toggle
// checkbox, colour swatch, live latest value + honest [min..max] range for the current window. Toggling persists
// to localStorage and forces a chart redraw so the overlay appears/disappears immediately.
function _fmtStreamNum(v) {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'k'
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(4)
}
function renderStreamPanel() {
  const panel = document.getElementById('streams-panel'); if (!panel || panel.style.display === 'none') return
  const body = panel.querySelector('#streams-body'); if (!body) return
  // While SCRUBBING a past window, mirror that window's stream values (fetched once per scrub); otherwise the live
  // window. When a feed stream has no overlapping in-memory history for a scrubbed window it shows greyed "no
  // history" (vs "no data" live) so a missing overlay is visible + explained rather than silently absent.
  const scrubbing = !!histWin
  const sd = scrubbing ? (histWin.streamData || null) : streamData
  if (!sd || !Array.isArray(sd.streams)) { body.innerHTML = '<div style="color:#6b786b;padding:8px;">' + (scrubbing ? 'loading window streams…' : 'waiting for stream data…') + '</div>'; return }
  const groups = {}
  sd.streams.forEach((st) => { (groups[st.group] = groups[st.group] || []).push(st) })
  let html = ''
  Object.keys(groups).forEach((g) => {
    html += `<div style="color:#7cc8ff;font-size:9px;letter-spacing:.5px;margin:8px 0 2px;border-bottom:1px solid #1c241c;padding-bottom:1px;">${g}</div>`
    groups[g].forEach((st) => {
      const on = !!streamSel[st.id]
      const rng = st.present ? `[${_fmtStreamNum(st.min)} .. ${_fmtStreamNum(st.max)}]` : (scrubbing ? 'no history' : 'no data')
      const swatch = st.kind === 'bar'
        ? `<span style="display:inline-block;width:16px;height:9px;background:${st.color};opacity:0.5;"></span>`
        : `<span style="display:inline-block;width:16px;height:0;border-top:2px solid ${st.color};"></span>`
      html += `<label style="display:flex;align-items:center;gap:6px;padding:2px 3px;cursor:pointer;font-size:10px;${st.present ? '' : 'opacity:0.4;'}">
        <input type="checkbox" ${on ? 'checked' : ''} data-sid="${st.id}" style="margin:0;">
        ${swatch}
        <span style="flex:1;color:#cfe0cf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${st.label}${st.kind === 'bar' ? ' <span style="color:#6b786b;">▮</span>' : ''}</span>
        <span style="color:${st.color};font-weight:700;min-width:44px;text-align:right;">${_fmtStreamNum(st.last)}</span>
        <span style="color:#6b786b;font-size:8px;min-width:80px;text-align:right;">${rng}</span>
      </label>`
    })
  })
  body.innerHTML = html
}

// ============================================================================
// ===== BOT-FAMILY CARDS (replaces the flat leaderboard list) ================
// Groups every shown bot into FAMILY cards, with a prominent TOP-3 row above them.
// Each bot row shows net $ / ROIc / trades / win% / ROI-per-hour + an inline P&L sparkline.
// Clicking a bot row sets selectedBot (highlights its #eqchart line), same as the old table.
// ============================================================================
const FAMILY_DEFS = [
  { key: 'W_NEURAL', label: 'W_NEURAL', accent: '#9b6bff', match: (b) => /^w_neural/i.test(b.name) || b.strat === 'WN' },
  { key: 'SLOWCREEP',label: 'SLOW-CREEP (dry-run)', accent: '#5fe0a0', match: (b) => b.strat === 'SC' },
  // NEAR-STRIKE family (strat 'NS': NearStrike + the 20 C_ns_* grid cells). Previously there was no NS
  // entry, so every near-strike bot fell through to the OTHER catch-all card — second-class citizens.
  // Accent matches their subtle-blue row outline.
  { key: 'NEARSTRIKE',label: 'NEAR-STRIKE (dry-run)', accent: '#5aa0ff', match: (b) => b.strat === 'NS' },
  // NOWCAST A/B (strat 'NC': C_nc_agree/dis/ctl) + BTCD hourly (strat 'BD': C_btcd_snipe/ctl), added 2026-07-02.
  // Own family cards so the wf-nowcast paper bots aren't buried in FORWARD / mis-counted as creep fleet.
  { key: 'NOWCAST',  label: 'NOWCAST A/B (paper)', accent: '#b98cff', match: (b) => b.strat === 'NC' },
  { key: 'BTCD',     label: 'BTCD hourly (paper)', accent: '#e0864f', match: (b) => b.strat === 'BD' },
  { key: 'FORWARD',  label: 'FORWARD (dry-run)', accent: '#4fd0e0', match: (b) => b.strat === 'C' },
  { key: 'EVOLUTION',label: 'EVOLUTION (Wave_v*)', accent: '#ff3fc4', match: (b) => /^Wave_v/i.test(b.name) },
  { key: 'OTHER',    label: 'OTHER', accent: '#e0b020', match: (b) => true }   // catch-all (E_fade, M_maker, Noah_Real…)
]
function _famOf(b) { for (const f of FAMILY_DEFS) if (f.match(b)) return f.key; return 'OTHER' }
const _money2 = (v) => (v == null ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(v).toFixed(2))
const _signC = (v) => (v > 0.001 ? '#3ec46d' : v < -0.001 ? '#ff5555' : '#6b786b')
// per-bot derived stats used by both the top-3 row and the family rows
function _botStats(b, widx) {
  const net = (b.nw != null ? b.nw - 1 : 0)              // cumulative net $ ( nw = 1 + net )
  const wr = b.trades ? Math.round(100 * b.wins / b.trades) : null
  const ageWin = Math.max((widx ?? 0) - (b.born_widx ?? 0), 1)
  const roiHr = (b.roi || 0) / (ageWin * 0.25)
  // roi is a TRUE return % for all bots now; roiNA ⇒ no capital base ⇒ show '—'.
  const roiTxt = b.roiNA ? '—' : ((b.roi || 0) >= 0 ? '+' : '') + (b.roi || 0).toFixed(1) + '%'
  const roiHrTxt = b.roiNA ? '—' : (roiHr >= 0 ? '+' : '') + roiHr.toFixed(1) + '%'
  return { net, wr, roiHr, roiTxt, roiHrTxt }
}
// one compact bot row inside a family card
function _famRow(b, widx) {
  const st = _botStats(b, widx)
  const sel = b.name === selectedBot
  const wrTxt = st.wr == null ? '—' : st.wr + '%'
  return `<div class="botcard-row${sel ? ' sel' : ''}${isPinned(b.name) ? ' pinned-row' : ''}" data-bot="${b.name}" style="display:flex;align-items:center;gap:8px;padding:5px 6px;cursor:pointer;border-top:1px solid var(--border);${sel ? 'background:rgba(240,210,90,0.10);' : ''}${b.disabled ? 'opacity:0.42;' : ''}">
    <div style="flex:1;min-width:0;">
      <div style="font-size:12px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${pinGlyph(b.name)}${sel ? '▶ ' : ''}${b.disabled ? '⊘ ' : ''}${b.name} <span class="cyan" style="font-weight:400;">[${b.strat}]</span></div>
      <div style="font-size:9px;color:#6b786b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${b.params || ''}</div>
      <div style="display:flex;gap:7px;font-size:10px;margin-top:2px;">
        <span>net <b style="color:${_signC(st.net)}">${_money2(st.net)}</b></span>
        <span>roi <b style="color:${b.roiNA ? '#6b786b' : _signC(b.roi || 0)}">${st.roiTxt}</b></span>
        <span>tr <b>${b.trades || 0}</b></span>
        <span>win <b>${wrTxt}</b></span>
        <span>/hr <b style="color:${b.roiNA ? '#6b786b' : _signC(st.roiHr)}">${st.roiHrTxt}</b></span>
      </div>
    </div>
    ${botSparkSVG(b.series, 118, 40)}
  </div>`
}
function renderBotCards(state, shown) {
  const host = $('bot-cards'); if (!host) return
  const widx = state.widx
  const list = (shown || []).slice()
  // TOP-3 = best by cumulative net $ (nw). Prominent cards with a larger sparkline.
  const top = list.slice().sort((a, b) => (b.nw || 0) - (a.nw || 0)).slice(0, 3)
  const topCards = top.map((b, i) => {
    const st = _botStats(b, widx)
    const fam = FAMILY_DEFS.find((f) => f.key === _famOf(b)) || FAMILY_DEFS[FAMILY_DEFS.length - 1]
    const sel = b.name === selectedBot
    const medal = ['①', '②', '③'][i] || ''
    return `<div class="botcard-row${isPinned(b.name) ? ' pinned-row' : ''}" data-bot="${b.name}" style="flex:1;min-width:230px;background:var(--panel);border:1px solid ${fam.accent};border-top:3px solid ${fam.accent};padding:9px 11px;cursor:pointer;${sel ? 'box-shadow:0 0 0 2px rgba(240,210,90,0.5) inset;' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <span style="font-size:13px;font-weight:800;color:var(--text);">${pinGlyph(b.name)}${medal} ${sel ? '▶ ' : ''}${b.name}</span>
        <span class="cyan" style="font-size:10px;">[${b.strat}]</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:5px 0 3px;">
        <span style="font-size:18px;font-weight:800;color:${_signC(st.net)};">${_money2(st.net)}</span>
        <span style="font-size:11px;color:${b.roiNA ? '#6b786b' : _signC(b.roi || 0)};">${st.roiTxt} roi</span>
      </div>
      <div style="display:flex;gap:9px;font-size:10px;color:#9aa39a;margin-bottom:5px;">
        <span>win <b style="color:var(--text)">${st.wr == null ? '—' : st.wr + '%'}</b></span>
        <span>trades <b style="color:var(--text)">${b.trades || 0}</b></span>
        <span>/hr <b style="color:${b.roiNA ? '#6b786b' : _signC(st.roiHr)}">${st.roiHrTxt}</b></span>
      </div>
      ${botSparkSVG(b.series, 210, 52)}
    </div>`
  }).join('')
  // FAMILY cards: group remaining (and all) bots by family, ordered W_NEURAL→FORWARD→EVOLUTION→OTHER.
  const byFam = {}
  list.forEach((b) => { const k = _famOf(b); (byFam[k] = byFam[k] || []).push(b) })
  const famCards = FAMILY_DEFS.map((f) => {
    let members = pinnedFirst((byFam[f.key] || []).slice().sort((a, b) => (b.nw || 0) - (a.nw || 0)))
    if (!members.length) return ''
    const aggNet = members.reduce((s, b) => s + ((b.nw || 1) - 1), 0)
    const aggTr = members.reduce((s, b) => s + (b.trades || 0), 0)
    // EVOLUTION can have many variants — show the top 6 by net, then a "+N more" footer.
    const CAP = f.key === 'EVOLUTION' ? 6 : 24
    const showMembers = members.slice(0, CAP)
    const moreN = members.length - showMembers.length
    return `<div class="panel" style="border-top:3px solid ${f.accent};min-width:330px;flex:1;max-width:520px;padding:0;overflow:hidden;">
      <div class="phead" style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--border);">
        <span style="color:${f.accent};">${f.label}</span>
        <span style="font-size:10px;font-weight:400;">net <b style="color:${_signC(aggNet)}">${_money2(aggNet)}</b> · ${members.length} bot${members.length === 1 ? '' : 's'} · ${aggTr} tr</span>
      </div>
      <div>${showMembers.map((b) => _famRow(b, widx)).join('')}</div>
      ${moreN > 0 ? `<div style="padding:4px 6px;font-size:10px;color:#6b786b;border-top:1px solid var(--border);">+${moreN} more variant${moreN === 1 ? '' : 's'} (see ROI chart)</div>` : ''}
    </div>`
  }).join('')
  host.innerHTML =
    `<div style="font-size:10px;color:#6b786b;margin:0 0 4px;letter-spacing:.5px;">★ TOP 3 BY NET · <span style="color:#9aa39a;">click any card for stats + all-time trade history</span></div>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">${topCards || '<span class="dim" style="font-size:11px;">no bots yet</span>'}</div>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">${famCards}</div>`
}

// ============================================================================
// ===== CREEP BREADTH ⁄ LUCK DIAGNOSTICS (fleet-level) =======================
// The ~18 C_creep* dry-run bots each BUY THE FAVORITE and hold to settle. Two ways
// their "14/18 positive" is misleading, both made visible here:
//   Graph 2 (WIN% vs PRICE): every bot's apparent edge is just win-rate − price paid.
//     Plot each on x=avg price, y=win-rate, against the y=x fair diagonal; dot size = n.
//     A real favorite-longshot bias sits a few cents ABOVE the line at HIGH n; a big
//     scatter that shrinks with n = noise.
//   Graph 3 (SAME-SIDE / BLOCK): per window (tk), how many bots went YES vs NO. They're
//     almost always ALL one side → the fleet is ~1 correlated bet, so "N winners" is fake
//     breadth. Block outcome per window: all-win / all-lose / mixed.
// READ-ONLY: reuses botAllTrades → the same normalized {tk,side,entry,pnl,closed} rows
// the detail overlay and table already use. Every helper is guarded (null/empty/n<2/NaN).

// A creep-fleet bot is any dry-run SlowCreep (strat 'SC') or forward taker (strat 'C').
function _isCreepBot(b) { return b && (b.strat === 'SC' || b.strat === 'C') }
// Per-bot roll-up from its normalized trades: {name, n, k, avgPx, winRate}. null if <1 usable.
function creepBotStat(state, b) {
  const trades = botAllTrades(state, b)
  const seq = _edgeTradeSeq(trades)
  if (!seq || seq.n < 1) return null
  const avgPx = seq.entries.reduce((a, c) => a + c, 0) / seq.n
  return { name: b.name, n: seq.n, k: seq.k, avgPx: avgPx, winRate: seq.k / seq.n }
}
// GRAPH 2 SVG — WIN% vs PRICE PAID scatter with the y=x fair diagonal. `pts`=[{name,n,avgPx,winRate}].
// Dot radius grows with n (low-n lucky points visually de-weighted); color by above/below diagonal.
function creepScatterSVG(pts) {
  if (!pts || pts.length < 1) return ''
  const W = 460, H = 300, PADL = 34, PADR = 12, PADT = 12, PADB = 28
  // domain: prices 0.45..0.95, win-rate 0..1 (favorites live in the upper-right)
  const x0 = 0.45, x1 = 0.95, y0 = 0, y1 = 1
  const X = (p) => PADL + ((Math.min(x1, Math.max(x0, p)) - x0) / (x1 - x0)) * (W - PADL - PADR)
  const Y = (w) => PADT + (1 - (Math.min(y1, Math.max(y0, w)) - y0) / (y1 - y0)) * (H - PADT - PADB)
  const nMax = pts.reduce((m, p) => Math.max(m, p.n), 1)
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;background:#070b07;border:1px solid var(--border);">`
  // axis gridlines at 0.5/0.6/0.7/0.8/0.9
  for (const gx of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    s += `<line x1="${X(gx).toFixed(1)}" y1="${PADT}" x2="${X(gx).toFixed(1)}" y2="${(H - PADB).toFixed(1)}" stroke="#141a14" stroke-width="1"/>`
    s += `<text x="${X(gx).toFixed(1)}" y="${(H - PADB + 11).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace" text-anchor="middle">${(gx * 100).toFixed(0)}c</text>`
  }
  for (const gy of [0, 0.25, 0.5, 0.75, 1]) {
    s += `<line x1="${PADL}" y1="${Y(gy).toFixed(1)}" x2="${(W - PADR).toFixed(1)}" y2="${Y(gy).toFixed(1)}" stroke="#141a14" stroke-width="1"/>`
    s += `<text x="${(PADL - 3).toFixed(1)}" y="${(Y(gy) + 3).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace" text-anchor="end">${(gy * 100).toFixed(0)}</text>`
  }
  // y=x FAIR diagonal (win-rate == price ⇒ efficient / no edge). Clip to the visible price domain.
  s += `<line x1="${X(x0).toFixed(1)}" y1="${Y(x0).toFixed(1)}" x2="${X(x1).toFixed(1)}" y2="${Y(x1).toFixed(1)}" stroke="#6b786b" stroke-width="1.1" stroke-dasharray="4 3"/>`
  s += `<text x="${(X(0.92)).toFixed(1)}" y="${(Y(0.92) - 4).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace" text-anchor="end">win% = price (fair)</text>`
  // points: radius 2.4..8 by sqrt(n); green above diagonal (winning more than price implies), red below.
  pts.slice().sort((a, b) => a.n - b.n).forEach((p) => {
    const above = p.winRate >= p.avgPx
    const col = above ? '#3ec46d' : '#ff7a6b'
    const r = 2.4 + 5.6 * Math.sqrt(p.n / nMax)
    s += `<circle cx="${X(p.avgPx).toFixed(1)}" cy="${Y(p.winRate).toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" fill-opacity="0.55" stroke="${col}" stroke-width="1"/>`
  })
  s += `<text x="${(PADL).toFixed(1)}" y="${(H - 4).toFixed(1)}" fill="#9aa39a" font-size="8" font-family="monospace">avg price paid (favorite) →   dot size ∝ n trades</text>`
  s += `</svg>`
  return s
}
// GRAPH 3 — SAME-SIDE / BLOCK CORRELATION. Group every creep bot's normalized trades by
// window token (tk); per window count YES vs NO entrants and classify block outcome from
// each entrant's pnl sign. Returns {windows:[{tk, yes, no, side, win, lose, outcome}], summary}.
function creepBlockStats(state, bots) {
  const byTk = {}   // tk -> {yes, no, win, lose, closed}
  ;(bots || []).forEach((b) => {
    if (!_isCreepBot(b)) return
    const trades = botAllTrades(state, b)
    if (!trades) return
    trades.forEach((q) => {
      if (!q || q.tk == null) return
      const side = (q.side === 'yes' || q.side === 'no') ? q.side : null
      if (!side) return
      const rec = byTk[q.tk] || (byTk[q.tk] = { tk: q.tk, yes: 0, no: 0, win: 0, lose: 0, closed: 0 })
      rec[side] += 1
      if (q.closed && q.pnl != null) { rec.closed += 1; if (q.pnl > 0) rec.win += 1; else rec.lose += 1 }
    })
  })
  const windows = Object.values(byTk).map((r) => {
    const n = r.yes + r.no
    const side = (r.no === 0 && r.yes > 0) ? 'YES' : (r.yes === 0 && r.no > 0) ? 'NO' : 'MIXED'
    const allSame = side !== 'MIXED'
    let outcome = 'open'
    if (r.closed > 0) outcome = (r.lose === 0) ? 'all-win' : (r.win === 0) ? 'all-lose' : 'mixed'
    return { tk: r.tk, n: n, yes: r.yes, no: r.no, side: side, allSame: allSame, win: r.win, lose: r.lose, closed: r.closed, outcome: outcome }
  })
  // chronological by the trailing time token in the ticker when present, else by tk string
  windows.sort((a, b) => String(a.tk).localeCompare(String(b.tk)))
  const active = windows.filter((w) => w.n >= 1)
  const multi = active.filter((w) => w.n >= 2)   // "correlation" only meaningful when ≥2 bots entered
  const allSameN = multi.filter((w) => w.allSame).length
  const closed = active.filter((w) => w.closed > 0)
  const allWin = closed.filter((w) => w.outcome === 'all-win').length
  const allLose = closed.filter((w) => w.outcome === 'all-lose').length
  const mixed = closed.filter((w) => w.outcome === 'mixed').length
  return { windows: active, summary: { activeN: active.length, multiN: multi.length, allSameN: allSameN, allWin: allWin, allLose: allLose, mixed: mixed } }
}
// GRAPH 3 SVG — a compact per-window strip: one bar per window, colored by block outcome
// (green all-win, red all-lose, amber mixed, dim open), with a marker showing same-side vs split.
function creepBlockStripSVG(windows) {
  if (!windows || !windows.length) return ''
  const N = windows.length
  const W = Math.max(200, Math.min(900, N * 9 + 40)), H = 64, PADL = 6, PADR = 6, PADT = 8, PADB = 14
  const bw = (W - PADL - PADR) / N
  const colOf = (o) => o === 'all-win' ? '#3ec46d' : o === 'all-lose' ? '#ff5555' : o === 'mixed' ? '#ff9d3b' : '#3a463a'
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;background:#070b07;border:1px solid var(--border);">`
  windows.forEach((w, i) => {
    const x = PADL + i * bw
    const col = colOf(w.outcome)
    const bh = H - PADT - PADB
    s += `<rect x="${x.toFixed(1)}" y="${PADT}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" fill-opacity="${w.allSame ? 0.85 : 0.4}"/>`
    // split windows (not all-same) get a white top notch so the RARE independent windows stand out
    if (!w.allSame) s += `<rect x="${x.toFixed(1)}" y="${PADT}" width="${Math.max(1, bw - 1).toFixed(1)}" height="2.2" fill="#ffffff"/>`
  })
  s += `<text x="${PADL}" y="${(H - 3).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace">oldest window</text>`
  s += `<text x="${(W - PADR).toFixed(1)}" y="${(H - 3).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace" text-anchor="end">newest · white notch = split (independent) window</text>`
  s += `</svg>`
  return s
}
let _creepDiagLastAt = 0, _creepDiagSig = ''
function renderCreepDiagnostics(state, shown) {
  const host = $('creep-diag'); if (!host) return
  const creeps = (shown || []).filter(_isCreepBot)
  if (!creeps.length) { host.innerHTML = `<div style="font-size:11px;color:#6b786b;padding:6px;">no creep/forward dry-run bots synced yet.</div>`; return }
  // per-bot stats for the scatter (drop bots with no usable closed trades)
  const pts = creeps.map((b) => creepBotStat(state, b)).filter(Boolean)
  const blk = creepBlockStats(state, creeps)
  // PERF GATE (mirror renderBotCards): skip rebuild when nothing material changed.
  const sig = creeps.length + '|' + pts.map((p) => p.name + ':' + p.n + ':' + p.k).join(',') + '|' + blk.summary.activeN + ':' + blk.summary.allSameN + ':' + blk.summary.allWin + ':' + blk.summary.allLose + ':' + blk.summary.mixed
  const now = Date.now()
  if (sig === _creepDiagSig && now - _creepDiagLastAt < 3000) return
  _creepDiagLastAt = now; _creepDiagSig = sig
  const scatter = creepScatterSVG(pts)
  const strip = creepBlockStripSVG(blk.windows)
  const su = blk.summary
  // headline breadth stat: fraction of ≥2-bot windows that were all-same-side
  const sameTxt = su.multiN > 0 ? `${su.allSameN}/${su.multiN}` : '—'
  const samePct = su.multiN > 0 ? Math.round(100 * su.allSameN / su.multiN) : null
  const breadthCol = (samePct != null && samePct >= 80) ? '#ff9d3b' : '#9aa39a'
  // count of points above the fair diagonal (apparent edge) — but note it's ~1 correlated bet
  const aboveN = pts.filter((p) => p.winRate >= p.avgPx).length
  host.innerHTML = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;">
      <div style="flex:1;min-width:320px;">
        <div style="font-size:11px;font-weight:700;color:#5fe0a0;margin-bottom:2px;">WIN% vs PRICE PAID — is the edge real, or just this sample?</div>
        ${scatter || '<div style="font-size:11px;color:#9a8a8a;padding:8px;">no closed creep trades with entry prices yet.</div>'}
        <div style="font-size:9px;color:#9aa39a;max-width:440px;line-height:1.5;margin-top:4px;">
          each dot = one creep bot · x = avg price paid, y = observed win-rate, size ∝ n trades.
          <b style="color:#3ec46d;">Above</b> the fair diagonal = winning MORE than the price implies (the apparent edge, ${aboveN}/${pts.length} bots); <b>ON</b> it = efficient/no-edge.
          A persistent favorite-longshot bias sits a few cents above the line at HIGH n; a big scatter that <b>shrinks toward the line as n grows = noise</b>. Low-n dots are lucky until proven otherwise.
        </div>
      </div>
      <div style="flex:1;min-width:320px;">
        <div style="font-size:11px;font-weight:700;color:#5fe0a0;margin-bottom:2px;">SAME-SIDE ⁄ BLOCK CORRELATION — is this N bets or 1?</div>
        ${strip || '<div style="font-size:11px;color:#9a8a8a;padding:8px;">no window-tagged creep trades yet (need tk + side).</div>'}
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:10px;margin-top:6px;">
          <span>all-same-side <b style="color:${breadthCol};">${sameTxt}${samePct != null ? ' (' + samePct + '%)' : ''}</b> of ≥2-bot windows</span>
          <span>block record <b style="color:#3ec46d;">${su.allWin}W</b> : <b style="color:#ff5555;">${su.allLose}L</b> : <b style="color:#ff9d3b;">${su.mixed} mixed</b></span>
        </div>
        <div style="font-size:9px;color:#9aa39a;max-width:440px;line-height:1.5;margin-top:4px;">
          one bar per window, colored by block outcome (<b style="color:#3ec46d;">all-win</b> ⁄ <b style="color:#ff5555;">all-lose</b> ⁄ <b style="color:#ff9d3b;">mixed</b>); a white notch = a rare SPLIT window where the fleet disagreed.
          When ~every window is all-same-side, the fleet is <b style="color:#ff9d3b;">~1 correlated momentum bet</b>, so "14/18 bots positive" is fake breadth — they win and lose together.
        </div>
      </div>
    </div>`
}

// ============================================================================
// ===== BOT DETAIL OVERLAY (click a bot card) ================================
// Full-screen dark-terminal overlay (reuses the #nn-detail pattern: position:fixed
// inset:0, dismiss via ✕ / click-outside / Esc). Shows the clicked bot's STATS panel
// plus its ALL-TIME trade history (every trade, scrollable). READ-ONLY — no write/sync
// paths are touched.
// ============================================================================
let selectedBotDetail = null   // which bot's detail overlay is open (name, or null)
let _allBots = null            // cache of the full synthesized bot set (incl. injected forward/slow-creep/NN) from the last heavy render — used by the detail overlay so a clicked card resolves between heavy ticks
// Map a bot (by name/strat) to its all-time trade rows, normalized to
// {t, side, entry, exit, pnl, tk, closed} (newest-first applied at render).
// NN bots (WN) pair exits→entries by entry_t; forward (C) reuse fwdNormTrades.
function botAllTrades(state, b) {
  if (!b) return null
  const nnSrc = { 'W_neural': state.w_neural_trades, 'W_neural_nobox': state.w_neural_nobox_trades, 'W_neural_v2': state.w_neural_v2_trades }
  if (b.strat === 'WN' && nnSrc[b.name] !== undefined) {
    const rows = nnSrc[b.name] || []
    const exByT = {}; rows.forEach((r) => { if (r && r.type === 'exit') exByT[r.entry_t] = r })
    const out = []
    rows.forEach((r) => {
      if (!r || r.type !== 'entry') return
      const ex = exByT[r.t]
      out.push({ t: r.t, tk: r.tk, side: r.side, entry: r.entry_px, exit: ex ? ex.exit_px : null, pnl: ex ? ex.pnl : null, closed: !!ex })
    })
    return out.sort((a, c) => (a.t || 0) - (c.t || 0))
  }
  // AUTO-DISCOVER: resolve the forward bot's trade log by matching its display name back to a fwdBotDefs entry
  // (same parsing that built the card), so the detail overlay shows the per-trade log for creep71/75/80/85 and
  // any future creepNN with no hardcoded name→key map.
  if (b.strat === 'C' || b.strat === 'SC' || b.strat === 'NS' || b.strat === 'NC' || b.strat === 'BD') {
    const _d = fwdBotDefs(state).find((d) => d.name === b.name)
    if (_d && state[_d.tradesKey] !== undefined) return fwdNormTrades(state[_d.tradesKey])
  }
  // E_fade / M_maker — same entry/exit pairing the current-window table injection uses (previously these
  // returned null, so their detail cards said "no per-trade history" despite full logs in state).
  if (b.strat === 'E' || b.strat === 'M') {
    const rows = (b.strat === 'E' ? state.e_trades : state.m_trades) || []
    const exByT = {}; rows.forEach((r) => { if (r && r.type === 'exit' && r.entry_t != null) exByT[r.entry_t] = r })
    const out = []
    rows.forEach((r) => {
      if (!r || r.type !== 'entry') return
      const ex = exByT[r.t]
      const exPx = ex ? (ex.exit_px != null ? ex.exit_px : (ex.exit && ex.exit.px != null ? ex.exit.px : (typeof ex.exit === 'number' ? ex.exit : null))) : null
      const exPnl = ex ? (ex.pnl != null ? ex.pnl : (ex.exit && ex.exit.pnl != null ? ex.exit.pnl : null)) : null
      out.push({ t: r.t, tk: r.tk, side: r.side, entry: r.entry_px != null ? r.entry_px : r.entry, exit: exPx, pnl: exPnl, closed: !!ex })
    })
    if (out.length) return out.sort((a, c) => (a.t || 0) - (c.t || 0))
  }
  // [N] Noah's own realtime trades from snap_labels — honest fills, both fees (same math as the table row).
  if (b.strat === 'N') {
    const out = []
    ;(state.snap_labels || []).forEach((L) => {
      if (!L || L.kind !== 'realtime' || L.buy_px == null || L.sell_px == null) return
      out.push({ t: L.buy_t, tk: null, side: L.side, entry: L.buy_px, exit: L.sell_px, pnl: +((L.sell_px - L.buy_px) - kalshiFee(L.buy_px) - kalshiFee(L.sell_px)).toFixed(3), closed: true })
    })
    if (out.length) return out.sort((a, c) => (a.t || 0) - (c.t || 0))
  }
  // EVOLUTION bots: their trades live in the embedded session trades_log keyed by bot name. (Session-capped,
  // so "all-time" here means this session's log — better than the old blanket "no history".)
  { const tl = (state.trades_log || []).filter((q) => q && q.bot === b.name)
    if (tl.length) return tl.map((q) => ({ t: q.t_in, tk: null, side: q.side, entry: q.entry, exit: q.status === 'closed' ? q.exit : null, pnl: q.status === 'closed' ? q.pnl : null, closed: q.status === 'closed' })).sort((a, c) => (a.t || 0) - (c.t || 0)) }
  return null   // no per-trade log at all (e.g. EVOLUTION Wave_v* board variants — box-side only)
}
// ===== EDGE vs LUCK — Bayesian model comparison ==============================
// Per bot: P(it has found a REAL edge | trade record) vs P(its good results are
// just LUCK | record). This is a Bayesian MODEL COMPARISON, not a p-value.
//
//   Under LUCK (efficient market, no skill) a bet placed at entry price e wins
//   with probability p_fair = e (the market price IS the fair win prob).
//   Under EDGE the bot wins ABOVE p_fair.
//
//   H_luck:  win-rate = p_fair  (point mass).   Lik = Binom(k; n, p_fair).
//   H_edge:  win-rate p ~ Uniform(p_fair, 1).
//            Lik = (1/(1-p_fair))·(1/(n+1))·(1 - I_{p_fair}(k+1, n-k+1))
//            where I = regularized incomplete Beta = Beta CDF.
//   BF = P(data|edge)/P(data|luck);  P(edge|data) = BF·π / (BF·π + (1-π)),  π=0.5.
//
// HONEST by construction: at small n the BF≈1 ⇒ P(edge)≈50% (uninformative); it
// only departs 50% under SUSTAINED over/under-performance. A no-edge bot stays ~50%.
//
// p_fair choice: we use the RAW entry price (NO fee added). This matches the model
// statement "a bet at price e wins with prob e" exactly — the cleanest, most honest
// market-efficiency baseline. (Adding ~2c fee would RAISE the bar and make every bot
// look slightly less edgy; we keep the bar at the pure market-implied prob.)
// READ-ONLY: computed from the same normalized trade rows the table already uses.
const EDGE_PRIOR = 0.5   // agnostic 50/50 prior on edge-vs-luck (documented constant)
// Lanczos log-gamma (g=7) — accurate to ~1e-13 for the small a,b (=k+1, n-k+1) here.
function _lgamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - _lgamma(1 - z)
  z -= 1
  let x = c[0]
  for (let i = 1; i < 9; i++) x += c[i] / (z + i)
  const t = z + 7 + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}
// Continued-fraction core (Lentz) for the incomplete beta. a,b >= 1, 0<x<1.
function _betacf(x, a, b) {
  const TINY = 1e-30, EPS = 1e-12, MAXIT = 300
  const qab = a + b, qap = a + 1, qam = a - 1
  let c = 1, d = 1 - qab * x / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY
    d = 1 / d; h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c; h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}
// Regularized incomplete beta I_x(a,b) = Beta CDF. Handles x=0/1; a,b>=1.
function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lbeta = _lgamma(a) + _lgamma(b) - _lgamma(a + b)
  // continued fraction converges fast on the appropriate side of the symmetry point
  if (x < (a + 1) / (a + b + 2)) {
    const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a
    return front * _betacf(x, a, b)
  } else {
    const front = Math.exp(b * Math.log(1 - x) + a * Math.log(x) - lbeta) / b
    return 1 - front * _betacf(1 - x, b, a)
  }
}
function _logBinomCoef(n, k) { return _lgamma(n + 1) - _lgamma(k + 1) - _lgamma(n - k + 1) }
// Core: k wins of n trades at market-implied fair win-prob pFair → {pEdge,pLuck,bf}.
function edgeVsLuck(k, n, pFair, prior) {
  prior = (prior == null) ? EDGE_PRIOR : prior
  if (!(n > 0) || k == null) return null
  pFair = Math.min(0.9999, Math.max(0.0001, pFair))
  // log P(data | H_luck) = log Binom(k; n, pFair)
  const logLikLuck = _logBinomCoef(n, k) + k * Math.log(pFair) + (n - k) * Math.log(1 - pFair)
  // P(data | H_edge) = (1/(1-pFair))·(1/(n+1))·(1 - I_pFair(k+1, n-k+1))
  const Ireg = regularizedIncompleteBeta(pFair, k + 1, n - k + 1)
  const likEdge = (1 / (1 - pFair)) * (1 / (n + 1)) * (1 - Ireg)
  if (!(likEdge > 0)) return { pEdge: 0, pLuck: 1, bf: 0, n: n, k: k, pFair: pFair }
  const bf = Math.exp(Math.log(likEdge) - logLikLuck)
  const pEdge = (bf * prior) / (bf * prior + (1 - prior))
  return { pEdge: pEdge, pLuck: 1 - pEdge, bf: bf, n: n, k: k, pFair: pFair }
}
// Take normalized trade rows → only CLOSED trades with a numeric entry price, in
// chronological order. Returns {entries:[...], wins:[0/1], k, n} or null.
function _edgeTradeSeq(trades) {
  if (!trades || !trades.length) return null
  const entries = [], wins = []
  for (const q of trades) {
    if (!q || !q.closed || q.pnl == null || q.entry == null) continue
    const e = Number(q.entry)
    if (!isFinite(e) || e <= 0 || e >= 1) continue   // need a usable market-implied prob in (0,1)
    entries.push(e)
    wins.push(q.pnl > 0 ? 1 : 0)
  }
  if (!entries.length) return null
  const k = wins.reduce((a, b) => a + b, 0)
  return { entries: entries, wins: wins, k: k, n: entries.length }
}
// Static (final) P(edge) for the whole record. p_fair = AVG entry price.
function edgeFromTrades(trades) {
  const seq = _edgeTradeSeq(trades)
  if (!seq) return null
  const pFair = seq.entries.reduce((a, b) => a + b, 0) / seq.n
  const r = edgeVsLuck(seq.k, seq.n, pFair, EDGE_PRIOR)
  if (!r) return null
  r.avgEntry = pFair
  return r
}
// Over-time series: after each trade i (1..n), recompute P(edge) using running
// wins-so-far and running avg entry price → [{i, pEdge}]. X = trade #, Y = P(edge).
function edgeSeriesOverTime(trades) {
  const seq = _edgeTradeSeq(trades)
  if (!seq) return null
  const out = []
  let kRun = 0, eSum = 0
  for (let i = 0; i < seq.n; i++) {
    kRun += seq.wins[i]
    eSum += seq.entries[i]
    const pFair = eSum / (i + 1)
    const r = edgeVsLuck(kRun, i + 1, pFair, EDGE_PRIOR)
    out.push({ i: i + 1, pEdge: r ? r.pEdge : 0.5 })
  }
  return out
}
// Compact inline SVG sparkline of P(edge)% over trade #, with the 50% reference line.
function edgeSparklineSVG(series, accent) {
  if (!series || series.length < 1) return ''
  const W = 320, H = 90, PADL = 26, PADR = 8, PADT = 8, PADB = 16
  const n = series.length
  const X = (i) => PADL + (n <= 1 ? 0 : ((i - 1) / (n - 1)) * (W - PADL - PADR))
  const Y = (p) => PADT + (1 - p) * (H - PADT - PADB)   // p in 0..1, 100% at top
  const y50 = Y(0.5)
  let pts = series.map((s) => X(s.i).toFixed(1) + ',' + Y(s.pEdge).toFixed(1)).join(' ')
  if (n === 1) pts = `${X(1).toFixed(1)},${Y(series[0].pEdge).toFixed(1)} ${(X(1) + 30).toFixed(1)},${Y(series[0].pEdge).toFixed(1)}`
  const last = series[n - 1].pEdge
  const lastCol = last >= 0.5 ? '#3ec46d' : '#ff7a6b'
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;">`
  // gridlines/labels for 0 / 50 / 100%
  s += `<line x1="${PADL}" y1="${Y(0).toFixed(1)}" x2="${W - PADR}" y2="${Y(0).toFixed(1)}" stroke="#1c241c" stroke-width="1"/>`
  s += `<line x1="${PADL}" y1="${Y(1).toFixed(1)}" x2="${W - PADR}" y2="${Y(1).toFixed(1)}" stroke="#1c241c" stroke-width="1"/>`
  s += `<line x1="${PADL}" y1="${y50.toFixed(1)}" x2="${W - PADR}" y2="${y50.toFixed(1)}" stroke="#6b786b" stroke-width="0.8" stroke-dasharray="3 2"/>`
  s += `<text x="2" y="${(Y(1) + 3).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace">100</text>`
  s += `<text x="2" y="${(y50 + 3).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace">50</text>`
  s += `<text x="2" y="${(Y(0) + 3).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace">0</text>`
  s += `<polyline fill="none" stroke="${accent || '#f0a000'}" stroke-width="1.6" points="${pts}"/>`
  s += `<circle cx="${X(n).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="2.6" fill="${lastCol}"/>`
  s += `<text x="${PADL}" y="${(H - 4).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace">trade 1</text>`
  s += `<text x="${(W - PADR).toFixed(1)}" y="${(H - 4).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace" text-anchor="end">trade ${n}</text>`
  s += `</svg>`
  return s
}
// ===== EDGE vs N — the DECAY DETECTOR ========================================
// The creep bots BUY THE FAVORITE (entry px > 0.5) and hold to settle: a martingale
// that wins small (~+34c) ~80% of the time and loses big (~−70c). Its positive ROI is
// ENTIRELY the win-rate sitting ABOVE the price paid IN THIS SAMPLE. So the honest edge
// metric in CENTS is exactly (winRate_so_far − avgPrice_so_far)·100 after each trade i.
// If that holds ABOVE the fee wall as n grows → possible real favorite-longshot bias.
// If it DECAYS toward the fee (the gated version already fell +17.9c→+8c as n 361→407)
// → the "edge" is just a trending sample. This is THE graph the whole audit turns on.
// Returns [{i, edgeC, wr, px}] in cents, or null. Reuses _edgeTradeSeq (same pipeline).
function edgeVsNSeries(trades) {
  const seq = _edgeTradeSeq(trades)
  if (!seq || seq.n < 2) return null
  const out = []
  let kRun = 0, eSum = 0
  for (let i = 0; i < seq.n; i++) {
    kRun += seq.wins[i]
    eSum += seq.entries[i]
    const wr = kRun / (i + 1)          // win-rate so far (0..1)
    const px = eSum / (i + 1)          // avg price paid so far (0..1) = break-even win-rate
    out.push({ i: i + 1, edgeC: (wr - px) * 100, wr: wr, px: px })
  }
  return out
}
// SVG for the EDGE-vs-N trajectory. Zero line + a −2c "fee wall" line. Green fill/line
// above 0, red below. The whole point is to SEE whether the curve is holding or sliding
// toward the fee line as the sample accumulates. Guarded: null/empty/n<2 handled by caller.
function edgeVsNSVG(series, accent) {
  if (!series || series.length < 2) return ''
  const W = 340, H = 120, PADL = 30, PADR = 10, PADT = 10, PADB = 18
  const n = series.length
  const FEE = -2   // cents — the taker fee wall
  let mn = FEE, mx = 0
  series.forEach((s) => { if (isFinite(s.edgeC)) { if (s.edgeC < mn) mn = s.edgeC; if (s.edgeC > mx) mx = s.edgeC } })
  // pad the range a touch and ensure 0 and FEE are always visible
  mx = Math.max(mx, 1); mn = Math.min(mn, FEE - 1)
  const pad = (mx - mn) * 0.08 || 1; mx += pad; mn -= pad
  const X = (i) => PADL + (n <= 1 ? 0 : ((i - 1) / (n - 1)) * (W - PADL - PADR))
  const Y = (c) => PADT + (1 - (c - mn) / (mx - mn)) * (H - PADT - PADB)
  const y0 = Y(0), yFee = Y(FEE)
  const last = series[n - 1].edgeC
  const lastCol = last >= 0 ? '#3ec46d' : '#ff7a6b'
  // split the curve into an above-zero (green) and below-zero (red) polyline via a clipped area.
  const linePts = series.map((s) => X(s.i).toFixed(1) + ',' + Y(s.edgeC).toFixed(1)).join(' ')
  // area fill down to zero line, tinted by final sign (dominant regime)
  const areaPts = `${X(1).toFixed(1)},${y0.toFixed(1)} ` + linePts + ` ${X(n).toFixed(1)},${y0.toFixed(1)}`
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;background:#070b07;border:1px solid var(--border);">`
  // zero line (solid) + fee wall (dashed amber-red)
  s += `<polygon points="${areaPts}" fill="${lastCol}" fill-opacity="0.12"/>`
  s += `<line x1="${PADL}" y1="${y0.toFixed(1)}" x2="${W - PADR}" y2="${y0.toFixed(1)}" stroke="#6b786b" stroke-width="0.9"/>`
  s += `<line x1="${PADL}" y1="${yFee.toFixed(1)}" x2="${W - PADR}" y2="${yFee.toFixed(1)}" stroke="#ff9d3b" stroke-width="0.9" stroke-dasharray="3 2"/>`
  s += `<text x="2" y="${(y0 + 3).toFixed(1)}" fill="#9aa39a" font-size="8" font-family="monospace">0c</text>`
  s += `<text x="2" y="${(yFee + 3).toFixed(1)}" fill="#ff9d3b" font-size="8" font-family="monospace">fee</text>`
  s += `<polyline fill="none" stroke="${accent || '#5fe0a0'}" stroke-width="1.7" points="${linePts}"/>`
  s += `<circle cx="${X(n).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="2.8" fill="${lastCol}"/>`
  s += `<text x="${(X(n) - 3).toFixed(1)}" y="${(Y(last) - 5).toFixed(1)}" fill="${lastCol}" font-size="9" font-family="monospace" font-weight="700" text-anchor="end">${last >= 0 ? '+' : ''}${last.toFixed(1)}c</text>`
  s += `<text x="${PADL}" y="${(H - 4).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace">trade 1</text>`
  s += `<text x="${(W - PADR).toFixed(1)}" y="${(H - 4).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace" text-anchor="end">trade ${n}</text>`
  s += `</svg>`
  return s
}
let _botDetailLastAt = 0, _botDetailSig = ''
function renderBotDetail(state, name, force) {
  const bots = (_allBots && _allBots.length ? _allBots : null) || (state && state.bots) || (lastState && lastState.bots) || []
  const b = bots.find((x) => x.name === name)
  let dt = $('bot-detail')
  if (!b) { if (dt) dt.style.display = 'none'; selectedBotDetail = null; return }
  const trades = botAllTrades(state, b)
  // PERF GATE: skip rebuild when nothing changed (unless forced by open/click).
  if (!force) {
    const sig = name + ':' + (b.trades || 0) + ':' + (b.nw || 0) + ':' + (trades ? trades.length : 0)
    const now = Date.now()
    if (sig === _botDetailSig && now - _botDetailLastAt < 2000) return
    _botDetailLastAt = now; _botDetailSig = sig
  }
  if (!dt) {
    dt = document.createElement('div'); dt.id = 'bot-detail'
    dt.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(4,4,8,0.97);overflow:auto;padding:16px;'
    const close = () => { selectedBotDetail = null; dt.style.display = 'none' }
    dt.addEventListener('click', (e) => { if (e.target === dt) close() })
    dt.addEventListener('dblclick', (e) => { if (e.target === dt) close() })
    document.body.appendChild(dt)
  }
  dt.style.display = 'block'
  const st = _botStats(b, state.widx)
  const fam = FAMILY_DEFS.find((f) => f.key === _famOf(b)) || FAMILY_DEFS[FAMILY_DEFS.length - 1]
  const m2 = _money2
  const sc = _signC
  // STATS panel rows
  const statCell = (lbl, val, col) => `<div style="display:flex;flex-direction:column;gap:1px;min-width:88px;">
    <div style="font-size:9px;color:#6b786b;letter-spacing:.5px;">${lbl}</div>
    <div style="font-size:14px;font-weight:700;color:${col || 'var(--text)'};">${val}</div></div>`
  const statsHTML = `<div style="display:flex;flex-wrap:wrap;gap:14px 22px;">
    ${statCell('NET $', m2(st.net), sc(st.net))}
    ${statCell('ROI %', st.roiTxt, b.roiNA ? '#6b786b' : sc(b.roi || 0))}
    ${statCell('ROI / HR', st.roiHrTxt, b.roiNA ? '#6b786b' : sc(st.roiHr))}
    ${statCell('NET WORTH', b.nw != null ? '$' + b.nw.toFixed(4) : '—')}
    ${statCell('TRADES', b.trades || 0)}
    ${statCell('WIN %', st.wr == null ? '—' : st.wr + '%')}
    ${statCell('WINS', b.wins != null ? b.wins : '—')}
    ${statCell('MAX $OUT', b.maxdep != null && b.maxdep > 0 ? '$' + b.maxdep.toFixed(2) : '—')}
    ${statCell('STATUS', b.disabled ? '⊘ disabled' : 'active', b.disabled ? '#ff7a6b' : '#3ec46d')}
  </div>`
  // ALL-TIME trade history table (newest first). PnL shown in cents.
  let histHTML
  if (trades && trades.length) {
    const rev = trades.slice().reverse()   // newest first
    const rows = rev.map((q) => {
      const tm = q.t != null ? etTime(q.t * 1000) : '—'
      const win = (q.tk || '').replace('KXBTC15M-', '') || '—'
      const sideCol = q.side === 'yes' ? '#3ec46d' : '#ff7a6b'
      const pnlc = q.pnl != null ? Math.round(q.pnl * 100) : null
      // BOTH-SIDES leg: ⋈ pairs the YES/NO legs of a window; an unfilled leg (never filled) reads "no fill"
      // with IN "—" and 0 pnl — the one-leg-adverse case. pess (pessimistic-fill) pnl shown subtly in title.
      const pairG = q.bothleg ? '<span title="both-sides leg" style="color:#5aa0ff;">⋈</span> ' : ''
      const pnlTxt = q.unfilled ? '<span style="color:#6b786b;" title="this leg never filled">no fill</span>'
        : (pnlc == null ? (q.closed ? '—' : '<span style="color:#6b786b;">open</span>') : (pnlc >= 0 ? '+' : '') + pnlc + 'c')
      const pnlCol = (q.unfilled || pnlc == null) ? 'var(--text)' : (pnlc >= 0 ? '#3ec46d' : '#ff5555')
      const pessT = q.pnl_pess != null ? ` title="pess ${q.pnl_pess >= 0 ? '+' : ''}${Math.round(q.pnl_pess * 100)}c"` : ''
      const cpx = (v) => v == null ? '—' : Math.round(v * 100) + 'c'
      return `<tr>
        <td style="color:#9aa39a;">${tm}</td>
        <td style="text-align:center;color:${sideCol};font-weight:700;">${pairG}${(q.side || '?').toUpperCase()}</td>
        <td style="text-align:right;">${cpx(q.entry)}</td>
        <td style="text-align:right;">${cpx(q.exit)}</td>
        <td style="text-align:right;font-weight:700;color:${pnlCol};"${pessT}>${pnlTxt}</td>
        <td style="color:#6b786b;">${win}</td>
      </tr>`
    }).join('')
    histHTML = `<div style="font-size:10px;color:#6b786b;margin-bottom:4px;">${trades.length} trade${trades.length === 1 ? '' : 's'} all-time · newest first · prices in cents</div>
      <div style="max-height:calc(100vh - 230px);overflow:auto;border:1px solid var(--border);">
        <table class="sig" style="width:100%;">
          <thead><tr><th>TIME</th><th class="r" style="text-align:center;">SIDE</th><th class="r">ENTRY</th><th class="r">EXIT</th><th class="r">P&amp;L</th><th>WINDOW</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
  } else {
    histHTML = `<div style="font-size:12px;color:#9a8a8a;padding:16px;background:var(--panel);border:1px solid var(--border);">no per-trade history available for this bot (stats only — e.g. evolution Wave_v* variants log no per-trade rows).</div>`
  }
  // EDGE vs LUCK — Bayesian model comparison (additive, read-only, guarded).
  let edgeHTML
  const edgeRes = edgeFromTrades(trades)
  if (!edgeRes) {
    edgeHTML = `<div style="font-size:12px;color:#9a8a8a;padding:12px;background:var(--panel);border:1px solid var(--border);">insufficient data — need closed trades with entry prices to tell edge from luck.</div>`
  } else {
    const ePct = (edgeRes.pEdge * 100), lPct = (edgeRes.pLuck * 100)
    const series = edgeSeriesOverTime(trades)
    const spark = edgeSparklineSVG(series, fam.accent)
    const edgeCol = ePct >= 50 ? '#3ec46d' : '#ff7a6b'
    // GRAPH 1 — EDGE vs N (the decay detector). Cumulative (winRate − avgPrice) in cents.
    const edgeN = edgeVsNSeries(trades)
    const edgeNsvg = edgeVsNSVG(edgeN, fam.accent)
    const edgeNlast = (edgeN && edgeN.length) ? edgeN[edgeN.length - 1].edgeC : null
    // simple decay read: compare the last quintile's mean edge vs the first — is it sliding to the fee?
    let decayNote = ''
    if (edgeN && edgeN.length >= 10) {
      const q = Math.max(2, Math.floor(edgeN.length / 5))
      const head = edgeN.slice(0, q).reduce((s, r) => s + r.edgeC, 0) / q
      const tail = edgeN.slice(-q).reduce((s, r) => s + r.edgeC, 0) / q
      const slid = tail < head
      decayNote = `<span style="color:${slid ? '#ff9d3b' : '#6b786b'};">first-fifth ${head >= 0 ? '+' : ''}${head.toFixed(1)}c → last-fifth ${tail >= 0 ? '+' : ''}${tail.toFixed(1)}c${slid ? ' · DECAYING toward fee' : ' · holding'}</span>`
    }
    const edgeNcol = edgeNlast == null ? '#6b786b' : (edgeNlast >= 0 ? '#3ec46d' : '#ff7a6b')
    edgeHTML = `
      <div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:18px 28px;">
        <div style="display:flex;flex-direction:column;gap:2px;">
          <div style="font-size:20px;font-weight:800;color:${edgeCol};">Edge: ${ePct.toFixed(1)}% · Luck: ${lPct.toFixed(1)}%</div>
          <div style="font-size:10px;color:#9aa39a;max-width:430px;line-height:1.5;">Bayesian, 50/50 prior; near 50% until ~30+ trades — small samples can't tell edge from luck.</div>
          <div style="font-size:9px;color:#6b786b;margin-top:3px;">k=${edgeRes.k}/${edgeRes.n} wins · avg entry (fair p) ${(edgeRes.avgEntry * 100).toFixed(1)}c · Bayes factor ${edgeRes.bf < 0.01 ? edgeRes.bf.toExponential(1) : edgeRes.bf.toFixed(2)} (BF&gt;1 favors edge)</div>
        </div>
        <div style="min-width:300px;">
          <div style="font-size:9px;color:#6b786b;margin-bottom:2px;">P(edge)% over trades — 50% line dashed</div>
          ${spark}
        </div>
      </div>
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px;">
          <span style="font-size:11px;font-weight:700;color:#5fe0a0;">EDGE vs N — the decay detector</span>
          <span style="font-size:10px;">edge now <b style="color:${edgeNcol};">${edgeNlast == null ? '—' : (edgeNlast >= 0 ? '+' : '') + edgeNlast.toFixed(1) + 'c'}</b></span>
        </div>
        ${edgeNsvg || '<div style="font-size:11px;color:#9a8a8a;padding:8px;">need ≥2 closed trades with entry prices.</div>'}
        <div style="font-size:9px;color:#9aa39a;max-width:520px;line-height:1.5;margin-top:4px;">
          cumulative (win-rate − avg price paid) in cents after each trade — the whole ROI of a hold-to-settle favorite bet IS this gap.
          Holding <b style="color:#3ec46d;">above 0/the fee</b> = a possible real favorite-longshot bias; <b style="color:#ff9d3b;">decaying toward the fee line</b> = trending-sample luck (recall the gated bot slid +17.9c→+8c as n grew 361→407). ${decayNote}
        </div>
      </div>`
  }
  dt.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <div style="font-size:16px;font-weight:700;color:${fam.accent};">● ${b.name} <span style="font-size:12px;color:#6b786b;font-weight:400;">[${b.strat}] · ${fam.label}${b.params ? ' · ' + b.params : ''}</span></div>
      <span id="bot-detail-close" style="cursor:pointer;color:#f0a000;border:1px solid #f0a000;padding:3px 12px;font-weight:700;">✕ close</span>
    </div>
    <div style="font-size:10px;color:#6b786b;margin-bottom:10px;">click background or press Esc to dismiss</div>
    <div class="panel" style="border-top-color:${fam.accent};margin-bottom:12px;">
      <div class="phead"><span style="color:${fam.accent};">STATS</span></div>
      ${statsHTML}
    </div>
    <div class="panel" style="border-top-color:${fam.accent};margin-bottom:12px;">
      <div class="phead"><span style="color:${fam.accent};">EDGE vs LUCK</span> <span style="font-size:9px;color:#6b786b;font-weight:400;">· Bayesian model comparison (H_edge vs H_luck), not a p-value</span></div>
      ${edgeHTML}
    </div>
    <div class="panel" style="border-top-color:${fam.accent};">
      <div class="phead"><span style="color:${fam.accent};">ALL-TIME TRADE HISTORY</span></div>
      ${histHTML}
    </div>`
  const cl = $('bot-detail-close'); if (cl) cl.addEventListener('click', () => { selectedBotDetail = null; dt.style.display = 'none' })
}

function drawROI(state, bots) {
  const svg = $('eqchart')
  const W = 900, H = 300, PADL = 16, PADR = 16, PADT = 12, PADB = 16
  const maxW = Math.max(1, state.widx || 0)
  let mn = 0, mx = 0
  bots.forEach((b) => (b.series || []).forEach(([wi, r]) => { if (r < mn) mn = r; if (r > mx) mx = r }))
  if (mx - mn < 1) { mx += 0.5; mn -= 0.5 }
  const X = (wi) => PADL + (maxW <= 0 ? 0 : (wi / maxW) * (W - PADL - PADR))
  const Y = (r) => PADT + (1 - (r - mn) / (mx - mn)) * (H - PADT - PADB)
  const night = document.documentElement.getAttribute('data-theme') === 'night'
  const POS = night ? '92,130,102' : '62,196,109', NEG = night ? '143,92,92' : '255,85,85', DIMC = night ? '74,74,74' : '107,120,107', LEAD = night ? '170,170,170' : '255,255,255'
  const leaderName = bots.length ? bots.reduce((a, b) => (b.roi > a.roi ? b : a), bots[0]).name : null
  let s = `<line x1="${PADL}" y1="${Y(0).toFixed(1)}" x2="${W - PADR}" y2="${Y(0).toFixed(1)}" stroke="#1c241c" stroke-width="1" vector-effect="non-scaling-stroke"/>`
  // draw losers/dim first, winners + leader last (on top)
  const ordered = bots.slice().sort((a, b) => Math.abs(a.roi) - Math.abs(b.roi))
  let selPts = null
  ordered.forEach((b) => {
    const ser = b.series || []
    if (ser.length < 1) return
    const isLeader = b.name === leaderName
    const isSel = selectedBot && b.name === selectedBot
    let rgb = b.roi > 0.01 ? POS : b.roi < -0.01 ? NEG : DIMC
    let op = Math.min(1, 0.22 + Math.abs(b.roi) / 8)
    if (isLeader) { rgb = LEAD; op = 1 }
    if (selectedBot && !isSel) op *= 0.22  // dim everything else when a bot is selected
    let pts = ser.map(([wi, r]) => X(wi).toFixed(1) + ',' + Y(r).toFixed(1)).join(' ')
    // anchor each line at its birth point so single-point series still show
    if (ser.length === 1) pts = `${X(ser[0][0]).toFixed(1)},${Y(ser[0][1]).toFixed(1)} ${X(ser[0][0] + 0.4).toFixed(1)},${Y(ser[0][1]).toFixed(1)}`
    if (isSel) { selPts = pts; return }  // draw the selected line last, on top
    s += `<polyline fill="none" stroke="rgba(${rgb},${op.toFixed(2)})" stroke-width="${isLeader ? 2.4 : 1.1}" vector-effect="non-scaling-stroke" points="${pts}"/>`
  })
  if (selPts) {
    const hl = night ? '255,210,90' : '255,255,255'
    s += `<polyline fill="none" stroke="rgb(${hl})" stroke-width="3" vector-effect="non-scaling-stroke" points="${selPts}"/>`
  }
  s += `<text x="${PADL}" y="${PADT + 8}" fill="#6b786b" font-size="9" font-family="monospace">${mx >= 0 ? '+' : ''}${mx.toFixed(1)}%</text>`
  s += `<text x="${PADL}" y="${H - PADB + 11}" fill="#6b786b" font-size="9" font-family="monospace">${mn.toFixed(1)}%</text>`
  s += `<text x="${W - PADR}" y="${H - PADB + 11}" fill="#6b786b" font-size="9" font-family="monospace" text-anchor="end">w${maxW}</text>`
  if (hoverE != null) {  // hover crosshair on the ROI chart
    const wi = Math.max(0, Math.round((hoverE - PADL) / (W - PADL - PADR) * maxW))
    const xx = X(wi)
    s += `<line x1="${xx.toFixed(1)}" y1="${PADT}" x2="${xx.toFixed(1)}" y2="${H - PADB}" stroke="#6b786b" stroke-width="0.8" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`
    s += `<text x="${xx.toFixed(1)}" y="${(H - PADB + 11).toFixed(1)}" fill="#6b786b" font-size="8" font-family="monospace" text-anchor="middle">w${wi}</text>`
    const sb = selectedBot ? bots.find((b) => b.name === selectedBot) : bots[0]
    if (sb && sb.series && sb.series.length) {
      let v = null; for (const [w, r] of sb.series) if (w <= wi) v = r
      if (v != null) {
        const yy = Y(v), col = v > 0 ? '#3ec46d' : v < 0 ? '#ff5555' : '#6b786b'
        s += `<circle cx="${xx.toFixed(1)}" cy="${yy.toFixed(1)}" r="3" fill="${col}"/><text x="${(xx + 5).toFixed(1)}" y="${(yy - 3).toFixed(1)}" fill="${col}" font-size="9" font-weight="bold" font-family="monospace">${sb.name.slice(0, 20)} ${v > 0 ? '+' : ''}${v.toFixed(2)}%</text>`
      }
    }
  }
  svg.innerHTML = s
  $('eq-sub').textContent = `${maxW} windows · ${bots.length} lines` + (selectedBot ? ` · ◆ ${selectedBot}` : ' · click a bot to highlight')
}

// BOT PINNING: one delegated pin-toggle handler for EVERY surface (leaderboard, window-ROI list,
// family/top-3 cards, NN cards). Runs in the CAPTURE phase so it fires BEFORE the row/card bubbling
// handlers below, and stopPropagation() prevents the click from opening the detail overlay / selecting
// the bot. Any element carrying .pin-toggle[data-pin] anywhere in the doc is handled here.
document.addEventListener('click', (e) => {
  const p = e.target.closest && e.target.closest('.pin-toggle[data-pin]')
  if (!p) return
  e.stopPropagation(); e.preventDefault()
  togglePin(p.getAttribute('data-pin'))
}, true)
// click a leaderboard row to highlight that bot's ROI line (click again to clear)
$('lb').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-bot]')
  if (!row) return
  const name = row.getAttribute('data-bot')
  selectedBot = (selectedBot === name) ? null : name
  if (lastState) render(lastState)
})
// click a family/top-3 CARD row → highlight that bot's ROI line AND open its detail overlay
// (stats + all-time trade history). The eqchart-highlight is kept as a secondary effect.
{ const _bc = $('bot-cards')
  if (_bc) _bc.addEventListener('click', (e) => {
    const row = e.target.closest('[data-bot]')
    if (!row) return
    const name = row.getAttribute('data-bot')
    selectedBot = name            // highlight the line (secondary effect)
    selectedBotDetail = name
    if (lastState) { render(lastState); renderBotDetail(lastState, name, true) }
  }) }
// Esc dismisses the bot-detail overlay (matches the dark-terminal overlay convention)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedBotDetail) {
    selectedBotDetail = null
    const dt = $('bot-detail'); if (dt) dt.style.display = 'none'
  }
})

// click a trade-table row to highlight that trade's marker on the chart (and vice-versa)
const tradeClick = (e) => {
  const row = e.target.closest('tr[data-tid]')
  if (!row) return
  const tid = row.getAttribute('data-tid')   // keep RAW string — injected W/WN/E/N rows have string ids ('w-…','n-yes'); Number() would NaN them and the click would be a dead no-op
  selectedTrade = (String(selectedTrade) === String(tid)) ? null : tid
  if (lastState) { render(lastState); drawVtrace(lastState, true) }
}
$('ct-open-tbody').addEventListener('click', tradeClick)
$('ct-settled-tbody').addEventListener('click', tradeClick)

// high-frequency T-minus countdown + progress ring (local ms clock, re-anchored on each state push)
function tickClock() {
  if (closeEpoch != null) {
    const rem = Math.max(0, closeEpoch - Date.now())
    const mm = Math.floor(rem / 60000), ss = Math.floor((rem % 60000) / 1000), cs = Math.floor((rem % 1000) / 10)
    const el = document.getElementById('m-cd')
    if (el) el.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
    const ring = document.getElementById('cd-ring')
    if (ring) { const fill = Math.min(1, Math.max(0, 1 - rem / 900000)); ring.setAttribute('stroke-dashoffset', (81.7 * (1 - fill)).toFixed(2)) }
  }
  requestAnimationFrame(tickClock)
}
requestAnimationFrame(tickClock)

// hover crosshairs (vertical line + labeled values at that time) on both charts.
// PERF(FREEZE): a fast mouse fires `mousemove` well above 100Hz, and each redraw (drawVtrace force=true)
// synchronously rebuilds the entire chart SVG — the heaviest function in the file. rAF-COALESCE: a burst of
// mousemoves only updates the hover coords + schedules ONE animation-frame redraw (≤ ~60Hz cap), instead of
// one full SVG rebuild per event. The `_hoverRaf*Pending` flags are cleared inside the rAF callback so a new
// frame can be scheduled. No visual change — the same draw runs, just at most once per frame.
let _hoverRafVPending = false, _hoverRafEPending = false
function _hoverRedrawV() { _hoverRafVPending = false; if (lastState) drawVtrace(lastState, true) }
function _hoverRedrawE() { _hoverRafEPending = false; if (lastState) (wOnly ? drawWNeural(lastState) : drawROI(lastState, lastState.bots || [])) }
function _scheduleHoverV() { if (!_hoverRafVPending) { _hoverRafVPending = true; requestAnimationFrame(_hoverRedrawV) } }
function _scheduleHoverE() { if (!_hoverRafEPending) { _hoverRafEPending = true; requestAnimationFrame(_hoverRedrawE) } }
;[['vtrace', 'V'], ['eqchart', 'E']].forEach(([id, which]) => {
  const el = document.getElementById(id)
  if (!el) return
  el.addEventListener('mousemove', (e) => {
    if (which === 'V' && vDrag) return   // panning the chart -> suppress hover crosshair
    const x = (e.offsetX / el.clientWidth) * 900
    if (which === 'V') { hoverV = x; hoverVy = (e.offsetY / el.clientHeight) * 340; _scheduleHoverV() } else { hoverE = x; _scheduleHoverE() }
  })
  el.addEventListener('mouseleave', () => {
    if (which === 'V') { hoverV = null; hoverVy = null; _scheduleHoverV() } else { hoverE = null; _scheduleHoverE() }
  })
})

// click a trade triangle on the chart to highlight it (click elsewhere to clear)
{ const vt = document.getElementById('vtrace')
  if (vt) vt.addEventListener('click', (e) => {
    const lbl = e.target && e.target.getAttribute ? e.target.getAttribute('data-lbl') : null
    if (lbl) { const _u = ((lastState && lastState.snap_labels) || []).find((x) => x.labeled_at === Number(lbl)); if (_u) undoStack.push(_u); window.cta.delLabel(Number(lbl)); if (lastState) drawVtrace(lastState, true); return }   // click × -> delete (Ctrl+Z to undo)
    const tid = e.target && e.target.getAttribute ? e.target.getAttribute('data-tid') : null
    selectedTrade = (tid != null && tid !== '') ? tid : null   // keep RAW string — String()-based comparisons keep chart & table selection in sync for both numeric trades_log ids and string-injected rows
    if (lastState) { drawVtrace(lastState, true); render(lastState) }
  })
}

// ===== chart zoom / pan / fullscreen =====
var vLo = 0, vHi = 900, vDrag = null, sigOnly = false, hoverVy = null, labelKind = null, boxDrag = null, yesPos = null, noPos = null, feedBot = true, vYLo = 0, vYHi = 1, undoStack = [], selectedLabel = null, histWin = null, viewWinOpen = 0, viewPts = null, histIdx = -1, histData = null
var ACC = (function () { try { return JSON.parse(localStorage.getItem('cta-acc')) || {} } catch (e) { return {} } })()
;['g', 'r', 'mg', 'mr', 'maxg', 'maxr', 'lastT', 'gb', 'rb', 'mgb', 'mrb'].forEach((k) => { if (ACC[k] == null) ACC[k] = 0 })
// PERF(FREEZE): localStorage.setItem is a SYNCHRONOUS disk-backed write; doing it on every drawVtrace (~4x/sec)
// added avoidable main-thread stalls. Coalesce to at most one write every few seconds, and force-flush on
// page hide/unload so no accuracy data is lost. In-memory ACC updates remain immediate (drawVtrace mutates ACC).
let _accTimer = null
function _writeACC() { _accTimer = null; try { localStorage.setItem('cta-acc', JSON.stringify(ACC)) } catch (e) {} }
function _persistACC() { if (_accTimer == null) _accTimer = setTimeout(_writeACC, 3000) }
window.addEventListener('beforeunload', _writeACC)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') _writeACC() })
{ const vt = document.getElementById('vtrace')
  if (vt) {
    const PADL = 30, PADR = 10, W = 900, H = 340, PADT = 8, PADB = 16
    const elAt = (offX) => { const vbx = (offX / vt.clientWidth) * W; return vLo + (vbx - PADL) / (W - PADL - PADR) * (vHi - vLo) }
    const pAt = (offY) => { const vby = (offY / vt.clientHeight) * H, f = 1 - (vby - PADT) / (H - PADT - PADB); return vYLo + f * (vYHi - vYLo) }
    vt.addEventListener('wheel', (e) => {
      e.preventDefault()
      const z = e.deltaY < 0 ? 0.9 : 1 / 0.9   // gentler than 0.8/1.25, zooms BOTH axes about the cursor
      const cx = elAt(e.offsetX); let lo = cx - (cx - vLo) * z, hi = cx + (vHi - cx) * z
      lo = Math.max(0, lo); hi = Math.min(900, hi)
      const cy = pAt(e.offsetY); let ylo = cy - (cy - vYLo) * z, yhi = cy + (vYHi - cy) * z
      ylo = Math.max(0, ylo); yhi = Math.min(1, yhi)
      if (hi - lo >= 3) { vLo = lo; vHi = hi }
      if (yhi - ylo >= 0.02) { vYLo = ylo; vYHi = yhi }
      if (lastState) drawVtrace(lastState, true)
    }, { passive: false })
    vt.addEventListener('mousedown', (e) => {
      if (labelKind) { boxDrag = { el0: elAt(e.offsetX), el1: elAt(e.offsetX) }; return }   // LABEL: start a box (X=buy / C=avoid)
      vDrag = { x: e.offsetX, y: e.offsetY, lo: vLo, hi: vHi, ylo: vYLo, yhi: vYHi }
    })
    window.addEventListener('mouseup', () => {
      if (boxDrag) {   // LABEL: finalize -> clicked edges (REALIZABLE) + extract OPTIMAL. Uses the VIEWED window (live or scrubbed)
        if (viewPts && viewPts.length) {
          const tr = viewPts, winOpen = viewWinOpen
          const a = Math.min(boxDrag.el0, boxDrag.el1), b = Math.max(boxDrag.el0, boxDrag.el1)
          const box = tr.filter((p) => { const el = p[0] - winOpen; return el >= a && el <= b })
          if (b - a >= 0.5 && box.length >= 2) {
            const eb = box[0], es = box[box.length - 1]
            // pick the MORE PROFITABLE side: best YES move (buy low i -> sell higher j) vs best NO move (buy high i -> sell lower j), whichever paid more
            let bY = -1, yi = 0, yj = 0, bN = -1, ni = 0, nj = 0
            for (let i = 0; i < box.length; i++) for (let j = i + 1; j < box.length; j++) {
              if (box[j][1] - box[i][1] > bY) { bY = box[j][1] - box[i][1]; yi = i; yj = j }
              if (box[i][1] - box[j][1] > bN) { bN = box[i][1] - box[j][1]; ni = i; nj = j }
            }
            const side = bY >= bN ? 'yes' : 'no', ob = side === 'yes' ? yi : ni, os = side === 'yes' ? yj : nj
            window.cta.saveLabel({ kind: labelKind, buy_t: +eb[0].toFixed(1), sell_t: +es[0].toFixed(1), buy_mid: eb[1], sell_mid: es[1], side,
              opt_buy_t: +box[ob][0].toFixed(1), opt_buy_mid: box[ob][1], opt_sell_t: +box[os][0].toFixed(1), opt_sell_mid: box[os][1], opt_edge: +Math.max(bY, bN).toFixed(3), labeled_at: Date.now() })
          }
        }
        boxDrag = null; if (lastState) drawVtrace(lastState, true); return
      }
      vDrag = null
    })
    vt.addEventListener('mousemove', (e) => {
      if (boxDrag) { boxDrag.el1 = elAt(e.offsetX); if (lastState) drawVtrace(lastState, true); return }   // LABEL: extend the box
      if (!vDrag) return
      const dEl = ((e.offsetX - vDrag.x) / vt.clientWidth) * (vDrag.hi - vDrag.lo)
      let lo = vDrag.lo - dEl, hi = vDrag.hi - dEl
      if (lo < 0) { hi -= lo; lo = 0 }
      if (hi > 900) { lo -= (hi - 900); hi = 900 }
      vLo = Math.max(0, lo); vHi = Math.min(900, hi)
      const dP = ((e.offsetY - vDrag.y) / vt.clientHeight) * (vDrag.yhi - vDrag.ylo)   // pan Y too
      let ylo = vDrag.ylo + dP, yhi = vDrag.yhi + dP
      if (ylo < 0) { yhi -= ylo; ylo = 0 }
      if (yhi > 1) { ylo -= (yhi - 1); yhi = 1 }
      vYLo = Math.max(0, ylo); vYHi = Math.min(1, yhi)
      if (lastState) drawVtrace(lastState, true)
    })
    function updateLabelUI() {
      const b = document.getElementById('chart-label')
      if (b) {
        const pos = yesPos && noPos ? '● YES+NO held — ↑↓ flatten' : yesPos ? '● YES held — ↑ to flatten' : noPos ? '● NO held — ↓ to flatten' : null
        b.textContent = pos || (labelKind === 'buy' ? '📦 BUY-box' : labelKind === 'avoid' ? '🚫 NO-TRADE' : labelKind === 'momentum' ? '⚡ MOMENTUM-box' : '📦 label')
        b.style.color = (yesPos || noPos) ? '#3ec46d' : labelKind === 'buy' ? '#ffd600' : labelKind === 'avoid' ? '#ff5555' : labelKind === 'momentum' ? '#aaff00' : ''
      }
      vt.style.cursor = labelKind ? 'crosshair' : ''
      vt.style.outline = labelKind === 'buy' ? '2px solid #ffd60099' : labelKind === 'avoid' ? '2px solid #ff555599' : labelKind === 'momentum' ? '2px solid #aaff00cc' : (yesPos || noPos) ? '2px solid #3ec46d99' : ''   // subtle frame = active mode
      vt.style.outlineOffset = '-2px'
    }
    const lblBtn = document.getElementById('chart-label')
    if (lblBtn) lblBtn.addEventListener('click', () => { labelKind = labelKind === 'buy' ? null : 'buy'; updateLabelUI() })
    const fbChk = document.getElementById('feed-bot')
    if (fbChk) { feedBot = fbChk.checked; fbChk.addEventListener('change', () => { feedBot = fbChk.checked }) }
    const infoBtn = document.getElementById('chart-info')
    if (infoBtn) infoBtn.addEventListener('click', () => { const lg = document.getElementById('chart-legend'); if (lg) lg.style.display = lg.style.display === 'none' ? 'block' : 'none' })
    // ===== history scrubber: page through past windows and label them =====
    function updateHistLabel() {
      const e = document.getElementById('hist-label'); if (!e) return
      const n = (histData && histData.windows && histData.windows.length) || 0
      if (histWin) { e.textContent = '⏪ ' + etTime(histWin.t0 * 1000) + ' (' + (histIdx + 1) + '/' + n + ') ' + ((histWin.pts && histWin.pts.length) || 0) + 'pts'; e.style.color = '#aaff00' }
      else { e.textContent = '● LIVE · ' + n + ' past'; e.style.color = n ? '#3ec46d' : '#ff5555' }
    }
    // SCRUB overlays: fetch the selected window's stream series ONCE (cached on the window object), then redraw +
    // refresh the panel so the same overlays/Δ-strike the live chart shows also appear on a scrubbed past window.
    // No 1Hz churn — this fires only on a scrub to a not-yet-fetched window.
    function fetchHistStreams(hw) {
      if (!hw || hw.streamData || !(window.cta && window.cta.getWindowStreams)) return
      const t0 = hw.t0
      window.cta.getWindowStreams(t0).then((d) => {
        hw.streamData = (d && Array.isArray(d.streams)) ? d : { t0, streams: [] }
        if (histWin === hw) { try { if (lastState) drawVtrace(lastState, true) } catch (e) {} ; try { renderStreamPanel() } catch (e) {} }
      }).catch(() => {})
    }
    function setHist(dir) {
      const hs = (histData && histData.windows) || []
      if (dir === 0 || !hs.length) { histWin = null; histIdx = -1 }
      else {
        if (histIdx < 0) histIdx = hs.length - 1; else histIdx += dir
        if (histIdx >= hs.length) { histWin = null; histIdx = -1 }   // ⏩ past the newest window = return to LIVE
        else { histIdx = Math.max(0, histIdx); histWin = hs[histIdx] }
      }
      vLo = 0; vHi = 900; vYLo = 0; vYHi = 1   // reset zoom so the whole window is in view
      if (histWin) fetchHistStreams(histWin)
      try { if (lastState) drawVtrace(lastState, true) } catch (err) { const _e = document.getElementById('hist-label'); if (_e) { _e.textContent = 'ERR ' + err.message; _e.style.color = '#ff5555' }; console.error(err); return }
      updateHistLabel()
      try { renderStreamPanel() } catch (e) {}
    }
    const go = (dir) => {
      if (histData || !(window.cta && window.cta.getHistory)) { setHist(dir); return }
      window.cta.getHistory().then((s) => { try { if (s) histData = JSON.parse(s) } catch (e) {} ; setHist(dir) })
    }
    { const hp = document.getElementById('hist-prev'), hn = document.getElementById('hist-next'), hl = document.getElementById('hist-live')
      if (hp) hp.addEventListener('click', () => go(-1))
      if (hn) hn.addEventListener('click', () => go(1))
      if (hl) hl.addEventListener('click', () => go(0)) }
    if (window.cta && window.cta.onHistory) window.cta.onHistory((d) => { try { histData = (typeof d === 'string' ? JSON.parse(d) : d); updateHistLabel() } catch (e) {} })
    if (window.cta && window.cta.getHistory) window.cta.getHistory().then((s) => { try { if (s && !histData) { histData = JSON.parse(s); updateHistLabel() } } catch (e) {} })
    setInterval(updateHistLabel, 1500)
    window.addEventListener('keydown', (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return
      const vm = document.getElementById('view-main'); if (!vm || vm.style.display === 'none') return   // PERF/SAFETY: only fire main-chart label shortcuts when the EVOLUTION tab is actually visible — mirrors the backtest handler's guard; stops arrow/x/c/m keystrokes from mutating label state (and recording phantom [N] trades) while PAPER-vs-LIVE / TRAINING / BACKTEST is open
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); const u = undoStack.pop(); if (u) window.cta.saveLabel(u); return }   // Ctrl+Z = undo last delete
      if (k === 'x') { labelKind = labelKind === 'buy' ? null : 'buy'; updateLabelUI() }
      else if (k === 'c') { labelKind = labelKind === 'avoid' ? null : 'avoid'; updateLabelUI() }
      else if (k === 'm') { labelKind = labelKind === 'momentum' ? null : 'momentum'; updateLabelUI() }   // neon-green: good momentum to ride
      else if (e.key === 'Delete' || e.key === 'Backspace') {   // delete the last box/trade in this window (boxes + trades)
        e.preventDefault()
        const ls = (lastState && lastState.snap_labels) || [], cw = Math.floor(viewWinOpen / 900)
        const mine = ls.filter((L) => L.buy_t != null && Math.floor(L.buy_t / 900) === cw), last = mine[mine.length - 1]
        if (last) { undoStack.push(last); window.cta.delLabel(last.labeled_at) }
      }
      else if (e.key === 'ArrowUp') {   // YES leg: open (buy YES at ask) / flatten (sell all YES at bid) -> records to [N]
        e.preventDefault()
        const w = lastState && lastState.window; if (!w || w.yb == null || w.nb == null || !lastState.trace || !lastState.trace.length) return
        const t = lastState.trace[lastState.trace.length - 1][0]
        if (!yesPos) { yesPos = { t, px: +(1 - w.nb).toFixed(2) } }   // YES ask = 1 - NO bid
        else { window.cta.saveLabel({ kind: 'realtime', side: 'yes', buy_t: +yesPos.t.toFixed(1), buy_px: yesPos.px, sell_t: +t.toFixed(1), sell_px: w.yb, train: feedBot, labeled_at: Date.now() }); yesPos = null }
        updateLabelUI()
      }
      else if (e.key === 'ArrowDown') {   // NO leg: open (buy NO at ask) / flatten (sell all NO at bid) -> records to [N]
        e.preventDefault()
        const w = lastState && lastState.window; if (!w || w.yb == null || w.nb == null || !lastState.trace || !lastState.trace.length) return
        const t = lastState.trace[lastState.trace.length - 1][0]
        if (!noPos) { noPos = { t, px: +(1 - w.yb).toFixed(2) } }   // NO ask = 1 - YES bid
        else { window.cta.saveLabel({ kind: 'realtime', side: 'no', buy_t: +noPos.t.toFixed(1), buy_px: noPos.px, sell_t: +t.toFixed(1), sell_px: w.nb, train: feedBot, labeled_at: Date.now() }); noPos = null }
        updateLabelUI()
      }
    })
    vt.addEventListener('dblclick', () => { vLo = 0; vHi = 900; vYLo = 0; vYHi = 1; if (lastState) drawVtrace(lastState, true) })
  }
  const fb = document.getElementById('chart-fs')
  const getV = () => document.getElementById('vtrace')
  function setFS(on) {
    const v = getV(); if (!v) return
    v.classList.toggle('fs', on)
    if (fb) fb.textContent = on ? '⛶ exit fullscreen' : '⛶ fullscreen'
    let x = document.getElementById('fs-exit')
    if (on && !x) {
      x = document.createElement('div'); x.id = 'fs-exit'; x.textContent = '✕ exit fullscreen (Esc)'
      x.style.cssText = 'position:fixed;top:10px;right:14px;z-index:10000;cursor:pointer;background:rgba(0,0,0,0.78);color:#f0a000;border:1px solid #f0a000;padding:5px 12px;font-family:monospace;font-size:13px;font-weight:700;'
      x.addEventListener('click', () => setFS(false))
      document.body.appendChild(x)
    } else if (!on && x) { x.remove() }
    if (lastState) drawVtrace(lastState, true)
  }
  if (fb) fb.addEventListener('click', () => setFS(!getV().classList.contains('fs')))
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setFS(false) })
  const sb = document.getElementById('chart-sig')
  if (sb) sb.addEventListener('click', () => {
    sigOnly = !sigOnly
    sb.textContent = sigOnly ? '▦ big moves only ✓' : '▦ big moves only'
    sb.style.color = sigOnly ? 'var(--amber)' : 'var(--cyan)'
    if (lastState) drawVtrace(lastState, true)
  })
  const rb = document.getElementById('chart-reset')
  if (rb) rb.addEventListener('click', () => {
    ;['g', 'r', 'mg', 'mr', 'maxg', 'maxr', 'lastT', 'gb', 'rb', 'mgb', 'mrb'].forEach((k) => ACC[k] = 0)
    if (_accTimer != null) { clearTimeout(_accTimer); _accTimer = null }   // cancel any pending debounced write so it can't re-persist stale data after the reset
    try { localStorage.removeItem('cta-acc') } catch (e) {}
    if (lastState) drawVtrace(lastState, true)
  })
}

// ===== PERF: coalesce/throttle state pushes to a single rAF-paced render (FREEZE FIX) =====
// The main process pushes state ~4-8x/sec; each render() rebuilds large SVG/innerHTML synchronously.
// Nothing in the source feed advances faster than ~0.25s, so re-rendering on every push is wasted work
// that pins the main thread and freezes interaction. We store only the LATEST state and schedule at most
// one redraw per RENDER_MIN_MS (coalescing bursts), via requestAnimationFrame so it never fights layout.
let _pendingState = null, _renderScheduled = false, _lastRenderAt = 0
const RENDER_MIN_MS = 230   // ~4x/sec ceiling — matches the remote `sleep 0.25` source cadence
function _flushRender() {
  _renderScheduled = false
  const s = _pendingState; _pendingState = null
  if (!s) return
  _lastRenderAt = Date.now()
  try { render(s) } catch (e) { /* never let one bad frame wedge the scheduler */ }
}
let _scheduledAt = 0   // FREEZE FIX: when the queued frame was armed — used to detect a wedged scheduler
function scheduleRender(state) {
  _pendingState = state                         // always keep the freshest state
  // FREEZE FIX (self-healing): requestAnimationFrame is suspended while the window is minimized/backgrounded,
  // so a frame armed just before the window was hidden may NEVER fire — leaving _renderScheduled stuck true and
  // silently dropping every later push (updates appear "frozen" until a manual interaction). If the armed frame
  // is overdue by a wide margin, force a synchronous flush now instead of waiting on the dead rAF, then re-arm.
  if (_renderScheduled) {
    if (Date.now() - _scheduledAt > 2000) { try { _flushRender() } catch (e) { _renderScheduled = false } }   // overdue → recover
    else return                                 // a redraw is already queued — it'll pick up the latest
  }
  const since = Date.now() - _lastRenderAt
  _renderScheduled = true
  _scheduledAt = Date.now()
  const delay = since >= RENDER_MIN_MS ? 0 : (RENDER_MIN_MS - since)
  // rAF coalesces with the compositor; the setTimeout enforces the min interval (and covers backgrounded tabs).
  // The setTimeout fires even when backgrounded, so a hidden window still flushes (rAF inside is best-effort).
  setTimeout(() => { try { requestAnimationFrame(_flushRender) } catch (e) { _flushRender() } }, delay)
}
window.cta.onState(scheduleRender)

// ===== DATA STREAMS: receive the per-window overlay payload, refresh the panel + redraw the chart =====
if (window.cta && window.cta.onStreams) window.cta.onStreams((d) => {
  streamData = d
  // While SCRUBBING, overlays come from histWin.streamData (fetched once per scrub) — the live 1Hz push must not
  // trigger a redraw/panel-refresh (no churn on the history path). streamData is still kept fresh for the return to LIVE.
  if (histWin) return
  try { renderStreamPanel() } catch (e) {}
  // only a live-value refresh + overlay redraw; force so it bypasses the drawVtrace signature gate
  try { if (lastState) drawVtrace(lastState, true) } catch (e) {}
})
// Build the floating streams panel (created once, appended to body) + wire the toolbar toggle button.
;(function () {
  const btn = document.getElementById('chart-streams')
  let panel = document.getElementById('streams-panel')
  if (!panel) {
    panel = document.createElement('div'); panel.id = 'streams-panel'
    panel.style.cssText = 'display:none;position:fixed;top:64px;right:16px;width:320px;max-height:74vh;overflow:auto;background:#0a0f0a;border:1px solid #2a3a2a;box-shadow:0 6px 24px rgba(0,0,0,0.65);z-index:9998;padding:8px 10px;font-family:monospace;'
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">'
      + '<b style="color:#f0a000;font-size:11px;">DATA STREAMS · overlay on chart</b>'
      + '<span id="streams-close" style="cursor:pointer;color:#ff5555;font-weight:700;">✕</span></div>'
      + '<div style="color:#6b786b;font-size:9px;margin-bottom:4px;line-height:1.4;">click to toggle · lines are min–max normalized to the chart (range shown) · bars ▮ at base · follows the ⏪ scrubber</div>'
      + '<div style="display:flex;gap:10px;margin-bottom:2px;"><span id="streams-none" style="cursor:pointer;color:#7cc8ff;font-size:9px;">clear all</span></div>'
      + '<div id="streams-body"></div>'
    document.body.appendChild(panel)
    panel.querySelector('#streams-close').addEventListener('click', () => { panel.style.display = 'none' })
    panel.querySelector('#streams-none').addEventListener('click', () => {
      streamSel = {}; try { localStorage.setItem('cta-streams-sel', '{}') } catch (e) {}
      renderStreamPanel(); if (lastState) drawVtrace(lastState, true)
    })
    panel.querySelector('#streams-body').addEventListener('change', (e) => {
      const sid = e.target && e.target.getAttribute && e.target.getAttribute('data-sid'); if (!sid) return
      streamSel[sid] = !!e.target.checked
      try { localStorage.setItem('cta-streams-sel', JSON.stringify(streamSel)) } catch (err) {}
      if (lastState) drawVtrace(lastState, true)
    })
  }
  if (btn) btn.addEventListener('click', () => {
    panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none'
    if (panel.style.display === 'block') renderStreamPanel()
  })
})()

// =====================================================================
// ===== BACKTEST tab — self-contained replay/transform/annotate UI ====
// =====================================================================
;(function () {
  const BT = {
    viz: null,
    waveSet: [], oracleSet: [],            // in-memory working sets (the single source of truth)
    wi: 0, loaded: false,
    lines: [], mode: null,                 // mode: null | 'wave' | 'oracle'
    drag: null,                            // {x0,x1} in data-t coords while drawing a NEW box
    view: null,                            // {x0,x1} visible time range (seconds); null => full window
    pan: null,                             // active time-axis pan: { startPx, vx0, vx1 }
    pending: null,                         // {t0,t1} awaiting STABLE/UNSTABLE choice
    sel: null,                             // selected annotation: { type:'wave'|'oracle', id }
    editDrag: null,                        // active move/resize: { id,type,kind:'move'|'l'|'r', startT, ot0, ot1, snapped }
    undoStack: [], redoStack: [],          // snapshots of {wave,oracle}
    UNDO_CAP: 50,
    COLS: ['t', 'mid', 'fair', 'cfmean', 'secleft', 'tfi', 'btcobi', 'tvol', 'mrate', 'dev'],
    PALETTE: ['#f0a000', '#4fd0e0', '#d070d0', '#ff5fa2', '#aaff00', '#ff8c00', '#7cc8ff', '#ffd600'],
    LSKEY: 'cta-bt-lines'
  }
  const newId = () => Date.now() + '_' + Math.random().toString(36).slice(2)
  const idx = (st) => BT.COLS.indexOf(st)
  const $$ = (id) => document.getElementById(id)

  // ---- transform computation (client-side, from a window's series) ----
  function transformLine(series, stream, transform, param, start) {
    const ci = idx(stream)
    const raw = series.map((r) => (r[ci] == null ? null : Number(r[ci])))
    const ts = series.map((r) => Number(r[0]))
    if (transform === 'raw') return raw
    if (transform === 'MA') {
      const w = Math.max(0.001, Number(param) || 30)
      const st = Number(start) || 0   // accumulate ONLY from `start` onward; line is null before `start`
      return raw.map((_, i) => {
        if (ts[i] < st) return null   // not plotted before start (removes pre-window / pre-wave noise)
        let sum = 0, n = 0
        for (let j = i; j >= 0 && ts[i] - ts[j] <= w && ts[j] >= st; j--) { if (raw[j] != null) { sum += raw[j]; n++ } }
        return n ? sum / n : null
      })
    }
    if (transform === 'deriv') {
      return raw.map((v, i) => {
        if (i === 0 || v == null || raw[i - 1] == null) return null
        const dt = ts[i] - ts[i - 1]; return dt > 0 ? (v - raw[i - 1]) / dt : null
      })
    }
    if (transform === 'integral') {
      let acc = 0; return raw.map((v) => { if (v != null) acc += v; return acc })
    }
    return raw
  }
  const lineLabel = (L) => L.stream + (L.transform === 'raw' ? '' : L.transform === 'MA' ? `·MA${L.param}s` + (Number(L.start) > 0 ? `@t0=${(+L.start).toFixed(0)}s` : '') : '·' + L.transform)

  // ---- persistence ----
  function saveLines() { try { localStorage.setItem(BT.LSKEY, JSON.stringify(BT.lines)) } catch (e) {} }
  function loadLines() {
    try { const s = JSON.parse(localStorage.getItem(BT.LSKEY)); if (Array.isArray(s) && s.length) { BT.lines = s; return } } catch (e) {}
    BT.lines = [ { stream: 'mid', transform: 'raw', param: 30, color: '#f0a000' },
                 { stream: 'fair', transform: 'raw', param: 30, color: '#4fd0e0' } ]
  }

  // ---- init (first open): load data + wire controls ----
  function initBacktest() {
    if (BT.loaded) { drawBT(); return }
    BT.loaded = true
    loadLines()
    wireControls()
    Promise.all([
      window.cta.getViz ? window.cta.getViz() : Promise.resolve(null),
      window.cta.getAnnotations ? window.cta.getAnnotations() : Promise.resolve({ wave: [], oracle: [] })
    ]).then(([viz, ann]) => {
      try { BT.viz = typeof viz === 'string' ? JSON.parse(viz) : viz } catch (e) { BT.viz = null }
      if (ann) {
        // load once into the working sets; assign ids to any legacy annotations that lack one.
        // QA-M1 FIX: also COERCE t0/t1 to finite numbers on load. A malformed/legacy/hand-edited
        // annotation with a missing or string t0/t1 otherwise crashed updateSelInfo (b.t0.toFixed)
        // on selection and produced NaN geometry in drawBT. Coerce once here so every downstream
        // draw/selinfo path sees real numbers (additive — well-formed annotations are unchanged).
        const _coerce = (o) => {
          const r = (o && o.id) ? { ...o } : { ...o, id: newId() }
          if (!Number.isFinite(+r.t0)) r.t0 = 0; else r.t0 = +r.t0
          if (!Number.isFinite(+r.t1)) r.t1 = r.t0; else r.t1 = +r.t1
          return r
        }
        BT.waveSet = (ann.wave || []).map(_coerce)
        BT.oracleSet = (ann.oracle || []).map(_coerce)
        // QA-DATALOSS FIX (2026-06-30): main now returns null for a side whose file EXISTS but FAILED
        // to read (vs [] for a genuinely empty/absent file). If either side failed to read, we are
        // looking at a FALSE-EMPTY working set — enabling persistence would let an add-one-box save
        // overwrite a good N-row file with 1 row (backupOnce only fires on a 0-length write, so that
        // path was unbacked). Keep annLoaded=false in that case: the boxes still DRAW for inspection,
        // but no persist fires until a clean reload succeeds. (Both sides non-null => safe to persist.)
        const _readFailed = (ann.wave === null) || (ann.oracle === null)
        BT.annLoaded = !_readFailed   // CRITICAL: only allow persistence AFTER a CLEAN load, so a pre-load OR failed-read save can't wipe the files
        // QA-D1 FIX (2026-07-01): a TRANSIENT failed annotation read previously left BT.loaded=true
        // PERMANENTLY, so `if (BT.loaded) return` at the top of initBacktest short-circuited every
        // future tab-open — the user saw an empty canvas and every edit silently no-op'd at
        // persistWave/persistOracle (annLoaded stayed false) for the whole session: a discarded
        // editing session, no warning, no retry. Disk was safe (persistence correctly blocked), so this
        // is session-loss not a wipe — but it's silent. Fix (additive; does NOT weaken the wipe guard):
        // on a failed read, RE-ARM the loader so the NEXT tab-open retries the read (wireControls is
        // idempotent via its `wired` flag, so re-running initBacktest is safe), and surface a visible
        // banner so the user knows edits won't persist until a clean reload. annLoaded stays false the
        // whole time, so no failed-read save can ever fire. A clean read clears the banner as before.
        if (_readFailed) {
          BT.loaded = false   // allow a retry on the next tab switch instead of latching empty forever
          const _si = $$('bt-selinfo')
          if (_si) _si.innerHTML = '<span style="color:#ff5555;font-weight:700;">⚠ annotations failed to load — edits will NOT save. Switch away and back to retry.</span>'
        }
      }
      const n = (BT.viz && BT.viz.windows && BT.viz.windows.length) || 0
      BT.wi = Math.min(BT.wi, Math.max(0, n - 1))
      drawBT(); renderLineList(); updateSummary(); updateUndoButtons()
      if (!(ann && ((ann.wave === null) || (ann.oracle === null)))) updateSelInfo()   // don't let updateSelInfo overwrite the failed-load banner
    })
  }
  window.initBacktest = initBacktest   // called from the tab-switch handler

  // ---- working-set persistence (overwrite full file) ----
  function persistWave() { if (!BT.annLoaded) return; if (window.cta.saveWaveSet) window.cta.saveWaveSet(BT.waveSet) }
  function persistOracle() { if (!BT.annLoaded) return; if (window.cta.saveOracleSet) window.cta.saveOracleSet(BT.oracleSet) }
  function persistBoth() { persistWave(); persistOracle() }
  const cloneSet = (a) => a.map((o) => ({ ...o }))
  // snapshot current state onto the undo stack and clear redo (call BEFORE every mutation)
  function pushUndo() {
    BT.undoStack.push({ wave: cloneSet(BT.waveSet), oracle: cloneSet(BT.oracleSet) })
    if (BT.undoStack.length > BT.UNDO_CAP) BT.undoStack.shift()
    BT.redoStack.length = 0
    updateUndoButtons()
  }
  function restoreSnap(snap) {
    BT.waveSet = cloneSet(snap.wave); BT.oracleSet = cloneSet(snap.oracle)
    // drop a stale selection if its box no longer exists
    if (BT.sel && !setOf(BT.sel.type).some((o) => o.id === BT.sel.id)) BT.sel = null
    persistBoth(); drawBT(); updateSelInfo(); updateUndoButtons()
  }
  function undo() {
    if (!BT.undoStack.length) return
    BT.redoStack.push({ wave: cloneSet(BT.waveSet), oracle: cloneSet(BT.oracleSet) })
    restoreSnap(BT.undoStack.pop())
  }
  function redo() {
    if (!BT.redoStack.length) return
    BT.undoStack.push({ wave: cloneSet(BT.waveSet), oracle: cloneSet(BT.oracleSet) })
    restoreSnap(BT.redoStack.pop())
  }
  function updateUndoButtons() {
    const u = $$('bt-undo'), r = $$('bt-redo')
    if (u) { u.style.opacity = BT.undoStack.length ? '1' : '0.35'; u.style.pointerEvents = BT.undoStack.length ? '' : 'none' }
    if (r) { r.style.opacity = BT.redoStack.length ? '1' : '0.35'; r.style.pointerEvents = BT.redoStack.length ? '' : 'none' }
  }

  // ---- selection helpers ----
  const setOf = (type) => (type === 'oracle' ? BT.oracleSet : BT.waveSet)
  const selBox = () => (BT.sel ? setOf(BT.sel.type).find((o) => o.id === BT.sel.id) || null : null)
  function updateSelInfo() {
    // enable the "MA from wave start" button only when a WAVE box is selected
    const mw = $$('bt-add-mawave')
    if (mw) {
      const on = !!(BT.sel && BT.sel.type === 'wave' && selBox())
      mw.style.opacity = on ? '1' : '0.35'
      mw.style.pointerEvents = on ? '' : 'none'
    }
    const el = $$('bt-selinfo'); if (!el) return
    const b = selBox()
    if (!b) { el.innerHTML = '<span class="dim">no box selected — click a box to select · drag body to move · drag edges to resize</span>'; return }
    const span = `${(b.t0).toFixed(1)}&ndash;${(b.t1).toFixed(1)}s`
    if (BT.sel.type === 'wave') {
      const col = b.label === 'stable' ? '#3ec46d' : '#ffa000'
      el.innerHTML = `<span class="amber">selected</span> WAVE · <b style="color:${col}">${b.label}</b> · ${span} <span class="dim">(S=stable U=unstable · Del=delete)</span>`
    } else {
      el.innerHTML = `<span class="amber">selected</span> ORACLE · exit&asymp;<b style="color:#d070d0">${b.avg_price != null ? b.avg_price.toFixed(3) : '—'}</b> · ${span} <span class="dim">(Del=delete)</span>`
    }
  }

  function curWindow() { return (BT.viz && BT.viz.windows && BT.viz.windows[BT.wi]) || null }

  // ---- window nav + summary ----
  function nav(d) {
    const n = (BT.viz && BT.viz.windows && BT.viz.windows.length) || 0
    if (!n) return
    BT.wi = Math.max(0, Math.min(n - 1, BT.wi + d))
    BT.drag = null; BT.pending = null; BT.editDrag = null; BT.sel = null; BT.pan = null; hidePop()
    const nw = curWindow(); resetView(nw ? (nw.dur || 900) : 900)   // new window => fit to full range
    drawBT(); updateSummary(); updateSelInfo()
  }
  function updateSummary() {
    const w = curWindow(), lab = $$('bt-wlabel'), sum = $$('bt-summary')
    const n = (BT.viz && BT.viz.windows && BT.viz.windows.length) || 0
    if (!w) { if (lab) lab.textContent = 'window —/—'; if (sum) sum.textContent = (BT.viz ? 'no windows' : 'viz_data.json not loaded'); return }
    if (lab) lab.textContent = `window ${BT.wi + 1}/${n} · ${w.tk}`
    const tr = w.trades || []
    const taken = tr.filter((t) => t.taken)
    const pnlTaken = taken.reduce((s, t) => s + (t.pnl || 0), 0)
    const pnlAll = tr.reduce((s, t) => s + (t.pnl || 0), 0)
    const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(2)
    if (sum) sum.innerHTML = `strike <b class="amber">${w.strike != null ? w.strike.toFixed(0) : '—'}</b> · dur ${Math.round(w.dur)}s · `
      + `${tr.length} trades · <b class="cyan">${taken.length} taken</b> · `
      + `Σpnl taken <b class="${pnlTaken >= 0 ? 'up' : 'down'}">${f(pnlTaken)}</b> · `
      + `Σpnl all <b class="${pnlAll >= 0 ? 'up' : 'down'}">${f(pnlAll)}</b>`
  }

  // ---- active-lines list ----
  function renderLineList() {
    const el = $$('bt-lines'); if (!el) return
    el.innerHTML = BT.lines.map((L, i) =>
      `<span style="display:inline-block;margin-right:12px;white-space:nowrap;">`
      + `<span class="swatch" style="background:${L.color};"></span>${lineLabel(L)} `
      + `<span data-bt-rm="${i}" style="cursor:pointer;color:var(--down);font-weight:700;">&times;</span></span>`
    ).join('') || '<span class="dim">no lines — add one above</span>'
  }

  // ---- coordinate geometry (must match the SVG viewBox 900x340) ----
  const GEO = { W: 900, H: 340, PADL: 34, PADR: 12, PADT: 12, PADB: 18 }
  const MIN_SPAN = 5   // minimum visible time span (s) when zoomed in
  // visible time range; clamps to [0,dur] and falls back to the full window
  function viewRange(dur) {
    const v = BT.view
    let x0 = v && isFinite(v.x0) ? v.x0 : 0
    let x1 = v && isFinite(v.x1) ? v.x1 : dur
    x0 = Math.max(0, Math.min(dur, x0)); x1 = Math.max(0, Math.min(dur, x1))
    if (x1 - x0 < MIN_SPAN) x1 = Math.min(dur, x0 + MIN_SPAN)
    if (x1 <= x0) { x0 = 0; x1 = dur }
    return { x0, x1 }
  }
  // reset the view to the full window
  function resetView(dur) { BT.view = { x0: 0, x1: dur } }
  // map data-time -> viewBox x using the CURRENT visible range
  function xOf(t, dur) {
    const { x0, x1 } = viewRange(dur)
    const sp = x1 - x0
    return GEO.PADL + (sp > 0 ? (t - x0) / sp : 0) * (GEO.W - GEO.PADL - GEO.PADR)
  }
  // map a pixel x (within the SVG element) -> data-time, in the CURRENT visible range
  function tFromPx(px, el, dur) {
    const { x0, x1 } = viewRange(dur)
    const sp = x1 - x0
    const vbx = (px / el.clientWidth) * GEO.W
    const t = x0 + (vbx - GEO.PADL) / (GEO.W - GEO.PADL - GEO.PADR) * sp
    return Math.max(0, Math.min(dur, t))
  }

  // ---- main draw ----
  function drawBT() {
    const svg = $$('bt-chart'); if (!svg) return
    const w = curWindow()
    if (!w) { svg.innerHTML = `<text x="450" y="170" fill="#6b786b" font-size="13" text-anchor="middle">no backtest data</text>`; return }
    const night = document.documentElement.getAttribute('data-theme') === 'night'
    const { W, H, PADL, PADR, PADT, PADB } = GEO
    const dur = w.dur || 900, series = w.series || []
    if (!BT.view) resetView(dur)
    const vr = viewRange(dur)                                          // current visible time range
    const inView = (t) => t >= vr.x0 - 1e-6 && t <= vr.x1 + 1e-6
    const C_GRID = night ? '#141414' : '#1c241c', C_AX = night ? '#444' : '#6b786b'
    const Yarea = (yNorm) => PADT + (1 - yNorm) * (H - PADT - PADB)   // yNorm 0..1 bottom..top
    const PLOTW = W - PADL - PADR
    const clipId = 'bt-plotclip'

    // mid/fair/dev share a fixed 0..1 axis; everything else self-scales to its own min..max
    const SHARED = { mid: 1, fair: 1, dev: 1 }
    let s = ''
    // clip region for all data layers so zoom/pan never paints outside the plot box
    s += `<defs><clipPath id="${clipId}"><rect x="${PADL}" y="${PADT}" width="${PLOTW.toFixed(1)}" height="${(H - PADT - PADB).toFixed(1)}"/></clipPath></defs>`
    // grid + time axis
    for (let g = 0; g <= 1.0001; g += 0.25) {
      const y = Yarea(g)
      s += `<line x1="${PADL}" y1="${y.toFixed(1)}" x2="${W - PADR}" y2="${y.toFixed(1)}" stroke="${Math.abs(g - 0.5) < 1e-9 ? (night ? '#333' : '#2a3a2a') : C_GRID}" stroke-width="${Math.abs(g - 0.5) < 1e-9 ? 1 : 0.5}" vector-effect="non-scaling-stroke"${Math.abs(g - 0.5) < 1e-9 ? ' stroke-dasharray="3 3"' : ''}/>`
      s += `<text x="2" y="${(y - 2).toFixed(1)}" fill="${C_AX}" font-size="8" font-family="monospace">${(g * 100).toFixed(0)}%</text>`
    }
    const nT = 6
    for (let k = 0; k <= nT; k++) {
      const t = vr.x0 + (vr.x1 - vr.x0) * k / nT, x = xOf(t, dur)
      s += `<line x1="${x.toFixed(1)}" y1="${PADT}" x2="${x.toFixed(1)}" y2="${H - PADB}" stroke="${C_GRID}" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`
      s += `<text x="${x.toFixed(1)}" y="${H - 4}" fill="${C_AX}" font-size="8" font-family="monospace" text-anchor="middle">${Math.round(t)}s</text>`
    }
    // zoom indicator (shown only when not viewing the full window)
    if (vr.x0 > 0.5 || vr.x1 < dur - 0.5) {
      s += `<text x="${(W - PADR - 2).toFixed(1)}" y="${(H - 4)}" fill="${C_AX}" font-size="8" font-family="monospace" text-anchor="end">view ${vr.x0.toFixed(0)}–${vr.x1.toFixed(0)}s / ${Math.round(dur)}s · ↺ fit to reset</text>`
    }
    // ---- all data layers go inside a clipped group ----
    s += `<g clip-path="url(#${clipId})">`

    // annotation boxes (wave + oracle) for this window. boxes are interactive: click=select, drag body=move, drag edges=resize
    const BOXH = (H - PADT - PADB)
    const isSel = (type, id) => BT.sel && BT.sel.type === type && BT.sel.id === id
    const handleW = 7   // px-ish hit width for the L/R resize edges (in viewBox units)
    ;(BT.waveSet || []).forEach((b) => {
      if (b.tk !== w.tk) return
      const x0 = xOf(b.t0, dur), x1 = xOf(b.t1, dur)
      const xa = Math.min(x0, x1), wd = Math.abs(x1 - x0)
      const col = b.label === 'stable' ? '62,196,109' : '255,160,0'
      const sel = isSel('wave', b.id)
      const sw = sel ? 2.4 : 1, fa = sel ? 0.22 : 0.13, sa = sel ? 1 : 0.7
      s += `<rect data-bt-box="wave" data-bt-id="${b.id}" data-bt-part="body" style="cursor:move" x="${xa.toFixed(1)}" y="${PADT}" width="${wd.toFixed(1)}" height="${BOXH.toFixed(1)}" fill="rgba(${col},${fa})" stroke="rgba(${col},${sa})" stroke-width="${sw}"/>`
      s += `<text x="${(xa + 3).toFixed(1)}" y="${(PADT + 11)}" fill="rgba(${col},1)" font-size="9" font-weight="bold" pointer-events="none">${b.label}</text>`
      if (sel) {
        s += `<rect data-bt-box="wave" data-bt-id="${b.id}" data-bt-part="l" style="cursor:ew-resize" x="${(xa - handleW / 2).toFixed(1)}" y="${PADT}" width="${handleW}" height="${BOXH.toFixed(1)}" fill="rgba(${col},0.55)"/>`
        s += `<rect data-bt-box="wave" data-bt-id="${b.id}" data-bt-part="r" style="cursor:ew-resize" x="${(xa + wd - handleW / 2).toFixed(1)}" y="${PADT}" width="${handleW}" height="${BOXH.toFixed(1)}" fill="rgba(${col},0.55)"/>`
      }
    })
    ;(BT.oracleSet || []).forEach((b) => {
      if (b.tk !== w.tk) return
      const x0 = xOf(b.t0, dur), x1 = xOf(b.t1, dur)
      const xa = Math.min(x0, x1), wd = Math.abs(x1 - x0)
      const sel = isSel('oracle', b.id)
      const sw = sel ? 2.4 : 1, fa = sel ? 0.24 : 0.14, sa = sel ? 1 : 0.8
      s += `<rect data-bt-box="oracle" data-bt-id="${b.id}" data-bt-part="body" style="cursor:move" x="${xa.toFixed(1)}" y="${PADT}" width="${wd.toFixed(1)}" height="${BOXH.toFixed(1)}" fill="rgba(176,112,208,${fa})" stroke="rgba(176,112,208,${sa})" stroke-width="${sw}"/>`
      if (b.avg_price != null) {
        const y = Yarea(Math.max(0, Math.min(1, (b.avg_price + 0.1) / 1.2)))
        s += `<line x1="${xa.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(xa + wd).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#d070d0" stroke-width="1.2" stroke-dasharray="3 2" pointer-events="none"/>`
        s += `<text x="${(xa + 3).toFixed(1)}" y="${(y - 3).toFixed(1)}" fill="#d070d0" font-size="9" font-weight="bold" pointer-events="none">exit&asymp;${b.avg_price.toFixed(3)}</text>`
      }
      if (sel) {
        s += `<rect data-bt-box="oracle" data-bt-id="${b.id}" data-bt-part="l" style="cursor:ew-resize" x="${(xa - handleW / 2).toFixed(1)}" y="${PADT}" width="${handleW}" height="${BOXH.toFixed(1)}" fill="rgba(176,112,208,0.55)"/>`
        s += `<rect data-bt-box="oracle" data-bt-id="${b.id}" data-bt-part="r" style="cursor:ew-resize" x="${(xa + wd - handleW / 2).toFixed(1)}" y="${PADT}" width="${handleW}" height="${BOXH.toFixed(1)}" fill="rgba(176,112,208,0.55)"/>`
      }
    })

    // plotted lines
    const legend = []
    BT.lines.forEach((L) => {
      const vals = transformLine(series, L.stream, L.transform, L.param, L.start)
      let lo, hi
      if (SHARED[L.stream] && L.transform === 'raw') { lo = -0.10; hi = 1.10 }   // price axis -10c..110c so negatives (dev) + >1 show
      else {
        // auto-fit each line to its OWN min/max over the CURRENTLY VISIBLE x-range
        lo = Infinity; hi = -Infinity
        vals.forEach((v, i) => { if (v != null && isFinite(v) && inView(Number(series[i][0]))) { if (v < lo) lo = v; if (v > hi) hi = v } })
        if (!isFinite(lo)) { lo = 0; hi = 1 }
        if (hi - lo < 1e-12) { hi = lo + 1 }
      }
      const norm = (v) => (v - lo) / (hi - lo)
      // draw the full polyline (clip-path bounds it to the plot box); fit was computed on visible pts only
      let pts = ''
      vals.forEach((v, i) => { if (v == null || !isFinite(v)) return; const t = Number(series[i][0]); const x = xOf(t, dur), y = Yarea(Math.max(0, Math.min(1, norm(v)))); pts += (pts ? ' ' : '') + x.toFixed(1) + ',' + y.toFixed(1) })
      if (pts) s += `<polyline fill="none" stroke="${L.color}" stroke-width="1.4" vector-effect="non-scaling-stroke" points="${pts}"/>`
      legend.push(`<tspan fill="${L.color}">&#9473; ${lineLabel(L)}${SHARED[L.stream] && L.transform === 'raw' ? '' : ` [${lo.toFixed(2)}..${hi.toFixed(2)}]`}</tspan>`)
    })
    if (legend.length) s += `<text x="${PADL + 2}" y="${PADT + 9}" font-size="9" font-family="monospace">${legend.join('  ')}</text>`

    // trade markers: entry ▲ / exit ▼ at mid-scaled p, connected, hover title
    ;(w.trades || []).forEach((t, ti) => {
      const xi = xOf(t.t_in, dur), xo = xOf(t.t_out, dur)
      const yi = Yarea(Math.max(0, Math.min(1, (t.p_in + 0.1) / 1.2))), yo = Yarea(Math.max(0, Math.min(1, (t.p_out + 0.1) / 1.2)))
      const col = t.taken ? ((t.pnl || 0) > 0 ? '#3ec46d' : '#ff5555') : (night ? '#555' : '#888')
      const op = t.taken ? 0.95 : 0.45
      const tip = `xc=${t.xc} pnl=${t.pnl != null ? t.pnl.toFixed(3) : '—'} ${t.taken ? 'TAKEN' : 'skip'} ${t.sgn === 1 ? 'UP/YES' : 'DOWN/NO'}`
      s += `<line x1="${xi.toFixed(1)}" y1="${yi.toFixed(1)}" x2="${xo.toFixed(1)}" y2="${yo.toFixed(1)}" stroke="${col}" stroke-width="0.8" opacity="${op}" vector-effect="non-scaling-stroke" pointer-events="none"/>`
      const sideCol = t.sgn === 1 ? '#3ec46d' : '#ff5555'   // BUY = open circle: green YES/up, red NO/down
      s += `<circle data-bt-tr="${ti}" style="cursor:pointer" cx="${xi.toFixed(1)}" cy="${yi.toFixed(1)}" r="4.5" fill="none" stroke="${sideCol}" stroke-width="1.6" vector-effect="non-scaling-stroke" opacity="${op}"><title>${tip}</title></circle>`
      s += `<polygon data-bt-tr="${ti}" style="cursor:pointer" points="${xo.toFixed(1)},${(yo + 5).toFixed(1)} ${(xo - 4).toFixed(1)},${(yo - 3).toFixed(1)} ${(xo + 4).toFixed(1)},${(yo - 3).toFixed(1)}" fill="${col}" opacity="${op}"><title>${tip}</title></polygon>`
    })

    // in-progress drag rectangle
    if (BT.drag) {
      const x0 = xOf(BT.drag.x0, dur), x1 = xOf(BT.drag.x1, dur)
      const c = BT.mode === 'oracle' ? '176,112,208' : '255,210,90'
      s += `<rect x="${Math.min(x0, x1).toFixed(1)}" y="${PADT}" width="${Math.abs(x1 - x0).toFixed(1)}" height="${(H - PADT - PADB).toFixed(1)}" fill="rgba(${c},0.18)" stroke="rgb(${c})" stroke-width="1" stroke-dasharray="3 2" pointer-events="none"/>`
    }
    s += `</g>`   // close clipped data layer
    svg.innerHTML = s
  }

  // ---- oracle avg_price recompute over [t0,t1] from the window's mid series ----
  function oracleAvg(w, t0, t1) {
    const series = w.series || []
    let sum = 0, n = 0
    series.forEach((r) => { const tt = Number(r[0]); if (tt >= t0 && tt <= t1 && r[1] != null) { sum += Number(r[1]); n++ } })
    return n ? +(sum / n).toFixed(4) : null
  }

  // ---- annotation drag handlers (select / draw-new / move / resize) ----
  function wireChartDrag() {
    const svg = $$('bt-chart'); if (!svg) return
    svg.addEventListener('mousedown', (e) => {
      const w = curWindow(); if (!w) return
      const dur = w.dur || 900
      const tgt = e.target
      const part = tgt && tgt.getAttribute ? tgt.getAttribute('data-bt-part') : null
      const boxType = tgt && tgt.getAttribute ? tgt.getAttribute('data-bt-box') : null
      const boxId = tgt && tgt.getAttribute ? tgt.getAttribute('data-bt-id') : null
      // clicking on an existing box: select + begin move/resize (works regardless of mode)
      if (part && boxId) {
        BT.sel = { type: boxType, id: boxId }
        const b = selBox()
        if (b) {
          const t = tFromPx(e.offsetX, svg, dur)
          BT.editDrag = { id: boxId, type: boxType, kind: part === 'l' ? 'l' : part === 'r' ? 'r' : 'move', startT: t, ot0: b.t0, ot1: b.t1, snapped: false }
        }
        hidePop(); drawBT(); updateSelInfo()
        e.preventDefault()
        return
      }
      // empty area:
      //  - annotation mode ON  -> start drawing a new box (unchanged behaviour)
      //  - annotation mode OFF -> start a time-axis PAN (and clear any selection)
      if (BT.mode) {
        const t = tFromPx(e.offsetX, svg, dur)
        BT.drag = { x0: t, x1: t }; drawBT()
      } else {
        const vr = viewRange(dur)
        BT.pan = { startPx: e.offsetX, vx0: vr.x0, vx1: vr.x1, moved: false }
        if (BT.sel) { BT.sel = null; drawBT(); updateSelInfo() }
      }
    })
    svg.addEventListener('mousemove', (e) => {
      const w = curWindow(); if (!w) return
      const dur = w.dur || 900
      if (BT.editDrag) {
        const ed = BT.editDrag, b = selBox(); if (!b) { BT.editDrag = null; return }
        if (!ed.snapped) { pushUndo(); ed.snapped = true }   // snapshot once, on first real move
        const t = tFromPx(e.offsetX, svg, dur)
        applyEdit(w, b, ed, t)
        drawBT(); updateSelInfo()
        return
      }
      if (BT.drag) { BT.drag.x1 = tFromPx(e.offsetX, svg, dur); drawBT(); return }
      // time-axis pan (annotation mode OFF): translate the visible range by the cursor delta
      if (BT.pan) {
        const span = BT.pan.vx1 - BT.pan.vx0
        const dpx = e.offsetX - BT.pan.startPx
        // convert pixel delta -> time delta within the plot area (account for SVG element scale)
        const dvb = (dpx / svg.clientWidth) * GEO.W
        let dt = -(dvb / (GEO.W - GEO.PADL - GEO.PADR)) * span
        let nx0 = BT.pan.vx0 + dt, nx1 = BT.pan.vx1 + dt
        if (nx0 < 0) { nx1 -= nx0; nx0 = 0 }
        if (nx1 > dur) { nx0 -= (nx1 - dur); nx1 = dur }
        nx0 = Math.max(0, nx0); nx1 = Math.min(dur, nx1)
        BT.view = { x0: nx0, x1: nx1 }
        if (Math.abs(dpx) > 2) BT.pan.moved = true
        drawBT()
      }
    })
    window.addEventListener('mouseup', (e) => {
      if (BT.pan) { BT.pan = null }
      // finish an edit move/resize
      if (BT.editDrag) {
        const ed = BT.editDrag; BT.editDrag = null
        if (ed.snapped) {    // there was an actual change -> persist
          if (ed.type === 'oracle') persistOracle(); else persistWave()
        }
        drawBT(); updateSelInfo(); return
      }
      // finish drawing a new box
      if (!BT.drag) return
      const w = curWindow(); const d = BT.drag; BT.drag = null
      if (!w) { drawBT(); return }
      const t0 = Math.min(d.x0, d.x1), t1 = Math.max(d.x0, d.x1)
      if (t1 - t0 < 1) { drawBT(); return }   // ignore trivial clicks
      if (BT.mode === 'wave') { BT.pending = { t0, t1 }; showWavePrompt(e) }
      else if (BT.mode === 'oracle') { saveOracle(w, t0, t1) }
      drawBT()
    })
    // trade marker click -> popup details
    svg.addEventListener('click', (e) => {
      const ti = e.target && e.target.getAttribute ? e.target.getAttribute('data-bt-tr') : null
      if (ti == null) return
      const w = curWindow(); if (!w) return
      const t = (w.trades || [])[Number(ti)]; if (!t) return
      showPop(e, `<b class="${t.taken ? ((t.pnl || 0) > 0 ? 'up' : 'down') : 'dim'}">${t.taken ? 'TAKEN' : 'SKIP'}</b> ${t.sgn === 1 ? 'UP/YES' : 'DOWN/NO'}<br>`
        + `xc=${t.xc} (thr ${BT.viz && BT.viz.thr})<br>in ${(t.p_in * 100).toFixed(1)}c @${t.t_in.toFixed(0)}s &rarr; out ${(t.p_out * 100).toFixed(1)}c @${t.t_out.toFixed(0)}s<br>`
        + `pnl <b class="${(t.pnl || 0) >= 0 ? 'up' : 'down'}">${t.pnl != null ? t.pnl.toFixed(3) : '—'}</b>`)
    })
    // scroll-wheel -> zoom the time axis, centered on the cursor's time position
    svg.addEventListener('wheel', (e) => {
      const vbt = $$('view-backtest'); if (!vbt || vbt.style.display === 'none') return
      const w = curWindow(); if (!w) return
      e.preventDefault()   // keep the page from scrolling
      const dur = w.dur || 900
      const vr = viewRange(dur)
      const span = vr.x1 - vr.x0
      const tc = tFromPx(e.offsetX, svg, dur)            // time under the cursor (anchor)
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2        // wheel down = zoom out
      let nspan = Math.max(MIN_SPAN, Math.min(dur, span * factor))
      const frac = span > 0 ? (tc - vr.x0) / span : 0.5  // keep cursor at same screen fraction
      let nx0 = tc - frac * nspan, nx1 = nx0 + nspan
      if (nx0 < 0) { nx1 -= nx0; nx0 = 0 }
      if (nx1 > dur) { nx0 -= (nx1 - dur); nx1 = dur }
      nx0 = Math.max(0, nx0); nx1 = Math.min(dur, nx1)
      BT.view = { x0: nx0, x1: nx1 }
      drawBT()
    }, { passive: false })
  }

  // ---- apply a move/resize to a box, clamped to [0,dur] ----
  function applyEdit(w, b, ed, t) {
    const dur = w.dur || 900
    const clamp = (x) => Math.max(0, Math.min(dur, x))
    if (ed.kind === 'move') {
      let dt = t - ed.startT
      const wd = ed.ot1 - ed.ot0
      // keep width fixed; clamp both ends inside the window
      let nt0 = ed.ot0 + dt, nt1 = ed.ot1 + dt
      if (nt0 < 0) { nt1 -= nt0; nt0 = 0 }
      if (nt1 > dur) { nt0 -= (nt1 - dur); nt1 = dur }
      b.t0 = +clamp(nt0).toFixed(1); b.t1 = +clamp(nt1).toFixed(1)
    } else if (ed.kind === 'l') {
      let nt0 = clamp(t)
      if (nt0 > ed.ot1 - 0.5) nt0 = ed.ot1 - 0.5
      b.t0 = +Math.max(0, nt0).toFixed(1); b.t1 = +ed.ot1.toFixed(1)
    } else if (ed.kind === 'r') {
      let nt1 = clamp(t)
      if (nt1 < ed.ot0 + 0.5) nt1 = ed.ot0 + 0.5
      b.t0 = +ed.ot0.toFixed(1); b.t1 = +Math.min(dur, nt1).toFixed(1)
    }
    // QA-M2 FIX: only overwrite avg_price when a value is actually computable. If a resize/move
    // lands the box in a data gap (no non-null series sample in [t0,t1]), oracleAvg returns null;
    // keeping the prior avg_price avoids silently destroying the annotation's price on a transient
    // drag (the user can still recompute by resizing back over data; undo also restores it).
    if (ed.type === 'oracle') { const _a = oracleAvg(w, b.t0, b.t1); if (_a != null) b.avg_price = _a }
  }

  function saveOracle(w, t0, t1) {
    pushUndo()
    const o = { id: newId(), tk: w.tk, t0: +t0.toFixed(1), t1: +t1.toFixed(1), avg_price: oracleAvg(w, t0, t1) }
    BT.oracleSet.push(o); BT.sel = { type: 'oracle', id: o.id }
    persistOracle(); drawBT(); updateSelInfo()
  }
  function saveWave(label) {
    const w = curWindow(); if (!w || !BT.pending) return
    pushUndo()
    const o = { id: newId(), tk: w.tk, t0: +BT.pending.t0.toFixed(1), t1: +BT.pending.t1.toFixed(1), label }
    BT.waveSet.push(o); BT.sel = { type: 'wave', id: o.id }
    BT.pending = null; hidePop(); persistWave(); drawBT(); updateSelInfo()
  }

  // ---- delete / flip-label (edits on the selected box) ----
  function deleteSelected() {
    const b = selBox(); if (!b) return
    pushUndo()
    const arr = setOf(BT.sel.type)
    const i = arr.findIndex((o) => o.id === BT.sel.id)
    if (i >= 0) arr.splice(i, 1)
    if (BT.sel.type === 'oracle') persistOracle(); else persistWave()
    BT.sel = null
    drawBT(); updateSelInfo()
  }
  function flipWaveLabel(label) {
    if (!BT.sel || BT.sel.type !== 'wave') return
    const b = selBox(); if (!b) return
    const nl = label || (b.label === 'stable' ? 'unstable' : 'stable')
    if (nl === b.label) return
    pushUndo()
    b.label = nl
    persistWave(); drawBT(); updateSelInfo()
  }

  // ---- floating popup (wave prompt + trade detail) ----
  function showPop(e, html) {
    const p = $$('bt-pop'); if (!p) return
    p.innerHTML = html; p.style.display = 'block'
    p.style.left = Math.min(window.innerWidth - 230, e.clientX + 12) + 'px'
    p.style.top = (e.clientY + 12) + 'px'
  }
  function showWavePrompt(e) {
    showPop(e, `<div style="margin-bottom:6px;">label this wave region:</div>`
      + `<span id="bt-stable" style="cursor:pointer;color:#3ec46d;font-weight:700;border:1px solid #3ec46d;padding:2px 10px;margin-right:6px;">STABLE</span>`
      + `<span id="bt-unstable" style="cursor:pointer;color:#ffa000;font-weight:700;border:1px solid #ffa000;padding:2px 10px;">UNSTABLE</span>`)
    // wire the two just-rendered buttons
    const sb = $$('bt-stable'), ub = $$('bt-unstable')
    if (sb) sb.onclick = () => saveWave('stable')
    if (ub) ub.onclick = () => saveWave('unstable')
  }
  function hidePop() { const p = $$('bt-pop'); if (p) p.style.display = 'none' }

  // ---- control wiring (run once) ----
  let wired = false
  function wireControls() {
    if (wired) return
    wired = true
    // QA FIX: the floating #bt-pop (trade-detail popup, position:fixed z-index:9999) had no
    // outside-close. A trade-detail popup lingered over the chart and swallowed clicks meant for
    // boxes/markers underneath it. Dismiss it on any click that isn't inside the popup itself
    // (capture phase so it runs before the chart's own click handlers; clicks INSIDE the popup —
    // e.g. the STABLE/UNSTABLE wave buttons — are preserved). Esc also closes it.
    document.addEventListener('mousedown', (e) => {
      const p = $$('bt-pop')
      if (p && p.style.display !== 'none' && !p.contains(e.target)) hidePop()
    }, true)
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePop() })
    const onPrev = $$('bt-prev'), onNext = $$('bt-next')
    if (onPrev) onPrev.addEventListener('click', () => nav(-1))
    if (onNext) onNext.addEventListener('click', () => nav(1))
    const add = $$('bt-add')
    if (add) add.addEventListener('click', () => {
      const stream = $$('bt-stream').value, transform = $$('bt-transform').value
      const param = Math.max(1, Number($$('bt-param').value) || 30)
      const color = BT.PALETTE[BT.lines.length % BT.PALETTE.length]
      const L = { stream, transform, param, color }
      if (transform === 'MA') L.start = 1.0   // DEFAULT: skip the opening tick of the window
      BT.lines.push(L)
      saveLines(); renderLineList(); drawBT()
    })
    // PER-WAVE: add an MA line whose `start` = the selected wave box's t0 (enabled only when a wave is selected)
    const addWave = $$('bt-add-mawave')
    if (addWave) addWave.addEventListener('click', () => {
      if (!(BT.sel && BT.sel.type === 'wave')) return
      const b = selBox(); if (!b) return
      const stream = $$('bt-stream').value
      const param = Math.max(1, Number($$('bt-param').value) || 30)
      const color = BT.PALETTE[BT.lines.length % BT.PALETTE.length]
      BT.lines.push({ stream, transform: 'MA', param, color, start: +(+b.t0).toFixed(1) })
      saveLines(); renderLineList(); drawBT()
    })
    const list = $$('bt-lines')
    if (list) list.addEventListener('click', (e) => {
      const rm = e.target && e.target.getAttribute ? e.target.getAttribute('data-bt-rm') : null
      if (rm == null) return
      BT.lines.splice(Number(rm), 1); saveLines(); renderLineList(); drawBT()
    })
    const setMode = (m) => {
      BT.mode = (BT.mode === m) ? null : m
      BT.drag = null; hidePop()
      const wv = $$('bt-wave'), oc = $$('bt-oracle'), svg = $$('bt-chart')
      if (wv) { wv.style.color = BT.mode === 'wave' ? '#3ec46d' : 'var(--dim)'; wv.style.borderColor = BT.mode === 'wave' ? '#3ec46d' : 'var(--border)' }
      if (oc) { oc.style.color = BT.mode === 'oracle' ? '#d070d0' : 'var(--dim)'; oc.style.borderColor = BT.mode === 'oracle' ? '#d070d0' : 'var(--border)' }
      if (svg) svg.style.cursor = BT.mode ? 'crosshair' : ''
    }
    const wv = $$('bt-wave'), oc = $$('bt-oracle')
    if (wv) wv.addEventListener('click', () => setMode('wave'))
    if (oc) oc.addEventListener('click', () => setMode('oracle'))
    // edit/delete/undo/redo buttons
    const del = $$('bt-delete'); if (del) del.addEventListener('click', () => deleteSelected())
    const flip = $$('bt-flip'); if (flip) flip.addEventListener('click', () => flipWaveLabel())
    const ub = $$('bt-undo'); if (ub) ub.addEventListener('click', () => undo())
    const rb = $$('bt-redo'); if (rb) rb.addEventListener('click', () => redo())
    const fit = $$('bt-fit'); if (fit) fit.addEventListener('click', () => { const w = curWindow(); resetView(w ? (w.dur || 900) : 900); BT.pan = null; drawBT() })
    wireChartDrag()
    updateUndoButtons()
    // keyboard: nav + edit/delete/undo/redo — only when the backtest tab is visible and not typing
    window.addEventListener('keydown', (e) => {
      const vbt = $$('view-backtest'); if (!vbt || vbt.style.display === 'none') return
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return
      const k = e.key
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return }
      if (ctrl) return   // leave other ctrl-combos alone
      if (k === 'ArrowLeft') { e.preventDefault(); nav(-1) }
      else if (k === 'ArrowRight') { e.preventDefault(); nav(1) }
      else if (k === 'Delete' || k === 'Backspace') { if (BT.sel) { e.preventDefault(); deleteSelected() } }
      else if (k === '0' || k === 'f' || k === 'F') { e.preventDefault(); const w = curWindow(); resetView(w ? (w.dur || 900) : 900); BT.pan = null; drawBT() }
      else if (k === 's' || k === 'S') { if (BT.sel && BT.sel.type === 'wave') { e.preventDefault(); flipWaveLabel('stable') } }
      else if (k === 'u' || k === 'U') { if (BT.sel && BT.sel.type === 'wave') { e.preventDefault(); flipWaveLabel('unstable') } }
    })
  }
})()

// ============================================================================
// WINDOW ANALYSIS tab — full level-analysis over ALL tick history.
// Talks to the scan engine (Rust cta_scan if runnable, else the Node worker) via window.cta.scan.
// Every view: comboboxes for numeric inputs, canvas rendering, CSV export, and a shared filter bar.
// ============================================================================
;(function () {
  const $ = (id) => document.getElementById(id)
  const METRICS = [
    'mid', 'fair', 'dev', 'pf', 'cfmean', 'btc', 'strike', 'dist', 'sdist', 'spread',
    'secleft', 'elapsed', 'zstrike', 'sig', 'calk', 'ya', 'na', 'yb', 'nb',
    'tfi', 'tvol', 'btcobi', 'btcspread', 'mid_d1', 'mid_d2', 'tfi_cum', 'eth', 'sol',
    'hour', 'weekday', 'mv10', 'mv30', 'mv60', 'mv120', 'mv300', 'settle', 'settle_bin', 't'
  ]
  const AN = { inited: false, engine: '?', seq: 0, curSub: 'presets', last: {} }

  // ---- viridis-ish + diverging colormaps ----
  const VIRIDIS = [
    [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37]
  ]
  function lerp(a, b, t) { return a + (b - a) * t }
  function viridis(x) {
    x = Math.max(0, Math.min(1, x))
    const s = x * (VIRIDIS.length - 1), i = Math.floor(s), f = s - i
    const a = VIRIDIS[i], b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)]
    return 'rgb(' + Math.round(lerp(a[0], b[0], f)) + ',' + Math.round(lerp(a[1], b[1], f)) + ',' + Math.round(lerp(a[2], b[2], f)) + ')'
  }
  function diverging(x) { // x in [-1,1]: blue(neg) - dark(0) - amber(pos)
    x = Math.max(-1, Math.min(1, x))
    if (x >= 0) return 'rgb(' + Math.round(lerp(20, 240, x)) + ',' + Math.round(lerp(24, 160, x)) + ',' + Math.round(lerp(24, 0, x)) + ')'
    return 'rgb(' + Math.round(lerp(20, 40, -x)) + ',' + Math.round(lerp(24, 150, -x)) + ',' + Math.round(lerp(24, 230, -x)) + ')'
  }
  function divergingRGB(x) { // same map as diverging() but returns [r,g,b] for ImageData pixels
    x = Math.max(-1, Math.min(1, x))
    if (x >= 0) return [Math.round(lerp(20, 240, x)), Math.round(lerp(24, 160, x)), Math.round(lerp(24, 0, x))]
    return [Math.round(lerp(20, 40, -x)), Math.round(lerp(24, 150, -x)), Math.round(lerp(24, 230, -x))]
  }

  function status(msg, cls) { const s = $('an-status'); if (s) { s.textContent = msg; s.style.color = cls === 'err' ? 'var(--down)' : cls === 'ok' ? 'var(--up)' : 'var(--dim)' } }

  // ---- scan wrapper with renderer-side staleness (supersede) ----
  async function scan(query, key) {
    const myseq = ++AN.seq
    query.key = key || 'default'
    const t0 = performance.now()
    status('scanning…')
    let res
    try { res = await window.cta.scan(query) } catch (e) { status('scan error: ' + e, 'err'); return null }
    if (myseq !== AN.seq) return null // superseded — drop
    if (!res) { status('no result', 'err'); return null }
    if (res.cancelled) return null
    if (res.error) { status('engine error: ' + res.error, 'err'); return null }
    const ms = (performance.now() - t0).toFixed(0)
    AN.engine = res.engine || AN.engine
    status('done in ' + ms + ' ms · ' + (res.elapsed_ms != null ? 'scan ' + res.elapsed_ms + ' ms · ' : '') + 'engine ' + AN.engine, 'ok')
    return res
  }

  // ---- filter bar ----
  function parseDate(s, endOfDay) {
    s = (s || '').trim(); if (!s) return null
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (!m) return null
    return Date.UTC(+m[1], +m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0) / 1000
  }
  function num(el) { const e = $(el); const v = parseFloat(e && e.value); return isFinite(v) ? v : null }
  function getFilters() {
    const f = {}
    const df = parseDate($('an-f-from') && $('an-f-from').value, false); if (df != null) f.date_from = df
    const dt = parseDate($('an-f-to') && $('an-f-to').value, true); if (dt != null) f.date_to = dt
    const sln = num('an-f-slmin'); if (sln != null) f.secleft_min = sln
    const slx = num('an-f-slmax'); if (slx != null) f.secleft_max = slx
    const pn = num('an-f-pmin'); if (pn != null) f.price_min = pn
    const px = num('an-f-pmax'); if (px != null) f.price_max = px
    const oc = $('an-f-outcome') && $('an-f-outcome').value; if (oc) f.outcome = oc
    return f
  }

  // ---- small control builders ----
  function sel(id, opts, val) {
    return '<select id="' + id + '">' + opts.map((o) => '<option' + (o === val ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>'
  }
  function inp(id, val, list, w) {
    return '<input type="text" id="' + id + '" value="' + (val == null ? '' : val) + '"' + (list ? ' list="' + list + '"' : '') + (w ? ' style="width:' + w + 'px"' : '') + '>'
  }
  function debounce(fn, ms) { let h; return function () { const a = arguments, c = this; clearTimeout(h); h = setTimeout(() => fn.apply(c, a), ms) } }
  // lag is snapped to whole 5s bins (the perf grid) and clamped to ±300s
  function snap5(v) { v = Math.round((+v || 0) / 5) * 5; if (v < -300) v = -300; if (v > 300) v = 300; return v }
  // shared lag-slider markup (id-prefixed) used by both the 9x9 preset and the LAG MATRIX pane
  function lagControls(pfx, w) {
    return '<span class="cyan" style="font-weight:700">LAG</span>' +
      '<input type="range" id="' + pfx + '-slider" min="-300" max="300" step="5" value="0" style="width:' + (w || 320) + 'px">' +
      '<span class="lag-lbl" id="' + pfx + '-lbl">lag = 0s</span>' +
      ' exact ' + inp(pfx + '-num', 0, null, 52) + 's' +
      ' step ' + sel(pfx + '-step', ['5', '10', '30', '60'], '5') + 's'
  }
  // wire a lag-slider group; onLag(lagSec) fires (debounced for drag, immediate for typed/step)
  function wireLag(pfx, onLag) {
    const sl = $(pfx + '-slider'), lbl = $(pfx + '-lbl'), num = $(pfx + '-num'), st = $(pfx + '-step')
    const deb = debounce((v) => onLag(v), 150)
    const apply = (v, immediate) => { v = snap5(v); if (sl) sl.value = v; if (num) num.value = v; if (lbl) lbl.textContent = 'lag = ' + v + 's'; (immediate ? onLag : deb)(v) }
    if (sl) sl.oninput = () => apply(parseFloat(sl.value) || 0, false)
    if (num) num.onchange = () => apply(parseFloat(num.value) || 0, true)
    if (st) st.onchange = () => { const s = Math.max(5, parseInt(st.value) || 5); if (sl) sl.step = s; apply(Math.round((parseFloat(sl.value) || 0) / s) * s, true) }
    return { get: () => snap5(sl ? parseFloat(sl.value) : 0), set: (v) => apply(v, true) }
  }
  // jump to the Correlation Explorer for a pair, carrying the current lag (explorer's lag axis is in
  // ticks, not seconds — noted in the status line)
  function carryToCorr(a, b, lagSec) {
    switchSub('corr')
    if (lagSec) { const lm = $('co-lagmax'); if (lm) lm.value = Math.max(60, Math.abs(Math.round(lagSec))) }
    runCorr(a, b)
    status('opened ' + a + ' → ' + b + (lagSec ? ' · carried lag ' + lagSec + 's (5s-bin lag; explorer lag axis is in ticks)' : ''), 'ok')
  }

  // ---- CSV ----
  function downloadCSV(name, rows) {
    const csv = rows.map((r) => r.map((c) => { const s = String(c == null ? '' : c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 100)
  }

  function fmtNum(v) {
    if (!isFinite(v)) return '—'
    const a = Math.abs(v)
    if (a !== 0 && (a < 0.01 || a >= 1e5)) return v.toExponential(2)
    if (a >= 1000) return v.toFixed(0)
    if (a >= 1) return v.toFixed(2)
    return v.toFixed(4)
  }
  function tShort(sec) { try { const d = new Date(sec * 1000); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() } catch (e) { return '' } }
  function tFull(sec) { try { return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') } catch (e) { return '' } }

  // ---- ray-cast point-in-polygon (for 3D bar hover hit-testing) ----
  function pointInPoly(px, py, pts) {
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside
    }
    return inside
  }

  // ---- HEATMAP renderer (canvas) with hover tooltip + legend ----
  // opts.mode==='3d' -> orthographic isometric extruded-bar view (COLOR = the color aggregate `v`,
  // HEIGHT = the second aggregate `h`). Otherwise the flat 2D grid.
  function drawHeatmap(canvas, res, opts) {
    opts = opts || {}
    if (opts.mode === '3d') return drawHeatmap3D(canvas, res, opts)
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#070b07'; ctx.fillRect(0, 0, W, H)
    const mL = 60, mB = 42, mT = 12, mR = 92, pw = W - mL - mR, ph = H - mT - mB
    const nx = res.nx, ny = res.ny
    let vmin = Infinity, vmax = -Infinity
    for (const c of res.cells) { if (c.v < vmin) vmin = c.v; if (c.v > vmax) vmax = c.v }
    if (!isFinite(vmin)) { vmin = 0; vmax = 1 }
    const signed = (res.agg !== 'count') && (vmin < 0 && vmax > 0)
    const logScale = opts.log && res.agg === 'count'
    const amax = Math.max(Math.abs(vmin), Math.abs(vmax)) || 1
    const colorOf = (v) => {
      if (signed) return diverging(v / amax)
      let t = logScale ? Math.log1p(v - vmin) / Math.log1p(vmax - vmin || 1) : (v - vmin) / (vmax - vmin || 1)
      return viridis(t)
    }
    const cw = pw / nx, ch = ph / ny, grid = {}
    for (const c of res.cells) {
      grid[c.iy * nx + c.ix] = c
      const x = mL + c.ix * cw, y = mT + (ny - 1 - c.iy) * ch
      ctx.fillStyle = colorOf(c.v); ctx.fillRect(x, y, Math.ceil(cw) + 0.5, Math.ceil(ch) + 0.5)
    }
    ctx.strokeStyle = '#1c241c'; ctx.lineWidth = 1; ctx.strokeRect(mL, mT, pw, ph)
    // selection outlines (pivot "analyze in R" cell/region picks)
    if (opts.selSet && opts.selSet.size) {
      ctx.strokeStyle = '#f0a000'; ctx.lineWidth = 1.4
      for (const c of res.cells) {
        if (!opts.selSet.has(c.ix + ',' + c.iy)) continue
        const x = mL + c.ix * cw, y = mT + (ny - 1 - c.iy) * ch
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1))
      }
      ctx.lineWidth = 1
    }
    ctx.fillStyle = '#6b786b'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
    for (let i = 0; i <= 6; i++) { const fr = i / 6, vx = res.xmin + fr * (res.xmax - res.xmin); ctx.fillText(fmtNum(vx), mL + fr * pw, H - mB + 14) }
    ctx.save(); ctx.translate(14, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(res.ylabel, 0, 0); ctx.restore()
    ctx.fillText(res.xlabel, mL + pw / 2, H - 4)
    ctx.textAlign = 'right'
    for (let i = 0; i <= 5; i++) { const fr = i / 5, vy = res.ymin + fr * (res.ymax - res.ymin); ctx.fillText(fmtNum(vy), mL - 4, mT + (1 - fr) * ph + 3) }
    const lx = W - mR + 22, lw = 14, lh = ph
    for (let i = 0; i < lh; i++) { const t = i / lh; ctx.fillStyle = signed ? diverging(1 - 2 * t) : viridis(1 - t); ctx.fillRect(lx, mT + i, lw, 1) }
    ctx.strokeStyle = '#1c241c'; ctx.strokeRect(lx, mT, lw, lh)
    ctx.fillStyle = '#6b786b'; ctx.textAlign = 'left'
    const legLbl = (res.agg === 'count' ? 'count' : res.agg + '(' + res.zlabel + ')')
    ctx.fillText(fmtNum(signed ? amax : vmax), lx + lw + 3, mT + 8)
    ctx.fillText(fmtNum(signed ? 0 : (vmin + vmax) / 2), lx + lw + 3, mT + lh / 2)
    ctx.fillText(fmtNum(signed ? -amax : vmin), lx + lw + 3, mT + lh - 2)
    ctx.save(); ctx.translate(W - 6, mT + lh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(legLbl, 0, 0); ctx.restore()
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect()
      const sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
      if (sx < mL || sx > mL + pw || sy < mT || sy > mT + ph) { $('an-tooltip').style.display = 'none'; return }
      const ix = Math.floor((sx - mL) / cw), iy = ny - 1 - Math.floor((sy - mT) / ch)
      const c = grid[iy * nx + ix], tt = $('an-tooltip')
      if (!c) { tt.style.display = 'none'; return }
      const xlo = res.xmin + ix * res.xbin, ylo = res.ymin + iy * res.ybin
      tt.innerHTML = res.xlabel + ' ' + fmtNum(xlo) + '–' + fmtNum(xlo + res.xbin) + '<br>' + res.ylabel + ' ' + fmtNum(ylo) + '–' + fmtNum(ylo + res.ybin) + '<br><b>' + legLbl + ' = ' + fmtNum(c.v) + '</b><br>n = ' + c.n
      tt.style.display = 'block'; tt.style.left = (e.clientX + 14) + 'px'; tt.style.top = (e.clientY + 12) + 'px'
    }
    canvas.onmouseleave = () => { $('an-tooltip').style.display = 'none' }
    canvas.onclick = opts.onCellClick ? (e) => {
      const rect = canvas.getBoundingClientRect()
      const sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
      if (sx < mL || sx > mL + pw || sy < mT || sy > mT + ph) return
      const ix = Math.floor((sx - mL) / cw), iy = ny - 1 - Math.floor((sy - mT) / ch)
      const c = grid[iy * nx + ix]; if (c) opts.onCellClick(c)
    } : null
  }

  // ---- 3D isometric extruded-bar heatmap (orthographic 45° view) ----
  // COLOR = res.cells[].v (same aggregate/colormap as 2D). HEIGHT = res.cells[].h (second aggregate;
  // falls back to count n). Painter's algorithm, back-to-front by (ix+iy). No WebGL.
  function drawHeatmap3D(canvas, res, opts) {
    opts = opts || {}
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#070b07'; ctx.fillRect(0, 0, W, H)
    const mL = 46, mB = 26, mT = 26, mR = 92, pw = W - mL - mR, ph = H - mT - mB
    const nx = res.nx, ny = res.ny
    if (!res.cells.length) { ctx.fillStyle = '#6b786b'; ctx.font = '11px monospace'; ctx.fillText('no data', mL + 10, mT + 20); return }
    // --- color scale (identical rules to 2D) ---
    let vmin = Infinity, vmax = -Infinity
    for (const c of res.cells) { if (c.v < vmin) vmin = c.v; if (c.v > vmax) vmax = c.v }
    if (!isFinite(vmin)) { vmin = 0; vmax = 1 }
    const signed = (res.agg !== 'count') && (vmin < 0 && vmax > 0)
    const logColor = opts.log && res.agg === 'count'
    const amax = Math.max(Math.abs(vmin), Math.abs(vmax)) || 1
    const colorOf = (v) => {
      if (signed) return diverging(v / amax)
      const t = logColor ? Math.log1p(v - vmin) / (Math.log1p(vmax - vmin || 1) || 1) : (v - vmin) / (vmax - vmin || 1)
      return viridis(t)
    }
    // --- height scale ---
    const hRaw = (c) => (c.h != null ? c.h : c.n)
    let hlo = Infinity, hhi = -Infinity
    for (const c of res.cells) { const h = hRaw(c); if (isFinite(h)) { if (h < hlo) hlo = h; if (h > hhi) hhi = h } }
    if (!isFinite(hlo)) { hlo = 0; hhi = 1 }
    hlo = Math.min(0, hlo) // baseline at 0 for the (typical) non-negative height aggregates
    let hmax = (opts.hmax != null && isFinite(opts.hmax)) ? opts.hmax : hhi
    if (!(hmax > hlo)) hmax = hlo + 1
    const hlog = opts.hscale === 'log' && hlo >= 0
    const hnorm = (h) => {
      if (!isFinite(h)) return 0
      const t = hlog ? Math.log1p(h - hlo) / (Math.log1p(hmax - hlo) || 1) : (h - hlo) / ((hmax - hlo) || 1)
      return Math.max(0, Math.min(1, t))
    }
    // --- projection (orthographic isometric) ---
    const rIso = 0.5
    const Hbar = Math.max(24, Math.min(ph * 0.42, 230))
    let kx = Math.min(pw / (nx + ny), (ph - Hbar) / ((nx + ny) * rIso))
    if (!(kx > 0) || !isFinite(kx)) kx = 1
    const ky = kx * rIso
    const ox = mL + ny * kx
    const oy = mT + Hbar
    const proj = (gx, gy, barPx) => [ox + (gx - gy) * kx, oy + (gx + gy) * ky - barPx]
    const shade = (rgb, f) => { const m = rgb.match(/\d+/g); return m ? 'rgb(' + Math.round(m[0] * f) + ',' + Math.round(m[1] * f) + ',' + Math.round(m[2] * f) + ')' : rgb }
    const poly = (pts, fill) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 0.5; ctx.stroke()
    }
    // back-to-front: smaller (ix+iy) is farther, draw first
    const ordered = res.cells.slice().sort((a, b) => (a.ix + a.iy) - (b.ix + b.iy))
    const polys = []
    for (const c of ordered) {
      const barPx = hnorm(hRaw(c)) * Hbar
      const top = colorOf(c.v)
      const B10 = proj(c.ix + 1, c.iy, 0), B11 = proj(c.ix + 1, c.iy + 1, 0), B01 = proj(c.ix, c.iy + 1, 0)
      const T00 = proj(c.ix, c.iy, barPx), T10 = proj(c.ix + 1, c.iy, barPx), T11 = proj(c.ix + 1, c.iy + 1, barPx), T01 = proj(c.ix, c.iy + 1, barPx)
      const qR = [B10, B11, T11, T10], qL = [B01, B11, T11, T01], qT = [T00, T10, T11, T01]
      poly(qR, shade(top, 0.72)); poly(qL, shade(top, 0.5)); poly(qT, top)
      polys.push({ c, quads: [qR, qL, qT] })
    }
    // --- axes: ticks along the two front base edges + labels ---
    ctx.fillStyle = '#6b786b'; ctx.font = '10px monospace'
    ctx.textAlign = 'left'
    for (let i = 0; i <= 4; i++) { const fr = i / 4, p = proj(fr * nx, ny, 0), vx = res.xmin + fr * (res.xmax - res.xmin); ctx.fillText(fmtNum(vx), p[0] + 2, p[1] + 12) }
    ctx.textAlign = 'right'
    for (let i = 0; i <= 4; i++) { const fr = i / 4, p = proj(nx, fr * ny, 0), vy = res.ymin + fr * (res.ymax - res.ymin); ctx.fillText(fmtNum(vy), p[0] - 2, p[1] + 12) }
    ctx.textAlign = 'center'
    { const p = proj(nx / 2, ny, 0); ctx.fillText(res.xlabel, p[0] + 16, p[1] + 22) }
    { const p = proj(nx, ny / 2, 0); ctx.fillText(res.ylabel, p[0] - 20, p[1] + 22) }
    // --- color legend (right edge) ---
    const lx = W - mR + 22, lw = 14, lh = ph
    for (let i = 0; i < lh; i++) { const t = i / lh; ctx.fillStyle = signed ? diverging(1 - 2 * t) : viridis(1 - t); ctx.fillRect(lx, mT + i, lw, 1) }
    ctx.strokeStyle = '#1c241c'; ctx.strokeRect(lx, mT, lw, lh)
    const legLbl = (res.agg === 'count' ? 'count' : res.agg + '(' + res.zlabel + ')')
    ctx.fillStyle = '#6b786b'; ctx.textAlign = 'left'
    ctx.fillText(fmtNum(signed ? amax : vmax), lx + lw + 3, mT + 8)
    ctx.fillText(fmtNum(signed ? 0 : (vmin + vmax) / 2), lx + lw + 3, mT + lh / 2)
    ctx.fillText(fmtNum(signed ? -amax : vmin), lx + lw + 3, mT + lh - 2)
    ctx.save(); ctx.translate(W - 6, mT + lh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('COLOR ' + legLbl, 0, 0); ctx.restore()
    // --- height legend (top-left) + a small vertical reference bar ---
    const hlbl = (res.hagg || 'count') === 'count' ? 'count' : (res.hagg + '(' + (res.hzlabel || '') + ')')
    ctx.fillStyle = '#f0a000'; ctx.textAlign = 'left'
    ctx.fillText('HEIGHT ' + hlbl + (hlog ? ' (log)' : ''), 4, 11)
    ctx.fillStyle = '#6b786b'
    ctx.fillText('[' + fmtNum(hlo) + ' … ' + fmtNum(hmax) + ']', 4, 22)
    // --- hover: front-to-back hit test over the extruded bars ---
    canvas.onclick = null
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect()
      const sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
      let hit = null
      for (let i = polys.length - 1; i >= 0 && !hit; i--) { for (const q of polys[i].quads) { if (pointInPoly(sx, sy, q)) { hit = polys[i].c; break } } }
      const tt = $('an-tooltip')
      if (!hit) { tt.style.display = 'none'; return }
      const xlo = res.xmin + hit.ix * res.xbin, ylo = res.ymin + hit.iy * res.ybin
      tt.innerHTML = res.xlabel + ' ' + fmtNum(xlo) + '–' + fmtNum(xlo + res.xbin) + '<br>' + res.ylabel + ' ' + fmtNum(ylo) + '–' + fmtNum(ylo + res.ybin) +
        '<br><b>color ' + legLbl + ' = ' + fmtNum(hit.v) + '</b><br><b>height ' + hlbl + ' = ' + fmtNum(hit.h != null ? hit.h : hit.n) + '</b><br>n = ' + hit.n
      tt.style.display = 'block'; tt.style.left = (e.clientX + 14) + 'px'; tt.style.top = (e.clientY + 12) + 'px'
    }
    canvas.onmouseleave = () => { $('an-tooltip').style.display = 'none' }
  }

  // ---- line/scatter/bar helper ----
  function drawXY(canvas, series, opts) {
    opts = opts || {}
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#070b07'; ctx.fillRect(0, 0, W, H)
    const mL = 54, mB = 30, mT = 10, mR = 12, pw = W - mL - mR, ph = H - mT - mB
    let xmin = opts.xmin, xmax = opts.xmax, ymin = opts.ymin, ymax = opts.ymax
    const allpts = []; for (const s of series) for (const p of s.pts) allpts.push(p)
    if (xmin == null) { xmin = Infinity; xmax = -Infinity; for (const p of allpts) { if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0] } }
    if (ymin == null) { ymin = Infinity; ymax = -Infinity; for (const p of allpts) { if (isFinite(p[1])) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1] } } }
    if (!isFinite(xmin)) { xmin = 0; xmax = 1 }
    if (!isFinite(ymin)) { ymin = 0; ymax = 1 }
    if (xmax === xmin) xmax = xmin + 1
    if (ymax === ymin) ymax = ymin + 1
    const X = (v) => mL + (v - xmin) / (xmax - xmin) * pw
    const Y = (v) => mT + (1 - (v - ymin) / (ymax - ymin)) * ph
    ctx.strokeStyle = '#1c241c'; ctx.strokeRect(mL, mT, pw, ph)
    if (ymin < 0 && ymax > 0) { ctx.strokeStyle = '#33443a'; ctx.beginPath(); ctx.moveTo(mL, Y(0)); ctx.lineTo(mL + pw, Y(0)); ctx.stroke() }
    if (opts.xzero && xmin < 0 && xmax > 0) { ctx.strokeStyle = '#33443a'; ctx.beginPath(); ctx.moveTo(X(0), mT); ctx.lineTo(X(0), mT + ph); ctx.stroke() }
    ctx.fillStyle = '#6b786b'; ctx.font = '10px monospace'; ctx.textAlign = 'right'
    for (let i = 0; i <= 4; i++) { const fr = i / 4, vy = ymin + fr * (ymax - ymin); ctx.fillText(fmtNum(vy), mL - 3, mT + (1 - fr) * ph + 3) }
    ctx.textAlign = 'center'
    for (let i = 0; i <= 5; i++) { const fr = i / 5, vx = xmin + fr * (xmax - xmin); ctx.fillText(opts.xtime ? tShort(vx) : fmtNum(vx), mL + fr * pw, H - mB + 14) }
    if (opts.xlabel) ctx.fillText(opts.xlabel, mL + pw / 2, H - 3)
    for (const s of series) {
      if (s.type === 'scatter') {
        ctx.fillStyle = s.color || 'rgba(79,208,224,0.4)'
        for (const p of s.pts) { if (isFinite(p[1])) ctx.fillRect(X(p[0]) - 0.8, Y(p[1]) - 0.8, 1.6, 1.6) }
      } else if (s.type === 'bar') {
        const bw = pw / s.pts.length
        for (let i = 0; i < s.pts.length; i++) { const p = s.pts[i]; ctx.fillStyle = s.color || '#4fd0e0'; const y = Y(Math.max(0, p[1])), h = Math.abs(Y(p[1]) - Y(0)); ctx.fillRect(X(p[0]) - bw / 2 + 0.5, y, Math.max(1, bw - 1), Math.max(1, h)) }
      } else {
        ctx.strokeStyle = s.color || '#f0a000'; ctx.lineWidth = s.w || 1.4; ctx.beginPath()
        let started = false
        for (const p of s.pts) { if (!isFinite(p[1])) { started = false; continue } const xx = X(p[0]), yy = Y(p[1]); if (!started) { ctx.moveTo(xx, yy); started = true } else ctx.lineTo(xx, yy) }
        ctx.stroke()
      }
    }
    if (opts.title) { ctx.fillStyle = '#6b786b'; ctx.textAlign = 'left'; ctx.fillText(opts.title, mL + 4, mT + 11) }
  }

  // ============ R STATS SIDECAR ============
  function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
  function kvTable(pairs) {
    return '<table class="sig"><tbody>' + pairs.map((p) => '<tr><td class="dim" style="padding-right:12px">' + escHtml(p[0]) + '</td><td class="r">' + (p[1] == null ? '—' : (typeof p[1] === 'number' ? fmtNum(p[1]) : escHtml(p[1]))) + '</td></tr>').join('') + '</tbody></table>'
  }
  function renderRResult(el, resp, meta) {
    if (!el) return
    el.style.display = 'block'
    if (!resp) { el.innerHTML = '<span class="down">R: no result</span>'; return }
    if (!resp.ok) {
      el.innerHTML = '<b class="down">R error:</b> ' + escHtml(resp.error || '?') +
        (resp.stdout ? '<br><span class="dim">stdout: ' + escHtml(resp.stdout) + '</span>' : '') +
        (resp.stderr ? '<br><span class="dim">stderr: ' + escHtml(resp.stderr) + '</span>' : '')
      return
    }
    const r = resp.result || {}
    const hdr = '<div class="dim" style="font-size:10px;margin-bottom:4px;">R · ' + escHtml(r.analysis || '') + (meta ? ' · ' + escHtml(meta) : '') + '</div>'
    let body = ''
    if (r.analysis === 'cor') {
      body = kvTable([['x → y', r.x + ' → ' + r.y], ['n', r.n], ['Pearson r', r.r], ['p-value', r.p], ['95% CI', fmtNum(r.ci_lo) + ' … ' + fmtNum(r.ci_hi)], ['t', r.t], ['df', r.df]])
    } else if (r.analysis === 'lm') {
      body = kvTable([['model', r.y + ' ~ ' + r.x], ['n', r.n], ['intercept', r.intercept], ['slope', r.slope], ['R²', r.r2], ['adj R²', r.adj_r2], ['slope p', r.slope_p], ['model p', r.model_p], ['resid sd', r.resid_sd], ['loess resid sd', r.loess_resid_sd], ['loess span', r.loess_span]])
    } else if (r.analysis === 'acf') {
      const rows = (r.lags || []).map((l) => '<tr><td class="r dim">' + l.lag + '</td><td class="r">' + fmtNum(l.acf) + '</td></tr>').join('')
      body = '<div class="dim">n=' + r.n + ' · lag.max=' + r.lag_max + '</div><table class="sig"><thead><tr><th class="r">lag</th><th class="r">acf</th></tr></thead><tbody>' + rows + '</tbody></table>'
    } else if (r.analysis === 'kmeans') {
      const cols = r.cols || []
      const head = '<tr><th class="r">cluster</th><th class="r">n</th>' + cols.map((c) => '<th class="r">' + escHtml(c) + '</th>').join('') + '</tr>'
      const rows = (r.centers || []).map((c, i) => '<tr><td class="r">' + c.cluster + '</td><td class="r dim">' + (r.sizes ? r.sizes[i] : '') + '</td>' + cols.map((cn) => '<td class="r">' + fmtNum(c.means ? c.means[cn] : NaN) + '</td>').join('') + '</tr>').join('')
      body = '<div class="dim">k=' + r.k + ' · n=' + r.n + ' · tot.withinss=' + fmtNum(r.tot_withinss) + ' · betweenss=' + fmtNum(r.betweenss) + ' (' + fmtNum(100 * r.betweenss / (r.totss || 1)) + '% of total)</div>' +
        '<table class="sig"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>'
    } else if (r.analysis === 'summary') {
      const keys = ['name', 'n', 'mean', 'sd', 'min', 'q1', 'median', 'q3', 'max', 'skew', 'kurt']
      const head = '<tr>' + keys.map((k) => '<th class="r">' + k + '</th>').join('') + '</tr>'
      const rows = (r.columns || []).map((c) => '<tr>' + keys.map((k) => '<td class="r' + (k === 'name' ? ' cyan' : '') + '">' + (k === 'name' ? escHtml(c[k]) : fmtNum(c[k])) + '</td>').join('') + '</tr>').join('')
      body = '<table class="sig"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>'
    } else {
      body = '<pre style="white-space:pre-wrap">' + escHtml(JSON.stringify(r, null, 1)) + '</pre>'
    }
    el.innerHTML = hdr + body
  }
  async function analyzeInR(outId, analysis, columns, rows, p1, meta) {
    const el = $(outId); if (!el) return
    if (AN.rAvail === false) { el.style.display = 'block'; el.innerHTML = '<span class="down">R unavailable:</span> <span class="dim">' + escHtml(AN.rReason || '') + '</span>'; return }
    if (!rows || !rows.length) { el.style.display = 'block'; el.innerHTML = '<span class="dim">no rows to analyze</span>'; return }
    el.style.display = 'block'; el.innerHTML = '<span class="dim">running R (' + escHtml(analysis) + ', n=' + rows.length + ')…</span>'
    let resp
    try { resp = await window.cta.rAnalyze({ analysis, columns, rows, params: { p1 } }) }
    catch (e) { el.innerHTML = '<span class="down">R IPC error: ' + escHtml(String(e)) + '</span>'; return }
    renderRResult(el, resp, meta)
  }

  // ============ PANES ============
  function buildPivot() {
    const p = $('an-pane-pivot')
    p.innerHTML =
      '<div class="an-ctrls">' +
      '<span class="cyan" style="font-weight:700">X</span>' + sel('pv-x', METRICS, 'elapsed') + ' bin ' + inp('pv-xbin', 60, 'dl-binsec', 60) + ' min ' + inp('pv-xmin', '', null, 56) + ' max ' + inp('pv-xmax', '', null, 56) +
      '<span class="cyan" style="font-weight:700;margin-left:8px">Y</span>' + sel('pv-y', METRICS, 'pf') + ' bin ' + inp('pv-ybin', 0.05, 'dl-binprice', 60) + ' min ' + inp('pv-ymin', '', null, 56) + ' max ' + inp('pv-ymax', '', null, 56) +
      '</div><div class="an-ctrls">' +
      '<span class="cyan" style="font-weight:700">COLOR</span>' + sel('pv-agg', ['count', 'mean', 'median'], 'mean') + ' of ' + sel('pv-z', METRICS, 'mv60') +
      ' <label><input type="checkbox" id="pv-log"> log(count)</label>' +
      '<span class="an-btn" id="pv-run">run</span><span class="an-btn sub" id="pv-csv">CSV</span>' +
      '</div><div class="an-ctrls">' +
      '<span class="an-btn sub" id="pv-mode">view: 2D</span>' +
      '<span class="amber" style="font-weight:700">HEIGHT</span>' + sel('pv-hagg', ['count', 'mean', 'median'], 'count') + ' of ' + sel('pv-hz', METRICS, 'mv60') +
      ' scale ' + sel('pv-hscale', ['linear', 'log'], 'linear') + ' max ' + inp('pv-hmax', '', null, 56) +
      '<span class="dim" style="font-size:10px">(3D: color = COLOR agg · height = HEIGHT agg)</span>' +
      '</div><div class="an-ctrls">' +
      '<span class="an-btn sub" id="pv-rbtn">analyze in R</span>' + sel('pv-ran', ['summary', 'kmeans'], 'summary') + ' k ' + inp('pv-k', 3, 'dl-k', 36) +
      '<span class="an-btn sub" id="pv-selclr">clear sel</span><span class="dim" id="pv-selinfo"></span>' +
      '</div>' +
      '<canvas id="pv-canvas" width="1160" height="440"></canvas>' +
      '<div class="an-rout" id="pv-rout" style="display:none;"></div>'
    $('pv-run').onclick = () => runPivot()
    $('pv-csv').onclick = () => { const r = AN.last.pivot; if (!r) return; const rows = [['ix', 'iy', 'x_lo', 'y_lo', 'value', 'n', 'height']]; for (const c of r.cells) rows.push([c.ix, c.iy, r.xmin + c.ix * r.xbin, r.ymin + c.iy * r.ybin, c.v, c.n, (c.h != null ? c.h : c.n)]); downloadCSV('pivot_' + r.xlabel + '_x_' + r.ylabel + '.csv', rows) }
    $('pv-log').onchange = drawPivotNow
    $('pv-hscale').onchange = drawPivotNow
    $('pv-hmax').onchange = drawPivotNow
    $('pv-mode').onclick = () => { AN.pivotMode = (AN.pivotMode === '3d') ? '2d' : '3d'; $('pv-mode').textContent = 'view: ' + (AN.pivotMode === '3d' ? '3D' : '2D'); drawPivotNow() }
    $('pv-hagg').onchange = () => { if (AN.last.pivot) runPivot() }
    $('pv-hz').onchange = () => { if (AN.last.pivot && $('pv-hagg').value !== 'count') runPivot() }
    $('pv-selclr').onclick = () => { AN.pivotSel = new Set(); drawPivotNow() }
    $('pv-rbtn').onclick = () => {
      const r = AN.last.pivot; if (!r) { renderRResult($('pv-rout'), { ok: false, error: 'run a pivot first' }); return }
      const s = AN.pivotSel
      const cells = (s && s.size) ? r.cells.filter((c) => s.has(c.ix + ',' + c.iy)) : r.cells
      const rows = cells.map((c) => [r.xmin + (c.ix + 0.5) * r.xbin, r.ymin + (c.iy + 0.5) * r.ybin, c.v, c.n, (c.h != null ? c.h : c.n)])
      analyzeInR('pv-rout', $('pv-ran').value, ['x', 'y', 'color', 'count', 'height'], rows, parseFloat($('pv-k').value) || 3, (s && s.size ? s.size + ' selected cells' : cells.length + ' cells'))
    }
  }
  function drawPivotNow() {
    const r = AN.last.pivot; if (!r) return
    if (!AN.pivotSel) AN.pivotSel = new Set()
    drawHeatmap($('pv-canvas'), r, {
      log: $('pv-log').checked, mode: AN.pivotMode === '3d' ? '3d' : '2d',
      hscale: $('pv-hscale').value, hmax: num('pv-hmax'),
      selSet: AN.pivotMode === '3d' ? null : AN.pivotSel,
      onCellClick: AN.pivotMode === '3d' ? null : onPivotCellClick
    })
    const s = $('pv-selinfo')
    if (s) s.textContent = ' ' + (AN.pivotSel.size ? AN.pivotSel.size + ' cells selected' : 'no selection → R uses all cells') + (AN.pivotMode === '3d' ? ' · (click-select in 2D)' : ' · click cells to select')
  }
  function onPivotCellClick(c) {
    if (!AN.pivotSel) AN.pivotSel = new Set()
    const k = c.ix + ',' + c.iy
    if (AN.pivotSel.has(k)) AN.pivotSel.delete(k); else AN.pivotSel.add(k)
    drawPivotNow()
  }
  async function runPivot() {
    const q = {
      type: 'pivot', filters: getFilters(),
      x: { metric: $('pv-x').value, bin: parseFloat($('pv-xbin').value), min: num('pv-xmin'), max: num('pv-xmax') },
      y: { metric: $('pv-y').value, bin: parseFloat($('pv-ybin').value), min: num('pv-ymin'), max: num('pv-ymax') },
      agg: $('pv-agg').value, z: $('pv-z').value,
      hagg: $('pv-hagg').value, hz: $('pv-hz').value
    }
    if (q.x.min == null) delete q.x.min
    if (q.x.max == null) delete q.x.max
    if (q.y.min == null) delete q.y.min
    if (q.y.max == null) delete q.y.max
    const r = await scan(q, 'pivot'); if (!r) return
    AN.last.pivot = r; drawPivotNow()
  }

  function buildCorr() {
    const p = $('an-pane-corr')
    p.innerHTML =
      '<div class="an-ctrls">' +
      '<span class="cyan" style="font-weight:700">A</span>' + sel('co-a', METRICS, 'tfi') +
      ' <span class="cyan" style="font-weight:700">vs B</span>' + sel('co-b', METRICS, 'mv60') +
      ' lag± ' + inp('co-lagmax', 60, 'dl-lag', 56) + ' step ' + inp('co-lagstep', 1, null, 40) + ' roll(ticks) ' + inp('co-roll', 300, null, 60) +
      '<span class="an-btn" id="co-run">run</span><span class="an-btn sub" id="co-csv">CSV</span>' +
      '<span class="dim" id="co-r"></span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:320px;"><div class="dim" style="font-size:10px;">A vs B scatter (≤5k pts)</div><canvas id="co-scatter" width="560" height="300"></canvas></div>' +
      '<div style="flex:1;min-width:320px;"><div class="dim" style="font-size:10px;">lag scan — r(A[i], B[i+lag])</div><canvas id="co-lag" width="560" height="300"></canvas></div>' +
      '</div>' +
      '<div class="dim" style="font-size:10px;margin-top:4px;">rolling correlation over time</div><canvas id="co-roll" width="1160" height="220"></canvas>' +
      '<div class="an-ctrls" style="margin-top:8px;">' +
      '<span class="an-btn sub" id="co-rbtn">analyze in R</span>' + sel('co-ran', ['cor.test', 'lm+loess', 'acf'], 'cor.test') + ' acf lag.max ' + inp('co-lagm', 20, null, 40) +
      '<span class="dim" style="font-size:10px">on the scatter sample (≤5k pts)</span></div>' +
      '<div class="an-rout" id="co-rout" style="display:none;"></div>'
    $('co-run').onclick = () => runCorr()
    $('co-csv').onclick = () => { const r = AN.last.corr; if (!r) return; const rows = [['lag', 'r', 'n']]; for (const l of r.lags) rows.push([l.lag, l.r, l.n]); downloadCSV('corr_lag_' + r.a + '_' + r.b + '.csv', rows) }
    $('co-rbtn').onclick = () => {
      const r = AN.last.corr; if (!r || !r.scatter || !r.scatter.length) { renderRResult($('co-rout'), { ok: false, error: 'run a correlation first' }); return }
      const sel2 = $('co-ran').value
      if (sel2 === 'acf') analyzeInR('co-rout', 'acf', [r.b], r.scatter.map((p) => [p[1]]), parseFloat($('co-lagm').value) || 20, 'acf of ' + r.b)
      else analyzeInR('co-rout', sel2 === 'lm+loess' ? 'lm' : 'cor', [r.a, r.b], r.scatter.map((p) => [p[0], p[1]]), null, r.a + ' vs ' + r.b)
    }
  }
  async function runCorr(pa, pb) {
    const q = {
      type: 'corr', filters: getFilters(),
      a: typeof pa === 'string' ? pa : $('co-a').value, b: typeof pb === 'string' ? pb : $('co-b').value,
      lag_max: parseFloat($('co-lagmax').value) || 60, lag_step: parseFloat($('co-lagstep').value) || 1, roll: parseFloat($('co-roll').value) || 300
    }
    if (typeof pa === 'string') { $('co-a').value = pa; $('co-b').value = pb }
    const r = await scan(q, 'corr'); if (!r) return
    AN.last.corr = r
    $('co-r').textContent = ' Pearson r = ' + fmtNum(r.r) + ' (n=' + r.n + ')'
    drawXY($('co-scatter'), [{ type: 'scatter', pts: r.scatter, color: 'rgba(79,208,224,0.35)' }], { xlabel: r.a + ' → ' + r.b })
    let la = 0.05; for (const l of r.lags) la = Math.max(la, Math.abs(l.r) || 0)
    drawXY($('co-lag'), [{ type: 'line', pts: r.lags.map((l) => [l.lag, l.r]), color: '#f0a000' }], { xzero: true, xlabel: 'lag (ticks)', ymin: -la, ymax: la })
    drawXY($('co-roll'), [{ type: 'line', pts: r.rolling, color: '#3ec46d' }], { xtime: true, xlabel: 'time' })
  }

  function buildWindows() {
    const p = $('an-pane-windows')
    p.innerHTML =
      '<div class="an-ctrls">' +
      '<span class="an-btn" id="wb-run">load window catalog</span><span class="an-btn sub" id="wb-csv">CSV</span>' +
      ' sort ' + sel('wb-sort', ['t0', 'range', 'rvol', 'path_eff', 'drift', 'tfi_sum', 'dist_open', 'settle'], 't0') + sel('wb-dir', ['desc', 'asc'], 'desc') +
      ' <label>outcome ' + sel('wb-oc', ['any', 'YES', 'NO'], 'any') + '</label>' +
      '<span class="an-btn sub" id="wb-rbtn">analyze in R</span>' + sel('wb-ran', ['summary', 'kmeans'], 'summary') + ' k ' + inp('wb-k', 3, 'dl-k', 36) +
      '<span class="dim" id="wb-info"></span></div>' +
      '<div style="max-height:520px;overflow:auto;"><table class="sig"><thead><tr>' +
      ['#', 'DATE (UTC)', 'TICKER', 'DUR', 'N', 'BTC RANGE', 'PATH-EFF', 'RVOL', 'DRIFT', 'TFI SUM', 'OBI MEAN', 'STRIKE', 'DIST OPEN', 'DIST CLOSE', 'SETTLE'].map((h) => '<th class="r">' + h + '</th>').join('') +
      '</tr></thead><tbody id="wb-tbody"></tbody></table></div>' +
      '<div class="an-rout" id="wb-rout" style="display:none;"></div>'
    $('wb-run').onclick = runWindows
    $('wb-sort').onchange = renderWindows; $('wb-dir').onchange = renderWindows; $('wb-oc').onchange = renderWindows
    $('wb-csv').onclick = () => { const r = AN.last.windows; if (!r) return; const rows = [['wi', 'tk', 't0_iso', 'dur', 'n', 'range', 'path_eff', 'rvol', 'drift', 'tfi_sum', 'obi_mean', 'strike', 'dist_open', 'dist_close', 'settle', 'settle_bin']]; for (const w of r.rows) rows.push([w.wi, w.tk, tFull(w.t0), w.dur, w.n, w.range, w.path_eff, w.rvol, w.drift, w.tfi_sum, w.obi_mean, w.strike, w.dist_open, w.dist_close, w.settle, w.settle_bin]); downloadCSV('window_catalog.csv', rows) }
    $('wb-rbtn').onclick = () => {
      const r = AN.last.windows; if (!r) { renderRResult($('wb-rout'), { ok: false, error: 'load the window catalog first' }); return }
      const oc = $('wb-oc').value
      let rws = r.rows.slice()
      if (oc !== 'any') rws = rws.filter((w) => (oc === 'YES' ? w.settle_bin === 1 : w.settle_bin === 0))
      const cols = ['range', 'rvol', 'path_eff', 'drift', 'tfi_sum', 'dist_open', 'dist_close']
      const rows = rws.map((w) => cols.map((c) => w[c]))
      analyzeInR('wb-rout', $('wb-ran').value, cols, rows, parseFloat($('wb-k').value) || 3, rws.length + ' windows' + (oc !== 'any' ? ' (' + oc + ')' : ''))
    }
  }
  async function runWindows() {
    const r = await scan({ type: 'windows', filters: getFilters() }, 'windows'); if (!r) return
    AN.last.windows = r
    const pr = (key) => { const arr = r.rows.map((w) => w[key]).filter((v) => isFinite(v)).sort((a, b) => a - b); return (v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m } return arr.length ? Math.round(lo / arr.length * 100) : 0 } }
    AN.winPct = { range: pr('range'), rvol: pr('rvol') }
    renderWindows()
  }
  function renderWindows() {
    const r = AN.last.windows; if (!r) return
    const sortk = $('wb-sort').value, dir = $('wb-dir').value === 'asc' ? 1 : -1, oc = $('wb-oc').value
    let rows = r.rows.slice()
    if (oc !== 'any') rows = rows.filter((w) => (oc === 'YES' ? w.settle_bin === 1 : w.settle_bin === 0))
    rows.sort((a, b) => (a[sortk] - b[sortk]) * dir)
    const P = AN.winPct || {}
    $('wb-tbody').innerHTML = rows.slice(0, 800).map((w, i) => {
      const rp = P.range ? P.range(w.range) : 0, vp = P.rvol ? P.rvol(w.rvol) : 0, sc = w.settle_bin === 1 ? 'up' : 'down'
      return '<tr><td class="r dim">' + (i + 1) + '</td><td class="r">' + tFull(w.t0) + '</td><td class="r dim">' + w.tk + '</td>' +
        '<td class="r">' + (w.dur / 60).toFixed(1) + 'm</td><td class="r dim">' + w.n + '</td>' +
        '<td class="r">$' + fmtNum(w.range) + ' <span class="dim">p' + rp + '</span></td>' +
        '<td class="r">' + w.path_eff.toFixed(3) + '</td>' +
        '<td class="r">' + fmtNum(w.rvol) + ' <span class="dim">p' + vp + '</span></td>' +
        '<td class="r ' + (w.drift >= 0 ? 'up' : 'down') + '">' + (w.drift >= 0 ? '+' : '') + fmtNum(w.drift) + '</td>' +
        '<td class="r ' + (w.tfi_sum >= 0 ? 'up' : 'down') + '">' + fmtNum(w.tfi_sum) + '</td>' +
        '<td class="r dim">' + fmtNum(w.obi_mean) + '</td><td class="r dim">' + fmtNum(w.strike) + '</td>' +
        '<td class="r">' + fmtNum(w.dist_open) + '</td><td class="r">' + fmtNum(w.dist_close) + '</td>' +
        '<td class="r ' + sc + '">' + (w.settle_bin === 1 ? 'YES' : 'NO') + ' ' + fmtNum(w.settle) + '</td></tr>'
    }).join('')
    $('wb-info').textContent = ' ' + rows.length + ' windows (showing ' + Math.min(800, rows.length) + ')'
  }

  function buildDist() {
    const p = $('an-pane-dist')
    p.innerHTML =
      '<div class="an-ctrls">' +
      '<span class="cyan" style="font-weight:700">metric</span>' + sel('di-m', METRICS, 'mv60') + ' bins ' + inp('di-bins', 60, null, 50) +
      ' min ' + inp('di-min', '', null, 56) + ' max ' + inp('di-max', '', null, 56) +
      ' <label><input type="checkbox" id="di-log"> log(count)</label>' +
      '<span class="an-btn" id="di-run">run</span><span class="an-btn sub" id="di-csv">CSV</span>' +
      '<span class="dim" id="di-stats"></span></div>' +
      '<canvas id="di-canvas" width="1160" height="360"></canvas>'
    $('di-run').onclick = runDist
    $('di-log').onchange = () => { if (AN.last.dist) renderDist(AN.last.dist) }
    $('di-csv').onclick = () => { const r = AN.last.dist; if (!r) return; const rows = [['lo', 'hi', 'n']]; for (const b of r.bins) rows.push([b.lo, b.hi, b.n]); downloadCSV('dist_' + r.metric + '.csv', rows) }
  }
  async function runDist() {
    const q = { type: 'dist', filters: getFilters(), metric: $('di-m').value, bins: parseFloat($('di-bins').value) || 60 }
    const mn = num('di-min'), mx = num('di-max'); if (mn != null) q.min = mn; if (mx != null) q.max = mx
    const r = await scan(q, 'dist'); if (!r) return
    AN.last.dist = r; renderDist(r)
  }
  function renderDist(r) {
    if (!r.bins.length) { drawXY($('di-canvas'), [], {}); $('di-stats').textContent = ' no data'; return }
    const log = $('di-log').checked
    const pts = r.bins.map((b) => [(b.lo + b.hi) / 2, log ? Math.log1p(b.n) : b.n])
    drawXY($('di-canvas'), [{ type: 'bar', pts, color: '#4fd0e0' }], { xlabel: r.metric, ymin: 0, xzero: true })
    $('di-stats').textContent = ' n=' + r.n + ' · mean ' + fmtNum(r.mean) + ' · median ' + fmtNum(r.median) + ' · std ' + fmtNum(r.std) + ' · p5 ' + fmtNum(r.p5) + ' · p95 ' + fmtNum(r.p95)
  }

  // ---- LAG MATRIX (all-metrics × all-metrics, lag-scannable) ----
  function buildLagMatrix() {
    const p = $('an-pane-lagmatrix')
    p.innerHTML =
      '<div class="an-ctrls">' + lagControls('lm', 340) +
      ' <span class="lm-mode on" id="lm-cur">current-lag</span><span class="lm-mode" id="lm-peak">PEAK</span>' +
      ' min|r| ' + inp('lm-minr', 0.05, 'dl-minr', 50) +
      ' <label class="mm-tog" title="darken pairs whose metrics are mathematically entangled (same lag-0 equivalence class) so only real cross-signal correlations light up"><input type="checkbox" id="lm-realonly" checked> real signals only</label>' +
      ' <label class="mm-tog" title="in PEAK mode, darken cells whose peak is at lag 0 (simultaneous = not tradable)"><input type="checkbox" id="lm-tradable" checked> tradable lags only</label>' +
      ' <span class="dim" id="lm-peakctl">peak lag± ' + inp('lm-peakmax', 300, 'dl-lag', 46) + 's step ' + sel('lm-peakstep', ['5', '10', '30', '60'], '30') + 's</span>' +
      '<span class="an-btn" id="lm-run">run</span><span class="an-btn sub" id="lm-csv">CSV</span>' +
      '</div>' +
      '<div class="lm-cap">every metric × every metric · <b>positive lag = ROW leads COLUMN</b> · r(row_t, col_{t+lag}) · 5s bins within each 15-min window (lag never crosses the boundary) · forward-looking mv*/settle EXCLUDED from axes (still available in the Pivot Builder) · <b>PEAK</b> = max |r| over the whole lag range (tooltip shows the argmax lag) · click a cell → Correlation Explorer' +
      '<br>slider steps are snapped to ≥5s (the bin size) — sub-bin lags are meaningless.</div>' +
      '<div class="lm-cap mm-legend" id="lm-legend"></div>' +
      '<div class="lm-cap" id="lm-cap2"></div>' +
      '<canvas id="lm-canvas" width="1180" height="1180" style="max-width:1180px;"></canvas>'
    AN.lmMode = 'current'
    AN.lmLag = wireLag('lm', () => { if (AN.lmMode !== 'peak') runLagMatrix() })
    const setMode = (m) => { AN.lmMode = m; $('lm-cur').classList.toggle('on', m === 'current'); $('lm-peak').classList.toggle('on', m === 'peak'); $('lm-peakctl').style.color = m === 'peak' ? 'var(--cyan)' : ''; runLagMatrix() }
    $('lm-cur').onclick = () => setMode('current')
    $('lm-peak').onclick = () => setMode('peak')
    $('lm-run').onclick = () => runLagMatrix()
    $('lm-minr').onchange = () => { if (AN.last.lagmatrix) drawLagMatrix() }
    if (AN.lmRealOnly === undefined) AN.lmRealOnly = true
    if (AN.lmTradable === undefined) AN.lmTradable = true
    $('lm-realonly').checked = AN.lmRealOnly; $('lm-tradable').checked = AN.lmTradable
    $('lm-realonly').onchange = () => { AN.lmRealOnly = $('lm-realonly').checked; if (AN.last.lagmatrix) drawLagMatrix() }
    $('lm-tradable').onchange = () => { AN.lmTradable = $('lm-tradable').checked; if (AN.last.lagmatrix) drawLagMatrix() }
    $('lm-peakmax').onchange = () => { if (AN.lmMode === 'peak') runLagMatrix() }
    $('lm-peakstep').onchange = () => { if (AN.lmMode === 'peak') runLagMatrix() }
    $('lm-csv').onclick = () => {
      const r = AN.last.lagmatrix; if (!r) return
      const M = r.metrics, classOf = r.classOf || {}, realOnly = AN.lmRealOnly !== false, tradable = AN.lmTradable !== false
      const dark = (a, b) => { if (realOnly) { if (M[a] === M[b]) return 1; const ca = classOf[M[a]], cb = classOf[M[b]]; if (ca != null && cb != null && ca === cb) return 1 } if (tradable && r.mode === 'peak' && r.lagmat && r.lagmat[a][b] === 0) return 1; return 0 }
      const rows = [['row_metric', 'col_metric', 'r', 'n', (r.mode === 'peak' ? 'argmax_lag_s' : 'lag_s')]]
      let skipped = 0
      for (let a = 0; a < M.length; a++) for (let b = 0; b < M.length; b++) {
        if (dark(a, b)) { skipped++; continue }
        const lg = r.mode === 'peak' ? (r.lagmat ? r.lagmat[a][b] : '') : r.lag
        rows.push([M[a], M[b], r.matrix[a][b], r.nmat ? r.nmat[a][b] : '', lg])
      }
      downloadCSV('lagmatrix_' + r.mode + '_' + (r.mode === 'peak' ? 'peak' : r.lag + 's') + '.csv', rows)
      status('exported ' + (rows.length - 1) + ' real cells' + ((realOnly || tradable) && skipped ? ' (' + skipped + ' entangled/non-tradable filtered)' : ''), 'ok')
    }
  }
  async function runLagMatrix() {
    const mode = AN.lmMode === 'peak' ? 'peak' : 'current'
    const q = { type: 'lagmatrix', filters: getFilters(), mode }
    if (mode === 'current') q.lag = AN.lmLag ? AN.lmLag.get() : 0
    else { q.peak_step = parseInt($('lm-peakstep').value) || 30; q.lag_max = parseFloat($('lm-peakmax').value) || 300 }
    if (mode === 'peak') status('scanning PEAK (all lags)…')
    const r = await scan(q, 'lagmatrix'); if (!r) return
    AN.last.lagmatrix = r; drawLagMatrix()
  }
  function drawLagMatrix() {
    const r = AN.last.lagmatrix; if (!r) return
    const canvas = $('lm-canvas'), W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d')
    const minR = Math.abs(parseFloat($('lm-minr').value)) || 0
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#070b07'; ctx.fillRect(0, 0, W, H)
    const M = r.metrics, k = M.length, mL = 78, mT = 78, cell = Math.min((W - mL - 8) / k, (H - mT - 8) / k)
    // real-signals-only: darken mathematically-entangled (same lag-0 equivalence class) + (PEAK) lag-0 cells
    const realOnly = AN.lmRealOnly !== false, tradable = AN.lmTradable !== false
    const classOf = r.classOf || {}
    const lmDark = (a, b) => {
      if (realOnly) { if (M[a] === M[b]) return 1; const ca = classOf[M[a]], cb = classOf[M[b]]; if (ca != null && cb != null && ca === cb) return 2 }
      if (tradable && r.mode === 'peak' && r.lagmat && r.lagmat[a][b] === 0) return 3
      return 0
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
      const v = r.matrix[a][b]
      const dc = lmDark(a, b)
      const dim = !isFinite(v) || Math.abs(v) < minR
      ctx.fillStyle = dc ? '#050705' : (!isFinite(v) ? '#101410' : (dim ? '#0c110c' : diverging(v)))
      ctx.fillRect(mL + b * cell, mT + a * cell, cell - 1, cell - 1)
      if (cell > 24 && isFinite(v) && !dim && !dc) { ctx.fillStyle = Math.abs(v) > 0.5 ? '#000' : '#0a0e0a'; ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.fillText(v.toFixed(2), mL + b * cell + cell / 2, mT + a * cell + cell / 2 + 3) }
    }
    ctx.fillStyle = '#6b786b'; ctx.font = '10px monospace'
    for (let i = 0; i < k; i++) {
      ctx.textAlign = 'right'; ctx.fillText(M[i], mL - 3, mT + i * cell + cell / 2 + 3)
      ctx.save(); ctx.translate(mL + i * cell + cell / 2, mT - 4); ctx.rotate(-Math.PI / 4); ctx.textAlign = 'left'; ctx.fillText(M[i], 0, 0); ctx.restore()
    }
    // axis captions
    ctx.save(); ctx.fillStyle = '#4fd0e0'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.fillText('COL (lagged +lag) →', mL, 12)
    ctx.translate(12, mT); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'right'; ctx.fillText('← ROW (leads)', 0, 0); ctx.restore()
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect(), sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
      const b = Math.floor((sx - mL) / cell), a = Math.floor((sy - mT) / cell), tt = $('an-tooltip')
      if (a < 0 || a >= k || b < 0 || b >= k) { tt.style.display = 'none'; return }
      const nn = r.nmat ? r.nmat[a][b] : null
      const lg = r.mode === 'peak' ? (r.lagmat ? r.lagmat[a][b] : 0) : r.lag
      const dc = lmDark(a, b)
      const classes = r.classes || []
      const dtxt = dc === 1 ? 'entangled: same metric' : dc === 2 ? ('same class: ' + ((classes[classOf[M[a]]] && classes[classOf[M[a]]].label) || (M[a] + '/' + M[b])) + ' (mathematically entangled)') : dc === 3 ? 'peak at lag 0 (simultaneous — not tradable)' : null
      tt.innerHTML = '<b>' + M[a] + '</b> → <b>' + M[b] + '</b><br>r = <b>' + fmtNum(r.matrix[a][b]) + '</b>' + (nn != null ? ' · n=' + nn : '') +
        '<br>' + (r.mode === 'peak' ? 'PEAK @ lag ' + lg + 's' : 'lag ' + lg + 's') + ' (row leads col)' +
        (dtxt ? '<br><span style="color:#f0b000">◾ darkened — ' + dtxt + '</span>' : '')
      tt.style.display = 'block'; tt.style.left = (e.clientX + 14) + 'px'; tt.style.top = (e.clientY + 12) + 'px'
    }
    canvas.onmouseleave = () => { $('an-tooltip').style.display = 'none' }
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect(), sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
      const b = Math.floor((sx - mL) / cell), a = Math.floor((sy - mT) / cell)
      if (a < 0 || a >= k || b < 0 || b >= k) return
      const lg = r.mode === 'peak' ? (r.lagmat ? r.lagmat[a][b] : 0) : r.lag
      carryToCorr(M[a], M[b], lg)
    }
    renderClassLegend('lm-legend', r.classes, r.entangleR)
    const cap = $('lm-cap2'); if (cap) {
      const nRef = avgN(r.nmat), rcrit = nRef > 3 ? (2 / Math.sqrt(nRef)) : NaN
      const nlags = r.mode === 'peak' ? (r.nlags || 0) : 1
      const npairs = k * k
      cap.innerHTML = '‖r‖ at 5s bins · n≈' + nRef + ' bin-pairs/cell · ' + k + '×' + k + ' metrics = ' + npairs + ' pairs × ' + nlags + ' lag' + (nlags === 1 ? '' : 's') + ' scanned' +
        (r.mode === 'peak' ? ' (±' + r.lag_max + 's step ' + r.peak_step + 's)' : ' (lag ' + r.lag + 's)') +
        ' · naive |r|>~' + (isFinite(rcrit) ? rcrit.toFixed(3) : '—') + ' ≈ p<0.05 <b>but autocorrelation inflates significance — treat as qualitative</b>' +
        ' · ' + r.nWin + ' windows · build ' + (r.build_ms || 0) + 'ms · scan ' + (r.elapsed_ms || 0) + 'ms'
    }
  }

  // ================= MEGA MATRIX (derived-channel factory · zoom/pan · PEAK · subset selector) =================
  // "add averages, integrals, derivatives, 2nd order, |integrals|, moving averages, averages of past n time,
  //  everything possible … 500x500 … adjust the lag … look for any possible relation." — the worker builds
  //  ~338 derived channels (26 base × 13 transforms); this view scans them at any lag with a zoom/pan canvas.
  const MM = {
    built: false, cat: null, checkedBase: null, checkedTf: null, mode: 'current', last: null,
    view: { cell: 0, ox: 0, oy: 0 }, oc: null, drag: null, peak: { running: false, cancel: false }, buildInFlight: false,
    realOnly: true, tradableLags: true // real-signals-only filters (default ON)
  }
  const MM_DEFAULT_BASE = ['flow', 'signal', 'strike'] // sensible ~60-channel default
  const MM_DEFAULT_TF = ['raw', 'deriv']
  const MM_MARGIN = 92 // px reserved for labels (top+left) inside the canvas

  function buildMegaMatrix() {
    const p = $('an-pane-megamatrix')
    p.innerHTML =
      '<div class="an-ctrls">' + lagControls('mm', 300) +
      ' <span class="lm-mode on" id="mm-cur">current-lag</span><span class="lm-mode" id="mm-peak">PEAK</span>' +
      ' min|r| ' + inp('mm-minr', 0.1, 'dl-minr', 50) +
      ' <label class="mm-tog" title="darken pairs that are mathematically entangled (same base metric / same lag-0 equivalence class) so only REAL cross-signal correlations light up"><input type="checkbox" id="mm-realonly" checked> real signals only</label>' +
      ' <label class="mm-tog" title="in PEAK mode, darken cells whose peak is at lag 0 (simultaneous = not tradable)"><input type="checkbox" id="mm-tradable" checked> tradable lags only</label>' +
      ' <span class="dim" id="mm-peakctl">peak lag± ' + inp('mm-peakmax', 300, 'dl-lag', 46) + 's step ' + sel('mm-peakstep', ['10', '30', '60', '120'], '30') + 's</span>' +
      ' <span class="an-btn" id="mm-run">run</span><span class="an-btn sub" id="mm-cancel" style="display:none;border-color:var(--down);color:var(--down)">cancel</span>' +
      ' <span class="an-btn sub" id="mm-full">FULL</span><span class="an-btn sub" id="mm-default">default</span>' +
      ' CSV top-<span></span>' + inp('mm-topk', 250, 'dl-megak', 52) + '<span class="an-btn sub" id="mm-csv">export</span>' +
      '</div>' +
      '<div class="mm-subset" id="mm-subset"><span class="dim">building derived channels…</span></div>' +
      '<div class="lm-cap mm-legend" id="mm-legend"></div>' +
      '<div class="an-ctrls" style="margin:2px 0 4px;"><div class="mm-prog" id="mm-prog"><i></i><span></span></div>' +
      '<span class="dim" id="mm-selinfo"></span></div>' +
      '<div class="lm-cap">every DERIVED channel × every derived channel · <b>positive lag = ROW leads COLUMN</b> · r(row_t, col_{t+lag}) · z-scored 10s bins within each 15-min window (lag never crosses the settle boundary) · <b>PEAK</b> = max|r| over the whole lag range · <b>wheel = zoom</b> (at cursor) · <b>drag = pan</b> · hover a cell for r/n/lag · click → Correlation Explorer (base pair). Missing bins are zero-imputed ⇒ magnitudes are mildly attenuated (a z-scored dot estimate, not exact Pearson).</div>' +
      '<div class="lm-cap" id="mm-cap2"></div>' +
      '<div class="mm-canvas-wrap"><canvas id="mm-canvas" width="1180" height="1180" style="max-width:1180px;"></canvas></div>'
    MM.built = true; MM.mode = 'current'
    MM.checkedBase = MM.checkedBase || new Set(MM_DEFAULT_BASE)
    MM.checkedTf = MM.checkedTf || new Set(MM_DEFAULT_TF)
    MM.lag = wireLag('mm', () => { if (MM.mode !== 'peak') runMega() })
    // mega lag step must be >= the 10s mega bin
    const mmStep = $('mm-step'); if (mmStep) { mmStep.innerHTML = ['10', '30', '60', '120'].map((o) => '<option' + (o === '10' ? ' selected' : '') + '>' + o + '</option>').join(''); const sl = $('mm-slider'); if (sl) sl.step = 10 }
    const setMode = (m) => { MM.mode = m; $('mm-cur').classList.toggle('on', m === 'current'); $('mm-peak').classList.toggle('on', m === 'peak'); $('mm-peakctl').style.color = m === 'peak' ? 'var(--cyan)' : ''; runMega() }
    $('mm-cur').onclick = () => setMode('current')
    $('mm-peak').onclick = () => setMode('peak')
    $('mm-run').onclick = () => runMega()
    $('mm-cancel').onclick = () => { MM.peak.cancel = true }
    $('mm-minr').onchange = () => { if (MM.last) { buildMegaImage(); drawMega() } }
    $('mm-realonly').checked = MM.realOnly; $('mm-tradable').checked = MM.tradableLags
    $('mm-realonly').onchange = () => { MM.realOnly = $('mm-realonly').checked; if (MM.last) { buildMegaImage(); drawMega() } }
    $('mm-tradable').onchange = () => { MM.tradableLags = $('mm-tradable').checked; if (MM.last) { buildMegaImage(); drawMega() } }
    $('mm-full').onclick = () => { MM.cat.baseFams.forEach((f) => MM.checkedBase.add(f)); MM.cat.tfFams.forEach((f) => MM.checkedTf.add(f)); syncSubsetChecks(); refreshSelInfo(); runMega() }
    $('mm-default').onclick = () => { MM.checkedBase = new Set(MM_DEFAULT_BASE); MM.checkedTf = new Set(MM_DEFAULT_TF); syncSubsetChecks(); refreshSelInfo(); runMega() }
    $('mm-csv').onclick = () => exportMegaCSV()
    // wheel-zoom + drag-pan
    const cv = $('mm-canvas')
    cv.addEventListener('wheel', onMegaWheel, { passive: false })
    cv.addEventListener('mousedown', (e) => { MM.drag = { x: e.clientX, y: e.clientY, ox: MM.view.ox, oy: MM.view.oy, moved: false } })
    window.addEventListener('mousemove', onMegaDrag)
    window.addEventListener('mouseup', () => { if (MM.drag) { const wasMove = MM.drag.moved; MM.drag = null; if (!wasMove) {} } })
    cv.addEventListener('mousemove', onMegaHover)
    cv.addEventListener('mouseleave', () => { $('an-tooltip').style.display = 'none' })
    cv.addEventListener('click', onMegaClick)
  }
  function syncSubsetChecks() {
    if (!MM.cat) return
    MM.cat.baseFams.forEach((f) => { const c = $('mm-b-' + f); if (c) c.checked = MM.checkedBase.has(f) })
    MM.cat.tfFams.forEach((f) => { const c = $('mm-t-' + f); if (c) c.checked = MM.checkedTf.has(f) })
  }
  async function ensureMegaCatalog() {
    if (MM.cat) return MM.cat
    MM.buildInFlight = true; showMegaProg(0, 'building derived channels…')
    const r = await scan({ type: 'megafields', filters: getFilters() }, 'megafields')
    MM.buildInFlight = false; hideMegaProg()
    if (!r || r.error) { $('mm-subset').innerHTML = '<span style="color:var(--down)">channel build failed</span>'; return null }
    MM.cat = r
    renderSubsetUI()
    return r
  }
  function renderSubsetUI() {
    const c = MM.cat; if (!c) return
    // count channels per family for labels
    const perBase = {}, perTf = {}
    c.channels.forEach((ch) => { perBase[ch.baseFam] = (perBase[ch.baseFam] || 0) + 1; perTf[ch.tfFam] = (perTf[ch.tfFam] || 0) + 1 })
    const baseBoxes = c.baseFams.map((f) => '<label><input type="checkbox" id="mm-b-' + f + '"' + (MM.checkedBase.has(f) ? ' checked' : '') + '> ' + f + ' <span class="dim">(' + (perBase[f] || 0) + ')</span></label>').join('')
    const tfBoxes = c.tfFams.map((f) => '<label><input type="checkbox" id="mm-t-' + f + '"' + (MM.checkedTf.has(f) ? ' checked' : '') + '> ' + f + ' <span class="dim">(' + (perTf[f] || 0) + ')</span></label>').join('')
    $('mm-subset').innerHTML =
      '<div class="grp"><b>BASE METRIC family</b>' + baseBoxes + '</div>' +
      '<div class="grp"><b>TRANSFORM family</b>' + tfBoxes + '</div>' +
      '<div class="grp"><b>catalog</b><span class="dim">' + c.finalCount + ' channels built · ' + c.dropped + ' degenerate dropped (of ' + c.totalPossible + ')</span>' +
      '<span class="dim">' + c.nWin + ' windows · ' + c.BIN + 's bins · build ' + (c.build_ms || 0) + 'ms</span></div>'
    c.baseFams.forEach((f) => { const el = $('mm-b-' + f); if (el) el.onchange = () => { el.checked ? MM.checkedBase.add(f) : MM.checkedBase.delete(f); refreshSelInfo() } })
    c.tfFams.forEach((f) => { const el = $('mm-t-' + f); if (el) el.onchange = () => { el.checked ? MM.checkedTf.add(f) : MM.checkedTf.delete(f); refreshSelInfo() } })
    renderClassLegend('mm-legend', c.classes, c.entangleR)
    refreshSelInfo()
  }
  // Legend of the detected base-metric equivalence classes (so Noah can see what got grouped/darkened).
  function renderClassLegend(elId, classes, thresh) {
    const el = $(elId); if (!el) return
    if (!classes || !classes.length) { el.innerHTML = ''; return }
    const multi = classes.filter((c) => c.multi), singles = classes.filter((c) => !c.multi).map((c) => c.members[0])
    const grp = multi.map((c) => '<span style="color:var(--amber)">■</span> <b>' + esc(c.label) + '</b>[' + c.members.map(esc).join(',') + ']').join(' &nbsp; ')
    el.innerHTML = '<b>entanglement classes</b> (raw base metrics with |r|&gt;' + (thresh || 0.9) + ' at lag 0 + structural book/btc families) — <b>“real signals only”</b> darkens any pair whose bases fall in the SAME class: ' +
      (grp || '<span class="dim">none merged</span>') +
      (singles.length ? ' &nbsp; <span class="dim">· independent: ' + singles.map(esc).join(', ') + '</span>' : '')
  }
  function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) }
  function selectedChannels() {
    if (!MM.cat) return []
    // ordered by baseFam order, then base, then transform order (as emitted by the worker catalog)
    return MM.cat.channels.filter((ch) => MM.checkedBase.has(ch.baseFam) && MM.checkedTf.has(ch.tfFam)).map((ch) => ch.name)
  }
  function refreshSelInfo() {
    const n = selectedChannels().length
    const el = $('mm-selinfo'); if (el) el.textContent = n + ' channels selected → ' + n + '×' + n + ' = ' + (n * n).toLocaleString() + ' pairs' + (n > 200 ? ' · FULL grid is heavy (seconds/lag) — narrow families for an instant slider' : '')
  }
  function showMegaProg(pct, label) { const p = $('mm-prog'); if (!p) return; p.style.display = 'inline-block'; p.querySelector('i').style.width = Math.max(0, Math.min(100, pct)) + '%'; p.querySelector('span').textContent = label || (Math.round(pct) + '%') }
  function hideMegaProg() { const p = $('mm-prog'); if (p) p.style.display = 'none' }

  async function runMega() {
    if (MM.peak.running) { MM.peak.cancel = true; return }
    const cat = await ensureMegaCatalog(); if (!cat) return
    const sel = selectedChannels()
    if (!sel.length) { status('select at least one base + transform family', 'err'); return }
    if (MM.mode === 'peak') return runMegaPeak(sel)
    const q = { type: 'megamatrix', filters: getFilters(), sel, lag: MM.lag ? MM.lag.get() : 0 }
    const r = await scan(q, 'megamatrix'); if (!r) return
    r.mode = 'current'
    MM.last = r; resetView(); buildMegaImage(); drawMega()
  }
  async function runMegaPeak(sel) {
    const stepSec = Math.max(10, parseInt($('mm-peakstep').value) || 30)
    const maxSec = Math.max(stepSec, Math.round((parseFloat($('mm-peakmax').value) || 300) / 10) * 10)
    const lags = []; for (let L = -maxSec; L <= maxSec; L += stepSec) lags.push(L)
    const k = sel.length
    // per-cell running argmax|r|
    const bestAbs = [], bestR = [], bestLag = []
    for (let a = 0; a < k; a++) { bestAbs.push(new Float32Array(k).fill(-1)); bestR.push(new Float32Array(k).fill(NaN)); bestLag.push(new Float32Array(k)) }
    MM.peak = { running: true, cancel: false }
    $('mm-cancel').style.display = ''; $('mm-run').style.display = 'none'
    const t0 = performance.now()
    let done = 0, P = 0
    for (let li = 0; li < lags.length; li++) {
      if (MM.peak.cancel) break
      const r = await scanQuiet({ type: 'megamatrix', filters: getFilters(), sel, lag: lags[li] }, 'megapeak')
      if (!r || r.error) break
      P = r.P
      const mat = r.matrix
      for (let a = 0; a < k; a++) { const row = mat[a], ba = bestAbs[a], br = bestR[a], bl = bestLag[a]; for (let b = 0; b < k; b++) { const v = row[b], av = v < 0 ? -v : v; if (av === av && av > ba[b]) { ba[b] = av; br[b] = v; bl[b] = lags[li] } } }
      done++
      const frac = done / lags.length, el = performance.now() - t0, eta = frac > 0 ? el / frac - el : 0
      showMegaProg(frac * 100, 'PEAK ' + done + '/' + lags.length + ' lags · ' + (el / 1000).toFixed(1) + 's · ETA ' + (eta / 1000).toFixed(1) + 's')
    }
    MM.peak.running = false; $('mm-cancel').style.display = 'none'; $('mm-run').style.display = ''; hideMegaProg()
    // assemble a result object mirroring the current-lag shape
    const matrix = bestR, lagmat = bestLag
    MM.last = { type: 'megamatrix', mode: 'peak', metrics: sel, matrix, lagmat, P, lag_max: maxSec, peak_step: stepSec, nlags: lags.length, lagsScanned: done, BIN: (MM.cat ? MM.cat.BIN : 10), nWin: (MM.cat ? MM.cat.nWin : 0), build_ms: (MM.cat ? MM.cat.build_ms : 0), elapsed_ms: Math.round(performance.now() - t0) }
    resetView(); buildMegaImage(); drawMega()
    status('PEAK done · ' + done + '/' + lags.length + ' lags · ' + ((performance.now() - t0) / 1000).toFixed(1) + 's', 'ok')
  }
  // like scan() but doesn't spam the status line / doesn't bump the supersede token (used inside the PEAK loop)
  async function scanQuiet(query, key) {
    query.key = key || 'default'
    try { return await window.cta.scan(query) } catch (e) { return { error: String(e) } }
  }

  function resetView() {
    const r = MM.last; if (!r) return
    const k = r.metrics.length, W = 1180, H = 1180
    MM.view.cell = Math.max(0.5, Math.min((W - MM_MARGIN - 6) / k, (H - MM_MARGIN - 6) / k))
    MM.view.ox = MM_MARGIN; MM.view.oy = MM_MARGIN
  }
  // per-result channel metadata: base metric + equivalence-class id for each axis position (cached on MM.last)
  function megaChanMeta() {
    const r = MM.last; if (!r) return null
    if (r._meta && r._meta.metrics === r.metrics) return r._meta
    const cat = MM.cat, nameToBase = {}, classOf = (cat && cat.classOf) || {}
    if (cat && cat.channels) cat.channels.forEach((c) => { nameToBase[c.name] = c.base })
    const base = r.metrics.map((n) => nameToBase[n] || n)
    const cls = base.map((b) => (classOf[b] != null ? classOf[b] : '__' + b))
    const meta = { metrics: r.metrics, base, cls, classes: (cat && cat.classes) || [] }
    r._meta = meta; return meta
  }
  // reason a cell is "not a real signal" — 0=none, 1=same base, 2=same class, 3=peak lag 0. Respects toggles.
  function megaDarkCode(a, b) {
    const r = MM.last; if (!r) return 0
    const meta = megaChanMeta(); if (!meta) return 0
    if (MM.realOnly) {
      if (meta.base[a] === meta.base[b]) return 1
      if (meta.cls[a] === meta.cls[b]) return 2
    }
    if (MM.tradableLags && r.mode === 'peak' && r.lagmat && r.lagmat[a][b] === 0) return 3
    return 0
  }
  function megaDarkText(code, a, b) {
    const meta = megaChanMeta(); if (!meta || !code) return null
    if (code === 1) return 'entangled: same base metric (' + meta.base[a] + ')'
    if (code === 2) { const cl = meta.classes[meta.cls[a]]; return 'same class: ' + (cl ? cl.label : meta.base[a] + '/' + meta.base[b]) + ' (mathematically entangled)' }
    if (code === 3) return 'peak at lag 0 (simultaneous — not tradable)'
    return null
  }
  function buildMegaImage() {
    const r = MM.last; if (!r) return
    const k = r.metrics.length
    let oc = MM.oc
    if (!oc || oc.width !== k) { oc = document.createElement('canvas'); oc.width = k; oc.height = k; MM.oc = oc }
    const octx = oc.getContext('2d'), img = octx.createImageData(k, k), d = img.data
    const minR = Math.abs(parseFloat($('mm-minr').value)) || 0
    for (let a = 0; a < k; a++) {
      const row = r.matrix[a]
      for (let b = 0; b < k; b++) {
        const v = row[b], off = (a * k + b) * 4
        // entanglement / non-tradable filters render near-black (≈ background) so only real signals light up
        if (megaDarkCode(a, b)) { d[off] = 5; d[off + 1] = 7; d[off + 2] = 5; d[off + 3] = 255; continue }
        if (!(v === v)) { d[off] = 14; d[off + 1] = 18; d[off + 2] = 14; d[off + 3] = 255; continue }
        if (Math.abs(v) < minR) { d[off] = 11; d[off + 1] = 15; d[off + 2] = 11; d[off + 3] = 255; continue }
        const c = divergingRGB(v); d[off] = c[0]; d[off + 1] = c[1]; d[off + 2] = c[2]; d[off + 3] = 255
      }
    }
    octx.putImageData(img, 0, 0)
  }
  function famBoundaries(metrics) {
    // return indices where the base-family changes (for separator lines) + family label spans
    const spans = []; let start = 0, curFam = null
    const famOf = (name) => { const ch = MM.cat && MM.cat.channels.find((c) => c.name === name); return ch ? ch.baseFam : '' }
    for (let i = 0; i < metrics.length; i++) { const f = famOf(metrics[i]); if (curFam === null) curFam = f; else if (f !== curFam) { spans.push({ fam: curFam, start, end: i }); start = i; curFam = f } }
    if (metrics.length) spans.push({ fam: curFam, start, end: metrics.length })
    return spans
  }
  function drawMega() {
    const r = MM.last; if (!r || !MM.oc) return
    const cv = $('mm-canvas'), W = cv.width, H = cv.height, ctx = cv.getContext('2d')
    const k = r.metrics.length, cell = MM.view.cell, ox = MM.view.ox, oy = MM.view.oy
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#070b07'; ctx.fillRect(0, 0, W, H)
    // clip to the grid viewport (below/right of the label margin)
    ctx.save(); ctx.beginPath(); ctx.rect(MM_MARGIN, MM_MARGIN, W - MM_MARGIN, H - MM_MARGIN); ctx.clip()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(MM.oc, 0, 0, k, k, ox, oy, k * cell, k * cell)
    // family separator lines
    const spans = famBoundaries(r.metrics)
    ctx.strokeStyle = 'rgba(79,208,224,0.35)'; ctx.lineWidth = 1
    for (const sp of spans) {
      const x = ox + sp.end * cell, y = oy + sp.end * cell
      if (sp.end < k) { ctx.beginPath(); ctx.moveTo(x, MM_MARGIN); ctx.lineTo(x, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(MM_MARGIN, y); ctx.lineTo(W, y); ctx.stroke() }
    }
    ctx.restore()
    // individual channel labels once cells are big enough; else family group ticks
    ctx.fillStyle = '#6b786b'; ctx.font = '9px monospace'
    if (cell >= 9) {
      for (let i = 0; i < k; i++) {
        const y = oy + i * cell + cell / 2 + 3, x = ox + i * cell + cell / 2
        if (y > MM_MARGIN - 2 && y < H + 8) { ctx.textAlign = 'right'; ctx.fillText(r.metrics[i], MM_MARGIN - 3, y) }
        if (x > MM_MARGIN - 2 && x < W + 8) { ctx.save(); ctx.translate(x, MM_MARGIN - 3); ctx.rotate(-Math.PI / 4); ctx.textAlign = 'left'; ctx.fillText(r.metrics[i], 0, 0); ctx.restore() }
      }
    } else {
      ctx.fillStyle = '#4fd0e0'; ctx.font = 'bold 10px monospace'
      for (const sp of spans) {
        const mid = ox + (sp.start + sp.end) / 2 * cell
        const y = oy + (sp.start + sp.end) / 2 * cell
        if (mid > MM_MARGIN && mid < W) { ctx.textAlign = 'center'; ctx.fillText(sp.fam, mid, MM_MARGIN - 6) }
        if (y > MM_MARGIN && y < H) { ctx.save(); ctx.translate(MM_MARGIN - 8, y); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(sp.fam, 0, 0); ctx.restore() }
      }
    }
    // axis captions
    ctx.fillStyle = '#4fd0e0'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.fillText('COL (lagged +lag) →', MM_MARGIN, 12)
    ctx.save(); ctx.translate(12, MM_MARGIN); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'right'; ctx.fillText('← ROW (leads)', 0, 0); ctx.restore()
    // mini-map (top-right): full grid + viewport rect
    drawMegaMinimap(ctx, W, H, k, cell, ox, oy)
    // caption
    updateMegaCaption()
  }
  function drawMegaMinimap(ctx, W, H, k, cell, ox, oy) {
    const mm = 116, mx = W - mm - 8, my = 8
    ctx.save()
    ctx.globalAlpha = 0.92; ctx.imageSmoothingEnabled = false
    ctx.drawImage(MM.oc, 0, 0, k, k, mx, my, mm, mm)
    ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(120,140,120,0.6)'; ctx.strokeRect(mx, my, mm, mm)
    // viewport rect in grid-cell coords: visible cells are [(MM_MARGIN-ox)/cell .. (W-ox)/cell]
    const gx0 = Math.max(0, (MM_MARGIN - ox) / cell), gx1 = Math.min(k, (W - ox) / cell)
    const gy0 = Math.max(0, (MM_MARGIN - oy) / cell), gy1 = Math.min(k, (H - oy) / cell)
    ctx.strokeStyle = 'var(--amber)'; ctx.strokeStyle = '#f0b000'; ctx.lineWidth = 1.5
    ctx.strokeRect(mx + gx0 / k * mm, my + gy0 / k * mm, (gx1 - gx0) / k * mm, (gy1 - gy0) / k * mm)
    ctx.restore()
  }
  function megaCellAt(e) {
    const cv = $('mm-canvas'), rect = cv.getBoundingClientRect(), W = cv.width, H = cv.height
    const sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
    if (sx < MM_MARGIN || sy < MM_MARGIN) return null
    const b = Math.floor((sx - MM.view.ox) / MM.view.cell), a = Math.floor((sy - MM.view.oy) / MM.view.cell)
    const k = MM.last ? MM.last.metrics.length : 0
    if (a < 0 || a >= k || b < 0 || b >= k) return null
    return { a, b, sx, sy }
  }
  function onMegaWheel(e) {
    e.preventDefault(); if (!MM.last) return
    const cv = $('mm-canvas'), rect = cv.getBoundingClientRect(), W = cv.width
    const sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (cv.height / rect.height)
    const worldX = (sx - MM.view.ox) / MM.view.cell, worldY = (sy - MM.view.oy) / MM.view.cell
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
    const k = MM.last.metrics.length
    const minCell = Math.max(0.5, (W - MM_MARGIN - 6) / k / 1.2), maxCell = 60
    MM.view.cell = Math.max(minCell, Math.min(maxCell, MM.view.cell * factor))
    MM.view.ox = sx - worldX * MM.view.cell; MM.view.oy = sy - worldY * MM.view.cell
    clampView(); drawMega()
  }
  function onMegaDrag(e) {
    if (!MM.drag) return
    const cv = $('mm-canvas'), rect = cv.getBoundingClientRect(), sc = cv.width / rect.width
    const dx = (e.clientX - MM.drag.x) * sc, dy = (e.clientY - MM.drag.y) * sc
    if (Math.abs(dx) + Math.abs(dy) > 3) MM.drag.moved = true
    MM.view.ox = MM.drag.ox + dx; MM.view.oy = MM.drag.oy + dy
    clampView(); drawMega()
  }
  function clampView() {
    const r = MM.last; if (!r) return
    const cv = $('mm-canvas'), W = cv.width, H = cv.height, k = r.metrics.length, cell = MM.view.cell
    const gw = k * cell
    if (gw <= W - MM_MARGIN) { MM.view.ox = MM_MARGIN } else { if (MM.view.ox > MM_MARGIN) MM.view.ox = MM_MARGIN; if (MM.view.ox + gw < W) MM.view.ox = W - gw }
    if (gw <= H - MM_MARGIN) { MM.view.oy = MM_MARGIN } else { if (MM.view.oy > MM_MARGIN) MM.view.oy = MM_MARGIN; if (MM.view.oy + gw < H) MM.view.oy = H - gw }
  }
  function onMegaHover(e) {
    if (MM.drag && MM.drag.moved) { $('an-tooltip').style.display = 'none'; return }
    const r = MM.last; if (!r) return
    const hit = megaCellAt(e), tt = $('an-tooltip')
    if (!hit) { tt.style.display = 'none'; return }
    const v = r.matrix[hit.a][hit.b]
    const lg = r.mode === 'peak' ? (r.lagmat ? r.lagmat[hit.a][hit.b] : 0) : r.lag
    const dc = megaDarkCode(hit.a, hit.b)
    tt.innerHTML = '<b>' + r.metrics[hit.a] + '</b> → <b>' + r.metrics[hit.b] + '</b><br>r = <b>' + fmtNum(v) + '</b>' + (r.P ? ' · n≈' + r.P : '') +
      '<br>' + (r.mode === 'peak' ? 'PEAK @ lag ' + lg + 's' : 'lag ' + lg + 's') + ' (row leads col)' +
      (dc ? '<br><span style="color:#f0b000">◾ darkened — ' + megaDarkText(dc, hit.a, hit.b) + '</span>' : '')
    tt.style.display = 'block'; tt.style.left = (e.clientX + 14) + 'px'; tt.style.top = (e.clientY + 12) + 'px'
  }
  function onMegaClick(e) {
    if (MM.drag && MM.drag.moved) return
    const r = MM.last; if (!r) return
    const hit = megaCellAt(e); if (!hit) return
    const ca = MM.cat.channels.find((c) => c.name === r.metrics[hit.a]), cb = MM.cat.channels.find((c) => c.name === r.metrics[hit.b])
    const baseA = ca ? ca.base : r.metrics[hit.a], baseB = cb ? cb.base : r.metrics[hit.b]
    const lg = r.mode === 'peak' ? (r.lagmat ? r.lagmat[hit.a][hit.b] : 0) : r.lag
    carryToCorr(baseA, baseB, lg)
    status('opened base pair ' + baseA + ' → ' + baseB + ' (derived transforms ' + r.metrics[hit.a] + '/' + r.metrics[hit.b] + ' are not shown in the tick-level explorer)', 'ok')
  }
  function updateMegaCaption() {
    const r = MM.last, cap = $('mm-cap2'); if (!r || !cap) return
    const k = r.metrics.length, npairs = k * k
    const nlags = r.mode === 'peak' ? (r.lagsScanned || r.nlags || 1) : 1
    const P = r.P || 0, rcrit = P > 3 ? 2 / Math.sqrt(P) : NaN
    const pOne = P > 3 ? 0.05 : 0 // naive per-test at |r|>2/sqrt(P)
    const tests = npairs * nlags
    const spurious = Math.round(tests * 0.05)
    cap.innerHTML = '<b>' + k + '</b> channels · ' + npairs.toLocaleString() + ' pairs × ' + nlags + ' lag' + (nlags === 1 ? '' : 's') + ' = <b>' + tests.toLocaleString() + '</b> tests' +
      (r.mode === 'peak' ? ' (PEAK ±' + r.lag_max + 's step ' + r.peak_step + 's)' : ' (lag ' + r.lag + 's)') +
      ' · n≈' + P.toLocaleString() + ' bin-pairs/cell · naive |r|>~' + (isFinite(rcrit) ? rcrit.toFixed(3) : '—') + ' ≈ p<0.05 → <b style="color:var(--down)">~' + spurious.toLocaleString() + ' cells expected spurious by chance</b>' +
      ' · <b>autocorrelation inflates significance — treat as qualitative</b> · ' + (r.nWin || 0) + ' windows · z-scored ' + (r.BIN || 10) + 's bins · build ' + (r.build_ms || 0) + 'ms · scan ' + (r.elapsed_ms || 0) + 'ms'
  }
  function exportMegaCSV() {
    const r = MM.last; if (!r) { status('run the matrix first', 'err'); return }
    const K = Math.max(1, Math.round(parseFloat($('mm-topk').value) || 250))
    const k = r.metrics.length, arr = []
    let skipped = 0
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) { if (a === b) continue; const v = r.matrix[a][b]; if (!(v === v)) continue; if (megaDarkCode(a, b)) { skipped++; continue } arr.push([a, b, v]) }
    arr.sort((p, q) => Math.abs(q[2]) - Math.abs(p[2]))
    const top = arr.slice(0, K)
    const rows = [['rank', 'row_channel', 'col_channel', 'r', 'abs_r', 'n', (r.mode === 'peak' ? 'argmax_lag_s' : 'lag_s')]]
    top.forEach((t, i) => { const lg = r.mode === 'peak' ? (r.lagmat ? r.lagmat[t[0]][t[1]] : '') : r.lag; rows.push([i + 1, r.metrics[t[0]], r.metrics[t[1]], t[2].toFixed(5), Math.abs(t[2]).toFixed(5), r.P || '', lg]) }
    )
    downloadCSV('megamatrix_' + r.mode + '_top' + K + '.csv', rows)
    status('exported top ' + top.length + ' of ' + arr.length + ' real cells by |r|' + ((MM.realOnly || MM.tradableLags) && skipped ? ' (' + skipped + ' entangled/non-tradable cells filtered out)' : ''), 'ok')
  }

  // ---- PRESETS ----
  function buildPresets() {
    const p = $('an-pane-presets')
    p.innerHTML =
      '<div class="dim" style="font-size:11px;margin-bottom:6px;">fixed views over ALL history · click a title to open it in the builder · hover cells for values · 3D height = count</div>' +
      '<div style="margin:10px 0 4px;"><span class="an-btn sub" id="ps1-mode">2D</span> <b class="cyan" id="ps1-t" style="cursor:pointer;font-size:11px;">EV surface — mean +60s move by TIME-INTO-WINDOW × FAVORITE PRICE</b></div><canvas id="ps1" width="1160" height="360"></canvas>' +
      '<div style="margin:10px 0 4px;"><span class="an-btn sub" id="ps2-mode">2D</span> <b class="cyan" id="ps2-t" style="cursor:pointer;font-size:11px;">seasonality — mean +60s move by HOUR (UTC) × WEEKDAY</b></div><canvas id="ps2" width="1160" height="300"></canvas>' +
      '<div style="margin:10px 0 4px;"><b class="cyan" id="ps3-t" style="cursor:pointer;font-size:11px;">stream correlation matrix — drag LAG to scan lead/lag · click a cell → correlation explorer</b></div>' +
      '<div class="an-ctrls" id="ps3-lagbar">' + lagControls('ps3', 300) + '<span class="dim" style="font-size:10px">positive lag = row LEADS column · r(row_t, col_{t+lag}) · 5s bins</span></div>' +
      '<div class="lm-cap" id="ps3-cap"></div>' +
      '<canvas id="ps3" width="720" height="720" style="max-width:720px;"></canvas>'
    $('ps1-mode').onclick = () => { AN.ps1Mode = AN.ps1Mode === '3d' ? '2d' : '3d'; $('ps1-mode').textContent = AN.ps1Mode === '3d' ? '3D' : '2D'; if (AN.last.ps1) drawHeatmap($('ps1'), AN.last.ps1, { mode: AN.ps1Mode }) }
    $('ps2-mode').onclick = () => { AN.ps2Mode = AN.ps2Mode === '3d' ? '2d' : '3d'; $('ps2-mode').textContent = AN.ps2Mode === '3d' ? '3D' : '2D'; if (AN.last.ps2) drawHeatmap($('ps2'), AN.last.ps2, { mode: AN.ps2Mode }) }
    AN.ps3Lag = wireLag('ps3', () => runPreset3())
  }
  const PRESET_CM_METRICS = ['tfi', 'tvol', 'btcobi', 'mid_d1', 'dev', 'dist', 'mv30', 'mv60', 'mv300']
  async function runPreset3() {
    const lag = AN.ps3Lag ? AN.ps3Lag.get() : 0
    const cm = await scan({ type: 'lagmatrix', filters: getFilters(), metrics: PRESET_CM_METRICS, mode: 'current', lag }, 'preset3')
    if (!cm) return
    AN.last.cm = cm; drawCorrMatrix($('ps3'), cm, { lag: cm.lag, clickCarryLag: true })
    const cap = $('ps3-cap')
    if (cap) cap.textContent = '‖r‖ at 5s bins · lag ' + cm.lag + 's · n≈' + avgN(cm.nmat) + ' bin-pairs/cell · ' + cm.nWin + ' windows · build ' + (cm.build_ms || 0) + 'ms · scan ' + (cm.elapsed_ms || 0) + 'ms · autocorrelation inflates naive significance'
  }
  function avgN(nmat) {
    if (!nmat) return 0
    let s = 0, c = 0
    for (let a = 0; a < nmat.length; a++) for (let b = 0; b < nmat[a].length; b++) { if (a === b) continue; const v = nmat[a][b]; if (isFinite(v)) { s += v; c++ } }
    return c ? Math.round(s / c) : 0
  }
  async function runPresets() {
    const r1 = await scan({ type: 'pivot', filters: getFilters(), x: { metric: 'elapsed', bin: 60, min: 0, max: 900 }, y: { metric: 'pf', bin: 0.05, min: 0.5, max: 1 }, agg: 'mean', z: 'mv60' }, 'presets')
    if (r1) { AN.last.ps1 = r1; drawHeatmap($('ps1'), r1, { mode: AN.ps1Mode === '3d' ? '3d' : '2d' }) }
    const r2 = await scan({ type: 'pivot', filters: getFilters(), x: { metric: 'hour', bin: 1, min: 0, max: 24 }, y: { metric: 'weekday', bin: 1, min: 0, max: 7 }, agg: 'mean', z: 'mv60' }, 'presets')
    if (r2) { AN.last.ps2 = r2; drawHeatmap($('ps2'), r2, { mode: AN.ps2Mode === '3d' ? '3d' : '2d' }) }
    await runPreset3()
  }
  function drawCorrMatrix(canvas, cm, opts) {
    opts = opts || {}
    const lag = opts.lag || cm.lag || 0
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#070b07'; ctx.fillRect(0, 0, W, H)
    const k = cm.metrics.length, mL = 70, mT = 70, cell = Math.min((W - mL - 10) / k, (H - mT - 10) / k)
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
      const r = cm.matrix[a][b]
      ctx.fillStyle = isFinite(r) ? diverging(r) : '#111'
      ctx.fillRect(mL + b * cell, mT + a * cell, cell - 1, cell - 1)
      if (cell > 26 && isFinite(r)) { ctx.fillStyle = Math.abs(r) > 0.5 ? '#000' : '#9aa'; ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.fillText(r.toFixed(2), mL + b * cell + cell / 2, mT + a * cell + cell / 2 + 3) }
    }
    ctx.fillStyle = '#6b786b'; ctx.font = '10px monospace'
    for (let i = 0; i < k; i++) {
      ctx.textAlign = 'right'; ctx.fillText(cm.metrics[i], mL - 3, mT + i * cell + cell / 2 + 3)
      ctx.save(); ctx.translate(mL + i * cell + cell / 2, mT - 4); ctx.rotate(-Math.PI / 4); ctx.textAlign = 'left'; ctx.fillText(cm.metrics[i], 0, 0); ctx.restore()
    }
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect(), sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
      const b = Math.floor((sx - mL) / cell), a = Math.floor((sy - mT) / cell), tt = $('an-tooltip')
      if (a < 0 || a >= k || b < 0 || b >= k) { tt.style.display = 'none'; return }
      const nn = cm.nmat ? cm.nmat[a][b] : null
      tt.innerHTML = '<b>' + cm.metrics[a] + '</b> → <b>' + cm.metrics[b] + '</b><br>r = <b>' + fmtNum(cm.matrix[a][b]) + '</b>' + (nn != null ? ' · n=' + nn : '') + (lag ? '<br>lag ' + lag + 's (row leads col)' : '')
      tt.style.display = 'block'; tt.style.left = (e.clientX + 14) + 'px'; tt.style.top = (e.clientY + 12) + 'px'
    }
    canvas.onmouseleave = () => { $('an-tooltip').style.display = 'none' }
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect(), sx = (e.clientX - rect.left) * (W / rect.width), sy = (e.clientY - rect.top) * (H / rect.height)
      const b = Math.floor((sx - mL) / cell), a = Math.floor((sy - mT) / cell)
      if (a < 0 || a >= k || b < 0 || b >= k) return
      if (opts.clickCarryLag) carryToCorr(cm.metrics[a], cm.metrics[b], lag)
      else { switchSub('corr'); runCorr(cm.metrics[a], cm.metrics[b]) }
    }
  }

  // ---- sub-tab switching ----
  function switchSub(name) {
    AN.curSub = name
    document.querySelectorAll('#an-subtabs .an-subtab').forEach((t) => t.classList.toggle('on', t.getAttribute('data-sub') === name))
    ;['presets', 'pivot', 'corr', 'lagmatrix', 'megamatrix', 'windows', 'dist'].forEach((s) => { const el = $('an-pane-' + s); if (el) el.style.display = s === name ? '' : 'none' })
    if (name === 'lagmatrix' && AN.last.lagmatrix === undefined) runLagMatrix()
    if (name === 'megamatrix' && !MM.cat) ensureMegaCatalog().then(() => refreshSelInfo())
  }

  window.initAnalysis = async function () {
    if (AN.inited) return
    AN.inited = true
    try { const info = await window.cta.scanEngine(); AN.engine = info.engine; $('an-engine').textContent = 'engine: ' + info.engine.toUpperCase() + (info.engine === 'node' ? ' (worker — Rust binary blocked by Smart App Control)' : ' (cta_scan)') } catch (e) {}
    try { const rinfo = await window.cta.rAvailable(); AN.rAvail = !!(rinfo && rinfo.available); AN.rReason = (rinfo && rinfo.reason) || 'Rscript not found'; if ($('an-engine')) $('an-engine').textContent += ' · R: ' + (AN.rAvail ? 'ready' : 'off') } catch (e) { AN.rAvail = false; AN.rReason = String(e) }
    buildPresets(); buildPivot(); buildCorr(); buildLagMatrix(); buildMegaMatrix(); buildWindows(); buildDist()
    document.querySelectorAll('#an-subtabs .an-subtab').forEach((t) => t.addEventListener('click', () => switchSub(t.getAttribute('data-sub'))))
    $('ps1-t').onclick = () => { switchSub('pivot'); $('pv-x').value = 'elapsed'; $('pv-xbin').value = 60; $('pv-y').value = 'pf'; $('pv-ybin').value = 0.05; $('pv-agg').value = 'mean'; $('pv-z').value = 'mv60'; runPivot() }
    $('ps2-t').onclick = () => { switchSub('pivot'); $('pv-x').value = 'hour'; $('pv-xbin').value = 1; $('pv-y').value = 'weekday'; $('pv-ybin').value = 1; $('pv-agg').value = 'mean'; $('pv-z').value = 'mv60'; runPivot() }
    $('ps3-t').onclick = () => switchSub('corr')
    $('an-apply').onclick = () => { AN.last = {}; refreshCurrent() }
    $('an-clear').onclick = () => { ['an-f-from', 'an-f-to', 'an-f-slmin', 'an-f-slmax', 'an-f-pmin', 'an-f-pmax'].forEach((i) => { if ($(i)) $(i).value = '' }); if ($('an-f-outcome')) $('an-f-outcome').value = ''; AN.last = {}; refreshCurrent() }
    window.cta.onScanProgress((d) => { if (!d || d.progress == null) return; if (d.phase === 'mega') { if (MM.buildInFlight) showMegaProg(d.progress, 'building derived channels… ' + d.progress + '%') } else if (d.progress < 100) status('loading archive… ' + d.progress + '%') })
    switchSub('presets')
    runPresets()
  }
  function refreshCurrent() {
    if (AN.curSub === 'presets') runPresets()
    else if (AN.curSub === 'pivot' && AN.last.pivot !== undefined) runPivot()
    else if (AN.curSub === 'corr' && AN.last.corr !== undefined) runCorr()
    else if (AN.curSub === 'lagmatrix') runLagMatrix()
    else if (AN.curSub === 'megamatrix') { MM.cat = null; MM.last = null; if (MM.built) { ensureMegaCatalog().then(() => refreshSelInfo()) } }
    else if (AN.curSub === 'windows') runWindows()
    else if (AN.curSub === 'dist' && AN.last.dist !== undefined) runDist()
  }
})()
