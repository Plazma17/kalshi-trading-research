#!/usr/bin/env python3
"""grok_queue.py -- self-feeding GROK FARM runner.

Waits for the GPU to be idle (no OTHER grok training process AND no foreign
progress_*.json written in the last IDLE_S seconds), then works
experiments_queue.jsonl sequentially FOREVER: each line is a spec, trained via a
generalized version of the grok_train_C machinery, writing progress_<id>.json in
the monitor's `curves` format, marking the line done, checkpoint-resumable.

Spec line (one JSON object per line in experiments_queue.jsonl):
  {
    "id": "L01_dir600",                       # unique; -> progress_<id>.json, ckpt_q_<id>.pt
    "inputs": ["mid","spread","dist","tfi",...],   # raw channel bases (keep-list)
    "target": {"kind":"dir","horizon_s":600,"thr":2.0},
    "sample_set": "event_matched",            # all|event_matched|final5|lowvol|choppy|nearstrike|buyzone
                                              #   |xcross|dspike|midflip  (family-event anchored)
    "model": {"width":128,"wd":0.10,"epochs":200000,"lr":1e-3,"ls":0.1,
              "init_scale":1.0, "grokfast":{"alpha":0.98,"lamb":2.0}},   # grokfast optional
    "source": "ledger|ai|literature",
    "note": "..."
  }
target.kind in: dir(3-class up/flat/down) | bigmove(binary |dmid|>thr) |
                settle(binary YES/NO) | extreme(binary reach>=0.9 or <=0.1 before end) |
                chop_tp(binary reach>=tp before end) | magbin(3-class magnitude terciles) |
                xdirsettle(binary: settle in signed-dist dir; real labels) |
                holdrev(binary: |dist| stays >=75% displaced over horizon) |
                fliprev(binary: mid re-crosses 0.5 within horizon)

Control:
  * touch grok_queue.STOP  -> runner exits at the next safe point.
  * a line is skipped once its "status" is "done" or "error".
  * resumes an interrupted run from ckpt_q_<id>.pt.

Run detached:  nohup python grok_queue.py > grok_queue.out 2>&1 &
"""
import numpy as np, torch, torch.nn as nn, json, os, sys, time, glob, tempfile, subprocess
try: import psutil
except Exception: psutil = None

GD   = r'C:\Users\Noah\claude-workspace\grok'
QF   = os.path.join(GD, 'experiments_queue.jsonl')
STOP = os.path.join(GD, 'grok_queue.STOP')
LOG  = os.path.join(GD, 'grok_queue_state.json')
QLOCK= os.path.join(GD, 'experiments_queue.lock')   # shared cross-process queue mutex
IDLE_S = 180              # foreign progress must be quiet this long
POLL_S = 30               # idle re-check cadence
EVAL_EVERY = 50
CKPT_EVERY = 400
dev  = 'cpu' if os.environ.get('GROKQ_CPU') else ('cuda' if torch.cuda.is_available() else 'cpu')
# OPT-IN speed (GROK_FAST=1): tensor-core TF32 matmul (~1.1x) + fused AdamW (net ~1.42x
# for this full-batch tiny-MLP step). Default OFF -> sequential numerics byte-unchanged.
FAST = os.environ.get('GROK_FAST') == '1'   # == '1' not bool(env): "0"/"" must mean OFF
# OPT-IN (GROK_GRAPH=1): CUDA-graph capture of the batched step (grok_batch reads this
# env at import). Composes with GROK_BATCH/GROK_FAST. ~1.5-1.6x at E<=2 (launch-bound),
# ~1.05x at E>=8 (memory-bound). Numerically identical to eager (grok_graph_verify.py).
GRAPH = os.environ.get('GROK_GRAPH') == '1'   # == '1' not bool(env): "0"/"" must mean OFF
if dev == 'cuda' and FAST:
    torch.backends.cuda.matmul.allow_tf32 = True; torch.backends.cudnn.allow_tf32 = True
# Substrings that mean "another grok trainer / fleet owns the GPU".
# Use the broad 'grok_train' prefix so it catches grok_train.py / grok_train_C.py /
# grok_train_D.py / any grok_train_*.py fleet member. 'launch_grok' catches the persistent
# fleet LAUNCHER bash (launch_grok_D.sh / launch_grok_C*.sh) which stays alive across the
# whole sequential fleet -> immune to a single run's slow progress-write cadence.
TRAIN_MARKERS = ['grok_train', 'grok_fleet', 'grok_diet', 'GROKC_EPOCHS', 'launch_grok']
YIELD_EVERY = 400          # epochs between mid-run contention checks

class Yield(Exception):
    """Raised mid-run when a foreign grok trainer (the mode-D fleet) reappears.
    The runner checkpoints and backs off so it NEVER sustains GPU contention with
    the fleet, even though the fleet's launcher is restarted with gaps."""

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def _replace_retry(tmp, path, tries=25, delay=0.25):
    """os.replace with Windows-lock retry. A concurrent READER (the kalshi-cta Electron
    dashboard tails progress_*.json / ckpt files) makes os.replace raise
    PermissionError(13,'Access is denied') on Windows -> WITHOUT this, one such race
    aborted the whole spec (and, for a batched pair, orphaned its partner). Retry ~6s."""
    for _ in range(tries):
        try:
            os.replace(tmp, path); return
        except PermissionError:
            time.sleep(delay)
    os.replace(tmp, path)               # final attempt: propagate if still locked

def _save_atomic(obj, path):
    """Checkpoint atomically: torch.save to a temp then os.replace, so a crash/kill
    mid-write can NEVER leave a truncated ckpt that fails to reload on resume (which
    would otherwise mark the run 'error' and lose all its training)."""
    tmp = path + '.tmp'
    torch.save(obj, tmp)
    _replace_retry(tmp, path)

