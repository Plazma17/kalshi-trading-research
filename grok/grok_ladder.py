#!/usr/bin/env python3
r"""grok_ladder.py -- Noah's ABLATION LADDER orchestrator for the GROK FARM.

WHAT: build single-channel grok nets for every raw stream -> see which
memorize / generalize -> escalate greedy-forward to 2,3,4-channel diets to map
exactly WHICH DATA (and which combinations) predicts the Kalshi price.

HOW IT INTEGRATES (does NOT own or touch the GPU):
  * emits specs into experiments_queue.jsonl in the grok_queue.py farm format
    (idempotent append -- never clobbers other agents' lines). grok_queue.py
    trains them one at a time when the GPU is idle and writes progress_<id>.json.
  * a canonical copy of every ladder spec is also kept in
    research_specs_ladder.jsonl (my source-of-record, same convention as the
    research agents' research_specs_*.jsonl).
  * the queue's build_run honours a per-spec "statics" field (added
    back-compatibly). Ladder runs set statics=["secleft"] so a single channel's
    30-bin context is isolated WITHOUT leaking mid/dist as always-on statics --
    this is what makes the ablation clean (Noah: "just that channel + secleft
    static").

MODES:
  python grok_ladder.py --seed            # seed TIER 1 into the queue NOW
  python grok_ladder.py --harvest         # read finished progress_*, compute
                                          #   ladder stats, generate + seed the
                                          #   NEXT tier, regenerate chart+report
  python grok_ladder.py --watch           # cheap detached poller: harvest each
                                          #   time the current tier finishes
  python grok_ladder.py --report          # regenerate chart+report only

PER-RUN STATS (the ladder's currency, all derived from progress_<id>.json):
  (a) MEMORIZATION CEILING = max train accuracy reached. For 1-2 channel diets
      this measures input distinguishability (Noah's data-sufficiency insight):
      a channel that can't push train acc up simply lacks the bits.
  (b) HOLDOUT-OVER-BASELINE = the LATE-WINDOW MEAN of the holdout metric (last
      LATE_FRAC of epochs, post-memorization) minus the diet-appropriate baseline.
      This is the RANKING currency (FARM-6): the old np.nanmax-over-curve is an
      upward-biased maximum over ~2000 correlated checkpoints and is kept only as a
      reported "peak (biased)" column. Headline is AUC-0.5 when majority>0.55 (raw
      acc BANNED there), else acc-majority (FARM-1/2). SE is AR(1)-corrected.
  (c) SICK flag: train acc < 95% of its own ceiling by ~20k epochs => broken
      run (bad init / dead diet), DISTINCT from a healthy grok-negative result.
  (d) DET-EV bridge: best-case after-fee cents/trade at the detected strength vs
      the taker/maker cost wall; DETECTED-NOT-TRADABLE = real but economically
      competed (route to composition/veto, not an entry battery).
  (e) FARM-5 NULL: each tier seeds LAD<tier>_NULL (random-3, shuffled target) =
      the pipeline's own permuted floor; every survivor must beat it.

ESCALATION (encoded below, not hand-waved):
  tier N done -> rank combos by LATE-MEAN holdout-over-baseline; a diet seeds a
  tier only if it clears baseline by > SE_MULT*SE AND the tier's NULL floor. N+1 =
    * TIER 2: all pairs among the top TOP_BROAD singles PLUS each of the top
      TOP_SEED singles paired with every remaining channel (greedy-forward).
    * TIER >=3: every combo with POSITIVE SYNERGY extended by one more channel.
  SYNERGY(combo) = holdout(combo) - max(holdout over its 1-drop sub-combos);
  also reported vs additive expectation. Positive synergy -> spawns children.
  Cap ~CAP_PER_TIER runs/tier.
"""
import numpy as np, json, os, sys, time, glob, tempfile, itertools

GD   = r'C:\Users\Noah\claude-workspace\grok'
QF   = os.path.join(GD, 'experiments_queue.jsonl')
QLOCK= os.path.join(GD, 'experiments_queue.lock')        # shared cross-process queue mutex (same path as grok_queue._qlock)
SRC  = os.path.join(GD, 'research_specs_ladder.jsonl')   # my canonical source

class _qlock:
    """Best-effort cross-process lock for experiments_queue.jsonl read-modify-write —
    MUST use the same sentinel path as grok_queue._qlock so the runner's mark() and this
    seeder are mutually exclusive. Breaks a stale lock after `stale` s; on timeout it
    proceeds WITHOUT the lock (degrades to old behavior) so it can never deadlock."""
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
CHART= os.path.join(GD, 'grok_ladder_chart.png')
REP  = os.path.join(GD, 'grok_ladder_report.md')

# ---- channel universe (the 10 pruned raw channels + secleft-as-only-input) ----
CHANNELS = ['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol']
SECLEFT  = 'secleft'                     # special: inputs=[] , statics=["secleft"]
ALLCH    = CHANNELS + [SECLEFT]

# ---- grok regime (same as Mode C, wd 0.10) ----
EPOCHS = int(os.environ.get('LADDER_EPOCHS', 100000))
MODEL  = {"width":128, "wd":0.10, "epochs":EPOCHS, "lr":1e-3, "ls":0.1, "warmup":1000}
THR    = 2.0            # cents: |dmid@120s|>THR = event
HZ_S   = 120           # horizon seconds

# ---- escalation knobs ----
TOP_BROAD   = 5        # all pairs among the top-5 singles
TOP_SEED    = 3        # each top-3 single x every remaining channel (greedy-fwd)
CAP_PER_TIER= 28       # <= ~30 runs/tier (batched mode can lift this)

# ---- FARM-6: robust escalation currency (quantification_report FARM scorecard) ----
# The OLD currency was np.nanmax(holdout) over the whole 100k-epoch curve = a maximum
# over ~2000 correlated checkpoints => upward-biased, and ranking/synergy/tier-seeding
# on that biased max means greedy-forward chases eval noise. FIX: rank on a LATE-WINDOW
# MEAN of the holdout metric (post-memorization, last LATE_FRAC of logged epochs) and
# require it to beat the diet-appropriate baseline by > SE_MULT * SE before a diet can
# seed a tier. SE is the late window's own scatter, AR(1)-corrected for the checkpoint
# autocorrelation (see _ar1_se). The old max is kept as a REPORTED-BUT-NOT-RANKING
# column ("peak (biased)"); the peak-minus-late gap = the selection inflation.
LATE_FRAC = 0.20       # late window = last 20% of logged epochs (post-grok regime)
SE_MULT   = 2.0        # a diet must clear baseline (and the tier null) by > 2*SE to seed

