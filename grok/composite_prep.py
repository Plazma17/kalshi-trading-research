#!/usr/bin/env python3
"""composite_prep.py -- Noah's COMPOSITE-STREAM FACTORY (2026-07-03).

Adds ~50 DERIVED, EVENT-ANCHORED / TRAILING-ONLY channels to grok_data.npz for the
grok farm, seeded by Noah's directive: "make a ton of different data streams like my
integral of distance-to-strike minus price-distance-to-0.5 since the last time they
intercepted -- create stuff like that and like 50 more, and diet some nets on that."

Channel #1 IS Noah's original np_divint stream (C-014): the integral of
(symlog_dist_pct - mid_pct) since the two curves last crossed, reset every window.
See np_divint.py / np_divint_report.md for its tick-level characterization.

DISCIPLINE -- every channel here is CAUSAL / TRAILING-ONLY:
  * only past+current bins within the SAME window are ever read (no future info),
  * per-window reset where noted (state cleared at each window's bin 0 -> no cross-
    window bleed),
  * the per-window kernel `compute_window()` is a pure function of a prefix, so a
    TRAILING-ONLY (leak) audit = recompute on truncated data and assert the result is
    byte-identical to the full computation's prefix (done below).

SCALE CAVEAT (documented, honest): grok_data.npz stores only Z-SCORED price channels
(dollar BTC price is irrecoverable -- see research_prep.py). Noah's divint uses a
dollar symlog `sy_pct(d)=50+50*sign(d)*min(1,log10(1+|d|)/log10(201))`. We reconstruct
the SAME structure in z-space: `sy_z = 50 + 50*tanh(SYK*sdist_z)` (sdist = the z-scored
SIGNED distance-to-strike channel, corr +0.69 with mid-0.5). Monotone squash of signed
distance -> 0..100, differing from the dollar version only by the squash's horizontal
scale (which the grok trainer's per-channel z-score absorbs anyway). The reset geometry
(gap sign-crossover, window reset) and the integral are preserved exactly. mid_pct uses
the TRUE 0-1 mid (D['mid']).

Append-only along the channel axis: existing channel indices are UNCHANGED, existing
specs unaffected. The live runner holds grok_data.npz open, so we NEVER swap it here --
we write the augmented dataset to grok_data.pending2.npz and print the swap procedure
(apply at the runner's next natural stop). Idempotent-ish: refuses to double-add if the
channels are already present in the target npz.
"""
import numpy as np, os, tempfile, sys

GD  = r'C:\Users\Noah\claude-workspace\grok'
NPZ = os.path.join(GD, 'grok_data.npz')
PEND = os.path.join(GD, 'grok_data.pending2.npz')

# ---- constants (all in NATIVE units of the z-scored/true channels; documented) ----
SYK        = 0.6    # tanh scale for the sy_z symlog-analog (saturates for |sdist_z|>~3)
BURST_THR  = 0.5    # vol-burst := |d cfmean_z| per 10s bin > this (z units ~ 0.5 sd jump)
SPIKE_THR  = 2.0    # spread-spike := spread_z LEVEL crossing above this (spread_z med ~0.56)
EWMA_FAST  = 0.5
EWMA_SLOW  = 0.9
HAWKES_A   = 0.7    # flow-intensity EWMA decay
DECAY_TAU  = 60.0   # post-burst decay clock time-constant (s)
EPS        = 1e-6

