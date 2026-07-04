#!/usr/bin/env python3
"""seed_osc_lockout_farm.py -- the OSCILLATORY-vs-LOCKOUT grok-farm push (Noah 2026-07-03).

Appends the comprehensive nolock/oscillatory/bothfill35/rangeR sweep to
experiments_queue.jsonl (APPEND-ONLY under the shared _qlock sentinel, idempotent: skips
ids already present). COORDINATES with agent a6ba9a84 which added the guard TARGET kinds
(nolock/rangeR/bothfill35/seqcomplete) + seeded the OSC_* diet specs; this file only APPENDS
new lines, never rewrites existing ones (the runner owns their status). The DECISION-TIME axis
uses this session's added `slNNN` sample_set (one causal decision per window at secleft=NNN,
clamped >=L-1 so L=30 context is real) -- reproduces np_rangeguard's per-window methodology so
the |mid-.5| baseline is apples-to-apples with the ~0.755 bar.

THE BAR: lockout is predicted by |mid-.5| ALONE (holdout AUC ~0.74 at secleft=600 here / 0.755
in np_rangeguard). Question: can NONLINEARITY + MORE FEATURES + MORE DATA beat it? Each spec's
note carries the (target,T) BASE_mid AUC + majority baseline scorecard.
"""
import os, json, time, numpy as np

GD = r'C:\Users\Noah\claude-workspace\grok'
QF = os.path.join(GD, 'experiments_queue.jsonl')
QLOCK = os.path.join(GD, 'experiments_queue.lock')
L = 30

# ---------------- baseline scorecard (|mid-.5| AUC + majority) per (target, sl) ----------------
D = np.load(os.path.join(GD, 'grok_data.npz'), allow_pickle=True)
SEC = D['secleft'].astype(np.float64); MID = D['mid'].astype(np.float64)
WD = D['winDay']; NWIN, BPW = MID.shape
DAYS = sorted(set(WD.tolist())); TRAIN = set(DAYS[:6])
IS_TR = np.array([WD[w] in TRAIN for w in range(NWIN)])
Kb = max(1, int(round(300.0/10.0)))
smax = np.maximum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]
smin = np.minimum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]

def _auc(score, lab):
    lab = lab.astype(bool); p = score[lab]; n = score[~lab]
    if len(p) == 0 or len(n) == 0: return float('nan')
    o = np.argsort(np.concatenate([p, n]), kind='mergesort'); r = np.empty(len(o)); r[o] = np.arange(1, len(o)+1)
    return float((r[:len(p)].sum()-len(p)*(len(p)+1)/2)/(len(p)*len(n)))

def _decbins(SL):
    return np.clip(np.abs(SEC - SL).argmin(axis=1), L-1, BPW-1)

def _labels(SL, kind):
    td = _decbins(SL); y = np.zeros(NWIN)
    for w in range(NWIN):
        t0 = td[w]; seg = MID[w, t0:]
        if kind == 'nolock':
            yy = 1
            for j in range(t0+1, min(t0+Kb, BPW-1)+1):
                mj = MID[w, j]
                if mj <= 0.05:
                    if smax[w, j] <= 0.15: yy = 0
                    break
                if mj >= 0.95:
                    if smin[w, j] >= 0.85: yy = 0
                    break
            y[w] = yy
        elif kind == 'rangeR':
            y[w] = 1.0 if (seg.max()-seg.min()) >= 0.15 else 0.0
        elif kind == 'oscillatory':
            d = np.diff(seg); s = np.sign(d); s = s[s != 0]
            nch = int(np.sum(s[1:] != s[:-1])) if len(s) > 1 else 0
            y[w] = 1.0 if ((seg.max()-seg.min()) >= 0.15 and nch >= 2) else 0.0
        elif kind == 'bothfill35':
            sf = MID[w, min(t0+1, BPW-1):]; y[w] = 1.0 if (sf.min() <= 0.35 and sf.max() >= 0.65) else 0.0
    amid = np.abs(MID[np.arange(NWIN), td]-0.5)
    return y, amid

