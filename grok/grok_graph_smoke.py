"""grok_graph_smoke.py — end-to-end smoke of grok_batch.train_batch's GROK_GRAPH path.
Runs a tiny 2-net group (small epochs/warmup) via the REAL train_batch. Set
GROK_GRAPH=1 to exercise the captured-graph branch. Cleans its own ckpt/progress.
Usage:  GROK_GRAPH=1 python grok_graph_smoke.py   (or GROK_GRAPH=0)
"""
import os, time, glob
GD = r'C:\Users\Noah\claude-workspace\grok'
suffix = 'G1' if os.environ.get('GROK_GRAPH') else 'G0'
ids = [f'ZZsmoke_{suffix}_a', f'ZZsmoke_{suffix}_b']
# clean prior smoke artifacts for these ids
for pat in [f'progress_ZZsmoke_{suffix}_*.json', 'ckpt_qbatch_*.pt']:
    pass
for f in glob.glob(os.path.join(GD, f'progress_ZZsmoke_{suffix}_*.json')):
    try: os.remove(f)
    except Exception: pass
import grok_batch as B
print('GRAPH flag in grok_batch =', B.GRAPH)
mdl = dict(width=128, epochs=2500, lr=1e-3, warmup=200, ls=0.1)
specs = [
    dict(id=ids[0], inputs=['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol'],
         target=dict(kind='dir', horizon_s=120, thr=2.0), sample_set='event_matched',
         model=dict(wd=0.05, seed=0, **mdl), source='smoke'),
    dict(id=ids[1], inputs=['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol'],
         target=dict(kind='dir', horizon_s=120, thr=2.0), sample_set='event_matched',
         model=dict(wd=0.10, seed=0, **mdl), source='smoke'),
]
# remove shared ckpt so it trains fresh
import hashlib
kh = hashlib.md5(('|'.join(sorted(ids))).encode()).hexdigest()[:10]
ck = os.path.join(GD, f'ckpt_qbatch_{kh}.pt')
if os.path.exists(ck): os.remove(ck)
t0 = time.time()
out = B.train_batch(specs, log=print)
dt = time.time() - t0
print(f'RESULT {out}  wall={dt:.1f}s  net-ep/s={2*2500/dt:.1f}')
# report final holdout acc per net (for eager-vs-graph curve equivalence)
import json
for i in ids:
    try:
        c = json.load(open(os.path.join(GD, f'progress_{i}.json')))['curves']
        last = c[-1]
        print(f'CURVE {i} ep{last["epoch"]} accHO={last["acc_ho"]:.5f} aucUD={last["aucUD_ho"]:.5f}')
    except Exception as e: print('curve read fail', i, e)
# clean up (unless KEEP=1)
if not os.environ.get('KEEP'):
    for f in glob.glob(os.path.join(GD, f'progress_ZZsmoke_{suffix}_*.json')) + [ck]:
        try: os.remove(f)
        except Exception: pass