# The 50 composite channels, in registry order (family A..E). Order here == the order
# they are appended, and MUST match the keys returned by compute_window().
CHANNELS = [
    # --- A. SINCE-EVENT INTEGRALS (13) ---
    'cs_divint', 'cs_divint_abs', 'cs_avggap', 'cs_idist_touch', 'cs_flow_touch',
    'cs_im50_cross', 'cs_itfi_flip', 'cs_iobi_flip', 'cs_iconcord_disc',
    'cs_iabsdmid_burst', 'cs_ispread_spike', 'cs_flow_open', 'cs_advexc_drift',
    # --- B. EVENT CLOCKS + COUNTS (10) ---
    'cs_tsc_gap', 'cs_ts50', 'cs_ts_touch', 'cs_ts_burst', 'cs_ts_spike',
    'cs_ts_tfiflip', 'cs_cnt_cross50', 'cs_cnt_touch', 'cs_cnt_burst', 'cs_driftlen',
    # --- C. DIVERGENCE / GEOMETRY COMPOSITES (11) ---
    'cs_gap_lvl', 'cs_sy_lvl', 'cs_mid_phi_wedge', 'cs_hilo_pos', 'cs_dd_extreme',
    'cs_range_open', 'cs_coil60', 'cs_coil120', 'cs_dist_secleft',
    'cs_absm50_sqrtsec', 'cs_gap_secleft',
    # --- D. FLOW COMPOSITES (9) ---
    'cs_concord_tfi', 'cs_flow_intensity', 'cs_tfi_obi', 'cs_flow_price_div',
    'cs_ewma_tfi_fast', 'cs_ewma_tfi_slow', 'cs_tfi_accel', 'cs_signed_tvol',
    'cs_concord_runlen',
    # --- E. VOL STRUCTURE (7) ---
    'cs_rvratio_30_300', 'cs_rv30', 'cs_rr_pos', 'cs_volofvol', 'cs_postburst_decay',
    'cs_rv300', 'cs_cfrv30',
]
assert len(CHANNELS) == 50, len(CHANNELS)


def _sgnz(x):
    """sign with 0 -> +1 (matches np_divint's sg[sg==0]=1)."""
    s = np.sign(x); s[s == 0] = 1.0; return s