# ---- DET-EV: detection->EV bridge (quantification_report DET-EV scorecard) ----
# Every survivor emits a BEST-CASE after-fee EV at its measured detection strength, so a
# real-but-competed detection is flagged DETECTED-NOT-TRADABLE BEFORE a study is spent.
# Simple translation (DET-2): detection strength -> best-case top-decile win-rate p
# (optimistically = the up/down AUC, an upper bound on any fixed-threshold tail win-rate)
# -> EV = p*payoff - (1-p)*loss - fee. Modeled as a symmetric best-case directional
# excursion capture EDGE_CAPTURE_C on a correct 120s call; fees are the cost wall
# (DET-1: ~3.4c taker / 1.4c maker; DET headline 3.5-7c taker). These are DELIBERATELY
# OPTIMISTIC (best-case) constants: if even this can't clear the taker wall the detection
# is economically dead regardless of statistical strength. The authoritative bridge is
# the grok tradability backtest (grok_report.md); this is the pre-study screen.
FEE_TAKER_C    = 3.5   # taker cost wall (cents/trade)
FEE_MAKER_C    = 1.4   # maker cost wall (cents/trade)
EDGE_CAPTURE_C = 12.0  # best-case cents captured by a correct 120s directional call (optimistic)

# ---- FARM-8: settle × quote-input mid-baseline comparator (quantification_report FARM-8) ----
# THE HOLE this closes: a settle-kind run whose inputs include a quote-family channel
# (mid / pf / ya-na-yb-nb) scores 0.81-0.996 holdout NOT because it learned anything, but
# because the mid AT DECISION TIME already IS the settle predictor (corr(mid_T-10,settle)
# ~0.99; on `final5` the target is a near-tautology of the input). The majority baseline is
# the WRONG comparator for these — the right one is the trivial rule "settle YES iff
# mid>0.5 at decision time". For any such spec we compute that MID-BASELINE on the SAME
# sample set + holdout days and RANK ON THE MARGIN (net - mid-baseline), labeled
# 'margin-over-mid'. A near-zero / negative margin = the net merely re-derived the mid.
QUOTE_INPUTS = frozenset(['mid', 'pf', 'ya', 'na', 'yb', 'nb'])
TAUT_THRESH  = 0.95    # any holdout headline > this => automatic TAUTOLOGY-CHECK tripwire
# baseline cache: keyed (kind, sample_set, HZ, thr). The settle label + (w,t) grid + the
# mid-at-decision series are INPUT-INDEPENDENT (inputs only change X, never the mask/target),
# so every settle-quote spec sharing that key shares ONE baseline -> harvest stays fast.
_MIDBASE_CACHE = {}

def _is_settle_quote(spec):
    """FARM-8 trigger: target.kind=='settle' AND inputs ∩ {mid,pf,ya,na,yb,nb} ≠ ∅."""
    if not spec: return False
    tg = spec.get('target') or {}
    if tg.get('kind') != 'settle': return False
    return bool(set(spec.get('inputs', [])) & QUOTE_INPUTS)

def _mid_baseline(spec):
    """FARM-8 baseline: accuracy/AUC of the rule 'settle YES iff mid>0.5 at decision time',
    scored on the SAME sample set + holdout days as the net. REUSES grok_queue.build_run for
    byte-identical sample construction (the mid channel + settle label + (w,t) grid all live
    in grok_data.npz). Cached per (kind, sample_set, HZ, thr) — input-independent, so one
    build serves every settle-quote spec sharing that key. Returns None if unavailable.

    Read-only: build_run is pure numpy (no GPU, no training); we force GROKQ_CPU so importing
    the runner module can NEVER spin up a CUDA context that contends with the live fleet."""
    tg = spec.get('target') or {}
    ss = spec.get('sample_set', 'all')
    os.environ.setdefault('GROKQ_CPU', '1')      # defensive: no CUDA ctx in the harvest proc
    try:
        import grok_queue as gq                  # lazy: loads grok_data.npz once, cached in sys.modules
    except Exception:
        return None
    HZ  = max(1, int(round(tg.get('horizon_s', 120) / gq.BIN_S)))
    thr = float(tg.get('thr', 2.0))
    key = (tg.get('kind'), ss, HZ, thr)
    if key in _MIDBASE_CACHE:
        return _MIDBASE_CACHE[key]
    # canonical minimal spec: same target/sample_set (=> identical mask/grid/label), default
    # statics so the raw mid-at-decision column is present, one cheap input to build fast.
    canon = {'id': '__midbase__', 'inputs': ['mid'], 'target': tg, 'sample_set': ss}
    try:
        run = gq.build_run(canon)
    except Exception:
        _MIDBASE_CACHE[key] = None; return None
    X, y, tr, K = run['X'], run['y'], run['tr_all'], run['K']
    present = [s for s in canon.get('statics', ['secleft', 'mid', 'dist'])
               if s in ('secleft', 'mid', 'dist')]
    if 'mid' not in present:
        _MIDBASE_CACHE[key] = None; return None
    mid_dec = X[:, K * gq.L + present.index('mid')]   # raw 0..1 mid at decision time (static col)
    ho = ~tr
    if not ho.any():
        _MIDBASE_CACHE[key] = None; return None
    acc = float(((mid_dec[ho] > 0.5).astype(int) == y[ho]).mean())
    au  = float(gq.auc(mid_dec[ho], y[ho].astype(int)))
    res = dict(acc=acc, auc=au, n_ho=int(ho.sum()), key=key)
    _MIDBASE_CACHE[key] = res
    return res

# ============================================================ spec construction
def _inputs_statics(diet):
    """diet = tuple of channel names. Returns (inputs, statics).
    secleft is a static-only coordinate, never a context channel."""
    inputs = [c for c in diet if c != SECLEFT]
    statics = ['secleft']                 # always the time-of-window coordinate
    return inputs, statics

def diet_tag(diet):
    return '+'.join(diet)