def _atomic_write_json(path, obj):
    """Atomic + Windows-lock-retried JSON write (temp + os.replace via _replace_retry).
    The single-spec progress write used a bare truncating `open(path,'w')`, which on
    Windows raises PermissionError(13) when the dashboard is tailing progress_<id>.json
    -> the WHOLE spec then aborts and is marked 'error' PERMANENTLY (next_spec skips
    'error'), losing the run despite a good ckpt. The batched path already writes atomic
    + retried; this brings the single-spec path to parity (no torn reads, no lock-kill)."""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(obj, f)
    _replace_retry(tmp, path)

class _qlock:
    """Best-effort cross-process lock for experiments_queue.jsonl read-modify-write.
    O_CREAT|O_EXCL sentinel; breaks a stale lock (crashed holder) after `stale` s; on
    timeout it PROCEEDS WITHOUT the lock (degrades to the old unlocked behavior) so it
    can never deadlock the farm. Only removes the sentinel if it actually held it."""
    def __init__(self, timeout=15.0, stale=90.0):
        self.timeout = timeout; self.stale = stale; self.fd = None; self.held = False
    def __enter__(self):
        t0 = time.time()
        while True:
            try:
                self.fd = os.open(QLOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try: os.write(self.fd, str(os.getpid()).encode())
                except OSError: pass
                self.held = True; return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(QLOCK) > self.stale:
                        os.remove(QLOCK); continue
                except OSError: pass
                if time.time() - t0 > self.timeout: return self   # proceed unlocked
                time.sleep(0.05)
    def __exit__(self, *a):
        if self.fd is not None:
            try: os.close(self.fd)
            except OSError: pass
        if self.held:
            try: os.remove(QLOCK)
            except OSError: pass
        return False

# =============== GPU-idle detection ===============
def others_training(my_pid):
    if psutil is None: return None
    for p in psutil.process_iter(['pid','cmdline']):
        try:
            if p.info['pid'] == my_pid: continue
            cl = ' '.join(p.info.get('cmdline') or [])
            if 'grok_queue.py' in cl: continue
            if any(mk in cl for mk in TRAIN_MARKERS): return cl[:80]
        except Exception: pass
    return None

def foreign_progress_recent(cur_prog, within):
    now = time.time()
    for f in glob.glob(os.path.join(GD, 'progress_*.json')):
        if os.path.basename(f) == cur_prog: continue
        try:
            if now - os.path.getmtime(f) < within: return os.path.basename(f)
        except Exception: pass
    return None

def gpu_idle(cur_prog='__none__'):
    ot = others_training(os.getpid())
    if ot: return False, 'proc: '+ot
    fp = foreign_progress_recent(cur_prog, IDLE_S)
    if fp: return False, 'recent-progress: '+fp
    return True, 'idle'

def wait_for_idle():
    while True:
        if os.path.exists(STOP): log('STOP file present -> exiting'); sys.exit(0)
        ok, why = gpu_idle()
        if ok: log('GPU idle ->', why); return
        log('waiting for GPU:', why); write_state('waiting', why)
        time.sleep(POLL_S)

def write_state(status, detail, extra=None):
    try:
        st = {'ts': time.time(), 'status': status, 'detail': detail, 'dev': dev}
        if extra: st.update(extra)
        json.dump(st, open(LOG, 'w'))
    except Exception: pass

# =============== data (loaded once) ===============
log('loading grok_data.npz ...')
D = np.load(os.path.join(GD, 'grok_data.npz'), allow_pickle=True)
NAMES = [str(x) for x in D['names']]; BASE = [str(x) for x in D['base']]; TF = [str(x) for x in D['tfFam']]
RAWIDX = {BASE[i]: i for i in range(len(NAMES)) if TF[i] == 'raw'}
ZALL = D['Zimp'].astype(np.float32)                 # (331,nWin,BPW)
MID  = D['mid'].astype(np.float32); SEC = D['secleft'].astype(np.float32)
# signed z-scored distance-to-strike (zero == the strike; sign == cross direction). Used by
# the FAMILY-EVENT sample sets (xcross/dspike/midflip) + targets (xdirsettle/holdrev/fliprev).
SDRAW = ZALL[RAWIDX['sdist']] if 'sdist' in RAWIDX else ZALL[RAWIDX['dist']]
WD_  = D['winDay']; LAB = D['label']
NWIN, BPW = MID.shape
DAYS = sorted(set(WD_.tolist()))
TRAIN_DAYS = set(DAYS[:6])
IS_TR_WIN = np.array([WD_[w] in TRAIN_DAYS for w in range(NWIN)])
L = 30
# seconds-per-bin derived from the data (grok_data.npz is 10s bins; Mode C used
# HZ=12 for 120s). Deriving it avoids a hardcoded divisor breaking if the grid
# is ever rebuilt at a different cadence.
BIN_S = float(np.round(np.abs(np.nanmedian(np.diff(SEC, axis=1)))))
if not (BIN_S > 0): BIN_S = 10.0
log(f'data: nWin={NWIN} BPW={BPW} days={DAYS} dev={dev} rawchans={len(RAWIDX)} bin_s={BIN_S}')

def auc(score, lab):
    lab = lab.astype(bool); p = score[lab]; n = score[~lab]
    if len(p) == 0 or len(n) == 0: return float('nan')
    order = np.argsort(np.concatenate([p, n]), kind='mergesort')
    ranks = np.empty(len(order), float); ranks[order] = np.arange(1, len(order)+1)
    rp = ranks[:len(p)].sum()
    return float((rp - len(p)*(len(p)+1)/2) / (len(p)*len(n)))

# =============== FAMILY-EVENT sample sets (causal, bin-level) ===============
# Event-anchored (w,t) masks that reproduce the tick-level np_xcross / np_spikehold /
# np_flipamp event definitions on the 10s-bin grid, CAUSALLY (bin t reads only bins <= t;
# the debounce/threshold state cleared per window -> no cross-window bleed). Bin-level
# counts match the tick reports closely (xcross 1847 vs 1823; midflip 1328 vs 1315 base
# flips; dspike 934). Computed once per event name, cached module-wide.
_EVENT_CACHE = {}
def _sgnz_grid(a):
    s = np.sign(a); s[s == 0] = 1.0; return s
def event_bins(name):
    """(NWIN,BPW) bool grid: True at the bin where the named family-event fires."""
    if name in _EVENT_CACHE: return _EVENT_CACHE[name]
    out = np.zeros((NWIN, BPW), bool)
    if name == 'xcross':
        # np_xcross ANCHOR: d=cfmean-strike crosses 0 (sign flip of signed dist), debounced 20s.
        ss = _sgnz_grid(SDRAW)
        cr = np.zeros((NWIN, BPW), bool); cr[:, 1:] = ss[:, 1:] != ss[:, :-1]
        DB = max(1, int(round(20.0/BIN_S)))
        for w in range(NWIN):
            row = cr[w]; last = -10**9
            for t in range(1, BPW):
                if row[t] and (t-last) >= DB: out[w, t] = True; last = t
    elif name == 'midflip':
        # np_flipamp FLIP: sign(mid-0.5) change, exclude first 60s after open, debounce 30s.
        ms = _sgnz_grid(MID-0.5)
        fl = np.zeros((NWIN, BPW), bool); fl[:, 1:] = ms[:, 1:] != ms[:, :-1]
        DB = max(1, int(round(30.0/BIN_S))); openok = SEC <= (900.0-60.0)
        for w in range(NWIN):
            last = -10**9
            for t in range(1, BPW):
                if fl[w, t] and (t-last) >= DB and openok[w, t]: out[w, t] = True; last = t
    elif name == 'dspike':
        # np_spikehold SPIKE->HOLD->GAP anchored at the HOLD bin: prior bin had a top-decile
        # |d(sy)/dt| spike; this bin continues SAME-SIGN but small (<=0.5x, the plateau) AND
        # sy is beyond mid in the spike direction (gap). sy_z = symlog analog of signed dist.
        syz = 50.0 + 50.0*np.tanh(0.6*SDRAW); mp = MID*100.0
        dsy = np.zeros((NWIN, BPW), np.float64); dsy[:, 1:] = syz[:, 1:]-syz[:, :-1]
        absd = np.abs(dsy); sg = _sgnz_grid(dsy)
        trbins = np.zeros((NWIN, BPW), bool); trbins[IS_TR_WIN, :] = True
        thr = float(np.quantile(absd[trbins], 0.90))
        spike = absd >= thr; gap = _sgnz_grid(syz-mp); HR = 0.5
        out[:, 1:] = (spike[:, :-1] & (sg[:, 1:] == sg[:, :-1])
                      & (absd[:, 1:] <= HR*absd[:, :-1]) & (gap[:, 1:] == sg[:, :-1]))
    else:
        raise ValueError('unknown event set '+name)
    _EVENT_CACHE[name] = out
    return out

# =============== build a run from a spec ===============
def build_run(spec):
    inputs = spec['inputs']; tg = spec['target']; ss = spec.get('sample_set', 'all')
    kind = tg['kind']; HZ = max(1, int(round(tg.get('horizon_s', 120)/BIN_S))); thr = float(tg.get('thr', 2.0))
    sel = [RAWIDX[k] for k in inputs if k in RAWIDX]
    keep = [k for k in inputs if k in RAWIDX]
    Zin = ZALL[sel].copy()                          # (K,nWin,BPW)
    K = Zin.shape[0]
    # --- SYNTHETIC/DERIVED context channels (direction-free geometry the raw grid lacks) ----
    # amid=|mid-.5| (THE trivial lockout predictor, as a per-bin channel) and secleftc=secleft/900
    # (time-left as a channel). Added so the LOCKOUT ABLATION LADDER can isolate |mid-.5| / time as
    # net INPUTS without leaking them as always-on statics. Pre-swap available (no needs_pending2).
    _DERIV = {'amid': np.abs(MID - 0.5), 'secleftc': SEC / 900.0}
    _dk = [k for k in inputs if k in _DERIV]
    if _dk:
        _extra = np.stack([_DERIV[k].astype(np.float32) for k in _dk], 0)   # (nd,NWIN,BPW)
        Zin = np.concatenate([Zin, _extra], 0); keep = keep + _dk; K = Zin.shape[0]
    # standardize on train bins only
    trmask = np.zeros((NWIN, BPW), bool); trmask[IS_TR_WIN, :] = True
    mu = Zin[:, trmask].mean(1); sd = Zin[:, trmask].std(1); sd[sd < 1e-6] = 1
    Zin = (Zin - mu[:, None, None]) / sd[:, None, None]
    distraw = ZALL[RAWIDX['dist']]

    # candidate (w,t)
    t_lo, t_hi = L-1, BPW-1-HZ
    ws = []; ts = []
    for w in range(NWIN):
        for tt in range(t_lo, t_hi+1):
            ws.append(w); ts.append(tt)
    ws = np.array(ws); ts = np.array(ts)
    DM = (MID[ws, ts+HZ] - MID[ws, ts]) * 100.0     # cents
    tr_all = IS_TR_WIN[ws]

    # ---- target labels + head type ----
    valid = np.ones(len(ws), bool)
    if kind == 'dir':
        y = np.where(DM < -thr, 0, np.where(DM > thr, 2, 1)).astype(np.int64); head = 'cls3'
    elif kind == 'magbin':
        am = np.abs(DM)
        q1, q2 = np.quantile(am[tr_all], [1/3, 2/3])
        y = np.where(am <= q1, 0, np.where(am <= q2, 1, 2)).astype(np.int64); head = 'cls3'
    elif kind == 'bigmove':
        y = (np.abs(DM) > thr).astype(np.int64); head = 'bin'
    elif kind == 'settle':
        y = np.clip(LAB[ws], 0, 1).astype(np.int64); valid = (LAB[ws] >= 0); head = 'bin'
    elif kind == 'extreme':
        y = np.zeros(len(ws), np.int64)
        for i in range(len(ws)):
            seg = MID[ws[i], ts[i]:]
            y[i] = 1 if (seg.max() >= 0.9 or seg.min() <= 0.1) else 0
        head = 'bin'
    elif kind == 'chop_tp':
        tp = float(tg.get('tp', 0.55))
        y = np.zeros(len(ws), np.int64)
        for i in range(len(ws)):
            y[i] = 1 if MID[ws[i], ts[i]:].max() >= tp else 0
        head = 'bin'
    elif kind == 'xdirsettle':
        # cross-DIRECTION settles: does the window settle in the signed-dist direction at
        # the (event) bin? Real settle labels. dir=sign(sdist) (=post-cross sign for xcross).
        # Engineered baseline = np_xcross 55.4% cross-dir settle; FARM-8 mid>0.5 if quote inputs.
        dirn = np.sign(SDRAW[ws, ts]); dirn[dirn == 0] = 1
        lab = LAB[ws]
        y = ((lab == 1) == (dirn > 0)).astype(np.int64); valid = (lab >= 0); head = 'bin'
    elif kind == 'holdrev':
        # HOLD-vs-revert: does |signed dist| stay >= 75% of its event-bin displacement for the
        # whole horizon (hold=1) or retrace below (revert=0)? causal forward look on the label.
        disp0 = np.abs(SDRAW[ws, ts]); y = np.zeros(len(ws), np.int64)
        for i in range(len(ws)):
            seg = np.abs(SDRAW[ws[i], ts[i]+1:ts[i]+HZ+1])
            y[i] = 1 if (seg.size > 0 and seg.min() >= 0.75*disp0[i]) else 0
        head = 'bin'
    elif kind == 'fliprev':
        # FLIP-reverts: after a mid 50-flip, does the mid RE-CROSS 0.5 back within the horizon?
        y = np.zeros(len(ws), np.int64)
        for i in range(len(ws)):
            side = 1.0 if (MID[ws[i], ts[i]]-0.5) >= 0 else -1.0
            seg = MID[ws[i], ts[i]+1:ts[i]+HZ+1] - 0.5
            y[i] = 1 if np.any(np.sign(seg) == -side) else 0
        head = 'bin'
    # ---- OSCILLATION / RANGE / LOCKOUT family (2026-07-03, Noah) -----------------------
    # Direction-free guards for the both-sides bot fleet. All look FORWARD from t to settle
    # (labels read bins > t; features X are still trailing-only bins <= t -> no leak). The
    # both-sides trade wins on ANY ~10-20c fluctuation and dies only on an early lockout-pin,
    # so these predict "will it wiggle enough / avoid the pin", NOT a direction.
    elif kind == 'rangeR':
        # Remaining-window mid-RANGE (max-min over [t, settle]) >= R. Noah's "will it wiggle
        # enough to complete" magnitude target. R variants {0.10,0.15,0.20} via tg['R'].
        # Reproduces np_rangeguard range>=R on the 10s-bin grid. Engineered baseline ~.83-.85
        # (magnitude/range = our strongest, direction-free family); trivial rule = |mid-.5|+time-left.
        R = float(tg.get('R', 0.15))
        smax = np.maximum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]   # suffix max over [t, settle]
        smin = np.minimum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]   # suffix min over [t, settle]
        rng = (smax - smin)[ws, ts]
        y = (rng >= R).astype(np.int64); head = 'bin'
    elif kind == 'nolock':
        # NOT early-lockout-pin: mid does NOT reach <=PIN_LO(0.05) or >=PIN_HI(0.95) within the
        # first K_LOCK=300s AND then STAY pinned (never returns past RET_LO=0.15 / RET_HI=0.85)
        # to settle. y=1 => tradable (no naked-leg strand) = the naked-leg-killer avoidance.
        # Reproduces np_rangeguard labels_at; strictly-forward scan (bins > t).
        PIN_LO, PIN_HI, RET_LO, RET_HI = 0.05, 0.95, 0.15, 0.85
        Kb = max(1, int(round(300.0/BIN_S)))
        smax = np.maximum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]
        smin = np.minimum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]
        y = np.ones(len(ws), np.int64)                               # default = NOT locked
        for i in range(len(ws)):
            w = ws[i]; t0 = ts[i]; jhi = min(t0+Kb, BPW-1)
            for j in range(t0+1, jhi+1):                             # first pin-touch in (t, t+K]
                mj = MID[w, j]
                if mj <= PIN_LO:
                    if smax[w, j] <= RET_LO: y[i] = 0                # stays pinned low -> locked
                    break
                if mj >= PIN_HI:
                    if smin[w, j] >= RET_HI: y[i] = 0                # stays pinned high -> locked
                    break
        head = 'bin'
    elif kind == 'bothfill35':
        # BOTH-legs-fill at price p over the remainder = the existing osc-logit label (baseline
        # to beat, engineered ~.68-.74). Maker-touch at p=0.35: YES fills when yes_ask<=p (mid<=p),
        # NO fills when no_ask<=p (mid>=1-p). grok_data asks are z-scored -> true-mid zero-spread
        # proxy on D['mid']. Direction-free: y=1 iff the remainder reaches BOTH trigger regions.
        p = float(tg.get('p', 0.35))
        smax = np.maximum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]
        smin = np.minimum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]
        tnext = np.minimum(ts+1, BPW-1)
        minfwd = smin[ws, tnext]; maxfwd = smax[ws, tnext]           # over (t, settle]
        y = ((minfwd <= p) & (maxfwd >= 1.0-p)).astype(np.int64); head = 'bin'
    elif kind == 'seqcomplete':
        # SEQUENTIAL lock-in COMPLETES this window (np_seqlock economic label = the thing that
        # actually pays): buy leg1 on the first cheap side (ask<=FIRST_MAX=0.40), then complete
        # the OTHER side when its ask<=(1-MIN_PROFIT-FIRST_MAX) for a guaranteed >=MIN_PROFIT(5c)
        # lock. maker-touch p1=FIRST_MAX; true-mid zero-spread proxy (yes_ask=mid, no_ask=1-mid).
        # y=1 iff a locked pair completes before settle. Order matters -> forward scan (bins > t).
        FM = float(tg.get('first_max', 0.40)); MPf = float(tg.get('min_profit', 0.05))
        cap = 1.0 - MPf - FM
        y = np.zeros(len(ws), np.int64)
        for i in range(len(ws)):
            w = ws[i]; j1 = -1; side = 0
            for j in range(ts[i]+1, BPW):                            # leg1: first cheap side
                mj = MID[w, j]
                if mj <= FM: j1 = j; side = 1; break                # bought YES (mid low)
                if mj >= 1.0-FM: j1 = j; side = -1; break           # bought NO  (mid high)
            if j1 < 0: continue
            for j in range(j1+1, BPW):                              # leg2: complete other side <=cap
                mj = MID[w, j]
                if side == 1:
                    if (1.0-mj) <= cap: y[i] = 1; break            # no_ask <= cap
                else:
                    if mj <= cap: y[i] = 1; break                  # yes_ask <= cap
        head = 'bin'
    elif kind == 'oscillatory':
        # OSCILLATORY (both-legs-completable) = remaining mid-RANGE (max-min over [t,settle]) >= R
        # (0.15) AND >= NCH(2) mid-direction changes over [t,settle]. Direction-free. The literal
        # "both-legs-completable window" per Noah's label def. NOTE: SATURATES (~0.85-0.98 base) over
        # a long remainder -> pair with bothfill35 (economic, balanced) in the sweep; discriminates
        # only at late-ish decision points (short remainder). Reproduces _validate_osc_labels.py.
        Rr = float(tg.get('R', 0.15)); NCH = int(tg.get('nch', 2))
        smax = np.maximum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]
        smin = np.minimum.accumulate(MID[:, ::-1], axis=1)[:, ::-1]
        rrng = (smax - smin)[ws, ts]
        y = np.zeros(len(ws), np.int64)
        for i in range(len(ws)):
            seg = MID[ws[i], ts[i]:]
            d = np.diff(seg); s = np.sign(d); s = s[s != 0]
            nch = int(np.sum(s[1:] != s[:-1])) if len(s) > 1 else 0
            y[i] = 1 if (rrng[i] >= Rr and nch >= NCH) else 0
        head = 'bin'
    else:
        raise ValueError('unknown target kind '+kind)

    # ---- sample-set restriction ----
    m = valid.copy()
    if ss == 'final5':
        m &= (SEC[ws, ts] <= 300)
    elif ss == 'lowvol':
        sig = ZALL[RAWIDX['sig']][ws, ts]; med = np.median(sig[tr_all & m]); m &= (sig <= med)
    elif ss == 'nearstrike':
        dr = np.abs(distraw[ws, ts]); med = np.median(dr[tr_all & m]); m &= (dr <= med)
    elif ss == 'buyzone':
        m &= (MID[ws, ts] >= 0.25) & (MID[ws, ts] <= 0.35)
    elif ss[:2] == 'sl' and ss[2:].isdigit():
        # DECISION-TIME band by SECONDS-LEFT: ONE causal decision per window at the bin nearest
        # secleft=NNN, clamped >=L-1 so the L=30 (=300s) trailing context is always REAL (no
        # negative-index wrap-leak from settle). Gives the report's per-window decision-time
        # methodology (== apples-to-apples with the |mid-.5| baseline). The guard's report used
        # decision-time=ELAPSED, but L=30 forces decisions at secleft<=~600; secleft=600 reproduces
        # the balanced nolock base~0.64 & |mid-.5| holdout AUC~0.74 (== the ~0.755 bar to beat).
        SL = float(ss[2:]); _tgt = np.clip(np.abs(SEC - SL).argmin(axis=1), L-1, BPW-1)
        m &= (ts == _tgt[ws])
    elif ss == 'choppy':
        # path inefficiency over the L-context: sum|dmid| / |net dmid|
        pi = np.empty(len(ws), np.float32)
        for i in range(len(ws)):
            seg = MID[ws[i], ts[i]-(L-1):ts[i]+1]
            net = abs(seg[-1]-seg[0]); tot = np.abs(np.diff(seg)).sum()
            pi[i] = tot/(net+1e-4)
        med = np.median(pi[tr_all & m]); m &= (pi >= med)
    elif ss in ('xcross', 'dspike', 'midflip'):
        # FAMILY-EVENT anchoring: restrict to bins where the named event fires (causal, bin-level;
        # reproduces np_xcross / np_spikehold / np_flipamp event definitions -- see event_bins()).
        m &= event_bins(ss)[ws, ts]
    elif ss == 'event_matched':
        is_event = np.abs(DM) > thr
        def sb(w, t): return np.clip((SEC[w, t]/900.0*6).astype(int), 0, 5)
        def mb(w, t): return np.clip((MID[w, t]*5).astype(int), 0, 4)
        strat = sb(ws, ts)*5 + mb(ws, ts); rng = np.random.default_rng(0)
        km = np.zeros(len(ws), bool)
        for split in [tr_all, ~tr_all]:
            ev = split & is_event & valid; ct = split & (~is_event) & valid
            km |= ev
            ev_i = np.where(ev)[0]; ct_i = np.where(ct)[0]
            for s in np.unique(strat[ev_i]):
                need = int((strat[ev_i] == s).sum()); pool = ct_i[strat[ct_i] == s]
                if len(pool) == 0: continue
                pick = rng.choice(pool, size=min(need, len(pool)), replace=False); km[pick] = True
        m &= km
    # 'all' -> no extra restriction

    idx = np.where(m)[0]
    ws, ts, y, tr_all = ws[idx], ts[idx], y[idx], tr_all[idx]

    # ---- shuffled-null floor (tg['shuffle']): permute labels WITHIN train and WITHIN holdout
    # (after the sample-set restriction) so each split's base rate is preserved EXACTLY while every
    # feature<->label link is destroyed -> a true chance-AUC (~0.5) null at the SAME class balance as
    # the real spec. (Declared in CF_NULL/OSC_NULL but never honored -> they trained on real labels.)
    if tg.get('shuffle'):
        _rs = np.random.default_rng(int(tg.get('seed', 0)))
        for _sel in (tr_all, ~tr_all):
            _i = np.where(_sel)[0]
            if len(_i) > 1: y[_i] = y[_i[_rs.permutation(len(_i))]]

    # ---- flattened context X + static ----
    N = len(ws); X = np.empty((N, K*L), np.float32); base_t = ts-(L-1)
    for o in range(L):
        X[:, o*K:(o+1)*K] = Zin[:, ws, base_t+o].T
    # static features: default = secleft/mid/dist (back-compat). A spec may set
    # "statics" to a subset (e.g. ["secleft"]) so the ABLATION LADDER can isolate
    # a single channel's context WITHOUT leaking mid/dist as always-on statics.
    stat_map = {'secleft': SEC[ws, ts]/900.0, 'mid': MID[ws, ts], 'dist': distraw[ws, ts]}
    stat_keys = spec.get('statics', ['secleft', 'mid', 'dist'])
    scols = [stat_map[s] for s in stat_keys if s in stat_map]
    if scols:
        X = np.concatenate([X, np.stack(scols, 1).astype(np.float32)], 1)
    return dict(X=X, y=y, tr_all=tr_all, head=head, keep=keep, K=K, HZ=HZ, Din=X.shape[1])