SCORE = {}
for kind in ['nolock', 'oscillatory', 'bothfill35', 'rangeR']:
    for SL in [600, 540, 480, 420, 360]:
        y, amid = _labels(SL, kind)
        ho = ~IS_TR
        # BASE_mid: |mid-.5| predicts the target. nolock: far-from-.5 -> lock (neg). range/osc/bf: far -> less range (neg). all direction: -amid.
        auc = _auc(-amid[ho], y[ho].astype(bool))
        maj = 1 if y[IS_TR].mean() >= 0.5 else 0
        maj_acc = float((y[ho] == maj).mean())
        SCORE[(kind, SL)] = (float(y[ho].mean()), auc, maj_acc)

def sc(kind, SL):
    br, auc, maj = SCORE.get((kind, SL), (float('nan'),)*3)
    return 'SCORECARD[%s@sl%d]: base_rate=%.3f BASE_mid(|mid-.5|)_AUC=%.3f majority_acc=%.3f' % (kind, SL, br, auc, maj)

# ---------------- channel diets ----------------
DERIV_SINGLES = ['mid', 'amid', 'dist', 'sdist', 'tvol', 'sig', 'btcspread', 'spread', 'tfi', 'btcobi', 'secleftc']
CS_SINGLES = [('coil', 'cs_coil60'), ('drawdown', 'cs_dd_extreme'), ('rv', 'cs_rv30'), ('divint', 'cs_divint')]
TOP5 = ['sdist', 'tvol', 'tfi', 'btcobi', 'sig']
PAIRS = [('sdist', 'tvol'), ('sdist', 'tfi'), ('tvol', 'tfi'), ('tvol', 'btcobi'), ('tfi', 'btcobi'), ('sig', 'sdist')]
AMID_EACH = ['dist', 'sdist', 'tvol', 'sig', 'tfi', 'btcobi', 'btcspread', 'spread']
PRUNED10 = ['mid', 'spread', 'dist', 'tfi', 'btcobi', 'tvol', 'btcspread', 'sig', 'eth', 'sol']
XASSET = ['eth', 'sol', 'btc', 'cfmean', 'dev', 'mid']
EVENTANCHOR = ['sdist', 'mid', 'mid_d1', 'mid_d2', 'tfi', 'tfi_cum', 'dist']
FAM_C = ['cs_gap_lvl', 'cs_sy_lvl', 'cs_mid_phi_wedge', 'cs_hilo_pos', 'cs_dd_extreme', 'cs_range_open',
         'cs_coil60', 'cs_coil120', 'cs_dist_secleft', 'cs_absm50_sqrtsec', 'cs_gap_secleft']
FAM_D = ['cs_concord_tfi', 'cs_flow_intensity', 'cs_tfi_obi', 'cs_flow_price_div', 'cs_ewma_tfi_fast',
         'cs_ewma_tfi_slow', 'cs_tfi_accel', 'cs_signed_tvol', 'cs_concord_runlen']
FAM_E = ['cs_rvratio_30_300', 'cs_rv30', 'cs_rr_pos', 'cs_volofvol', 'cs_postburst_decay', 'cs_rv300', 'cs_cfrv30']
RAW30 = ['bsprxobi', 'btc', 'btcobi', 'btcspread', 'calk', 'cfmean', 'dev', 'dist', 'eth', 'fair',
         'hod_cos', 'hod_sin', 'mid', 'mid_d1', 'mid_d2', 'na', 'nb', 'pf', 'sdist', 'sig', 'sol',
         'spread', 'sprxtfi', 'strike', 'tfi', 'tfi_cum', 'tvol', 'ya', 'yb', 'zstrike']