def make_specs(diet, tier, targets):
    """One diet -> one spec per target ('dir' 3-class, 'evc' event-vs-control)."""
    inputs, statics = _inputs_statics(diet)
    tag = diet_tag(diet)
    out = []
    for tg in targets:
        if tg == 'dir':
            target = {"kind":"dir", "horizon_s":HZ_S, "thr":THR}
            sid = f'LAD{tier}_{tag}_dir'
        elif tg == 'evc':
            target = {"kind":"bigmove", "horizon_s":HZ_S, "thr":THR}
            sid = f'LAD{tier}_{tag}_evc'
        else:
            raise ValueError(tg)
        out.append({
            "id": sid,
            "inputs": inputs,
            "statics": statics,
            "target": target,
            "sample_set": "event_matched",
            "model": dict(MODEL),
            "source": "ladder",
            "ladder": {"tier": tier, "diet": list(diet), "target": tg},
            "note": (f"ABLATION LADDER T{tier} diet=[{tag}] "
                     f"({'3-class dir' if tg=='dir' else 'event-vs-control'}) "
                     f"dmid@{HZ_S}s thr{THR}c, secleft-static only."),
        })
    return out

# ============================================================ queue io (idempotent)
def _read_jsonl(path):
    specs = []
    if not os.path.exists(path): return specs
    for ln in open(path, encoding='utf-8'):
        s = ln.strip()
        if not s: continue
        try: specs.append(json.loads(s))
        except Exception: pass
    return specs

def _atomic_write_jsonl(path, specs):
    fd, tmp = tempfile.mkstemp(dir=GD, suffix='.jsonl'); os.close(fd)
    with open(tmp, 'w', encoding='utf-8') as f:
        for s in specs: f.write(json.dumps(s, ensure_ascii=False)+'\n')
    # os.replace with Windows-lock retry: experiments_queue.jsonl is concurrently read/
    # rewritten by the runner (grok_queue.mark) and can be transiently locked by a reader;
    # a bare os.replace raises PermissionError(13) and ABORTS the harvest/seed mid-run.
    # Matches grok_queue._replace_retry (~6s). os.replace stays atomic so no partial file.
    for _ in range(25):
        try:
            os.replace(tmp, path); return
        except PermissionError:
            time.sleep(0.25)
    os.replace(tmp, path)

def seed_specs(specs):
    """Append specs (by id) to BOTH research_specs_ladder.jsonl (canonical) and
    experiments_queue.jsonl (the live farm). Idempotent: skips ids already
    present in each file; never rewrites/clobbers foreign lines in the queue."""
    # Under the shared queue lock: a concurrent grok_queue.mark() rewrite can't clobber
    # freshly-seeded specs, and our rewrite can't clobber a done-status it just wrote.
    with _qlock():
        # 1) canonical source
        src = _read_jsonl(SRC); have_src = {s.get('id') for s in src}
        add_src = [s for s in specs if s['id'] not in have_src]
        if add_src:
            _atomic_write_jsonl(SRC, src + add_src)
        # 2) live queue -- append missing only, atomic rewrite preserving all lines
        q = _read_jsonl(QF); have_q = {s.get('id') for s in q}
        add_q = [s for s in specs if s['id'] not in have_q]
        if add_q:
            _atomic_write_jsonl(QF, q + add_q)
        return len(add_q), len(add_src)

# ============================================================ stats harvest
def _ar1_se(vals):
    """AR(1)-corrected standard error of the MEAN of a late-window holdout series.
    The ~LATE_FRAC*n_epoch checkpoints are strongly autocorrelated (successive
    evals of a slowly-moving net), so the naive std/sqrt(n) UNDER-states the SE.
    Correct with the effective sample size under a lag-1 AR model:
        n_eff = n * (1 - r1) / (1 + r1),   SE = std(ddof=1) / sqrt(n_eff)
    r1 is clamped to [0, 0.99] (negative autocorr gets NO variance-reduction credit,
    i.e. we never claim MORE independence than the raw count). Returns nan if n<2."""
    x = np.asarray([v for v in vals if v == v], float)
    n = len(x)
    if n < 2: return float('nan')
    sd = float(x.std(ddof=1))
    if sd == 0.0: return 0.0
    xc = x - x.mean()
    denom = float((xc * xc).sum())
    r1 = float((xc[:-1] * xc[1:]).sum() / denom) if denom > 0 else 0.0
    r1 = min(max(r1, 0.0), 0.99)
    n_eff = n * (1.0 - r1) / (1.0 + r1)
    n_eff = min(max(n_eff, 1.0), float(n))
    return sd / np.sqrt(n_eff)

def _ev_bridge(hob, late_aucUD):
    """DET-EV best-case after-fee EV bridge, computed at detection time.
    strength -> best-case top-decile win-rate p (optimistically the up/down AUC, an
    upper bound on a fixed-threshold tail win-rate) -> EV = (2p-1)*EDGE_CAPTURE_C - fee
    (symmetric best-case directional-excursion model). Returns taker/maker EV + a state
    label; DETECTED-NOT-TRADABLE = even this optimistic EV can't clear the taker wall."""
    p = late_aucUD
    if p is None or p != p:
        p = 0.5 + max(0.0, hob if (hob is not None and hob == hob) else 0.0)
    p = min(max(float(p), 0.0), 1.0)
    gross = (2.0 * p - 1.0) * EDGE_CAPTURE_C
    ev_taker = gross - FEE_TAKER_C
    ev_maker = gross - FEE_MAKER_C
    if   ev_taker > 0: state = 'TRADABLE-CANDIDATE'
    elif ev_maker > 0: state = 'MAKER-ONLY'
    else:              state = 'DETECTED-NOT-TRADABLE'
    return dict(p_best=p, gross=gross, ev_taker=ev_taker, ev_maker=ev_maker, ev_state=state)

