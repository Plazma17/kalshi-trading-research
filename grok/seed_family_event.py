#!/usr/bin/env python3
"""seed_family_event.py -- append the DIST-MID FAMILY event-anchored diet specs to
experiments_queue.jsonl under the _qlock convention (grok_queue.QLOCK sentinel).

Noah's directive (2026-07-03): send the dist-mid family to the grok farm. The nets learn
the NONLINEAR forms of "which crossings continue / which holds persist / which flips revert",
beating the engineered baselines from the np_* screens:
  * xcross  x xdirsettle (cross-dir-settles)  -- np_xcross  55.4% cross-dir settle read
  * dspike  x holdrev    (hold-vs-revert)     -- np_spikehold HOLD+GAP non-reverting subset
  * midflip x fliprev    (flip-reverts)        -- np_ssdrop/np_flipamp flip-revert base rates

Each event x target x 3 diets {full-pruned 10ch (pre-swap OK), composite family-C geometry
(needs_pending2), flow-D (needs_pending2)} + 1 shuffled-null on the xcross set = 10 specs.

APPEND-ONLY under the shared _qlock: we never rewrite existing lines (the runner owns their
status). Idempotent: skips ids already present. The 6 composite (Cgeo/Dflow) specs carry
"needs_pending2": true -- they train on cs_* channels that exist ONLY after the pending2 swap.
The 3 ten-channel diets + the null are raw-channel-only (pre-swap runnable), but all 10 specs
are appended AFTER the 14 CF_ composite specs (queue tail), so the runner won't reach them
before the pending2 swap + runner restart -- which is exactly when the new build_run
(family-event sample sets + xdirsettle/holdrev/fliprev target kinds) loads. The RUNNER IS NOT
TOUCHED by this script (append-only queue write; the code edit is already on disk and loads on
its next natural restart).
"""
import os, json, time

GD = r'C:\Users\Noah\claude-workspace\grok'
QF = os.path.join(GD, 'experiments_queue.jsonl')
QLOCK = os.path.join(GD, 'experiments_queue.lock')

# --- diets ---
TEN10 = ['mid', 'spread', 'dist', 'tfi', 'btcobi', 'tvol', 'btcspread', 'sig', 'eth', 'sol']
FAM_C = ['cs_gap_lvl', 'cs_sy_lvl', 'cs_mid_phi_wedge', 'cs_hilo_pos', 'cs_dd_extreme',
         'cs_range_open', 'cs_coil60', 'cs_coil120', 'cs_dist_secleft', 'cs_absm50_sqrtsec',
         'cs_gap_secleft']                                     # composite family C (geometry)
FAM_D = ['cs_concord_tfi', 'cs_flow_intensity', 'cs_tfi_obi', 'cs_flow_price_div',
         'cs_ewma_tfi_fast', 'cs_ewma_tfi_slow', 'cs_tfi_accel', 'cs_signed_tvol',
         'cs_concord_runlen']                                  # composite family D (flow)
# scattered raw-channel false-positive floor (FARM-5 style): channels not expected to carry
# the cross-direction signal -> a random-diet floor the real diets must beat. shuffle=True is
# set for forward-compat (runner does not yet honor target.shuffle -> currently a random diet).
NULL_SUB = ['dev', 'pf', 'zstrike', 'calk', 'hod_sin', 'hod_cos', 'sprxtfi', 'bsprxobi']

MODEL = {"width": 128, "wd": 0.1, "epochs": 120000, "lr": 1e-3, "ls": 0.1, "warmup": 1000}
SRC = "family-event"

# --- the 3 event x target pairs (sample_set, kind, horizon_s, engineered-baseline note) ---
PAIRS = [
    ('xcross',  'xdirsettle', 120,
     'np_xcross engineered baseline: cross-dir settle 55.4% (>50%); bin-level read 57.3%. '
     'FARM-8 mid>0.5 baseline applies if quote inputs present (none in these diets).'),
    ('dspike',  'holdrev',    120,
     'np_spikehold engineered baseline: HOLD+GAP selects the non-reverting subset (dist re-move '
     'preceded 100% of adverse); unconditional hold-rate ~0.39. gapdyn Cell-B P(flip)=0.48 vs 0.41.'),
    ('midflip', 'fliprev',    300,
     'np_ssdrop/np_flipamp engineered baseline: matched-base flip-revert 0.76/0.85/0.88 at '
     '60/120/300s (Noah cell +0.10..+0.20 lift); bin-level re-cross rate 0.735 @300s.'),
]
DIETS = [
    ('10ch', TEN10, False, 'full-pruned 10-channel raw diet (pre-swap runnable)'),
    ('Cgeo', FAM_C, True,  'composite family-C geometry diet'),
    ('Dflow', FAM_D, True, 'composite family-D flow diet'),
]


def spec(sid, inputs, kind, ss, hz, needs2, note, shuffle=False):
    tg = {"kind": kind, "horizon_s": hz, "thr": 2.0}
    if shuffle:
        tg["shuffle"] = True
    s = {"id": sid, "inputs": inputs, "statics": ["secleft"], "target": tg,
         "sample_set": ss, "model": dict(MODEL), "source": SRC, "note": note}
    if needs2:
        s["needs_pending2"] = True
    return s


SPECS = []
short = {'xdirsettle': 'xset', 'holdrev': 'hold', 'fliprev': 'frev'}
for ss, kind, hz, base_note in PAIRS:
    for dname, inputs, needs2, dnote in DIETS:
        sid = f'FE_{ss}_{short[kind]}_{dname}'
        SPECS.append(spec(sid, inputs, kind, ss, hz, needs2,
                          f'DIST-MID FAMILY. {ss} x {kind} ({dnote}, {len(inputs)}ch) '
                          f'-> width128/120k, statics=[secleft]. ENGINEERED BASELINE: {base_note}'
                          + (' needs_pending2 swap.' if needs2 else '')))
# 1 shuffled-null on the xcross set (FARM-5 floor; scattered raw diet, pre-swap runnable)
SPECS.append(spec('FE_xcross_NULL', NULL_SUB, 'xdirsettle', 'xcross', 120, False,
                  'DIST-MID FAMILY FARM-5 NULL floor for the xcross set: 8 scattered raw channels, '
                  'shuffle target (runner-shuffle not yet honored -> random-diet floor for now). '
                  'The real xcross diets must beat this.', shuffle=True))


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
    if not todo:
        print('seed_family_event: all', len(SPECS), 'specs already present -> no-op'); return
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
    print(f'seed_family_event: appended {len(todo)} specs:')
    for s in todo:
        print('   ', s['id'], f"({len(s['inputs'])} ch, {s['target']['kind']}/{s['sample_set']}, "
              f"needs_pending2={s.get('needs_pending2', False)})")


if __name__ == '__main__':
    main()
