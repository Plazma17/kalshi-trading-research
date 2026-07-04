#!/usr/bin/env python3
"""seed_composite_diets.py -- append the composite-factory diet specs to
experiments_queue.jsonl under the _qlock convention (grok_queue.QLOCK sentinel).

Each spec trains on cs_* channels that exist ONLY after the pending2 swap, so every
spec carries "needs_pending2": true. APPEND-ONLY: we never rewrite existing lines
(the runner owns their status), we only add new lines while holding the shared lock,
so we can't clobber a live mark(). Idempotent: skips ids already present.

Backlog guard: 48 specs are queued ahead, so the runner won't reach these before the
swap; they're the last lines, and the swap (STOP -> mv pending2 -> relaunch) is the
natural unblock. Batchable groups: all dir@120/event_matched specs share one
batchable_key (train together); the 5 settle/all specs share another; the choppy
single is its own group.
"""
import os, json, time

GD = r'C:\Users\Noah\claude-workspace\grok'
QF = os.path.join(GD, 'experiments_queue.jsonl')
QLOCK = os.path.join(GD, 'experiments_queue.lock')

FAM = {
 'A': ['cs_divint','cs_divint_abs','cs_avggap','cs_idist_touch','cs_flow_touch',
       'cs_im50_cross','cs_itfi_flip','cs_iobi_flip','cs_iconcord_disc',
       'cs_iabsdmid_burst','cs_ispread_spike','cs_flow_open','cs_advexc_drift'],
 'B': ['cs_tsc_gap','cs_ts50','cs_ts_touch','cs_ts_burst','cs_ts_spike',
       'cs_ts_tfiflip','cs_cnt_cross50','cs_cnt_touch','cs_cnt_burst','cs_driftlen'],
 'C': ['cs_gap_lvl','cs_sy_lvl','cs_mid_phi_wedge','cs_hilo_pos','cs_dd_extreme',
       'cs_range_open','cs_coil60','cs_coil120','cs_dist_secleft','cs_absm50_sqrtsec',
       'cs_gap_secleft'],
 'D': ['cs_concord_tfi','cs_flow_intensity','cs_tfi_obi','cs_flow_price_div',
       'cs_ewma_tfi_fast','cs_ewma_tfi_slow','cs_tfi_accel','cs_signed_tvol',
       'cs_concord_runlen'],
 'E': ['cs_rvratio_30_300','cs_rv30','cs_rr_pos','cs_volofvol','cs_postburst_decay',
       'cs_rv300','cs_cfrv30'],
}
ALL50 = FAM['A']+FAM['B']+FAM['C']+FAM['D']+FAM['E']
DIVINT_CORE = ['cs_divint','cs_divint_abs','cs_avggap','cs_tsc_gap']  # Noah #1 bundle
# scattered null subset (one-ish per family) = a random-diet floor the combined diet must beat
NULL_SUB = ['cs_divint','cs_ts50','cs_coil60','cs_ewma_tfi_slow','cs_rv30',
            'cs_cnt_touch','cs_hilo_pos','cs_signed_tvol']

MODEL = {"width":128,"wd":0.1,"epochs":120000,"lr":1e-3,"ls":0.1,"warmup":1000}
SRC = "composite-factory"

def spec(sid, inputs, kind, ss, note, extra_target=None):
    tg = {"kind":kind,"horizon_s":120,"thr":2.0}
    if extra_target: tg.update(extra_target)
    return {"id":sid,"inputs":inputs,"statics":["secleft"],"target":tg,
            "sample_set":ss,"model":dict(MODEL),"source":SRC,"needs_pending2":True,
            "note":note}

SPECS = []
# 5 family diets @ dir@120 event_matched
for f in ['A','B','C','D','E']:
    SPECS.append(spec(f'CF_{f}_dir', FAM[f], 'dir', 'event_matched',
        f'composite family {f} ({len(FAM[f])} ch) -> dir@120 event_matched. needs_pending2 swap.'))
# 5 family diets @ settle all
for f in ['A','B','C','D','E']:
    SPECS.append(spec(f'CF_{f}_settle', FAM[f], 'settle', 'all',
        f'composite family {f} ({len(FAM[f])} ch) -> settle all. Read vs FARM-8 mid>0.5 baseline '
        f'(some composites encode mid). needs_pending2 swap.'))
# 2 singles for Noah's #1 divint: dir + oscillatory(choppy)
SPECS.append(spec('CF_divint_dir', DIVINT_CORE, 'dir', 'event_matched',
    'Noah #1 divint core [A,|A|,avgGap,tsc] -> dir@120 event_matched. needs_pending2 swap.'))
SPECS.append(spec('CF_divint_osc', DIVINT_CORE, 'dir', 'choppy',
    'Noah #1 divint core -> dir@120 on CHOPPY (oscillatory) regime = the flip-prediction '
    'analog (np_divint targeted mid FLIPS; farm has no flip-kind, choppy = the oscillation '
    'proxy). needs_pending2 swap.'))
# 1 combined all-50 diet
SPECS.append(spec('CF_all50_dir', ALL50, 'dir', 'event_matched',
    'ALL 50 composite channels -> dir@120 event_matched (the kitchen-sink diet). '
    'needs_pending2 swap.'))
# 1 shuffled-null companion (FARM-5 style; runner does not yet honor target.shuffle ->
# currently a random-diet floor of 8 scattered channels; upgrades to a true permutation
# null with the one-line build_run change. The combined/family diets must beat it.)
SPECS.append(spec('CF_NULL_dir', NULL_SUB, 'dir', 'event_matched',
    'FARM-5 NULL floor for the composite diets: 8 scattered cs_ channels, shuffled target '
    '(runner-shuffle not yet honored -> random-diet floor for now). needs_pending2 swap.',
    extra_target={"shuffle":True}))

def acquire(timeout=15.0, stale=90.0):
    t0 = time.time()
    while True:
        try:
            fd = os.open(QLOCK, os.O_CREAT|os.O_EXCL|os.O_WRONLY)
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
    if not todo:
        print('seed_composite_diets: all', len(SPECS), 'specs already present -> no-op'); return
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
    print(f'seed_composite_diets: appended {len(todo)} specs:')
    for s in todo: print('   ', s['id'], f"({len(s['inputs'])} ch, {s['target']['kind']}/{s['sample_set']})")

if __name__ == '__main__':
    main()
