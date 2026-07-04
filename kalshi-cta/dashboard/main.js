const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

// BUG FIX (packaged-blank): once packaged, __dirname points INSIDE the .exe app bundle, NOT the
// source workspace, so path.join(__dirname,'..') can't find the synced bot data and the dashboard
// renders blank. When packaged, resolve ROOT to the ABSOLUTE real workspace dir (env-overridable);
// in dev keep the relative resolve. ONLY the resolution changes — every downstream write path
// (appendMerge/writeAtomic/writeSet/snap-label handlers/rewriteLabels) still targets ROOT verbatim.
const ROOT = process.env.CTA_DASHBOARD_ROOT
  || (app.isPackaged ? 'C:\\Users\\Noah\\claude-workspace\\kalshi-cta' : path.join(__dirname, '..'))
// ===== built-in box->local sync: one persistent ssh stream, runs inside the app (no separate window) =====
const { spawn } = require('child_process')
const SYNC_KEY = 'C:\\users\\Noah\\claude-workspace\\aws_key.pem'
const SYNC_BOX = (() => { try { const ip = fs.readFileSync('C:\\users\\Noah\\claude-workspace\\box_ip.txt', 'utf8').trim(); return 'ec2-user@' + (ip || 'YOUR_BOX_IP') } catch (e) { return 'ec2-user@YOUR_BOX_IP' } })()  // reads box_ip.txt so IP changes don't need a code edit; QA: empty/whitespace file falls back to the known IP (was silently producing 'ec2-user@' and breaking sync)
const SYNC_SSH = (() => { try { const p = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'; return fs.existsSync(p) ? p : 'ssh' } catch (e) { return 'ssh' } })()
let syncProc = null
// PERF(FREEZE): the SSH stream re-cats every file ~4x/sec and calls writeAtomic each cycle even when the
// content is byte-identical. fs.renameSync bumps mtime every time, which defeated the push() mtime-gate (the
// live-state file looked "changed" 4x/sec during idle). Skip the write when the bytes match what we last wrote
// for this file, so an unchanged file keeps a stable mtime and the downstream push/render gates can rest.
const _lastWritten = new Map()   // file -> last text we actually wrote (change-detection; mirrors appendMerge's _lastIncoming)
function writeAtomic(file, data) { try { if (_lastWritten.get(file) === data) return; _lastWritten.set(file, data); fs.writeFileSync(file + '.tmp', data); fs.renameSync(file + '.tmp', file) } catch (e) {} }
// APPEND-MERGE for append-only .jsonl mirrors: the SSH stream only sends a tail; overwriting would
// SHRINK the local archive on a box restart / /dev/shm wipe (the recurring data-loss failure mode).
// Union local+incoming by record-identity (t + entry_t + type), keep the superset, sort by t, atomic write.
const _lastIncoming = new Map()   // file -> last incoming tail text we actually processed (change-detection)
// PERF(FREEZE): per-file fast-append cache. The weights files (tail -200 of ~2.5KB nested-matrix rows) get a
// genuinely-new row appended on every train, so the byte-identical _lastIncoming guard always MISSES and the
// full O(filesize) appendMerge (parse 200 huge incoming lines + parse the entire local file + map/sort/stringify
// /rewrite) ran several times a minute — the single heaviest residual main-thread stall. This cache lets the
// common "pure tail-append of new rows" case skip re-reading+re-stringifying the whole file and instead
// fs.appendFileSync ONLY the new rows. Built from the authoritative full merge, so it always reflects on disk.
// FREEZE FIX (sliding-tail): sigs maps each known key -> its content fingerprint so the leading overlap of a
// `tail -N` window (incoming[0..N-2] already on disk) is SKIPPED instead of bailing the fast path on the first
// known key — restoring the bounded per-tick cost the path was written for. Only a key that is NEW, or KNOWN but
// with CHANGED content (a re-emitted field-richer/poorer row needing the overlay), defers to the full merge.
const _mergeCache = new Map()   // file -> { keys:Set<string>, sigs:Map<string,string>, maxT:number, count:number }
const _rowSig = (r) => { try { return JSON.stringify(r) } catch { return '' } }   // content fingerprint for collision-change detection
const JSONL_MERGE_CAP = 30000   // FREEZE FIX: cap the full-merge rewrite tail (append-only archives grew unboundedly → per-merge cost climbed all session)
function appendMerge(file, incomingText) {
  try {
    // FREEZE FIX: the SSH stream re-cats the same append-only tail ~4x/sec. When the incoming bytes are
    // byte-identical to the previous chunk for this file, the full parse+readback+map+sort+stringify+write
    // pipeline would re-run for ZERO new data. Skip it. (A genuinely changed/grown tail still runs the
    // entire merge below, so the never-delete / field-richer-wins data-integrity guarantees are untouched.)
    const _prevText = _lastIncoming.get(file)
    if (_prevText === incomingText) return
    _lastIncoming.set(file, incomingText)
    const splitLines = (txt) => (txt || '').trim().split('\n').filter(Boolean)
    const parseLines = (lines) => lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const incLines = splitLines(incomingText)
    // FREEZE FIX (text-level prefix overlap): `cat` re-emits the WHOLE append-only file ~4x/sec, so on a growth
    // tick the only difference from last time is a short NEW SUFFIX of lines. Previously the fast path still
    // parsed + JSON.stringify'd EVERY row just to recognise the leading overlap it would skip — O(filesize)
    // per growth tick. Instead, diff the raw lines against the previous incoming text: any leading lines that
    // are byte-identical to last tick were already processed+on-disk, so parse/scan ONLY the divergent suffix.
    // This makes the per-growth-tick cost O(new-rows) instead of O(filesize). (A change in the overlap region
    // shifts the divergence point earlier, so re-emitted/edited tail rows are still caught and full-merged.)
    let _ov = 0
    if (_prevText != null) {
      const prevLines = splitLines(_prevText)
      const lim = Math.min(prevLines.length, incLines.length)
      while (_ov < lim && prevLines[_ov] === incLines[_ov]) _ov++
    }
    const suffixLines = _ov > 0 ? incLines.slice(_ov) : incLines
    if (_ov > 0 && !suffixLines.length) return   // pure overlap with last tick + no new lines — nothing to do
    const incoming = parseLines(incLines)   // full parse kept for the full-merge fallback (authoritative path)
    if (!incoming.length) return   // nothing new — never clobber with empty
    const idTie = (r) => { const v = r.id != null ? r.id : (r.seq != null ? r.seq : (r.uid != null ? r.uid : null)); return v == null ? '' : v }
    const keyOf = (r) => [r.t, r.entry_t, r.type, r.trained, idTie(r)].map((x) => x == null ? '' : x).join('|')
    // ---- FAST-APPEND PATH ----------------------------------------------------------------------------------
    // Only when we hold a trusted cache for this file (so its key-set reflects on-disk truth) AND the incoming
    // tail is a clean superset that only ADDS strictly-newer rows: append just the new rows. Any collision with
    // an existing key, any out-of-order `t`, or a record missing `t` -> fall through to the full merge below
    // (which preserves the field-richer-wins overlay, sorting, and shrink-backup guarantees unchanged).
    // Scan ONLY the divergent suffix (the overlap lines are already on disk, byte-identical to last tick).
    const fc = _mergeCache.get(file)
    if (fc && fc.sigs) {
      const fresh = []
      let fast = true
      const scanRows = parseLines(suffixLines)
      for (const r of scanRows) {
        const k = keyOf(r)
        if (fc.keys.has(k)) {
          // SLIDING-TAIL OVERLAP: this key is already on disk. If the CONTENT is identical, it's just the leading
          // part of the tail window we've already stored -> SKIP it and keep scanning (do NOT bail). Only when a
          // re-emitted row actually CHANGED do we defer to the full merge so the field-richer-wins overlay runs.
          if (fc.sigs.get(k) === _rowSig(r)) continue
          fast = false; break
        }
        // Non-tail / missing `t` -> the file would need a re-sort, which append can't do. Defer to full merge.
        if (r.t == null || r.t < fc.maxT) { fast = false; break }
        fresh.push([k, r])
      }
      if (fast) {
        if (!fresh.length) return                     // every incoming row already present (pure overlap) — no write
        const body = fresh.map(([, r]) => JSON.stringify(r)).join('\n') + '\n'
        fs.appendFileSync(file, body)                 // append ONLY the strictly-new rows (no full re-read/re-stringify)
        fresh.forEach(([k, r]) => { fc.keys.add(k); fc.sigs.set(k, _rowSig(r)); if (r.t > fc.maxT) fc.maxT = r.t })
        fc.count += fresh.length
        return
      }
    }
    // ---- FULL MERGE PATH (authoritative; rebuilds the cache) ------------------------------------------------
    // QA-LOW(keyOf): keyOf/idTie are declared above the fast-append path; the tie-breaker appends the bot's
    // own explicit per-record identity (r.id / r.seq / r.uid) WHEN PRESENT so two DISTINCT records sharing the
    // same float `t` (+entry_t+type+trained) can't silently collide/dedup. Deliberately NOT a full-line content
    // hash: a re-emitted tail row that LOST a field must still collide with its richer existing copy so the
    // field-richer-wins overlay (QA-W1 below) can repair it.
    let existing = []
    // QA-DATALOSS FIX (2026-06-29): this previously called parse(...), which is NOT defined in this module
    // (only parseLines/splitLines are). The ReferenceError was swallowed by this line's empty catch, leaving
    // existing=[], so the full-merge path rebuilt the file from the INCOMING TAIL ONLY — truncating the local
    // append-only archive to tail -400 / tail -200 on every full-merge tick (a changed-content collision or an
    // out-of-order `t`). That directly violates the never-delete/superset guarantee. Read the on-disk file with
    // the in-scope parser so existing reflects the true local archive and the union/field-richer-wins merge holds.
    try { existing = parseLines(splitLines(fs.readFileSync(file, 'utf8'))) } catch {}
    const map = new Map()
    existing.forEach((r) => map.set(keyOf(r), r))
    // QA-W1: on key collision keep the FIELD-RICHER record (merge non-null incoming over existing).
    // A re-emitted tail record that lost/nulled a field can no longer silently degrade the local copy.
    const nonNullCount = (o) => Object.values(o).filter((v) => v != null).length
    incoming.forEach((r) => {
      const k = keyOf(r), prev = map.get(k)
      if (!prev) { map.set(k, r); return }
      // union fields: take prev as base, overlay only the non-null fields from incoming
      const merged = { ...prev }
      for (const [kk, vv] of Object.entries(r)) { if (vv != null) merged[kk] = vv }
      // never let the merge end up poorer than what we already had
      map.set(k, nonNullCount(merged) >= nonNullCount(prev) ? merged : prev)
    })
    let merged = Array.from(map.values()).sort((a, b) => (a.t || 0) - (b.t || 0))
    // FREEZE FIX: bound the rewritten archive. Without a cap the full merge re-reads+re-stringifies an
    // ever-growing file every tick, so per-merge cost climbed all session. Keep the most-recent tail; this only
    // trims rows already far older than anything the renderer reads (readState caps at JSONL_CAP=20000 anyway).
    // NOT a "shrink" in the data-loss sense (we keep the newest JSONL_MERGE_CAP rows), so it must NOT trip the
    // shrink-backup guard below — compute that against the pre-cap length.
    const preCapLen = merged.length
    if (merged.length > JSONL_MERGE_CAP) merged = merged.slice(merged.length - JSONL_MERGE_CAP)
    // QA-W2: post-merge shrink should NEVER happen for an append-only archive; if it somehow does,
    // snapshot to a TIMESTAMPED backup so a second consecutive shrink can't overwrite the first good copy.
    // (Use preCapLen so the intentional tail-cap above is not mistaken for a data-loss shrink.)
    if (preCapLen < existing.length) {
      try { if (fs.existsSync(file) && fs.statSync(file).size > 0) fs.copyFileSync(file, file + '.shrinkbak.' + Date.now()) } catch (e) {}
      backupOnce(file)   // also keep the rolling .lastnonempty.bak (recoverable single-copy)
    }
    const body = merged.map((o) => JSON.stringify(o)).join('\n') + (merged.length ? '\n' : '')
    fs.writeFileSync(file + '.tmp', body); fs.renameSync(file + '.tmp', file)
    // rebuild the fast-append cache from the just-written authoritative set so the next tick (a pure
    // tail-append of one new weights row) can skip the full re-read/re-stringify entirely.
    { const keys = new Set(); const sigs = new Map(); let maxT = -Infinity
      for (const r of merged) { const k = keyOf(r); keys.add(k); sigs.set(k, _rowSig(r)); if (r.t != null && r.t > maxT) maxT = r.t }
      _mergeCache.set(file, { keys, sigs, maxT, count: merged.length }) }
  } catch (e) {}
}
// ===== DATA STREAMS: in-memory rolling series for the per-second feed snapshot files =====
// The feed *_live.json files (perp_flow / xexch_texture / deribit_gex / deribit_vol / brti_book / btcobi)
// are single-object snapshots refreshed ~1x/sec on the box. The sync loop cats each one every cycle; we
// accumulate them here into a bounded in-memory per-tick series (keyed by the snapshot's `ts`, deduped),
// used to overlay these streams on the current-window chart. MEMORY-ONLY (not persisted): the current
// window repopulates within seconds of launch, so no disk churn and nothing to go stale on the box.
const _liveSeries = new Map()     // feedKey (e.g. 'perp_flow_live') -> [{t, ...fields}]
const _liveSeriesTs = new Map()   // feedKey -> last ts seen (dedup)
const LIVE_SERIES_CAP = 1600      // ~25min at 1/s — comfortably covers a 15-min window plus spill
function appendSeries(feedKey, text) {
  try {
    const obj = JSON.parse((text || '').trim())
    if (!obj || typeof obj !== 'object') return
    const ts = obj.ts != null ? obj.ts : obj.t
    if (ts == null) return
    if (_liveSeriesTs.get(feedKey) === ts) return   // same snapshot re-cat'd — skip
    _liveSeriesTs.set(feedKey, ts)
    let arr = _liveSeries.get(feedKey); if (!arr) { arr = []; _liveSeries.set(feedKey, arr) }
    obj.t = ts
    arr.push(obj)
    if (arr.length > LIVE_SERIES_CAP) arr.splice(0, arr.length - LIVE_SERIES_CAP)
  } catch (e) {}
}
// TICKLOG TAIL mirror: the box emits `tail -3500 ticklog.jsonl` every ~2s. We union it with the local mirror
// (dedup by `t`), keep the most-recent TICKLOG_TAIL_CAP rows, and atomic-write. BOUNDED by design — unlike the
// generic appendMerge (whose fast-append path never trims), so the file can't grow to 100MB+ over a long session
// and turn the mtime-cached read into a freeze. 12000 rows ≈ 8 windows: enough for the scrubber history + the
// current-window stream overlays, while a re-read (only when the file actually changes, ~2s) stays cheap.
const TICKLOG_TAIL_CAP = 12000
let _ttLastIncoming = null
function appendTicklogTail(text) {
  try {
    if (_ttLastIncoming === text) return   // byte-identical re-cat (no new rows) — skip the read/merge/write
    _ttLastIncoming = text
    const file = path.join(ROOT, 'ticklog_tail.jsonl')
    const parse = (t) => (t || '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const incoming = parse(text); if (!incoming.length) return
    let existing = []; try { existing = parse(fs.readFileSync(file, 'utf8')) } catch (e) {}
    const map = new Map()
    for (const r of existing) if (r && r.t != null) map.set(r.t, r)
    for (const r of incoming) if (r && r.t != null) map.set(r.t, r)
    let merged = Array.from(map.values()).sort((a, b) => a.t - b.t)
    if (merged.length > TICKLOG_TAIL_CAP) merged = merged.slice(merged.length - TICKLOG_TAIL_CAP)
    const body = merged.map((o) => JSON.stringify(o)).join('\n') + '\n'
    fs.writeFileSync(file + '.tmp', body); fs.renameSync(file + '.tmp', file)
  } catch (e) {}
}
// STREAM CATALOG: [id, label, group, kind('line'|'bar'), src('tick'|<feed_live_basename>), field]
// 'tick' fields come from the synced ticklog tail (per-tick, current window); feed fields come from _liveSeries.
const STREAM_CATALOG = [
  ['tfi', 'trade-flow imbalance', 'ORDER-FLOW', 'line', 'tick', 'tfi'],
  ['tvol', 'trade volume', 'ORDER-FLOW', 'bar', 'tick', 'tvol'],
  ['btcobi', 'BTC book imbalance', 'ORDER-FLOW', 'line', 'tick', 'btcobi'],
  ['btcspread', 'BTC spread', 'ORDER-FLOW', 'line', 'tick', 'btcspread'],
  ['mrate', 'msg rate', 'ORDER-FLOW', 'bar', 'tick', 'mrate'],
  ['biddepth', 'BTC bid depth', 'ORDER-FLOW', 'bar', 'btcobi_live', 'biddepth'],
  ['askdepth', 'BTC ask depth', 'ORDER-FLOW', 'bar', 'btcobi_live', 'askdepth'],
  ['sig', 'sigma (vol)', 'PRICE/MODEL', 'line', 'tick', 'sig'],
  ['dev', 'mid-fair deviation', 'PRICE/MODEL', 'line', 'tick', 'dev'],
  ['zstrike', 'z to strike', 'PRICE/MODEL', 'line', 'tick', 'zstrike'],
  ['cfmean', 'CF index', 'PRICE/MODEL', 'line', 'tick', 'cfmean'],
  ['btc', 'BTC spot', 'PRICE/MODEL', 'line', 'tick', 'btc'],
  ['calk', 'calk (vol calib)', 'PRICE/MODEL', 'line', 'tick', 'calk'],
  ['ya', 'YES ask', 'KALSHI', 'line', 'tick', 'ya'],
  ['na', 'NO ask', 'KALSHI', 'line', 'tick', 'na'],
  ['eth', 'ETH spot', 'CROSS-ASSET', 'line', 'tick', 'eth'],
  ['sol', 'SOL spot', 'CROSS-ASSET', 'line', 'tick', 'sol'],
  ['liq_rate', 'liq $/s', 'PERP', 'bar', 'perp_flow_live', 'liq_usd_per_s'],
  ['liq_imb', 'liq imbalance', 'PERP', 'line', 'perp_flow_live', 'liq_imb'],
  ['oi', 'open interest', 'PERP', 'line', 'perp_flow_live', 'oi'],
  ['oi_slope', 'OI slope', 'PERP', 'line', 'perp_flow_live', 'oi_slope'],
  ['funding_apr', 'funding APR', 'PERP', 'line', 'perp_flow_live', 'funding_apr'],
  ['cb_buyimb', 'CB buy imbalance', 'TEXTURE', 'line', 'xexch_texture_live', 'cb_buyimb'],
  ['kr_buyimb', 'KR buy imbalance', 'TEXTURE', 'line', 'xexch_texture_live', 'kr_buyimb'],
  ['cb_rate', 'CB trade rate', 'TEXTURE', 'bar', 'xexch_texture_live', 'cb_rate'],
  ['cb_vol', 'CB volume', 'TEXTURE', 'bar', 'xexch_texture_live', 'cb_vol'],
  ['gex_signed', 'GEX signed', 'DERIBIT', 'line', 'deribit_gex_live', 'gex_signed'],
  ['gex_near', 'GEX near signed', 'DERIBIT', 'line', 'deribit_gex_live', 'gex_near_signed'],
  ['iv', 'Deribit IV', 'DERIBIT', 'line', 'deribit_vol_live', 'iv'],
  ['iv_kalshi', 'Kalshi-implied IV', 'DERIBIT', 'line', 'deribit_vol_live', 'iv_kalshi'],
  ['iv_ratio', 'IV ratio (K/D)', 'DERIBIT', 'line', 'deribit_vol_live', 'ratio'],
  ['cons_obi', 'BRTI cons OBI', 'BRTI', 'line', 'brti_book_live', 'cons_obi'],
  ['brti_lead', 'BRTI lead vs idx', 'BRTI', 'line', 'brti_book_live', 'lead_vs_idx'],
  ['venue_disp', 'venue dispersion', 'BRTI', 'line', 'brti_book_live', 'venue_disp']
]
const STREAM_COLORS = ['#f0a000', '#4fd0e0', '#d070d0', '#ff5fa2', '#aaff00', '#ff8c00', '#7cc8ff', '#ffd600', '#67e0b0', '#ff6b6b', '#b088ff', '#00c2a8', '#e8a0ff', '#9fd356', '#ff9e40', '#5fd0ff', '#ff7ac0', '#c0e070', '#88c0ff', '#ffb0b0', '#70e0c0', '#d0a0ff', '#a0e0a0', '#ffcf70']
function _downsample(pts, maxN) {
  if (pts.length <= maxN) return pts
  const step = pts.length / maxN, out = []
  for (let i = 0; i < maxN; i++) out.push(pts[Math.floor(i * step)])
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1])
  return out
}
// SHARED stream-series builder: for a given set of that-window's ticklog rows (winRows) + the window's dense id
// (win) / open-epoch (winOpen), build the overlay payload for EVERY catalogued stream — per-tick series
// (elapsed-sec, value), min/max (for honest normalization), latest value, present flag. Feed-snapshot streams
// pull from the in-memory _liveSeries filtered to this window (older scrubbed windows won't have any -> present
// false). Used identically by the LIVE path (buildStreams) and the SCRUB path (buildStreamsForWindow) so the
// normalization the renderer draws is byte-for-byte the same for a past window as for the live one.
function _seriesForWindow(winRows, win, winOpen) {
  const tk = winRows.length ? winRows[winRows.length - 1].tk : null
  const streams = STREAM_CATALOG.map((c, idx) => {
    const [id, label, group, kind, src, field] = c
    let rows
    if (src === 'tick') rows = winRows.map((r) => [r.t, r[field]])
    else { const arr = _liveSeries.get(src) || []; rows = arr.filter((r) => Math.floor(r.t / 900) === win).map((r) => [r.t, r[field]]) }
    const pts = []; let mn = Infinity, mx = -Infinity, last = null
    for (const [t, v] of rows) {
      if (v == null || typeof v !== 'number' || !isFinite(v)) continue
      pts.push([+(t - winOpen).toFixed(1), v]); if (v < mn) mn = v; if (v > mx) mx = v; last = v
    }
    return { id, label, group, kind, color: STREAM_COLORS[idx % STREAM_COLORS.length], present: pts.length > 0, n: pts.length, last, min: pts.length ? mn : null, max: pts.length ? mx : null, pts: _downsample(pts, 260) }
  })
  return { tk, streams }
}
// Build the current-window overlay payload. Cheap (mtime-cached read + one pass over the current window's rows);
// pushed on the 'streams' channel ~1x/sec.
function buildStreams() {
  const tl = _readJsonl('ticklog_tail.jsonl')
  let nowEp = tl.length ? tl[tl.length - 1].t : Date.now() / 1000
  if (nowEp == null) nowEp = Date.now() / 1000
  const curWin = Math.floor(nowEp / 900), winOpen = curWin * 900
  const winRows = []
  for (let i = tl.length - 1; i >= 0; i--) {
    const r = tl[i]; if (!r || r.t == null) continue
    if (Math.floor(r.t / 900) !== curWin) { if (winRows.length) break; else continue }
    winRows.push(r)
  }
  winRows.reverse()
  const { tk, streams } = _seriesForWindow(winRows, curWin, winOpen)
  return { t0: winOpen, tk, nowEl: +(nowEp - winOpen).toFixed(1), streams }
}
// SCRUBBER overlay payload: build the SAME stream series for a selected PAST window (identified by its open
// epoch), on demand (once per scrub, via the 'get-window-streams' IPC). Same single-source ticklog parse
// (_readJsonl, mtime-cached) as buildHistoryFromTicklog + the identical _seriesForWindow normalization. Feed
// streams render whatever overlapping _liveSeries history still exists for the window; windows older than the
// ~25min in-memory feed buffers come back present:false so the panel can grey them as "no history".
function buildStreamsForWindow(t0) {
  const win = Math.floor(Number(t0) / 900), winOpen = win * 900
  const tl = _readJsonl('ticklog_tail.jsonl')
  const winRows = tl.filter((r) => r && r.t != null && Math.floor(r.t / 900) === win).sort((a, b) => a.t - b.t)
  if (!winRows.length) return null
  const { tk, streams } = _seriesForWindow(winRows, win, winOpen)
  return { t0: winOpen, tk, streams }
}
// HISTORY (rolling): reconstruct the last completed 15-min windows from the synced ticklog tail. The old
// history.json was a static days-old file the box no longer produces and the sync loop never pulled — this
// derives {windows:[{tk,t0,strike,pts:[[t,mid,fair]]}]} from RECENT ticks instead. Windows ascending by t0
// (newest last, matching the scrubber, which starts at hs.length-1), current incomplete window excluded.
function buildHistoryFromTicklog() {
  const tl = _readJsonl('ticklog_tail.jsonl')
  if (!tl.length) return null
  const nowEp = tl[tl.length - 1].t || Date.now() / 1000
  const curWin = Math.floor(nowEp / 900)
  const byWin = new Map()
  for (const r of tl) {
    if (!r || r.t == null || r.mid == null) continue
    const w = Math.floor(r.t / 900); if (w === curWin) continue
    let a = byWin.get(w); if (!a) { a = []; byWin.set(w, a) } a.push(r)
  }
  if (!byWin.size) return null
  const windows = Array.from(byWin.keys()).sort((a, b) => a - b).slice(-12).map((w) => {
    const rows = byWin.get(w).sort((a, b) => a.t - b.t)
    let strike = null; for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].strike != null) { strike = rows[i].strike; break } }
    const pts = _downsample(rows.map((r) => [+r.t.toFixed(2), r.mid, r.fair != null ? r.fair : r.mid]), 220)
    return { tk: rows[rows.length - 1].tk, t0: w * 900, strike, pts }
  })
  return JSON.stringify({ windows })
}