def _run_stats(sid, spec=None):
    """Read progress_<sid>.json -> robust ladder stats. None if not started.

    FARM-6: the RANKING currency `hob` is now the LATE-WINDOW-MEAN holdout-over-baseline
    (mean over the last LATE_FRAC of logged epochs), NOT the curve max. The old
    np.nanmax is kept as `peak_hob` ("peak (biased)"); `sel_inflation` = peak - late.
    `hob_se` is the AR(1)-corrected SE of the late window; `passes_2se` = late edge
    clears baseline by > SE_MULT*SE. FARM-1/2: dir(maj<0.55) headlines acc-edge; any
    imbalanced/binary target headlines AUC-0.5. DET-EV fields via _ev_bridge.

    FARM-8: when `spec` is supplied AND it is a settle-kind run with a quote-family input
    (mid/pf/ya/na/yb/nb), the baseline is NOT 0.5/majority — it is the trivial mid>0.5 rule
    (`_mid_baseline`) on the SAME sample set + holdout days. `hob` becomes the MARGIN-OVER-MID
    (net headline − mid-baseline), the EV bridge is fed that margin, and mid_base_* /
    margin_over_mid fields are returned. Independently, ANY run whose peak holdout headline
    exceeds TAUT_THRESH (0.95) gets `tautology=True` — a 'target is recoverable from the
    inputs, check before celebrating' tripwire (nothing on this market is 95%+ predictable OOS)."""
    p = os.path.join(GD, f'progress_{sid}.json')
    if not os.path.exists(p): return None
    try: d = json.load(open(p))
    except Exception: return None
    curves = d.get('curves', [])
    if not curves: return None
    # head: prefer the trainer-written field; D-fleet files store head=None so infer
    # from the target name (dir/mag/dirshuf/magbin -> 3-class; else binary).
    head = d.get('head')
    if not head:
        tgt = str(d.get('target', ''))
        head = 'cls3' if tgt in ('dir', 'mag', 'magbin', 'dirshuf') else 'bin'
    base = None
    nc = d.get('nc_ho')
    if isinstance(nc, list) and nc: base = float(nc[0])
    eps   = [r.get('epoch', 0) for r in curves]
    acctr = [r.get('acc_tr', float('nan')) for r in curves]
    accho = [r.get('acc_ho', float('nan')) for r in curves]
    aucho = [r.get('aucUD_ho', float('nan')) for r in curves]   # =AUC for binary; up/down AUC for dir
    ceiling = float(np.nanmax(acctr)) if acctr else float('nan')
    # ---- peak (biased) = the OLD max-over-curve, reported but NOT ranked on ----
    peak_accho = float(np.nanmax(accho)) if accho else float('nan')
    peak_aucho = float(np.nanmax(aucho)) if aucho else float('nan')
    # ---- late window: last LATE_FRAC of logged epochs (post-memorization) ----
    max_ep = max(eps) if eps else 0
    cut = (1.0 - LATE_FRAC) * max_ep
    late = [r for r in curves if r.get('epoch', 0) >= cut] or curves[-1:]
    late_accho = float(np.nanmean([r.get('acc_ho', float('nan')) for r in late]))
    late_aucho = float(np.nanmean([r.get('aucUD_ho', float('nan')) for r in late]))
    majority = base if base is not None else (1/3.0 if head == 'cls3' else 0.5)
    # FARM-1/2 headline: raw acc is BANNED whenever majority>0.55 -> AUC is the meter.
    if head == 'cls3' and majority <= 0.55:
        primary = 'acc'
        late_metric, peak_metric, late_series = late_accho, peak_accho, [r.get('acc_ho') for r in late]
        hob      = late_metric - majority
        peak_hob = peak_metric - majority
    else:
        primary = 'auc'
        late_metric, peak_metric, late_series = late_aucho, peak_aucho, [r.get('aucUD_ho') for r in late]
        hob      = late_metric - 0.5
        peak_hob = peak_metric - 0.5
    hob_se = _ar1_se(late_series)
    # ---- FARM-8: settle × quote-input => rank on the MARGIN over the mid>0.5 baseline ----
    is_settle_quote = _is_settle_quote(spec)
    mid_base_acc = mid_base_auc = mid_base_nho = margin_over_mid = None
    if is_settle_quote:
        mb = _mid_baseline(spec)
        if mb is not None:
            mid_base_acc, mid_base_auc, mid_base_nho = mb['acc'], mb['auc'], mb['n_ho']
            base_metric   = mid_base_auc if primary == 'auc' else mid_base_acc
            margin_over_mid = late_metric - base_metric
            hob      = margin_over_mid                 # ranking currency becomes margin-over-mid
            peak_hob = peak_metric - base_metric
    passes_2se = bool(hob == hob and hob_se == hob_se and hob > SE_MULT * hob_se)
    sel_inflation = (peak_hob - hob) if (peak_hob == peak_hob and hob == hob) else float('nan')
    # ---- FARM-8 tautology tripwire: peak holdout headline > 0.95 on ANY target ----
    tautology = bool(peak_metric == peak_metric and peak_metric > TAUT_THRESH)
    # SICK: by ~20k epochs, train acc should be within 95% of its ceiling
    sick = False; reached20k = (max_ep >= 20000)
    if reached20k and ceiling == ceiling and ceiling > 0:
        near = min(curves, key=lambda r: abs(r.get('epoch', 0) - 20000))
        sick = (near.get('acc_tr', 0.0) < 0.95 * ceiling)
    # EV bridge: settle-quote feeds the MARGIN (edge OVER the mid rule), not the raw AUC —
    # a real detection here must beat the mid the market already prices, else EV is a mirage.
    if is_settle_quote and margin_over_mid is not None:
        ev = _ev_bridge(margin_over_mid, 0.5 + margin_over_mid)
    else:
        ev = _ev_bridge(hob, late_aucho)   # late up/down AUC as the best-case win-rate proxy
    return dict(sid=sid, head=head, ceiling=ceiling, base=base, majority=majority,
                primary=primary, hob=hob, hob_se=hob_se, passes_2se=passes_2se,
                peak_hob=peak_hob, sel_inflation=sel_inflation,
                late_accho=late_accho, late_aucho=late_aucho,
                peak_accho=peak_accho, peak_aucho=peak_aucho,
                is_settle_quote=bool(is_settle_quote), tautology=tautology,
                mid_base_acc=mid_base_acc, mid_base_auc=mid_base_auc,
                mid_base_nho=mid_base_nho, margin_over_mid=margin_over_mid,
                max_epoch=max_ep, sick=bool(sick), reached20k=bool(reached20k),
                n_curve=len(curves), n_late=len(late), **ev)

def _queue_status(sid):
    for s in _read_jsonl(QF):
        if s.get('id') == sid: return s.get('status')
    return None

NULL_KEY = ('__NULL__',)   # sentinel diet-key for a tier's FARM-5 shuffled-target null