def compute_window(mid, sdist, tfi, cf, spr, obi, tvol, sig, sec, bin_s):
    """Pure per-window kernel. All outputs at bin i depend ONLY on inputs[:i+1]
    (trailing-only) -> prefix(compute_window(full))[:T] == compute_window(full[:T]).
    `mid` is the TRUE 0-1 mid; the rest are the z-scored raw channels; `sec` is secleft.
    Returns {name: 1-D float array length n} for every name in CHANNELS."""
    n = len(mid)
    el = np.arange(n, dtype=np.float64) * bin_s          # elapsed seconds 0,10,20,...
    dt = np.full(n, bin_s, np.float64); dt[0] = 0.0      # np_divint: dt prepend-diff => 0 at i=0
    mp = mid.astype(np.float64) * 100.0                  # mid in cents (true)
    m50 = mid.astype(np.float64) - 0.5
    secfrac = np.clip(sec.astype(np.float64) / 900.0, 0.0, 1.0)

    # ---------- geometry base ----------
    sy_z = 50.0 + 50.0 * np.tanh(SYK * sdist.astype(np.float64))   # symlog-analog 0..100
    gap = sy_z - mp                                                # Noah's (sy_pct - mid_pct)

    # ---------- event masks (rising-edge booleans, causal) ----------
    def sign_change(sgn):
        ev = np.zeros(n, bool)
        ev[1:] = sgn[1:] != sgn[:-1]
        return ev
    ev_gap   = sign_change(_sgnz(gap))
    ev_50    = sign_change(_sgnz(m50))
    ev_touch = sign_change(_sgnz(sdist.astype(np.float64)))        # cfmean crosses strike
    ev_tfi   = sign_change(_sgnz(tfi.astype(np.float64)))
    ev_obi   = sign_change(_sgnz(obi.astype(np.float64)))

    dmid = np.zeros(n); dmid[1:] = mp[1:] - mp[:-1]                # cents move / bin
    dcf  = np.zeros(n); dcf[1:] = np.abs(cf[1:] - cf[:-1])
    ev_burst = dcf > BURST_THR
    sp = spr.astype(np.float64)
    ev_spike = np.zeros(n, bool)
    ev_spike[1:] = (sp[1:] > SPIKE_THR) & (sp[:-1] <= SPIKE_THR)   # rising-edge crossing

    # drift-run sign (0-move carries previous sign so flats don't reset the run)
    drift = np.zeros(n)
    cur = 1.0
    for i in range(n):
        s = np.sign(dmid[i])
        if s != 0: cur = s
        drift[i] = cur
    ev_drift = sign_change(drift)

    # concordance: flow toward the leading side (>0 confirms, <0 fights the mid)
    concord = tfi.astype(np.float64) * _sgnz(m50)
    ev_conc = sign_change(_sgnz(concord))

    # ---------- generic since-event primitives (all causal) ----------
    def since_int(signal, reset_ev):
        out = np.zeros(n); acc = 0.0
        for i in range(n):
            if reset_ev[i]: acc = 0.0
            acc += signal[i] * dt[i]
            out[i] = acc
        return out

    def since_time(reset_ev):
        out = np.zeros(n); t0 = el[0]
        for i in range(n):
            if reset_ev[i] and i > 0: t0 = el[i]
            out[i] = el[i] - t0
        return out

    def since_count(ev):
        out = np.zeros(n); c = 0.0
        for i in range(n):
            if ev[i] and i > 0: c += 1.0
            out[i] = c
        return out

    # ---------- A. since-event integrals ----------
    A_div   = since_int(gap, ev_gap)                              # signed divint (Noah #1)
    tsc_gap = since_time(ev_gap)
    avggap  = A_div / np.maximum(tsc_gap, bin_s)
    idist_t = since_int(np.abs(sdist.astype(np.float64)), ev_touch)
    flow_t  = since_int(tfi.astype(np.float64), ev_touch)
    im50    = since_int(m50, ev_50)
    itfi    = since_int(tfi.astype(np.float64), ev_tfi)
    iobi    = since_int(obi.astype(np.float64), ev_obi)
    iconc   = since_int(concord, ev_conc)
    iabsdm  = since_int(np.abs(dmid), ev_burst)
    ispr    = since_int(sp, ev_spike)
    flowopen = np.cumsum(tfi.astype(np.float64) * dt)             # since window open (no reset)

    # adverse-excursion integral since current drift-run start. NB: the drift-run here is
    # the SMOOTHED directional regime (sign of an EWMA of dmid), NOT the per-bin same-sign
    # run used for cs_driftlen -- a per-bin same-sign run is monotone by construction so it
    # can NEVER show an adverse excursion (that made this channel trivially 0). Under a
    # smoothed regime, intra-run pullbacks against the trend ARE adverse -> real signal.
    drift_s = _sgnz(_ewma(dmid, 0.8))
    ev_drift_s = sign_change(drift_s)
    advexc = np.zeros(n); acc = 0.0; run_start_mp = mp[0]
    for i in range(n):
        if ev_drift_s[i]:
            acc = 0.0; run_start_mp = mp[i]
        rel = (mp[i] - run_start_mp) * drift_s[i]                 # + favorable / - adverse
        acc += min(0.0, rel) * dt[i]                              # integrate ONLY adverse part
        advexc[i] = acc

    # ---------- B. clocks + counts ----------
    ts50   = since_time(ev_50)
    ts_tch = since_time(ev_touch)
    ts_brs = since_time(ev_burst)
    ts_spk = since_time(ev_spike)
    ts_tfi = since_time(ev_tfi)
    c_x50  = since_count(ev_50)
    c_tch  = since_count(ev_touch)
    c_brs  = since_count(ev_burst)
    driftlen = since_time(ev_drift)

    # ---------- C. divergence / geometry composites ----------
    # model-vs-market wedge: implied prob from signed-dist/trailing-vol (logistic approx
    # to the normal CDF, documented) minus the market mid.
    rv_cf30 = _trailing_std(cf.astype(np.float64), 3)
    z_imp = sdist.astype(np.float64) / (rv_cf30 + EPS)
    phi = 0.5 * (1.0 + np.tanh(0.8 * z_imp))                      # ~normal-CDF logistic approx
    wedge = mid.astype(np.float64) - phi
    runmax = np.maximum.accumulate(mp); runmin = np.minimum.accumulate(mp)  # expanding since open
    hilo_pos = (mp - runmin) / (runmax - runmin + EPS)
    dd_extreme = mp - runmax                                      # <=0 drawdown from window peak
    range_open = runmax - runmin
    coil60  = _coil(mp, 6)
    coil120 = _coil(mp, 12)
    dist_sec = np.abs(sdist.astype(np.float64)) * secfrac
    absm50_sqrtsec = np.abs(m50) * 100.0 * np.sqrt(secfrac)
    gap_sec = gap * secfrac

    # ---------- D. flow composites ----------
    concord_tfi = concord
    tfi_obi = tfi.astype(np.float64) * obi.astype(np.float64)
    # Hawkes-lite same-sign flow intensity
    fint = np.zeros(n); prev = 0.0; e = 0.0
    tf = tfi.astype(np.float64)
    for i in range(n):
        same = (np.sign(tf[i]) == np.sign(prev)) and tf[i] != 0
        e = HAWKES_A * e + (abs(tf[i]) if same else 0.0)
        fint[i] = e; prev = tf[i] if tf[i] != 0 else prev
    cumflow = np.cumsum(tf)
    mism = (_sgnz(cumflow) != _sgnz(dmid)).astype(np.float64)
    flow_price_div = np.cumsum(mism * dt)                        # accumulated flow/price mismatch
    ewma_f = _ewma(tf, EWMA_FAST)
    ewma_s = _ewma(tf, EWMA_SLOW)
    tfi_accel = tf - ewma_s
    signed_tvol = tvol.astype(np.float64) * _sgnz(tf)
    concord_runlen = since_time(ev_conc)

    # ---------- E. vol structure ----------
    rv30  = _trailing_std(mp, 3)
    rv300 = _trailing_std(mp, 30)
    rvratio = rv30 / (rv300 + EPS)
    volofvol = _trailing_std(np.abs(dmid), 12)
    rr6 = _trailing_range(mp, 6)
    rr_pos = rr6 / (_trailing_max(rr6, 30) + EPS)
    postburst = np.exp(-ts_brs / DECAY_TAU)
    cfrv30 = _trailing_std(cf.astype(np.float64), 3)

    out = {
        'cs_divint': A_div, 'cs_divint_abs': np.abs(A_div), 'cs_avggap': avggap,
        'cs_idist_touch': idist_t, 'cs_flow_touch': flow_t, 'cs_im50_cross': im50,
        'cs_itfi_flip': itfi, 'cs_iobi_flip': iobi, 'cs_iconcord_disc': iconc,
        'cs_iabsdmid_burst': iabsdm, 'cs_ispread_spike': ispr, 'cs_flow_open': flowopen,
        'cs_advexc_drift': advexc,
        'cs_tsc_gap': tsc_gap, 'cs_ts50': ts50, 'cs_ts_touch': ts_tch, 'cs_ts_burst': ts_brs,
        'cs_ts_spike': ts_spk, 'cs_ts_tfiflip': ts_tfi, 'cs_cnt_cross50': c_x50,
        'cs_cnt_touch': c_tch, 'cs_cnt_burst': c_brs, 'cs_driftlen': driftlen,
        'cs_gap_lvl': gap, 'cs_sy_lvl': sy_z, 'cs_mid_phi_wedge': wedge, 'cs_hilo_pos': hilo_pos,
        'cs_dd_extreme': dd_extreme, 'cs_range_open': range_open, 'cs_coil60': coil60,
        'cs_coil120': coil120, 'cs_dist_secleft': dist_sec, 'cs_absm50_sqrtsec': absm50_sqrtsec,
        'cs_gap_secleft': gap_sec,
        'cs_concord_tfi': concord_tfi, 'cs_flow_intensity': fint, 'cs_tfi_obi': tfi_obi,
        'cs_flow_price_div': flow_price_div, 'cs_ewma_tfi_fast': ewma_f,
        'cs_ewma_tfi_slow': ewma_s, 'cs_tfi_accel': tfi_accel, 'cs_signed_tvol': signed_tvol,
        'cs_concord_runlen': concord_runlen,
        'cs_rvratio_30_300': rvratio, 'cs_rv30': rv30, 'cs_rr_pos': rr_pos,
        'cs_volofvol': volofvol, 'cs_postburst_decay': postburst, 'cs_rv300': rv300,
        'cs_cfrv30': cfrv30,
    }
    return out