KITCHENSINK = RAW30 + FAM_C + FAM_D + FAM_E + \
    ['cs_divint', 'cs_divint_abs', 'cs_avggap', 'cs_idist_touch', 'cs_flow_touch', 'cs_im50_cross',
     'cs_itfi_flip', 'cs_iobi_flip', 'cs_iconcord_disc', 'cs_iabsdmid_burst', 'cs_ispread_spike',
     'cs_flow_open', 'cs_advexc_drift', 'cs_tsc_gap', 'cs_ts50', 'cs_ts_touch', 'cs_ts_burst',
     'cs_ts_spike', 'cs_ts_tfiflip', 'cs_cnt_cross50', 'cs_cnt_touch', 'cs_cnt_burst', 'cs_driftlen']
KITCHENSINK = list(dict.fromkeys(KITCHENSINK))  # dedup, preserve order (-> 80 unique)

MODEL = {"width": 128, "wd": 0.10, "epochs": 120000, "lr": 1e-3, "ls": 0.1, "warmup": 1000}
MODEL256 = dict(MODEL, width=256)
HZ = 10  # horizon_s: tiny so t_hi=88 -> all sl-decision bins available (nolock label is fwd-to-settle, HZ-independent)

def spec(sid, inputs, kind, sl, note, model=None, np2=False, needs_all=False, shuffle=False, R=None):
    tg = {"kind": kind, "horizon_s": HZ, "thr": 2.0}
    if R is not None: tg['R'] = R
    if shuffle: tg['shuffle'] = True
    s = {"id": sid, "inputs": inputs, "statics": ["secleft"], "target": tg,
         "sample_set": "sl%d" % sl, "model": dict(model or MODEL), "source": "osc-lockout-farm",
         "note": note + ' | ' + sc(kind, sl)}
    if np2: s["needs_pending2"] = True
    if needs_all: s["needs_all"] = True
    return s

SPECS = []
# === 1. LOCKOUT ABLATION LADDER @ sl600 (nolock) ==================================
for ch in DERIV_SINGLES:
    SPECS.append(spec('NL_abl_%s' % ch, [ch], 'nolock', 600,
        'ABLATION single-channel: does %s alone beat |mid-.5|? (statics=[secleft])' % ch))
for nice, cs in CS_SINGLES:
    SPECS.append(spec('NL_abl_%s' % nice, [cs], 'nolock', 600,
        'ABLATION single composite %s(%s) vs |mid-.5|. needs_pending2 swap.' % (nice, cs), np2=True))
for a, b in PAIRS:
    SPECS.append(spec('NL_abl_%s_%s' % (a, b), [a, b], 'nolock', 600,
        'ABLATION top-5 pair %s+%s vs |mid-.5|.' % (a, b)))
for ch in AMID_EACH:
    SPECS.append(spec('NL_abl_amid_%s' % ch, ['amid', ch], 'nolock', 600,
        'ABLATION |mid-.5|+%s: does %s ADD to the trivial predictor?' % (ch, ch)))
# === 2. DIET x DECISION-TIME grid ================================================
# nolock
for sl in [600, 480, 360]:
    SPECS.append(spec('ND_pruned10_sl%d' % sl, PRUNED10, 'nolock', sl,
        'DIET full-pruned-10ch raw x nolock @ decision T=secleft%d.' % sl))
SPECS.append(spec('ND_xasset_sl600', XASSET, 'nolock', 600, 'DIET cross-asset eth/sol/btc/cfmean x nolock.'))
SPECS.append(spec('ND_eventanchor_sl600', EVENTANCHOR, 'nolock', 600, 'DIET event-anchored (sdist/mid_d/tfi_cum) x nolock.'))
SPECS.append(spec('ND_geoC_sl600', FAM_C, 'nolock', 600, 'DIET geometry-C-composite (11ch) x nolock. needs_pending2.', np2=True))
SPECS.append(spec('ND_volE_sl600', FAM_E, 'nolock', 600, 'DIET vol-E-composite (7ch) x nolock. needs_pending2.', np2=True))
SPECS.append(spec('ND_flowD_sl600', FAM_D, 'nolock', 600, 'DIET flow-D-composite (9ch) x nolock. needs_pending2.', np2=True))
SPECS.append(spec('ND_kitchensink80_sl600', KITCHENSINK, 'nolock', 600,
    'HEADLINE: full-80ch KITCHEN-SINK (everything possible) x nolock, width256. needs_pending2 + needs_all (waits for FULL swap).',
    model=MODEL256, np2=True, needs_all=True))