# ---- gather all ladder specs currently in the canonical source, by tier/diet ----
def _ladder_index():
    """Return {tier: {diet_tuple: {'dir':stats|None,'evc':stats|None}}}.
    FARM-5: a tier's shuffled-target NULL run (ladder.null=True, id LAD<tier>_NULL) is
    routed to the sentinel diet-key NULL_KEY so it is READ as the tier's permuted floor
    but never iterated as a real diet (never ranked / paired / escalated)."""
    idx = {}
    for s in _read_jsonl(SRC):
        lad = s.get('ladder')
        if not lad: continue
        tier = lad['tier']; tg = lad['target']
        diet = NULL_KEY if lad.get('null') else tuple(lad['diet'])
        node = idx.setdefault(tier, {}).setdefault(diet, {'dir': None, 'evc': None})
        st = _run_stats(s['id'], s)      # pass the spec: enables the FARM-8 settle-quote check
        node[tg] = st
        node.setdefault('_status', {})[tg] = _queue_status(s['id'])
    return idx

def _real_diets(tier_map):
    """Iterate a tier's real diets, skipping the FARM-5 null sentinel."""
    return {d: n for d, n in tier_map.items() if d != NULL_KEY}

def _diet_hob(node):
    """Holdout-over-baseline (late-window-mean, FARM-6) for a diet node; prefer dir."""
    if node.get('dir') and node['dir']['hob'] == node['dir']['hob']:
        return node['dir']['hob']
    if node.get('evc') and node['evc']['hob'] == node['evc']['hob']:
        return node['evc']['hob']
    return None

def _diet_se(node):
    """AR(1)-corrected SE of the diet's ranking metric (matches _diet_hob's target)."""
    if node.get('dir') and node['dir']['hob'] == node['dir']['hob']:
        return node['dir'].get('hob_se')
    if node.get('evc') and node['evc']['hob'] == node['evc']['hob']:
        return node['evc'].get('hob_se')
    return None

def _tier_null_floor(idx, tier):
    """FARM-5 permuted floor for a tier = its LAD<tier>_NULL late-mean hob, or None."""
    node = idx.get(tier, {}).get(NULL_KEY)
    if not node: return None
    return _diet_hob(node)

def _diet_passes(idx, tier, node):
    """FARM-6 + FARM-5 escalation gate: a diet may seed the next tier only if its
    late-window-mean edge clears the diet-appropriate baseline by > SE_MULT*SE AND
    (when the tier's null has finished) also clears the permuted null floor."""
    h = _diet_hob(node)
    if h is None or h != h: return False
    st = node.get('dir') or node.get('evc')
    if not (st and st.get('passes_2se')): return False
    floor = _tier_null_floor(idx, tier)
    if floor is not None and floor == floor and h <= floor: return False
    return True