# =============== model ===============
class MLP(nn.Module):
    def __init__(self, Din, W, nout):
        super().__init__()
        self.f = nn.Sequential(nn.Linear(Din, W), nn.GELU(), nn.Linear(W, W), nn.GELU())
        self.o = nn.Linear(W, nout)
    def forward(self, x): return self.o(self.f(x))

def train_spec(spec):
    sid = spec['id']; mp = spec.get('model', {})
    W = int(mp.get('width', 128)); wd = float(mp.get('wd', 0.10))
    epochs = int(mp.get('epochs', 200000)); lr = float(mp.get('lr', 1e-3))
    ls = float(mp.get('ls', 0.1)); warmup = int(mp.get('warmup', 1000))
    init_scale = float(mp.get('init_scale', 1.0)); gf = mp.get('grokfast')
    PROG = os.path.join(GD, f'progress_{sid}.json'); CKPT = os.path.join(GD, f'ckpt_q_{sid}.pt')

    run = build_run(spec)
    X, y, tr_all, head, Din = run['X'], run['y'], run['tr_all'], run['head'], run['Din']
    nout = 3 if head == 'cls3' else 1
    Xt = torch.tensor(X, device=dev)
    trm = torch.tensor(tr_all, device=dev); tr_i = torch.where(trm)[0]; ho_i = torch.where(~trm)[0]
    yt = torch.tensor(y, device=dev)
    # baselines
    if head == 'cls3':
        cnt = np.bincount(y[tr_all], minlength=3).astype(np.float64); cnt[cnt == 0] = 1
        cw = torch.tensor(cnt.sum()/(3*cnt), dtype=torch.float32, device=dev)
        crit = nn.CrossEntropyLoss(weight=cw, label_smoothing=ls)
        maj = int(np.bincount(y[tr_all], minlength=3).argmax()); base_acc = float((y[~tr_all] == maj).mean())
    else:
        pos = float(y[tr_all].mean()); pw = torch.tensor([(1-pos)/max(pos, 1e-3)], device=dev)
        crit = nn.BCEWithLogitsLoss(pos_weight=pw)
        maj = int(round(y[tr_all].mean())); base_acc = float((y[~tr_all] == maj).mean())
        ytf = torch.tensor(y.astype(np.float32), device=dev)

    net = MLP(Din, W, nout).to(dev)
    if init_scale != 1.0:
        with torch.no_grad():
            for mod in net.modules():
                if isinstance(mod, nn.Linear): mod.weight.mul_(init_scale)
    nparams = sum(p.numel() for p in net.parameters())
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=wd, fused=(dev == 'cuda' and FAST))
    gf_ema = None
    if gf:
        gf_alpha = float(gf.get('alpha', 0.98)); gf_lamb = float(gf.get('lamb', 2.0))

    @torch.no_grad()
    def evaluate(idx):
        net.eval(); out = net(Xt[idx]); yy = y[idx.cpu().numpy()]
        if head == 'cls3':
            prob = torch.softmax(out, 1).cpu().numpy(); pred = prob.argmax(1)
            acc = float((pred == yy).mean())
            ud = (yy != 1); sUD = prob[:, 2]-prob[:, 0]
            aUD = auc(sUD[ud], (yy[ud] == 2).astype(int)) if ud.any() else float('nan')
            aEC = auc(1-prob[:, 1], (yy != 1).astype(int))
            ce = float(nn.functional.cross_entropy(out, torch.tensor(yy, device=dev)).item())
            net.train(); return acc, aUD, aEC, ce
        else:
            p = torch.sigmoid(out.squeeze(-1)).cpu().numpy(); pred = (p > 0.5).astype(int)
            acc = float((pred == yy).mean()); a = auc(p, yy.astype(int))
            ce = float(nn.functional.binary_cross_entropy(torch.tensor(p), torch.tensor(yy.astype(np.float32))).item())
            net.train(); return acc, a, a, ce

    start = 0; curves = []
    if os.path.exists(CKPT):
        ck = torch.load(CKPT, map_location=dev)
        net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt'])
        start = ck['epoch']+1; curves = ck.get('curves', []); gf_ema = ck.get('gf_ema')
        log(f'{sid}: resumed from epoch {start}')

    log(f'=== RUN {sid} head={head} Din={Din} N={len(y)} params={nparams} wd={wd} epochs={epochs} start={start} ===')
    t0 = time.time()
    for ep in range(start, epochs):
        if os.path.exists(STOP):
            _save_atomic({'net': net.state_dict(), 'opt': opt.state_dict(), 'epoch': ep-1,
                          'curves': curves, 'gf_ema': gf_ema}, CKPT)
            log(f'{sid}: STOP -> checkpointed at ep{ep-1}'); sys.exit(0)
        if ep % YIELD_EVERY == 0 and ep > start:
            other = others_training(os.getpid())     # fleet reappeared mid-run?
            if other:
                _save_atomic({'net': net.state_dict(), 'opt': opt.state_dict(), 'epoch': ep-1,
                              'curves': curves, 'gf_ema': gf_ema}, CKPT)
                log(f'{sid}: YIELD at ep{ep-1} -> fleet active: {other[:50]}')
                write_state('yielded', sid, {'epoch': ep-1, 'to': other[:50]})
                raise Yield()
        net.train()
        for g in opt.param_groups: g['lr'] = lr*min(1.0, (ep+1)/warmup)
        out = net(Xt[tr_i])
        if head == 'cls3':
            loss = crit(out, yt[tr_i])
        else:
            loss = crit(out.squeeze(-1), ytf[tr_i])
        opt.zero_grad(); loss.backward()
        if gf:                                  # grokfast-EMA: amplify slow gradients
            if gf_ema is None: gf_ema = [torch.zeros_like(p) for p in net.parameters()]
            for p, e in zip(net.parameters(), gf_ema):
                if p.grad is None: continue
                e.mul_(gf_alpha).add_(p.grad, alpha=1-gf_alpha)
                p.grad.add_(e, alpha=gf_lamb)
        opt.step()
        if ep % EVAL_EVERY == 0 or ep == epochs-1:
            a_tr, b_tr, c_tr, ce_tr = evaluate(tr_i)
            a_ho, b_ho, c_ho, ce_ho = evaluate(ho_i)
            row = dict(epoch=ep, tloss=float(loss.item()),
                       diracc_tr=[a_tr, b_tr, c_tr], diracc_ho=[a_ho, b_ho, c_ho],
                       mae_tr=[ce_tr, 0.0, 0.0], mae_ho=[ce_ho, 0.0, 0.0],
                       nc_tr=[base_acc, 0.5, 0.5], nc_ho=[base_acc, 0.5, 0.5],
                       edge_tr=[a_tr-base_acc, b_tr-0.5, c_tr-0.5],
                       edge_ho=[a_ho-base_acc, b_ho-0.5, c_ho-0.5],
                       settle_tr=a_tr, settle_ho=a_ho,
                       acc_tr=a_tr, acc_ho=a_ho, aucUD_ho=b_ho, aucEC_ho=c_ho,
                       sec=round(time.time()-t0, 1))
            curves.append(row)
            if len(curves) > 5000: curves = curves[:500] + curves[500:][::2]
            _atomic_write_json(PROG, {'mode': sid, 'params': nparams, 'wd': wd, 'L': L, 'HZ': run['HZ'], 'K': run['K'],
                       'keep': run['keep'], 'head': head, 'source': spec.get('source'),
                       'baselines': {'majority': base_acc}, 'nc_ho': [base_acc, 0.5, 0.5],
                       'curves': curves})
            if ep % (EVAL_EVERY*20) == 0:
                log(f'{sid} ep{ep} loss{loss.item():.4f} accTR {a_tr:.3f} accHO {a_ho:.3f} aucHO {b_ho:.3f}')
                write_state('running', sid, {'epoch': ep, 'accHO': a_ho, 'aucHO': b_ho})
        if ep % CKPT_EVERY == 0 or ep == epochs-1:
            _save_atomic({'net': net.state_dict(), 'opt': opt.state_dict(), 'epoch': ep,
                          'curves': curves, 'gf_ema': gf_ema}, CKPT)
    _save_atomic({'net': net.state_dict(), 'opt': opt.state_dict(), 'epoch': epochs-1,
                  'curves': curves, 'gf_ema': gf_ema}, CKPT)
    log(f'{sid}: DONE')