# oscillatory (sl480 where it discriminates)
SPECS.append(spec('OD_pruned10_sl480', PRUNED10, 'oscillatory', 480, 'DIET pruned10 x oscillatory (rng>=.15 & >=2 dir-changes).'))
SPECS.append(spec('OD_geoC_sl480', FAM_C, 'oscillatory', 480, 'DIET geometry-C x oscillatory. needs_pending2.', np2=True))
SPECS.append(spec('OD_kitchensink80_sl480', KITCHENSINK, 'oscillatory', 480,
    'HEADLINE kitchen-sink-80 x oscillatory, width256. needs_pending2 + needs_all.', model=MODEL256, np2=True, needs_all=True))
# bothfill35 (economic both-legs-completable, balanced)
SPECS.append(spec('BD_pruned10_sl600', PRUNED10, 'bothfill35', 600, 'DIET pruned10 x bothfill35 (economic both-legs-completable).'))
SPECS.append(spec('BD_kitchensink80_sl600', KITCHENSINK, 'bothfill35', 600,
    'HEADLINE kitchen-sink-80 x bothfill35, width256. needs_pending2 + needs_all.', model=MODEL256, np2=True, needs_all=True))
# === 3. SHUFFLED-NULL floors =====================================================
SPECS.append(spec('NULL_nolock_pruned10_sl600', PRUNED10, 'nolock', 600,
    'NULL FLOOR: pruned10 x nolock with labels permuted within-split -> chance-AUC ~0.5 reference.', shuffle=True))
SPECS.append(spec('NULL_osc_pruned10_sl480', PRUNED10, 'oscillatory', 480,
    'NULL FLOOR: pruned10 x oscillatory shuffled -> chance-AUC ~0.5 reference.', shuffle=True))


def acquire(timeout=15.0, stale=90.0):
    t0 = time.time()
    while True:
        try:
            fd = os.open(QLOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode()); return fd
        except FileExistsError:
            try:
                if time.time()-os.path.getmtime(QLOCK) > stale: os.remove(QLOCK); continue
            except OSError: pass
            if time.time()-t0 > timeout: return None
            time.sleep(0.05)

def main():
    existing = set()
    if os.path.exists(QF):
        for ln in open(QF, encoding='utf-8'):
            s = ln.strip()
            if not s: continue
            try: existing.add(json.loads(s).get('id'))
            except Exception: pass
    todo = [s for s in SPECS if s['id'] not in existing]
    print('=== FARM SCORECARD (|mid-.5| baseline + majority, holdout days 7-8) ===')
    for kind in ['nolock', 'oscillatory', 'bothfill35', 'rangeR']:
        for SL in [600, 480, 360]:
            print('  ' + sc(kind, SL))
    print('total specs defined: %d ; already present: %d ; to append: %d' % (len(SPECS), len(SPECS)-len(todo), len(todo)))
    if not todo:
        print('no-op (all present)'); return
    fd = acquire()
    if fd is None: print('WARN: _qlock timeout -> appending unlocked (append-only, low risk)')
    try:
        with open(QF, 'a', encoding='utf-8') as f:
            for s in todo: f.write(json.dumps(s, ensure_ascii=False)+'\n')
    finally:
        if fd is not None:
            os.close(fd)
            try: os.remove(QLOCK)
            except OSError: pass
    np2 = sum(1 for s in todo if s.get('needs_pending2'))
    print('APPENDED %d specs (%d pre-swap runnable, %d needs_pending2):' % (len(todo), len(todo)-np2, np2))
    for s in todo:
        print('    %-28s %-11s sl=%s ch=%2d%s' % (s['id'], s['target']['kind'],
              s['sample_set'][2:], len(s['inputs']), ' [np2]' if s.get('needs_pending2') else ''))

if __name__ == '__main__':
    main()
