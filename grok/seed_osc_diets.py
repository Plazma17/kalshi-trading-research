#!/usr/bin/env python3
"""seed_osc_diets.py -- append the OSCILLATION/RANGE/LOCKOUT guard diets to
experiments_queue.jsonl under the _qlock convention (append-only, idempotent).

Noah's directive (2026-07-03): HEAVY WORK on predicting oscillation -- the guard for
the whole both-sides bot fleet. Four new build_run targets (rangeR / nolock / bothfill35
/ seqcomplete), all direction-free forward-from-t labels (no leak). See grok_queue.build_run.

SAFETY: every spec here uses ONLY cs_* composite channels, so grok_queue._spec_channels_ready
returns False until the pending2 swap+restart -> the runner leaves them PENDING and can never
run them under the OLD (pre-restart) build_run that lacks these kinds. The pure-raw
full-pruned-10ch comparators CANNOT be channel-gated, so they are staged separately in
osc_pruned_POST_RESTART.jsonl for append immediately AFTER the swap-restart (new build_run present).
"""
import os, json, time
GD = r'C:\Users\Noah\claude-workspace\grok'
QF = os.path.join(GD, 'experiments_queue.jsonl')
QLOCK = os.path.join(GD, 'experiments_queue.lock')

GEO  = ['cs_absm50_sqrtsec','cs_coil60','cs_coil120','cs_dd_extreme']       # |mid-.5|*sqrt(sec), coil, drawdown
VOLE = ['cs_rvratio_30_300','cs_volofvol','cs_signed_tvol']                 # rv-ratio, vol-of-vol, tvol(signed)
NULLD= ['cs_coil60','cs_volofvol','cs_dd_extreme','cs_rvratio_30_300']      # scattered = random-diet floor
MODEL = {"width":128,"wd":0.1,"epochs":120000,"lr":1e-3,"ls":0.1,"warmup":1000}
SRC = "osc-guard"
# engineered baselines to beat (per Noah): magnitude/range family ~.83-.85 (our strongest,
# direction-free); osc-logit both-fill ~.68-.74; trivial rule = |mid-0.5| + trailing-rv.
BASE = {'rangeR':'range/magnitude family ~.83-.85 vs |mid-.5|+trailing-rv',
        'nolock':'NOT-lockout naked-leg avoidance; beat |mid-.5|+rv',
        'bothfill35':'osc-logit both-legs-fill@0.35 baseline-to-beat ~.68-.74',
        'seqcomplete':'seq-lockin economic label (the thing that pays); beat |mid-.5|+rv'}

def spec(sid, inputs, kind, note, ss='all', horizon=120, extra=None):
    tg = {"kind":kind,"horizon_s":horizon,"thr":2.0}
    if extra: tg.update(extra)
    return {"id":sid,"inputs":inputs,"statics":["secleft"],"target":tg,"sample_set":ss,
            "model":dict(MODEL),"source":SRC,"needs_pending2":True,"note":note}

SPECS = []
for dname, inp in [('geoC', GEO), ('volE', VOLE)]:
    for kind in ['rangeR','nolock','bothfill35','seqcomplete']:
        ex = {"R":0.15} if kind=='rangeR' else None
        SPECS.append(spec(f'OSC_{dname}_{kind}', inp, kind,
            f'{dname} composite diet -> {kind}{"@0.15" if kind=="rangeR" else ""} @T120s all. '
            f'osc-guard for both-sides fleet. baseline: {BASE[kind]}. needs_pending2 swap.', extra=ex))
# shuffled-null (FARM-5 style; runner ignores target.shuffle for now -> random-diet floor)
SPECS.append(spec('OSC_NULL_rangeR', NULLD, 'rangeR',
    'FARM-5 NULL floor for the osc guard: 4 scattered cs_ channels -> rangeR@0.15, shuffled '
    'target (runner-shuffle not yet honored -> random-diet floor). The diets must beat it. needs_pending2 swap.',
    extra={"R":0.15,"shuffle":True}))
# T=60 variant of the best-looking label (rangeR = magnitude family, our strongest) on geoC
SPECS.append(spec('OSC_geoC_rangeR_T60', GEO, 'rangeR',
    'geoC -> rangeR@0.15 at T=60s (min-remaining-time gate; admits later entries). Decision-time '
    f'twin of OSC_geoC_rangeR. baseline: {BASE["rangeR"]}. needs_pending2 swap.', horizon=60, extra={"R":0.15}))

def acquire(timeout=15.0, stale=90.0):
    t0=time.time()
    while True:
        try:
            fd=os.open(QLOCK, os.O_CREAT|os.O_EXCL|os.O_WRONLY); os.write(fd,str(os.getpid()).encode()); return fd
        except FileExistsError:
            try:
                if time.time()-os.path.getmtime(QLOCK)>stale: os.remove(QLOCK); continue
            except OSError: pass
            if time.time()-t0>timeout: return None
            time.sleep(0.05)

def main():
    existing=set()
    if os.path.exists(QF):
        for ln in open(QF,encoding='utf-8'):
            s=ln.strip()
            if not s: continue
            try: existing.add(json.loads(s).get('id'))
            except Exception: pass
    todo=[s for s in SPECS if s['id'] not in existing]
    if not todo:
        print('seed_osc_diets: all',len(SPECS),'specs already present -> no-op'); return
    fd=acquire()
    if fd is None: print('WARN: _qlock timeout -> appending unlocked (append-only, low risk)')
    try:
        with open(QF,'a',encoding='utf-8') as f:
            for s in todo: f.write(json.dumps(s,ensure_ascii=False)+'\n')
    finally:
        if fd is not None:
            os.close(fd)
            try: os.remove(QLOCK)
            except OSError: pass
    print(f'seed_osc_diets: appended {len(todo)} cs_-gated specs (needs_pending2):')
    for s in todo: print('   ',s['id'],f"({len(s['inputs'])}ch {s['target']['kind']}@T{s['target']['horizon_s']}/{s['sample_set']})")

if __name__=='__main__': main()