# ---------- trailing (causal) rolling helpers ----------
def _trailing_std(x, k):
    n = len(x); out = np.zeros(n)
    for i in range(n):
        lo = max(0, i - k + 1)
        seg = x[lo:i + 1]
        out[i] = seg.std() if len(seg) >= 2 else 0.0
    return out

def _trailing_range(x, k):
    n = len(x); out = np.zeros(n)
    for i in range(n):
        lo = max(0, i - k + 1); seg = x[lo:i + 1]
        out[i] = seg.max() - seg.min()
    return out

def _trailing_max(x, k):
    n = len(x); out = np.zeros(n)
    for i in range(n):
        lo = max(0, i - k + 1); out[i] = x[lo:i + 1].max()
    return out

def _coil(x, k):
    """range/|net| over the trailing k bins (path coil; direction-free)."""
    n = len(x); out = np.zeros(n)
    for i in range(n):
        lo = max(0, i - k + 1); seg = x[lo:i + 1]
        net = abs(seg[-1] - seg[0]); rng = seg.max() - seg.min()
        out[i] = rng / (net + 1e-4)
    return out

def _ewma(x, alpha):
    n = len(x); out = np.zeros(n); e = 0.0
    for i in range(n):
        e = alpha * e + (1 - alpha) * x[i]
        out[i] = e
    return out