# =============== queue file management ===============
def read_queue():
    specs = []
    if not os.path.exists(QF): return specs
    for ln in open(QF, encoding='utf-8'):
        s = ln.strip()
        if not s: continue
        try: specs.append(json.loads(s))
        except Exception as e: log('bad queue line skipped:', repr(e)[:80])
    return specs

def rewrite_queue(specs):
    fd, tmp = tempfile.mkstemp(dir=GD, suffix='.jsonl'); os.close(fd)
    with open(tmp, 'w', encoding='utf-8') as f:
        for s in specs: f.write(json.dumps(s, ensure_ascii=False)+'\n')
    _replace_retry(tmp, QF)

def mark(spec_id, status, note=''):
    with _qlock():                       # serialize the read-modify-replace vs other queue writers
        specs = read_queue()
        for s in specs:
            if s.get('id') == spec_id:
                s['status'] = status; s['finished_at'] = time.time()
                if note: s['status_note'] = note
        rewrite_queue(specs)

def _spec_channels_ready(s):
    """False iff an inputs-spec has NONE of its input channels in the currently
    loaded dataset -- e.g. a needs_pending2 composite diet (cs_* channels) BEFORE the
    grok_data.pending2 swap+restart. Such a spec MUST be skipped (left pending), never
    run now: build_run would silently drop it to statics-only (K=0 -> Din=len(statics))
    and main() would mark it 'done' on garbage, so it never re-runs post-swap. This is
    also the BATCH-path hazard: batchable_key ignores `inputs`, so a runnable raw-diet
    (e.g. FE_xcross_xset_10ch) would otherwise group its needs_pending2 partners
    (FE_xcross_xset_Cgeo/Dflow, same sample_set/target/width/epochs) and drag them into a
    statics-only train_batch -> all marked done. Self-heals: once the swap loads cs_*
    into RAWIDX, this returns True and the specs run normally."""
    if 'inputs' not in s: return True                 # shell specs unaffected
    def _av(k): return (k in RAWIDX) or (k in ('amid', 'secleftc'))   # +derived synth channels
    ins = s.get('inputs', [])
    # needs_all (the 80-ch KITCHEN-SINK): mixes raw (present pre-swap) + cs_ (post-swap only) ->
    # any()==True would run it PREMATURELY on the 30 available channels + mark done, so it never
    # gets its full 80. Require ALL inputs present -> it waits for the pending2 swap like a pure diet.
    if s.get('needs_all'): return all(_av(k) for k in ins)
    return any(_av(k) for k in ins)