def _spec_done(sid):
    """A ladder run is finished when the queue marked it done/error, OR its
    progress curve reached (near) the epoch budget."""
    stt = _queue_status(sid)
    if stt in ('done', 'error'): return True
    st = _run_stats(sid)
    return bool(st and st['max_epoch'] >= EPOCHS - EPOCHS//50 - 1)

def _tier_specs_ids(tier):
    return [s['id'] for s in _read_jsonl(SRC)
            if s.get('ladder', {}).get('tier') == tier]

def _tier_complete(idx, tier):
    """Complete only when the tier has specs AND every one is finished. An
    unstarted tier (no progress yet) is NOT complete."""
    ids = _tier_specs_ids(tier)
    if not ids: return False
    return all(_spec_done(sid) for sid in ids)

# ============================================================ tier generation
def make_null_spec(tier):
    """FARM-5: one shuffled-target NULL per tier (LAD<tier>_NULL) = the pipeline's own
    permuted false-positive floor (the queue/ladder analog of the D-fleet's D10).
    A deterministic random 3-channel diet with SHUFFLED labels, same regime/statics.

    NOTE ON THE SHUFFLE (honest, load-bearing): the queue runner (grok_queue.build_run)
    is currently NOT touched — it honors the spec `statics` field but does not yet honor
    a `target.shuffle` flag, so as-run this seeds a RANDOM-DIET floor (real labels, three
    arbitrary channels) rather than a true label-permutation null. The spec carries
    target.shuffle=true so that adding one line to build_run
    (`if tg.get('shuffle'): y = _permute_within_split(y)`) upgrades it to a true
    permutation floor WITH NO SPEC CHANGE. This mirrors how the ladder already depends on
    the back-compatibly-added `statics` field. The harvest reads whatever LAD<tier>_NULL
    produces as that tier's floor and labels it accordingly."""
    rng = np.random.default_rng(1010 + tier)
    diet = tuple(sorted(rng.choice(CHANNELS, size=3, replace=False).tolist()))
    inputs, statics = _inputs_statics(diet)
    return {
        "id": f'LAD{tier}_NULL',
        "inputs": inputs,
        "statics": statics,
        "target": {"kind": "dir", "horizon_s": HZ_S, "thr": THR, "shuffle": True},
        "sample_set": "event_matched",
        "model": dict(MODEL),
        "source": "ladder",
        "ladder": {"tier": tier, "diet": list(diet), "target": "dir", "null": True},
        "note": (f"ABLATION LADDER T{tier} NULL (FARM-5 permuted floor): random 3-ch "
                 f"diet=[{diet_tag(diet)}], shuffled labels, secleft-static only. Every "
                 f"tier-{tier} survivor must beat this floor. (needs runner shuffle "
                 f"support for a TRUE permutation null; see make_null_spec.)"),
    }

def tier1_specs():
    specs = []
    for ch in ALLCH:
        specs += make_specs((ch,), 1, ['dir','evc'])
    specs.append(make_null_spec(1))            # FARM-5: seed tier-1's permuted floor
    return specs

def tier2_specs(idx):
    singles = _real_diets(idx.get(1, {}))      # exclude the FARM-5 null sentinel
    scored = []
    for diet, node in singles.items():
        h = _diet_hob(node)
        if h is None: continue
        # FARM-6/FARM-5 gate: only diets that clear baseline by >2*SE (and the null
        # floor, when finished) are eligible to seed a tier. Screened-out singles are
        # still RANKED for the report, but do not spawn pairs.
        scored.append((diet[0], h, _diet_passes(idx, 1, node)))
    scored.sort(key=lambda x: (-(x[1] if x[1]==x[1] else -9), x[0]))
    ranked = [c for c,_,_ in scored]
    eligible = [c for c,_,ok in scored if ok]
    top_broad = eligible[:TOP_BROAD]
    top_seed  = eligible[:TOP_SEED]
    pairs = set()
    for a,b in itertools.combinations(top_broad, 2):
        pairs.add(tuple(sorted((a,b))))
    for a in top_seed:
        for b in ALLCH:
            if b == a: continue
            pairs.add(tuple(sorted((a,b))))
    pairs = list(pairs)[:CAP_PER_TIER]
    specs = []
    for pr in pairs:
        specs += make_specs(pr, 2, ['dir'])     # combos: dir target (predict price)
    if specs:
        specs.append(make_null_spec(2))         # FARM-5: seed tier-2's own null floor
    return specs, ranked

def _subcombos(diet):
    """all 1-drop sub-diets."""
    return [tuple(d for j,d in enumerate(diet) if j != i) for i in range(len(diet))]

def synergy_of(idx, diet):
    """holdout(diet) - max(holdout over 1-drop sub-diets). None if data missing."""
    tier = len(diet)
    node = idx.get(tier, {}).get(diet)
    if not node: return None
    h = _diet_hob(node)
    if h is None: return None
    subs = []
    for sub in _subcombos(diet):
        sn = idx.get(len(sub), {}).get(sub)
        if sn:
            sh = _diet_hob(sn)
            if sh is not None: subs.append(sh)
    if not subs: return None
    best_sub = max(subs)
    return dict(hob=h, best_sub=best_sub, synergy=h-best_sub,
                additive=h-sum(subs))   # crude additive-expectation delta

def next_tier_specs(idx):
    """From the highest COMPLETE tier, build the next tier (encoded escalation)."""
    tiers = sorted(idx.keys())
    if not tiers:
        return tier1_specs(), 1, "seed tier 1"
    top = max(tiers)
    if not _tier_complete(idx, top):
        return [], top, f"tier {top} still running"
    if top == 1:
        specs, ranked = tier2_specs(idx)
        return specs, 2, f"tier2 from singles rank {ranked[:TOP_BROAD]}"
    # tier >=3: extend every POSITIVE-SYNERGY combo (FARM-6-gated) by one channel
    parents = []
    for diet, node in _real_diets(idx[top]).items():   # skip the FARM-5 null sentinel
        syn = synergy_of(idx, diet)
        # FARM-6/FARM-5: parent must have positive synergy AND clear the >2*SE + null
        # gate itself, else greedy-forward spawns children off eval noise.
        if syn and syn['synergy'] > 0 and _diet_passes(idx, top, node):
            parents.append((diet, syn['synergy']))
    parents.sort(key=lambda x: -x[1])
    children = set()
    for diet, _ in parents:
        for c in ALLCH:
            if c in diet: continue
            children.add(tuple(sorted(diet + (c,))))
    children = list(children)[:CAP_PER_TIER]
    specs = []
    for d in children:
        specs += make_specs(d, top+1, ['dir'])
    if specs:
        specs.append(make_null_spec(top+1))            # FARM-5: seed the new tier's null
    return specs, top+1, f"tier{top+1} from {len(parents)} positive-synergy parents (>2*SE + null-gated)"

# ============================================================ chart + report
def _diet_row(idx, tier, diet, node):
    """Assemble one report row (dict) for a real diet, with the FARM-6 late-mean
    ranking currency, the peak(biased) column, and the DET-EV bridge."""
    st = node.get('dir') or node.get('evc')
    h = _diet_hob(node); se = _diet_se(node)
    cel = None; sick = False
    for tg in ('dir', 'evc'):
        s = node.get(tg)
        if s:
            cel = s['ceiling'] if cel is None else max(cel, s['ceiling'])
            sick = sick or s['sick']
    syn = synergy_of(idx, diet) if tier >= 2 else None
    return dict(label=diet_tag(diet), tier=tier, ceiling=cel, hob=h, hob_se=se,
                peak_hob=(st['peak_hob'] if st else None),
                sel_inflation=(st['sel_inflation'] if st else None),
                majority=(st['majority'] if st else None),
                primary=(st['primary'] if st else None),
                late_auc=(st['late_aucho'] if st else None),
                passes=_diet_passes(idx, tier, node),
                ev_taker=(st['ev_taker'] if st else None),
                ev_maker=(st['ev_maker'] if st else None),
                ev_state=(st['ev_state'] if st else None),
                tautology=(st['tautology'] if st else False),
                margin_over_mid=(st['margin_over_mid'] if st else None),
                synergy=(syn['synergy'] if syn else None), sick=sick)

def render(idx):
    rows = []
    for tier in sorted(idx.keys()):
        entries = [_diet_row(idx, tier, diet, node)
                   for diet, node in _real_diets(idx[tier]).items()]
        entries.sort(key=lambda e: -(e['hob'] if (e['hob'] is not None and e['hob']==e['hob']) else -9))
        rows += entries
    _chart(rows); _report(rows, idx)
    return rows

def _chart(rows):
    try:
        import matplotlib; matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except Exception as e:
        print('matplotlib unavailable, skipping chart:', e); return
    if not rows:
        print('no ladder rows yet, skipping chart'); return
    n = len(rows)
    labels = [f"T{r['tier']} {r['label']}" for r in rows]
    cel = np.array([[r['ceiling'] if r['ceiling'] is not None else np.nan] for r in rows])
    hob = np.array([[r['hob'] if r['hob'] is not None else np.nan] for r in rows])
    syn = np.array([[r['synergy'] if r['synergy'] is not None else np.nan] for r in rows])
    fig, axs = plt.subplots(1, 3, figsize=(11, max(3, 0.32*n+1.5)), sharey=True)
    for ax, mat, title, cmap, ctr in [
        (axs[0], cel, 'memorization\nceiling (train acc)', 'viridis', None),
        (axs[1], hob, 'holdout>base\n(LATE-window mean)', 'RdBu_r', 0.0),
        (axs[2], syn, 'synergy\n(vs best sub-diet)', 'PiYG', 0.0)]:
        if ctr is not None:
            vmax = np.nanmax(np.abs(mat)) if np.isfinite(mat).any() else 1
            vmax = vmax if vmax and vmax==vmax and vmax>0 else 0.05
            im = ax.imshow(mat, aspect='auto', cmap=cmap, vmin=-vmax, vmax=vmax)
        else:
            im = ax.imshow(mat, aspect='auto', cmap=cmap)
        ax.set_title(title, fontsize=9)
        ax.set_xticks([])
        fig.colorbar(im, ax=ax, fraction=0.05, pad=0.02)
        for i in range(n):
            v = mat[i,0]
            if v==v: ax.text(0, i, f'{v:+.3f}' if ctr is not None else f'{v:.3f}',
                             ha='center', va='center', fontsize=6,
                             color='white' if ctr is None else 'black')
    axs[0].set_yticks(range(n)); axs[0].set_yticklabels(labels, fontsize=6)
    fig.suptitle('GROK ABLATION LADDER — which data predicts the price (FARM-6 late-mean)', fontsize=11)
    fig.tight_layout(rect=[0,0,1,0.97])
    fig.savefig(CHART, dpi=120); plt.close(fig)
    print('wrote', CHART)

def _all_specs():
    """Every spec the harvest can see, by id (live queue ∪ canonical ladder source ∪ the
    research source files). Queue status wins. Used by the FARM-8 scorecard, which spans
    the WHOLE farm (not just ladder tiers) — settle-quote specs live in the main queue."""
    by_id = {}
    for path in (SRC, QF,
                 os.path.join(GD, 'research_specs_deferred.jsonl'),
                 os.path.join(GD, 'research_specs_ladder.jsonl')):
        for s in _read_jsonl(path):
            sid = s.get('id')
            if sid: by_id[sid] = s          # later files (queue) override — carry live status
    return by_id

def _farm8_scorecard(f):
    """FARM-8 section: every settle-kind run with a quote-family input (mid/pf/ya/na/yb/nb),
    scored against the trivial mid>0.5 baseline on the SAME sample set + holdout days, ranked
    by MARGIN-OVER-MID. A near-zero / negative margin = the net just re-derived the mid the
    market already prices (the '0.99 holdout' was the target being recoverable from the input,
    not a detection). ⚠TAUT = peak holdout headline > 0.95 (recoverable-target tripwire)."""
    specs = [s for s in _all_specs().values() if _is_settle_quote(s)]
    out = ['', '## FARM-8 — settle × quote-input: mid-baseline comparator', '',
           'Settle runs whose inputs include a quote-family channel (mid/pf/ya/na/yb/nb). The',
           'majority baseline is the WRONG comparator: the mid AT DECISION TIME already *is*',
           'the settle predictor. Baseline below = the trivial **settle YES iff mid>0.5**, on',
           'the SAME sample set + holdout days. **margin-over-mid = net headline − mid-base**',
           'is the real number (ranking currency for these rows); ≤0 = no detection beyond the',
           'mid. ⚠TAUT = a holdout checkpoint exceeded 0.95 (target recoverable from inputs).', '']
    if not specs:
        out.append('_No settle × quote-input specs present._'); return out
    out += ['| spec | sample_set | quote-inputs | net AUC(late) | mid-base AUC | **margin(AUC)** | '
            'net acc(late) | mid-base acc | margin(acc) | n_ho | ⚠ | EV state |',
            '|---|---|---|---|---|---|---|---|---|---|---|---|']
    scored = []
    for s in specs:
        sid = s['id']; st = _run_stats(sid, s)
        if st is None:
            out.append(f'| {sid} | {s.get("sample_set","all")} | '
                       f'{",".join(sorted(set(s.get("inputs",[])) & QUOTE_INPUTS))} | '
                       '· | · | · | · | · | · | · | (not started) | · |')
            continue
        m_auc = (st['late_aucho'] - st['mid_base_auc']) if st['mid_base_auc'] is not None else None
        m_acc = (st['late_accho'] - st['mid_base_acc']) if st['mid_base_acc'] is not None else None
        scored.append((m_auc if m_auc is not None else -9, sid, s, st, m_auc, m_acc))
    for _, sid, s, st, m_auc, m_acc in sorted(scored, key=lambda x: -x[0]):
        qin = ",".join(sorted(set(s.get("inputs", [])) & QUOTE_INPUTS))
        out.append(
            f"| {sid} | {s.get('sample_set','all')} | {qin} | "
            f"{f(st['late_aucho'],'{:.3f}')} | {f(st['mid_base_auc'],'{:.3f}')} | "
            f"**{f(m_auc)}** | {f(st['late_accho'],'{:.3f}')} | {f(st['mid_base_acc'],'{:.3f}')} | "
            f"{f(m_acc)} | {st['mid_base_nho'] if st['mid_base_nho'] is not None else '·'} | "
            f"{'⚠TAUT' if st['tautology'] else ''} | {st['ev_state'] or '·'} |")
    out += ['', '_Reading: the raw settle holdout AUC (0.89–0.99) is almost entirely the mid; '
            'the margin over the mid>0.5 rule is ~0 or NEGATIVE, i.e. the net adds nothing '
            'the market has not already priced. These are NOT detections — do not rank them '
            'beside dir/evc runs on raw holdout._']
    return out

def _report(rows, idx):
    def f(x, s='{:+.3f}'):
        return s.format(x) if (x is not None and x == x) else '·'
    lines = ['# GROK ABLATION LADDER — report', '',
             f'_generated {time.strftime("%Y-%m-%d %H:%M:%S")}_', '',
             'Which raw stream (and which diet) lets a tiny grok-MLP predict the Kalshi',
             'price. **Escalation currency = the LATE-WINDOW MEAN** of the holdout metric',
             f'(last {int(LATE_FRAC*100)}% of epochs, post-memorization) — NOT the '
             'curve-max, which is upward-biased over ~2000 correlated checkpoints (FARM-6).',
             '',
             '**Headline metric (FARM-1/2):** AUC−0.5 whenever the majority baseline > 0.55',
             '(raw accuracy is BANNED there — it flatters a below-majority classifier); dir',
             '(majority 0.385) headlines acc−majority. The **majority baseline is printed',
             'per row.** A diet may seed the next tier only if its late-mean edge clears the',
             f'baseline by > {SE_MULT:g}·SE (AR(1)-corrected) **and** the tier\'s permuted',
             'NULL floor (FARM-5). **peak(biased)** = the old curve-max edge; **infl** =',
             'peak−late = the selection inflation. **best-EV** = DET-EV best-case after-fee',
             'cents/trade (taker/maker) at the detected strength vs the ~3.5c taker / 1.4c',
             'maker cost wall; **DETECTED-NOT-TRADABLE** = even the optimistic EV can\'t',
             'clear the taker wall (real detection, economically competed — route to',
             'composition/veto, NOT an entry edge). SICK = train never reached 95% of its',
             'ceiling by 20k ep (broken run, uninterpretable — not a clean negative).',
             '',
             '| tier | diet | ceil | maj-base | hob (late) | ±2·SE | pass | peak(biased) | infl | AUC(late) | best-EV tk/mk | EV state | syn | taut | sick |',
             '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for r in rows:
        twose = (2*r['hob_se']) if (r['hob_se'] is not None and r['hob_se']==r['hob_se']) else None
        ev = ('·' if r['ev_taker'] is None else f"{r['ev_taker']:+.1f}/{r['ev_maker']:+.1f}")
        lines.append(
            f"| {r['tier']} | {r['label']} | {f(r['ceiling'],'{:.3f}')} | "
            f"{f(r['majority'],'{:.3f}')} | {f(r['hob'])} | {f(twose,'{:.3f}')} | "
            f"{'✓' if r['passes'] else '·'} | {f(r['peak_hob'])} | "
            f"{f(r['sel_inflation'])} | {f(r['late_auc'],'{:.3f}')} | {ev} | "
            f"{r['ev_state'] or '·'} | {f(r['synergy'])} | "
            f"{'⚠TAUT' if r.get('tautology') else ''} | {'⚠' if r['sick'] else ''} |")
    lines += _farm8_scorecard(f)
    # ---- FARM-5 null floors per tier ----
    lines += ['', '## FARM-5 permuted NULL floors (per tier)', '',
              '| tier | LAD<t>_NULL | status | null floor (late hob) |',
              '|---|---|---|---|']
    for tier in sorted(idx.keys()):
        node = idx[tier].get(NULL_KEY)
        sid = f'LAD{tier}_NULL'
        if node is None:
            lines.append(f'| {tier} | {sid} | not seeded | · |')
        else:
            floor = _tier_null_floor(idx, tier)
            stt = (node.get('_status', {}) or {}).get('dir') or 'pending'
            done = _spec_done(sid)
            lines.append(f"| {tier} | {sid} | {'done' if done else (stt or 'pending')} | "
                         f"{f(floor)} |")
    lines += ['', '_The NULL is a random-3-channel, shuffled-target run — the pipeline\'s '
              'own false-positive floor (the queue/ladder analog of the D-fleet D10). '
              'Until the runner honors `target.shuffle` it runs as a random-diet floor '
              '(see make_null_spec); every tier survivor must still beat it._']
    # escalation state
    _, nt, why = next_tier_specs(idx)
    lines += ['', f'**Next tier:** {why}', '',
              'Escalation (grok_ladder.py): rank singles by the **late-window-mean** '
              f'holdout-over-baseline; a diet seeds a tier only if it clears baseline by '
              f'> {SE_MULT:g}·SE **and** the tier null (FARM-6/FARM-5). '
              f'tier2 = all pairs among the top-{TOP_BROAD} ELIGIBLE singles + '
              f'top-{TOP_SEED}×rest; tier≥3 = every positive-synergy, gate-passing combo '
              f'extended by one channel; cap {CAP_PER_TIER}/tier. '
              'Run `python grok_ladder.py --harvest` when a tier finishes.']
    open(REP,'w',encoding='utf-8').write('\n'.join(lines))
    print('wrote', REP)

# ============================================================ modes
def do_seed():
    specs = tier1_specs()
    aq, asrc = seed_specs(specs)
    print(f'TIER 1 seeded: {len(specs)} specs ({len(ALLCH)} channels × 2 targets); '
          f'+{aq} new to queue, +{asrc} to canonical source.')
    for s in specs: print('  ', s['id'])

def do_harvest():
    idx = _ladder_index()
    render(idx)
    specs, nt, why = next_tier_specs(idx)
    if specs:
        aq, asrc = seed_specs(specs)
        print(f'HARVEST -> {why}: seeded {len(specs)} specs (+{aq} queue, +{asrc} src).')
    else:
        print(f'HARVEST -> {why}: no new specs seeded (chart+report refreshed).')

def do_score(ids):
    """FARM-8 sanity/inspection: score given spec ids against the mid>0.5 baseline and print
    net / mid-baseline / margin-over-mid (+ tautology). Read-only; touches nothing running."""
    by_id = _all_specs()
    print('FARM-8 mid-baseline scoring (net vs "settle YES iff mid>0.5", holdout days):')
    for sid in ids:
        s = by_id.get(sid)
        if s is None:
            print(f'  {sid}: spec not found in queue/source'); continue
        if not _is_settle_quote(s):
            print(f'  {sid}: NOT settle×quote (kind={ (s.get("target") or {}).get("kind") }, '
                  f'inputs∩quote={sorted(set(s.get("inputs",[])) & QUOTE_INPUTS)}) — no mid-baseline'); continue
        st = _run_stats(sid, s)
        if st is None:
            print(f'  {sid}: no progress yet'); continue
        m_auc = st['late_aucho'] - st['mid_base_auc'] if st['mid_base_auc'] is not None else float('nan')
        m_acc = st['late_accho'] - st['mid_base_acc'] if st['mid_base_acc'] is not None else float('nan')
        print(f"  {sid:<20s} ss={s.get('sample_set','all'):<6s} "
              f"net AUC={st['late_aucho']:.4f} mid-base AUC={st['mid_base_auc']:.4f} "
              f"margin(AUC)={m_auc:+.4f} | net acc={st['late_accho']:.4f} "
              f"mid-base acc={st['mid_base_acc']:.4f} margin(acc)={m_acc:+.4f} "
              f"| n_ho={st['mid_base_nho']} {'⚠TAUT' if st['tautology'] else ''}")

def do_watch():
    print('watch: polling for tier completion (cheap, no GPU). Ctrl-C / delete to stop.')
    last = None
    while True:
        idx = _ladder_index()
        specs, nt, why = next_tier_specs(idx)
        render(idx)
        if specs:
            aq, asrc = seed_specs(specs)
            print(time.strftime('%H:%M:%S'), f'{why}: +{aq} queue / +{asrc} src')
        else:
            if why != last: print(time.strftime('%H:%M:%S'), why)
        last = why
        time.sleep(300)

if __name__ == '__main__':
    try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')   # Windows console is cp1252; ⚠/✓ need utf-8
    except Exception: pass
    mode = sys.argv[1] if len(sys.argv) > 1 else '--seed'
    if   mode == '--seed':    do_seed()
    elif mode == '--harvest': do_harvest()
    elif mode == '--watch':   do_watch()
    elif mode == '--report':  render(_ladder_index())
    elif mode == '--score':   do_score(sys.argv[2:] or ['RP4','RP13','L07_favgate_settle','L09_final5_settle'])
    else: print(__doc__)