def main():
    D = np.load(NPZ, allow_pickle=True)
    names = [str(x) for x in D['names']]; base = [str(x) for x in D['base']]
    tf = [str(x) for x in D['tfFam']]; causal = np.asarray(D['causal'])
    Z = D['Zimp'].astype(np.float32); C, nWin, BPW = Z.shape
    MID = D['mid'].astype(np.float64); SEC = D['secleft'].astype(np.float64)
    ri = {base[i]: i for i in range(len(names)) if tf[i] == 'raw'}
    bin_s = float(np.round(np.abs(np.nanmedian(np.diff(SEC, axis=1)))))
    if not (bin_s > 0): bin_s = 10.0

    if all(n in names for n in CHANNELS):
        print('composite_prep: all 50 channels already present -> no-op'); return

    need = ['sdist', 'tfi', 'cfmean', 'spread', 'btcobi', 'tvol', 'sig']
    for k in need:
        if k not in ri: raise SystemExit(f'missing required raw channel {k}')
    SD = Z[ri['sdist']]; TFI = Z[ri['tfi']]; CF = Z[ri['cfmean']]
    SPR = Z[ri['spread']]; OBI = Z[ri['btcobi']]; TVOL = Z[ri['tvol']]; SIG = Z[ri['sig']]

    OUT = {c: np.zeros((nWin, BPW), np.float32) for c in CHANNELS}
    print(f'computing {len(CHANNELS)} composite channels over {nWin} windows x {BPW} bins '
          f'(bin_s={bin_s}) ...')
    for w in range(nWin):
        res = compute_window(MID[w], SD[w], TFI[w], CF[w], SPR[w], OBI[w], TVOL[w], SIG[w],
                             SEC[w], bin_s)
        for c in CHANNELS:
            OUT[c][w] = res[c].astype(np.float32)
    print('  done computing.')

    # ================= ASSERTS =================
    # (1) finiteness
    for c in CHANNELS:
        assert np.isfinite(OUT[c]).all(), f'{c} has non-finite values'
    # (2) channel #1 sanity: signed divint, its |.| companion, and its reset structure
    assert np.allclose(OUT['cs_divint_abs'], np.abs(OUT['cs_divint'])), 'divint_abs != |divint|'
    # tsc_gap must be non-negative and monotone within a run (a clock)
    assert (OUT['cs_tsc_gap'] >= 0).all() and (OUT['cs_ts50'] >= 0).all()
    # counts are integer-valued and non-decreasing across bins (expanding within window)
    for c in ('cs_cnt_cross50', 'cs_cnt_touch', 'cs_cnt_burst'):
        arr = OUT[c]
        assert np.all(np.diff(arr, axis=1) >= -1e-6), f'{c} not non-decreasing'
        assert np.allclose(arr, np.round(arr)), f'{c} not integer-valued'
    # drawdown <= 0, hilo_pos in [0,1]
    assert (OUT['cs_dd_extreme'] <= 1e-4).all(), 'dd_extreme has positive values'
    assert (OUT['cs_hilo_pos'] >= -1e-4).all() and (OUT['cs_hilo_pos'] <= 1 + 1e-4).all()

    # (3) TRAILING-ONLY (LEAK) AUDIT -- the load-bearing test.
    # Recompute each channel on TRUNCATED windows [:T] and require byte-identical prefix
    # equality with the full computation's [:T] slice. A future-peeking channel would
    # differ (its value at bin T-1 would move when bins >=T are removed).
    rng = np.random.default_rng(0)
    audit_w = rng.choice(nWin, size=6, replace=False)
    audit_T = [20, 45, 70, 89]
    leak_fail = []
    for w in audit_w:
        full = compute_window(MID[w], SD[w], TFI[w], CF[w], SPR[w], OBI[w], TVOL[w], SIG[w],
                              SEC[w], bin_s)
        for T in audit_T:
            trunc = compute_window(MID[w][:T], SD[w][:T], TFI[w][:T], CF[w][:T], SPR[w][:T],
                                   OBI[w][:T], TVOL[w][:T], SIG[w][:T], SEC[w][:T], bin_s)
            for c in CHANNELS:
                a = full[c][:T]; b = trunc[c]
                if not np.allclose(a, b, atol=1e-6, rtol=1e-5, equal_nan=True):
                    leak_fail.append((c, int(w), T, float(np.max(np.abs(a - b)))))
    if leak_fail:
        print('LEAK-TEST FAILURES (channel, win, T, maxdiff):')
        for f in leak_fail[:40]: print('   ', f)
        raise SystemExit(f'composite_prep: {len(leak_fail)} trailing-only violations -> ABORT')
    n_checks = len(audit_w) * len(audit_T) * len(CHANNELS)
    print(f'  LEAK AUDIT PASSED: {n_checks} prefix-identity checks '
          f'({len(audit_w)} windows x {len(audit_T)} truncations x {len(CHANNELS)} channels), '
          f'0 violations.')

    # ================= APPEND + SAVE =================
    rows = [OUT[c][None] for c in CHANNELS]
    Znew = np.concatenate([Z] + rows, axis=0)
    names2 = names + CHANNELS; base2 = base + CHANNELS
    tf2 = tf + ['raw'] * len(CHANNELS)
    causal2 = np.concatenate([causal, np.ones(len(CHANNELS), bool)])
    assert Znew.shape == (C + 50, nWin, BPW), Znew.shape
    assert np.array_equal(Znew[:C], Z), 'existing channels changed!'   # append-only guarantee

    out = {k: np.array(D[k]) for k in D.files}
    out['Zimp'] = Znew; out['names'] = np.array(names2); out['base'] = np.array(base2)
    out['tfFam'] = np.array(tf2); out['causal'] = causal2
    D.close()

    if os.path.exists(PEND): os.remove(PEND)
    fd, tmp = tempfile.mkstemp(dir=GD, suffix='.npz'); os.close(fd)
    np.savez_compressed(tmp, **out)
    saved = tmp if (os.path.exists(tmp) and os.path.getsize(tmp) > 0) else tmp + '.npz'
    if not os.path.exists(saved): saved = tmp + '.npz'
    os.replace(saved, PEND)
    for stray in (tmp, tmp + '.npz'):
        if os.path.exists(stray) and stray != PEND:
            try: os.remove(stray)
            except OSError: pass
    raw_after = len([1 for i in range(len(names2)) if tf2[i] == 'raw'])
    raw_before = len([1 for i in range(len(names)) if tf[i] == 'raw'])
    print(f'composite_prep: WROTE {PEND}')
    print(f'  Zimp {Z.shape} -> {Znew.shape}  (raw channels {raw_before} -> {raw_after})')
    print(f'  added 50 channels: {CHANNELS[0]} ... {CHANNELS[-1]}')
    print('  grok_data.npz is UNTOUCHED (live runner holds it). Swap at next natural stop:')
    print('    1) touch grok_queue.STOP  (runner checkpoints + exits at next boundary)')
    print('    2) wait for the grok_queue python proc to be GONE')
    print('    3) move grok_data.pending2.npz -> grok_data.npz')
    print('    4) del grok_queue.STOP ; relaunch runner (canonical launch in farm_readme.md)')


if __name__ == '__main__':
    try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass
    main()