def next_spec():
    for s in read_queue():
        if s.get('status') in ('done', 'error'): continue
        if 'id' not in s: continue
        if 'shell' in s: return s
        if 'inputs' in s and 'target' in s and _spec_channels_ready(s): return s
    return None

def pending_batch_group(spec, gb, cap=None):
    """OPT-IN (GROK_BATCH=1): collect all PENDING specs that share spec's
    grok_batch.batchable_key (same sample_set/target/width/epochs; differ only in
    inputs + wd/ls/seed) so they can be trained SIMULTANEOUSLY as one stacked
    ensemble (grok_batch.train_batch). Bounded by GROK_BATCH_MAX (GPU memory)."""
    cap = cap or int(os.environ.get('GROK_BATCH_MAX', 16))
    key = gb.batchable_key(spec)
    if key is None: return [spec]
    grp = []
    for s in read_queue():
        if s.get('status') in ('done', 'error') or 'id' not in s: continue
        if not _spec_channels_ready(s): continue      # never batch a pre-swap needs_pending2 partner (statics-only garbage -> done)
        if gb.batchable_key(s) == key:
            grp.append(s)
            if len(grp) >= cap: break
    return grp or [spec]

def run_shell(spec):
    """A backlog spec that just runs a detached-style shell command inline (e.g. the
    C1/C2 1,000,000-epoch extension via grok_train_C.py). GPU-idle already gated.
    grok_train_C.py resumes its OWN ckpt/progress -> if that work is already at 1M
    (e.g. the fleet agent did it) this is a near-instant no-op (no duplication)."""
    sid = spec['id']; cmd = spec['shell']
    log(f'=== SHELL {sid}: {cmd} ===')
    write_state('running', sid, {'shell': cmd})
    p = subprocess.run(['bash', '-lc', f'cd "{GD}" && {cmd}'], cwd=GD)
    log(f'{sid}: shell exit {p.returncode}')
    if p.returncode != 0: raise RuntimeError(f'shell exit {p.returncode}')