// CPU-HANG FIX (2026-06-29, reference-cta-box-cpu-hang): every SSH reconnect spawned a NEW box-side
// `while true; cat ~20 files; sleep` loop WITHOUT killing the prior one. After a few drops, 2-3 piled up on
// the 4-core box (~80 cat-spawns/sec) and CPU-starved the NNs into a 34-min hang. Three defenses below:
//   (1) SINGLE-FLIGHT (local): never run two local ssh children at once. If one is already live, no-op.
//   (2) MARKER REAP (box): the remote command first kills any OLDER loop carrying our unique marker, so an
//       orphaned loop from a dropped SSH (whose local child is gone but whose box-side loop keeps running) is
//       reaped before we start a fresh one. Both generations run the IDENTICAL command string, so a bare
//       `pkill -f <marker>` would self-kill (the documented trap). Instead we pgrep all marker-bearing PIDs
//       and kill every one EXCEPT this shell ($$) and its ssh parent ($PPID) — only prior generations die.
//   (3) LOAD REDUCTION: 0.25s -> 0.5s cadence (halves cat-spawn rate) and tail -400 -> tail -150 on the
//       growing *_history files (appendMerge's mtime/overlap gate dedupes downstream, so a shorter tail still
//       carries every new row between 0.5s ticks; the full cat of small status/trade files is unchanged).
const SYNC_MARKER = 'CTASYNCv1'
// AUTO-DISCOVER forward bots: the box loop now ENUMERATES C_*_status.json / C_*_trades.jsonl and tags each
// with a dynamic marker (<<<FBS file>>> / <<<FBT file>>>) instead of a fixed per-bot marker list, so any new
// creep variant (C_creep75/80/85, etc.) on the box auto-syncs with NO code edit. This helper validates the
// emitted filename (defensive: only a bare basename matching the expected forward-bot shape is honored — never
// a path with separators / .. that could escape ROOT) and returns the target ROOT path + the data-loss-safe
// writer for it (status JSON -> writeAtomic; trades .jsonl -> appendMerge / never-shrink). Returns null to skip.
const _FBS_RE = /^C_[A-Za-z0-9_]+_status\.json$/   // status: single JSON object -> writeAtomic
const _FBT_RE = /^C_[A-Za-z0-9_]+_trades\.jsonl$/  // trades: append-only archive -> appendMerge (superset/never-shrink)
function fwdSyncTarget(kind, name) {
  if (typeof name !== 'string' || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('..') >= 0) return null
  if (kind === 'S' && _FBS_RE.test(name)) return { file: path.join(ROOT, name), write: writeAtomic }
  if (kind === 'T' && _FBT_RE.test(name)) return { file: path.join(ROOT, name), write: appendMerge }
  return null
}
function startSync() {
  if (syncProc) return   // (1) SINGLE-FLIGHT: a live local ssh child already owns the stream — do not stack a second
  // (2) reap any orphaned older box-side loop carrying our marker, then (3) start the throttled, lighter loop.
  const loop = ": " + SYNC_MARKER + "; i=0; while true; do i=$((i+1)); echo '<<<S>>>'; cat /dev/shm/cta/cta_evolve_state.json; echo; echo '<<<T>>>'; cat /dev/shm/cta/cta_live_trades.jsonl 2>/dev/null; echo; echo '<<<P>>>'; cat /dev/shm/cta/paper_trades.jsonl 2>/dev/null; echo; echo '<<<B>>>'; cat /dev/shm/cta/paper_evolve_board.json 2>/dev/null; echo; echo '<<<C>>>'; cat /dev/shm/cta/calib_status.json 2>/dev/null; echo; echo '<<<N>>>'; cat /dev/shm/cta/w_neural_status.json 2>/dev/null; echo; echo '<<<W>>>'; cat /dev/shm/cta/w_neural_trades.jsonl 2>/dev/null; echo; echo '<<<H>>>'; tail -150 /dev/shm/cta/w_neural_history.jsonl 2>/dev/null; echo; echo '<<<X>>>'; cat /dev/shm/cta/E_trades.jsonl 2>/dev/null; echo; echo '<<<MM>>>'; cat /dev/shm/cta/M_trades.jsonl 2>/dev/null; echo; echo '<<<NB>>>'; cat /dev/shm/cta/w_neural_nobox_status.json 2>/dev/null; echo; echo '<<<NBW>>>'; cat /dev/shm/cta/w_neural_nobox_trades.jsonl 2>/dev/null; echo; echo '<<<NBH>>>'; tail -150 /dev/shm/cta/w_neural_nobox_history.jsonl 2>/dev/null; echo; echo '<<<WGT>>>'; tail -200 /dev/shm/cta/w_neural_weights.jsonl 2>/dev/null; echo; echo '<<<WGTX>>>'; tail -200 /dev/shm/cta/w_neural_nobox_weights.jsonl 2>/dev/null; echo; echo '<<<V2S>>>'; cat /dev/shm/cta/w_neural_v2_status.json 2>/dev/null; echo; echo '<<<V2W>>>'; cat /dev/shm/cta/w_neural_v2_trades.jsonl 2>/dev/null; echo; echo '<<<V2H>>>'; tail -150 /dev/shm/cta/w_neural_v2_history.jsonl 2>/dev/null; echo; echo '<<<V2G>>>'; tail -200 /dev/shm/cta/w_neural_v2_weights.jsonl 2>/dev/null; echo; echo '<<<RWS>>>'; cat /dev/shm/cta/w_neural_real_status.json 2>/dev/null; echo; echo '<<<RWT>>>'; cat /dev/shm/cta/w_neural_real_trades.jsonl 2>/dev/null; echo; echo '<<<RWH>>>'; tail -150 /dev/shm/cta/w_neural_real_history.jsonl 2>/dev/null; echo; echo '<<<RWA>>>'; cat /dev/shm/cta/w_neural_real_account.json 2>/dev/null; echo; cd /dev/shm/cta 2>/dev/null; for f in C_*_status.json; do [ -e \"$f\" ] || continue; echo \"<<<FBS $f>>>\"; cat \"$f\" 2>/dev/null; echo; done; for f in C_*_trades.jsonl; do [ -e \"$f\" ] || continue; echo \"<<<FBT $f>>>\"; cat \"$f\" 2>/dev/null; echo; done; echo '<<<E>>>'; echo '<<<TLM>>>'; if [ $((i%4)) -eq 1 ]; then tail -3500 /dev/shm/cta/ticklog.jsonl 2>/dev/null; fi; echo; for lf in brti_book_live btcobi_live perp_flow_live xexch_texture_live deribit_gex_live deribit_vol_live; do echo \"<<<LFX $lf>>>\"; cat /dev/shm/cta/$lf.json 2>/dev/null; echo; done; echo '<<<Z>>>'; sleep 0.5; done"
  // The loop carries the literal marker via the leading `: CTASYNCv1` no-op, so it sits in the box-side bash
  // argv where pgrep -f can find it. We CANNOT use a bare `pkill -f CTASYNCv1` here: both generations run the
  // identical command string, so any marker match would also match THIS shell's own argv (the documented
  // self-kill trap). Instead pgrep all marker-bearing PIDs and kill every one EXCEPT this shell ($$) and its
  // ssh parent ($PPID) — reaping only prior/orphaned generations, never ourselves. `kill -9` then settle.
  const reap = 'me=$$; pp=$PPID; for p in $(pgrep -f ' + SYNC_MARKER + ' 2>/dev/null); do if [ "$p" != "$me" ] && [ "$p" != "$pp" ]; then kill -9 "$p" 2>/dev/null; fi; done; sleep 0.3; '
  const remote = reap + loop
  const args = ['-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=4', '-o', 'ServerAliveCountMax=2', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'Compression=yes', '-i', SYNC_KEY, SYNC_BOX, remote]
  try { syncProc = spawn(SYNC_SSH, args, { windowsHide: true }) } catch (e) { syncProc = null; setTimeout(startSync, 2000); return }
  let buf = '', tgt = '', acc = ''
  // AUTO-DISCOVER forward bots: the currently-pending dynamic forward-bot write target ({file, write}) and a
  // flusher that commits the accumulated section to it when the NEXT marker (or terminal <<<E>>>) arrives.
  // The acc.length>1 guard mirrors the fixed sections: an empty cat (not-yet-created trades file) is skipped,
  // so a missing/empty box file never clobbers the local mirror.
  let fbTarget = null
  const flushFB = () => { if (tgt === 'FB' && fbTarget && acc.length > 1) fbTarget.write(fbTarget.file, acc) }
  // DATA STREAMS: the live-feed section (LFX) accumulates one snapshot per feed; flush the pending one when the
  // next LFX marker (or terminal <<<Z>>>) arrives, mirroring flushFB.
  let lfKey = null
  const flushLF = () => { if (tgt === 'LF' && lfKey && acc.length > 1) appendSeries(lfKey, acc) }
  syncProc.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1)
      if (line === '<<<S>>>') { tgt = 'S'; acc = '' }
      else if (line === '<<<T>>>') { if (tgt === 'S' && acc.length > 2) writeAtomic(path.join(ROOT, 'cta_evolve_state.json'), acc); tgt = 'T'; acc = '' }
      else if (line === '<<<P>>>') { if (tgt === 'T' && acc.length > 1) writeAtomic(path.join(ROOT, 'cta_live_trades.jsonl'), acc); tgt = 'P'; acc = '' }
      else if (line === '<<<B>>>') { if (tgt === 'P' && acc.length > 1) writeAtomic(path.join(ROOT, 'paper_trades.jsonl'), acc); tgt = 'B'; acc = '' }
      else if (line === '<<<C>>>') { if (tgt === 'B' && acc.length > 1) writeAtomic(path.join(ROOT, 'paper_evolve_board.json'), acc); tgt = 'C'; acc = '' }
      else if (line === '<<<N>>>') { if (tgt === 'C' && acc.length > 1) writeAtomic(path.join(ROOT, 'calib_status.json'), acc); tgt = 'N'; acc = '' }
      else if (line === '<<<W>>>') { if (tgt === 'N' && acc.length > 1) writeAtomic(path.join(ROOT, 'w_neural_status.json'), acc); tgt = 'W'; acc = '' }
      else if (line === '<<<H>>>') { if (tgt === 'W' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_trades.jsonl'), acc); tgt = 'H'; acc = '' }
      else if (line === '<<<X>>>') { if (tgt === 'H' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_history.jsonl'), acc); tgt = 'X'; acc = '' }
      else if (line === '<<<MM>>>') { if (tgt === 'X' && acc.length > 1) writeAtomic(path.join(ROOT, 'e_trades.jsonl'), acc); tgt = 'MM'; acc = '' }
      else if (line === '<<<NB>>>') { if (tgt === 'MM' && acc.length > 1) writeAtomic(path.join(ROOT, 'm_trades.jsonl'), acc); tgt = 'NB'; acc = '' }
      else if (line === '<<<NBW>>>') { if (tgt === 'NB' && acc.length > 1) writeAtomic(path.join(ROOT, 'w_neural_nobox_status.json'), acc); tgt = 'NBW'; acc = '' }
      else if (line === '<<<NBH>>>') { if (tgt === 'NBW' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_nobox_trades.jsonl'), acc); tgt = 'NBH'; acc = '' }
      else if (line === '<<<WGT>>>') { if (tgt === 'NBH' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_nobox_history.jsonl'), acc); tgt = 'WGT'; acc = '' }
      else if (line === '<<<WGTX>>>') { if (tgt === 'WGT' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_weights.jsonl'), acc); tgt = 'WGTX'; acc = '' }
      else if (line === '<<<V2S>>>') { if (tgt === 'WGTX' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_nobox_weights.jsonl'), acc); tgt = 'V2S'; acc = '' }
      else if (line === '<<<V2W>>>') { if (tgt === 'V2S' && acc.length > 1) writeAtomic(path.join(ROOT, 'w_neural_v2_status.json'), acc); tgt = 'V2W'; acc = '' }
      else if (line === '<<<V2H>>>') { if (tgt === 'V2W' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_v2_trades.jsonl'), acc); tgt = 'V2H'; acc = '' }
      else if (line === '<<<V2G>>>') { if (tgt === 'V2H' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_v2_history.jsonl'), acc); tgt = 'V2G'; acc = '' }
      else if (line === '<<<RWS>>>') { if (tgt === 'V2G' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_v2_weights.jsonl'), acc); tgt = 'RWS'; acc = '' }
      else if (line === '<<<RWT>>>') { if (tgt === 'RWS' && acc.length > 1) writeAtomic(path.join(ROOT, 'w_neural_real_status.json'), acc); tgt = 'RWT'; acc = '' }
      else if (line === '<<<RWH>>>') { if (tgt === 'RWT' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_real_trades.jsonl'), acc); tgt = 'RWH'; acc = '' }
      else if (line === '<<<RWA>>>') { if (tgt === 'RWH' && acc.length > 1) appendMerge(path.join(ROOT, 'w_neural_real_history.jsonl'), acc); tgt = 'RWA'; acc = '' }
      // AUTO-DISCOVER forward bots: the LAST fixed section is w_neural_real_account.json; it is flushed when the
      // FIRST dynamic forward-bot marker (or the terminal <<<E>>>) arrives. Every C_*_status.json / C_*_trades.jsonl
      // the box enumerates is tagged <<<FBS file>>> / <<<FBT file>>> and routed generically — so any new creep
      // variant auto-syncs with NO marker/parser edit. Status -> writeAtomic, trades -> appendMerge (never-shrink).
      else if (line.startsWith('<<<FBS ') || line.startsWith('<<<FBT ')) {
        if (tgt === 'RWA' && acc.length > 1) writeAtomic(path.join(ROOT, 'w_neural_real_account.json'), acc)
        else flushFB()
        const isS = line.startsWith('<<<FBS ')
        const fn = line.slice(7, line.length - 3).trim()   // strip '<<<FBS '/'<<<FBT ' (both 7 chars) + '>>>' suffix
        fbTarget = fwdSyncTarget(isS ? 'S' : 'T', fn)        // null => unrecognized/unsafe name: content collected then dropped
        tgt = 'FB'; acc = ''
      }
      else if (line === '<<<E>>>') { if (tgt === 'RWA' && acc.length > 1) writeAtomic(path.join(ROOT, 'w_neural_real_account.json'), acc); else flushFB(); fbTarget = null; tgt = '' }
      // DATA STREAMS sections (after <<<E>>>, which has already closed the FB region and set tgt=''):
      //   <<<TLM>>>      -> ticklog tail (emitted every ~2s) -> appendMerge into ticklog_tail.jsonl (rolling mirror)
      //   <<<LFX name>>> -> per-second feed snapshot -> appendSeries (in-memory rolling series)
      //   <<<Z>>>        -> terminal: flush the last feed snapshot
      else if (line === '<<<TLM>>>') { tgt = 'TLM'; acc = '' }
      else if (line.startsWith('<<<LFX ')) {
        if (tgt === 'TLM' && acc.length > 1) appendTicklogTail(acc)
        else flushLF()
        lfKey = line.slice(7, line.length - 3).trim()   // strip '<<<LFX ' (7) + '>>>' (3)
        tgt = 'LF'; acc = ''
      }
      else if (line === '<<<Z>>>') { flushLF(); lfKey = null; tgt = '' }
      else acc += line + '\n'
    }
  })
  syncProc.on('close', () => { syncProc = null; setTimeout(startSync, 1000) })   // auto-reconnect
  syncProc.on('error', () => { syncProc = null; setTimeout(startSync, 2000) })
}
function readLiveTrades() {
  try {
    return fs.readFileSync(path.join(ROOT, 'cta_live_trades.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function readPaperTrades() {
  try {
    return fs.readFileSync(path.join(ROOT, 'paper_trades.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
const LABELS = path.join(ROOT, 'snap_labels.jsonl')
function readSnapLabels() {
  try {
    return fs.readFileSync(LABELS, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
// QA GUARD: only append a well-formed object. A null/undefined/primitive payload (e.g. an undo pop of an
// empty stack, or a future caller bug) would otherwise write a literal "undefined\n"/"null\n" junk line into
// the append-only label archive; readSnapLabels then silently drops it on parse, but it still pollutes the
// file and any raw consumer. Reject non-objects at the door (additive; a real label object is unchanged).
ipcMain.on('save-label', (_e, label) => { try { if (!label || typeof label !== 'object') return; fs.appendFileSync(LABELS, JSON.stringify(label) + '\n') } catch {} })
// QA-LOW(main.js:107-109): route the full-file label rewrites through writeAtomic (.tmp + rename) so a
// crash mid-write can no longer tear snap_labels.jsonl (was a bare fs.writeFileSync).
// QA-DATALOSS DEFENSE (2026-06-29): del/exclude/flip derive the new full set from readSnapLabels(), which
// returns [] on ANY read exception (transient EBUSY/EACCES, partial read mid-append). Writing that [] back
// would WIPE the user-curated label archive — the same archetype as the wave/oracle annotation wipe. Guard:
// only treat an empty RESULT as legit when the READ itself returned rows (i.e. the user really deleted the
// last label). An empty result that came from an EMPTY read over a NON-EMPTY on-disk file is a failed read
// -> back up + abort (never wipe). Deleting the genuine last label still works (read had 1 row, now 0).
function rewriteLabels(prev, next) {
  if (!Array.isArray(next)) return                             // never coerce garbage into a wipe
  if (next.length === 0 && prev.length === 0) {
    // read produced nothing AND result is nothing: if the file is actually non-empty, the read FAILED -> abort
    try { if (fs.existsSync(LABELS) && fs.statSync(LABELS).size > 0) { backupOnce(LABELS); return } } catch (e) { return }
  }
  writeAtomic(LABELS, next.map((l) => JSON.stringify(l)).join('\n') + (next.length ? '\n' : ''))
}
// QA-D3 FIX (2026-07-01): delete only the FIRST label whose labeled_at === ts, not ALL of them.
// labeled_at = Date.now() is the label identity; two labels created in the same millisecond (e.g. a
// rapid YES then NO leg via the keyboard, or programmatic saves) collide. The old `filter(!== ts)`
// removed EVERY colliding row on a single delete (and the renderer's undo pushes only ONE, so the
// second was silently lost user data). Splice the first match instead; a non-collision delete is
// byte-for-byte identical to before. Additive + guarded — never widens into a wipe (rewriteLabels
// still aborts+backs-up on a failed/empty read).
ipcMain.on('del-label', (_e, ts) => { try { const p = readSnapLabels(); const i = p.findIndex((l) => l.labeled_at === ts); if (i < 0) return; const next = p.slice(0, i).concat(p.slice(i + 1)); rewriteLabels(p, next) } catch {} })
ipcMain.on('exclude-label', (_e, ts) => { try { const p = readSnapLabels(); rewriteLabels(p, p.map((l) => l.labeled_at === ts ? { ...l, train: l.train === false } : l)) } catch {} })
ipcMain.on('flip-label', (_e, ts) => { try { const p = readSnapLabels(); rewriteLabels(p, p.map((l) => (l.labeled_at === ts && l.kind === 'realtime' && l.buy_px != null && l.sell_px != null) ? { ...l, side: l.side === 'yes' ? 'no' : 'yes', buy_px: +(1 - l.buy_px).toFixed(2), sell_px: +(1 - l.sell_px).toFixed(2) } : l)) } catch {} })
// HISTORY: prefer the rolling window-history rebuilt from the synced ticklog tail (recent windows). Fall back
// to the legacy static history.json only if the ticklog tail hasn't populated yet (e.g. first seconds after launch).
let _builtHistory = null
ipcMain.handle('get-history', () => {
  try { const h = buildHistoryFromTicklog(); if (h) { _builtHistory = h; return h } } catch (e) {}
  if (_builtHistory) return _builtHistory
  try { return fs.readFileSync(path.join(ROOT, 'history.json'), 'utf8') } catch (e) { return null }
})
// SCRUBBER stream overlays: build the stream-series payload for one past window (by its open epoch), on demand
// when the user scrubs to it. Returns the SAME shape as the live 'streams' push (see buildStreamsForWindow).
ipcMain.handle('get-window-streams', (_e, t0) => {
  try { return buildStreamsForWindow(t0) } catch (e) { return null }
})
// ===== BACKTEST tab: viz data + wave/oracle annotations (additive; does not touch live sync) =====
const WAVE_LABELS = path.join(ROOT, 'wave_labels.jsonl')
const ORACLE_LABELS = path.join(ROOT, 'oracle_labels.jsonl')
ipcMain.handle('get-viz', () => { try { return fs.readFileSync(path.join(ROOT, 'viz_data.json'), 'utf8') } catch (e) { return null } })
ipcMain.handle('get-annotations', () => {
  // QA-DATALOSS FIX (2026-06-30): distinguish a FAILED READ of an EXISTING file from a genuinely
  // empty/absent one. Previously rd() returned [] on ANY exception (EBUSY/EACCES/partial read mid-
  // append). The renderer could not tell that false-empty from a real empty, set annLoaded=true with
  // empty working sets, and a subsequent ADD-one-box persist overwrote a good N-row file with 1 row
  // (backupOnce only fires on a length-0 write, so that single unbacked corridor lost data). Now:
  //   - file does not exist        -> [] (legitimately empty; persistence may proceed)
  //   - file exists but read threw -> null (FAILED read; renderer must NOT enable persistence)
  //   - file read OK               -> parsed rows (possibly [] if truly empty on disk)
  const rd = (f) => {
    let txt
    try { txt = fs.readFileSync(f, 'utf8') }
    catch (e) { return (e && e.code === 'ENOENT') ? [] : null }   // missing = empty; any other error = failed read
    return txt.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }
  return { wave: rd(WAVE_LABELS), oracle: rd(ORACLE_LABELS) }
})
// QA GUARD (same rationale as save-label): reject a non-object payload so a malformed IPC message can't
// append a junk "undefined\n"/"null\n" line into the append-only annotation archive.
ipcMain.on('save-wave-label', (_e, o) => { try { if (!o || typeof o !== 'object') return; fs.appendFileSync(WAVE_LABELS, JSON.stringify(o) + '\n') } catch {} })
ipcMain.on('save-oracle-label', (_e, o) => { try { if (!o || typeof o !== 'object') return; fs.appendFileSync(ORACLE_LABELS, JSON.stringify(o) + '\n') } catch {} })
// working-set overwrite model (edit/delete/undo/redo): renderer owns the full set, we rewrite the whole file.
// DATA-LOSS DEFENSE: this is the archetype-bug surface (a "save full set" that wipes good data). Two guards:
//  1) Reject a non-array payload outright (never coerce garbage into an empty wipe).
//  2) Before overwriting a currently-NON-EMPTY file with an EMPTY set, snapshot the old content to a
//     single rolling .bak so any wipe (legit delete-all OR a future renderer bug) is always recoverable.
function backupOnce(file) {
  try { if (fs.existsSync(file) && fs.statSync(file).size > 0) fs.copyFileSync(file, file + '.lastnonempty.bak') } catch (e) {}
}
function writeSet(file, arr) {
  try {
    if (!Array.isArray(arr)) return   // GUARD: malformed/undefined payload must never overwrite good data
    const body = arr.map((o) => JSON.stringify(o)).join('\n') + (arr.length ? '\n' : '')
    if (arr.length === 0) backupOnce(file)   // about to (legitimately or not) empty the file -> keep a recoverable copy
    fs.writeFileSync(file + '.tmp', body); fs.renameSync(file + '.tmp', file)   // atomic: no torn/partial file on crash
  } catch (e) {}
}
ipcMain.on('save-wave-set', (_e, arr) => writeSet(WAVE_LABELS, arr))
ipcMain.on('save-oracle-set', (_e, arr) => writeSet(ORACLE_LABELS, arr))
function readHistory() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'history.json'), 'utf8')) } catch (e) { return null } }

// ===== PERF: mtime-cached file reads (FREEZE FIX) =====
// readState() previously readFileSync+JSON.parsed ~22 files (incl. unbounded append-only .jsonl archives)
// on EVERY push tick (~8x/sec), re-parsing every line of each full archive each time — the root driver
// of the main-process stall. We now cache the parsed result per file and only re-read when the file's
// mtime (and size) changed. For .jsonl archives we additionally CAP the in-memory array to the tail the
// renderer actually uses (current window + history graphs), so per-tick cost is bounded as archives grow.
const _fileCache = new Map()   // absolute path -> { mtimeMs, size, value }
const JSONL_CAP = 20000        // runaway-growth safety bound (well above any realistic session; mtime-cache is the real win)
const STATE_EMBED_CAP = 20000  // FREEZE FIX: cap the trace/trades_log arrays EMBEDDED in cta_evolve_state.json on every parse (the renderer only displays the current 15-min window; this bounds the IPC payload + downstream iteration)
function _cachedRead(file, parser, cap) {
  let stat
  try { stat = fs.statSync(file) } catch { _fileCache.delete(file); return parser == null ? null : [] }
  const hit = _fileCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value
  let value
  try {
    const txt = fs.readFileSync(file, 'utf8')
    value = parser ? parser(txt) : JSON.parse(txt)
    if (cap && Array.isArray(value) && value.length > cap) value = value.slice(value.length - cap)
  } catch { value = parser == null ? null : [] }
  _fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}
const _parseJsonl = (txt) => (txt || '').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const _readJson = (f) => _cachedRead(path.join(ROOT, f), null, 0)
const _readJsonl = (f, cap) => _cachedRead(path.join(ROOT, f), _parseJsonl, cap == null ? JSONL_CAP : cap)

function readState() {
  try {
    // cta_evolve_state.json changes every tick — read it fresh, but everything else is mtime-cached so a
    // tick where nothing else changed is nearly free (no re-parse of the big append-only archives).
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'cta_evolve_state.json'), 'utf8'))
    // PERF(FREEZE): trace/trades_log are embedded INSIDE the live state file (not the capped .jsonl mirrors),
    // so they grow unbounded across a 15-min window and every downstream IPC payload + renderer iteration
    // scales with them — the classic "laggier the longer it runs". The parse itself is unavoidable, but cap the
    // arrays here so everything after stays bounded. STATE_EMBED_CAP must exceed the largest tail the renderer
    // reads: drawVtrace renders only the current 15-min window (~2700 rows at 3/s) via _vwCache, the leaderboard
    // reads per-window series — 20000 is far above either, so this only trims rows the UI never displays.
    if (Array.isArray(s.trace) && s.trace.length > STATE_EMBED_CAP) s.trace = s.trace.slice(-STATE_EMBED_CAP)
    if (Array.isArray(s.trades_log) && s.trades_log.length > STATE_EMBED_CAP) s.trades_log = s.trades_log.slice(-STATE_EMBED_CAP)
    s.live_trades = _readJsonl('cta_live_trades.jsonl')
    s.snap_labels = _readJsonl('snap_labels.jsonl', 0)   // user-curated labels: shown IN FULL on the Training tab — never cap
    s.paper_trades = _readJsonl('paper_trades.jsonl')
    s.evolve_board = _readJson('paper_evolve_board.json')
    s.calib_status = _readJson('calib_status.json')
    s.w_neural_status = _readJson('w_neural_status.json')
    s.w_neural_trades = _readJsonl('w_neural_trades.jsonl')
    s.w_neural_history = _readJsonl('w_neural_history.jsonl')
    s.e_trades = _readJsonl('e_trades.jsonl')
    s.m_trades = _readJsonl('m_trades.jsonl')
    // NN-ONLY mode: nobox twin + weight-history mirrors
    s.w_neural_nobox_status = _readJson('w_neural_nobox_status.json')
    s.w_neural_nobox_trades = _readJsonl('w_neural_nobox_trades.jsonl')
    s.w_neural_nobox_history = _readJsonl('w_neural_nobox_history.jsonl')
    s.w_neural_weights = _readJsonl('w_neural_weights.jsonl')
    s.w_neural_nobox_weights = _readJsonl('w_neural_nobox_weights.jsonl')
    // WN2 (W_neural_v2) — WN-seeded bot + the friend's #1 LIVE window-tradability guard
    s.w_neural_v2_status = _readJson('w_neural_v2_status.json')
    s.w_neural_v2_trades = _readJsonl('w_neural_v2_trades.jsonl')
    s.w_neural_v2_history = _readJsonl('w_neural_v2_history.jsonl')
    s.w_neural_v2_weights = _readJsonl('w_neural_v2_weights.jsonl')
    // W_neural_REAL — the LIVE real-money bot (1-contract, hard $10 cap). Distinct REAL card.
    s.w_neural_real_status = _readJson('w_neural_real_status.json')
    s.w_neural_real_trades = _readJsonl('w_neural_real_trades.jsonl')
    s.w_neural_real_history = _readJsonl('w_neural_real_history.jsonl')
    // GROUND TRUTH from the real Kalshi account (read-only poller) — authoritative headline for the REAL card
    s.w_neural_real_account = _readJson('w_neural_real_account.json')
    // AUTO-DISCOVER forward bots: enumerate every C_*_status.json / C_*_trades.jsonl the box synced into ROOT
    // and attach each under a state key derived from its filename (lowercase basename minus extension):
    //   C_creep75_status.json -> s.c_creep75_status   |   C_creep75_trades.jsonl -> s.c_creep75_trades
    // So a brand-new creep variant appears with NO per-bot read line. _readJson tolerates a missing/malformed
    // file (null) and _readJsonl returns [] when absent, exactly as the previous explicit reads did. Read-only.
    try {
      for (const f of fs.readdirSync(ROOT)) {
        if (/^C_[A-Za-z0-9_]+_status\.json$/.test(f)) s[f.slice(0, -5).toLowerCase()] = _readJson(f)
        else if (/^C_[A-Za-z0-9_]+_trades\.jsonl$/.test(f)) s[f.slice(0, -6).toLowerCase()] = _readJsonl(f)
      }
    } catch {}
    return s
  } catch { return null }
}

// ===== WINDOW ANALYSIS scan engine =====
// Preferred fast path: the Rust `cta_scan` binary (multithreaded, ~0.7s over the full 785MB ticklog).
// Fallback: a Node worker-thread engine (scan_worker.js) implementing the SAME query contract — used
// automatically when the Rust binary is missing OR blocked (Smart App Control on this box refuses to
// spawn the unsigned exe; the worker runs inside the already-signed Node/Electron process). Either way
// the scan runs OFF the UI thread and results are identical-shaped JSON.
const { Worker } = require('worker_threads')
const CTA_SCAN_BIN = process.env.CTA_SCAN_BIN || 'C:\\Users\\Noah\\claude-workspace\\cta_scan\\target\\release\\cta_scan.exe'
const CTA_TICKLOG = process.env.CTA_TICKLOG || path.join(ROOT, '..', 'ticklog_archive.jsonl')
let _scanWorker = null, _workerReqId = 0
const _workerPending = new Map()
function scanWin() { return win } // late-bound; win declared below
// worker_threads cannot load a script from INSIDE an asar archive, so resolve to the real-fs source
// copy (ROOT points at the real workspace even when packaged). __dirname is the dev/unpacked fallback.
const WORKER_JS = (() => {
  const cand = [path.join(ROOT, 'dashboard', 'scan_worker.js'), path.join(__dirname, 'scan_worker.js')]
  for (const c of cand) { try { if (!c.includes('.asar') && fs.existsSync(c)) return c } catch (e) {} }
  return path.join(__dirname, 'scan_worker.js')
})()
function getWorker() {
  if (_scanWorker) return _scanWorker
  try {
    _scanWorker = new Worker(WORKER_JS, { workerData: { ticklog: CTA_TICKLOG } })
    _scanWorker.on('message', (m) => {
      if (m && m.progress != null) { const w = scanWin(); if (w && !w.isDestroyed()) w.webContents.send('scan-progress', { id: m.id, progress: m.progress, phase: m.phase || null }); return }
      const p = _workerPending.get(m.id); if (!p) return; _workerPending.delete(m.id)
      p.resolve(m.ok ? m.result : { error: m.error })
    })
    _scanWorker.on('error', (e) => { for (const [, p] of _workerPending) p.resolve({ error: String(e) }); _workerPending.clear(); _scanWorker = null })
    _scanWorker.on('exit', () => { _scanWorker = null })
  } catch (e) { _scanWorker = null }
  return _scanWorker
}
function workerScan(query) {
  return new Promise((resolve) => {
    const w = getWorker(); if (!w) { resolve({ error: 'worker-unavailable' }); return }
    const id = ++_workerReqId
    _workerPending.set(id, { resolve })
    try { w.postMessage({ id, query }) } catch (e) { _workerPending.delete(id); resolve({ error: String(e) }) }
  })
}
// Probe the Rust binary once: spawn it and see whether it actually runs (SAC will make this fail).
let _rustOk = false, _rustProbed = false
function probeRust(cb) {
  if (_rustProbed) return cb(_rustOk)
  if (!fs.existsSync(CTA_SCAN_BIN)) { _rustProbed = true; _rustOk = false; return cb(false) }
  let done = false
  const finish = (ok) => { if (done) return; done = true; _rustProbed = true; _rustOk = ok; cb(ok) }
  try {
    const c = spawn(CTA_SCAN_BIN, [], { windowsHide: true })
    let out = ''
    c.on('error', () => finish(false))
    if (c.stdout) c.stdout.on('data', (d) => (out += d))
    c.on('close', () => { try { JSON.parse(out); finish(true) } catch (e) { finish(false) } })
    try { c.stdin.write('{"type":"fields"}'); c.stdin.end() } catch (e) { finish(false) }
    setTimeout(() => finish(false), 4000)
  } catch (e) { finish(false) }
}
const _scanChildren = new Map()   // key -> child (for killing superseded Rust queries)
function rustScan(query, key) {
  return new Promise((resolve) => {
    const prev = _scanChildren.get(key); if (prev) { try { prev._cancel = true; prev.kill() } catch (e) {} }
    let c
    try { c = spawn(CTA_SCAN_BIN, [], { windowsHide: true }) } catch (e) { resolve({ error: String(e) }); return }
    _scanChildren.set(key, c)
    const out = [], err = []
    c.on('error', (e) => { if (_scanChildren.get(key) === c) _scanChildren.delete(key); resolve({ error: String(e) }) })
    if (c.stdout) c.stdout.on('data', (d) => out.push(d))
    if (c.stderr) c.stderr.on('data', (d) => err.push(d))
    c.on('close', () => {
      if (_scanChildren.get(key) === c) _scanChildren.delete(key)
      if (c._cancel) { resolve({ cancelled: true }); return }
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))) }
      catch (e) { resolve({ error: 'parse-failed', stderr: Buffer.concat(err).toString('utf8').slice(0, 300) }) }
    })
    try { c.stdin.write(JSON.stringify(query)); c.stdin.end() } catch (e) {}
  })
}
ipcMain.handle('scan', async (_e, query) => {
  if (!query || typeof query !== 'object') return { error: 'bad-query' }
  const key = query.key || 'default'
  // lagmatrix / megamatrix are Node-worker-only engines (the Rust cta_scan binary doesn't implement them) — force the worker.
  if (query.type === 'lagmatrix' || query.type === 'megamatrix' || query.type === 'megafields') return await workerScan(query).then((r) => { r && (r.engine = 'node'); return r })
  return await new Promise((resolve) => {
    probeRust((ok) => {
      if (ok) rustScan(query, key).then((r) => { r && (r.engine = 'rust'); resolve(r) })
      else workerScan(query).then((r) => { r && (r.engine = 'node'); resolve(r) })
    })
  })
})
ipcMain.handle('scan-engine', async () => new Promise((resolve) => probeRust((ok) => resolve({ engine: ok ? 'rust' : 'node', bin: CTA_SCAN_BIN, ticklog: CTA_TICKLOG }))))

// ===== R stats sidecar (the "analyze in R" buttons) =====
// Rscript.exe is a SIGNED binary (R installer), so — unlike the UNSIGNED cta_scan.exe that Smart App
// Control blocks — SAC does NOT block spawning it. Verified end-to-end from Node: cor.test / lm+loess /
// acf / kmeans / summary all run and return JSON (~3.6s cold). jsonlite is absent on this R, so the
// bundled cta_stats.R emits JSON by hand with base R only.
// asar note: the .R file is packed inside the asar. Electron's fs CAN read inside an asar, but Rscript
// (a native spawn) CANNOT — so we read the script out of the asar and write a plain temp copy under
// app.getPath('userData')/cta_rscripts, then point Rscript at that real-fs copy. Data slices go to a
// temp CSV under os.tmpdir()/cta_r (deleted after each run).
const CTA_RSCRIPT = process.env.CTA_RSCRIPT || 'C:\\Program Files\\R\\R-4.6.1\\bin\\Rscript.exe'
let _rScriptPath = null
function ensureRScript() {
  if (_rScriptPath && fs.existsSync(_rScriptPath)) return _rScriptPath
  let src = null
  for (const c of [path.join(__dirname, 'cta_stats.R'), path.join(ROOT, 'dashboard', 'cta_stats.R')]) {
    try { if (fs.existsSync(c)) { src = fs.readFileSync(c, 'utf8'); break } } catch (e) {}
  }
  if (src == null) return null
  try {
    const dir = path.join(app.getPath('userData'), 'cta_rscripts')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'cta_stats.R')
    fs.writeFileSync(p, src)
    _rScriptPath = p
    return p
  } catch (e) { return null }
}
let _rProbe = null
function probeR() {
  if (_rProbe) return _rProbe
  _rProbe = new Promise((resolve) => {
    if (!fs.existsSync(CTA_RSCRIPT)) return resolve({ available: false, reason: 'Rscript not found at ' + CTA_RSCRIPT })
    let done = false
    const fin = (o) => { if (!done) { done = true; resolve(o) } }
    try {
      const c = spawn(CTA_RSCRIPT, ['-e', 'cat("rok")'], { windowsHide: true })
      let out = ''
      c.on('error', (e) => fin({ available: false, reason: String(e) }))
      if (c.stdout) c.stdout.on('data', (d) => (out += d))
      c.on('close', () => fin(/rok/.test(out) ? { available: true, reason: '' } : { available: false, reason: 'probe returned: ' + out.slice(0, 120) }))
      setTimeout(() => fin({ available: false, reason: 'probe timeout' }), 15000)
    } catch (e) { fin({ available: false, reason: String(e) }) }
  })
  return _rProbe
}
ipcMain.handle('r-available', async () => { const r = await probeR(); return Object.assign({}, r, { bin: CTA_RSCRIPT }) })
const _rTmpDir = path.join(os.tmpdir(), 'cta_r')
ipcMain.handle('r-analyze', async (_e, req) => {
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad-request' }
  const probe = await probeR()
  if (!probe.available) return { ok: false, error: 'Rscript unavailable: ' + probe.reason }
  const scriptPath = ensureRScript()
  if (!scriptPath) return { ok: false, error: 'cta_stats.R not found / not writable' }
  const analysis = String(req.analysis || 'summary')
  const cols = Array.isArray(req.columns) ? req.columns : []
  const rows = Array.isArray(req.rows) ? req.rows : []
  if (!cols.length || !rows.length) return { ok: false, error: 'no data' }
  const MAXR = 50000
  const useRows = rows.length > MAXR ? rows.slice(0, MAXR) : rows
  const esc = (v) => { const s = (v == null ? '' : String(v)); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  let csv = cols.map(esc).join(',') + '\n'
  let buf = []
  for (const r of useRows) { buf.push(r.map(esc).join(',')); if (buf.length >= 2000) { csv += buf.join('\n') + '\n'; buf = [] } }
  if (buf.length) csv += buf.join('\n') + '\n'
  let csvPath
  try {
    fs.mkdirSync(_rTmpDir, { recursive: true })
    csvPath = path.join(_rTmpDir, 'r_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.csv')
    fs.writeFileSync(csvPath, csv)
  } catch (e) { return { ok: false, error: 'csv write: ' + String(e) } }
  const p1 = (req.params && req.params.p1 != null) ? String(req.params.p1) : ''
  return await new Promise((resolve) => {
    const out = [], err = []
    let done = false
    const fin = (o) => { if (done) return; done = true; try { fs.unlinkSync(csvPath) } catch (e) {}; resolve(o) }
    let c
    try { c = spawn(CTA_RSCRIPT, [scriptPath, csvPath, analysis, p1], { windowsHide: true }) }
    catch (e) { return fin({ ok: false, error: String(e) }) }
    c.on('error', (e) => fin({ ok: false, error: String(e) }))
    if (c.stdout) c.stdout.on('data', (d) => out.push(d))
    if (c.stderr) c.stderr.on('data', (d) => err.push(d))
    c.on('close', () => {
      const so = Buffer.concat(out).toString('utf8').trim()
      const se = Buffer.concat(err).toString('utf8').trim()
      try { fin({ ok: true, result: JSON.parse(so), stderr: se.slice(0, 300) }) }
      catch (e) { fin({ ok: false, error: 'R output parse failed', stdout: so.slice(0, 300), stderr: se.slice(0, 300) }) }
    })
    setTimeout(() => { try { c.kill() } catch (e) {} ; fin({ ok: false, error: 'R timeout (30s)' }) }, 30000)
  })
})

let win
function create() {
  win = new BrowserWindow({
    width: 1360, height: 900, backgroundColor: '#000000', title: 'CTA · EVOLUTION',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false, contextIsolation: true }
  })
  win.removeMenu()
  win.loadFile(path.join(__dirname, 'index.html'))
  // full screen: F11 toggles, Esc exits
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen())
    else if (input.key === 'Escape' && win.isFullScreen()) win.setFullScreen(false)
  })
  ipcMain.on('toggle-fullscreen', () => { if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen()) })
  // PERF(FREEZE): mtime-gate the push. cta_evolve_state.json is read fresh + JSON.parse'd every push and
  // embeds the unbounded trace/trades_log arrays, so per-push parse cost grows across a 15-min window. When
  // the live-state file's mtime+size are unchanged since the last push, the parsed payload is byte-identical
  // and the renderer would re-render for nothing — so skip readState()+send entirely. The renderer's own
  // signature short-circuit is the second line of defense; this avoids even the parse on the main thread.
  // (force=true on did-finish-load guarantees the first paint regardless of the cache state.)
  const STATE_FILE = path.join(ROOT, 'cta_evolve_state.json')
  let _lastPush = { mtimeMs: -1, size: -1 }
  const push = (force) => {
    if (!win || win.isDestroyed()) return
    if (!force) {
      try { const st = fs.statSync(STATE_FILE); if (st.mtimeMs === _lastPush.mtimeMs && st.size === _lastPush.size) return; _lastPush = { mtimeMs: st.mtimeMs, size: st.size } } catch (e) {}
    } else { try { const st = fs.statSync(STATE_FILE); _lastPush = { mtimeMs: st.mtimeMs, size: st.size } } catch (e) {} }
    win.webContents.send('state', readState())
  }
  win.webContents.on('did-finish-load', () => push(true))
  // DATA STREAMS: build + push the current-window overlay payload ~1x/sec (mtime-cached read + one window pass).
  const pushStreams = () => { if (!win || win.isDestroyed()) return; try { win.webContents.send('streams', buildStreams()) } catch (e) {} }
  win.webContents.on('did-finish-load', pushStreams)
  setInterval(pushStreams, 1000)
  // FREEZE FIX: 120ms (~8.3x/sec) was far faster than anything updates — the remote feed advances every
  // ~0.25s (sleep 0.25) and the renderer coalesces to ~4x/sec. 300ms (~3.3x/sec) keeps the UI live while
  // cutting main-process readState() work by ~60%. Cached reads make most of these ticks nearly free.
  setInterval(push, 300)
  // HISTORY (rolling): rebuild the recent completed windows from the synced ticklog tail and push on the
  // 'history' channel. Falls back to the legacy static history.json only until the ticklog tail populates.
  const pushHist = () => {
    if (!win || win.isDestroyed()) return
    try {
      const h = buildHistoryFromTicklog()
      if (h) { _builtHistory = h; win.webContents.send('history', h); return }
      const f = fs.readFileSync(path.join(ROOT, 'history.json'), 'utf8'); if (f) win.webContents.send('history', f)
    } catch (e) {}
  }
  win.webContents.on('did-finish-load', pushHist)
  setInterval(pushHist, 20000)   // windows complete every 15min; 20s keeps the scrubber list fresh as ticks accrue
}
// Distinct Windows taskbar identity (separate entry/icon from the poly_copy dashboard, which
// otherwise both group under a generic "electron"). Must be set before any window is created.
app.setAppUserModelId('com.noah.cta-dashboard')
app.whenReady().then(() => { create(); startSync() })
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => { try { if (syncProc) syncProc.kill() } catch (e) {} })