# =============== main loop ===============
def main():
    try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass
    log(f'grok_queue runner start; dev={dev} FAST={FAST} BATCH={os.environ.get("GROK_BATCH")=="1"} GRAPH={GRAPH}')
    while True:
        if os.path.exists(STOP): log('STOP -> exit'); write_state('stopped', 'STOP file'); return
        spec = next_spec()
        if spec is None:
            write_state('empty', 'no pending specs'); log('queue empty; sleeping'); time.sleep(POLL_S); continue
        sid = spec['id']
        wait_for_idle()
        # re-confirm still pending (another instance / manual edit)
        cur = next_spec()
        if cur is None or cur.get('id') != sid:
            continue
        group = None
        try:
            write_state('running', sid)
            # --- OPT-IN batched-ensemble path (GROK_BATCH=1): train all same-shape
            #     pending specs at once (~1.85x/net over fused single, ~2.8x over the
            #     original farm; also avoids multi-proc GPU thrash). Default off =
            #     unchanged sequential behavior. ---
            _GB = None
            if os.environ.get('GROK_BATCH') == '1' and 'shell' not in spec:
                try: import grok_batch as _GB
                except Exception as e: log('grok_batch import failed, sequential:', repr(e)[:80]); _GB = None
            group = pending_batch_group(spec, _GB) if (_GB and _GB.batchable_key(spec) is not None) else None
            if group and len(group) >= 2:
                log(f'BATCH mode: {len(group)} specs ->', [g['id'] for g in group])
                ids, _st = _GB.train_batch(group, log=log, stop_file=STOP)
                # Only mark done on a real completion. On STOP, train_batch returns
                # (ids,'stopped') with the shared ckpt saved but training INCOMPLETE;
                # marking those 'done' would skip them on resume -> partial curves
                # recorded as finished (the ladder harvest would then rank truncated runs).
                if _st == 'ok':
                    for gid in ids: mark(gid, 'done')
                    log('BATCH marked done', ids)
                else:
                    log(f'BATCH not completed (state={_st}); left PENDING to resume', ids)
            elif 'shell' in spec:
                run_shell(spec); mark(sid, 'done'); log(sid, 'marked done')
            else:
                train_spec(spec); mark(sid, 'done'); log(sid, 'marked done')
        except Yield:
            # fleet reappeared mid-run: leave spec PENDING, back off, resume from ckpt when idle
            log(sid, 'yielded to fleet; will resume when idle'); continue
        except SystemExit:
            raise
        except Exception as e:
            import traceback; traceback.print_exc()
            # Mark the WHOLE batched group 'error', not just sid. Previously only sid
            # (the first spec next_spec() returned) was marked, leaving its batch
            # PARTNER 'pending' -> on retry the partner re-groups ALONE under a
            # DIFFERENT ckpt_qbatch hash (md5 of the sorted group ids) and silently
            # retrains from scratch. Consistent marking keeps a pair's fate coupled.
            err_ids = [g['id'] for g in group] if (group and len(group) >= 2) else [sid]
            for eid in err_ids: mark(eid, 'error', repr(e)[:160])
            log('ERROR ->', err_ids, '::', repr(e)[:160])

if __name__ == '__main__':
    main()
