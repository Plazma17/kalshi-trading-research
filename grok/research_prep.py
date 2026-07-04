#!/usr/bin/env python3
"""research_prep.py -- add DERIVED channels to grok_data.npz for the research-claim
merge (research_specs_{lore,academic,pm}.jsonl -> experiments_queue.jsonl).

Adds ALL derived channels needed by the translated research specs that are
computable from ALREADY-BANKED data (no unbanked feed). Each channel is appended
as a NEW raw channel (base=name, tfFam='raw', causal=True) so the runner's
build_run picks it up via RAWIDX after the next (centralized) restart. Append-only
along the channel axis => existing channel indices are UNCHANGED, existing specs
unaffected.

Derivations (all TRAILING-ONLY / CONTEMPORANEOUS -> no future info / no leak):
  hod_sin, hod_cos  : window-open hour-of-day (UTC) from the ticker string,
                      cyclically encoded, broadcast constant across the window's
                      bins. Uses ONLY the window-open timestamp -> no leak.
                      Unlocks RL12 (killzone), RA8 (hour seasonality), RP14 (TOD flow).
  sprxtfi           : spread * tfi  (contemporaneous interaction, same bin).
  bsprxobi          : btcspread * btcobi (contemporaneous interaction, same bin).
                      Both unlock RA15 (spread-as-gate interaction terms). Product of
                      two same-bin channels -> pointwise, no leak.

NOT added (deferred instead): round-number distance (needs ABSOLUTE BTC price in $;
grok_data.npz stores only z-scored price channels -> irrecoverable) and any OKX /
L2 / BRTI-book channel (unbanked feed). Those specs are parked in
research_specs_deferred.jsonl.

Idempotent: re-running detects the channels already present and is a no-op.
Atomic save (temp + os.replace) so concurrent readers never see a torn file.
"""
import numpy as np, os, tempfile, sys

GD = r'C:\Users\Noah\claude-workspace\grok'
NPZ = os.path.join(GD, 'grok_data.npz')
NEW = ['hod_sin', 'hod_cos', 'sprxtfi', 'bsprxobi']

def main():
    D = np.load(NPZ, allow_pickle=True)
    names = [str(x) for x in D['names']]
    base  = [str(x) for x in D['base']]
    tf    = [str(x) for x in D['tfFam']]
    causal = np.asarray(D['causal'])
    Z = D['Zimp'].astype(np.float32)             # (C, nWin, BPW)
    C, nWin, BPW = Z.shape
    ticker = [str(x) for x in D['ticker']]
    rawidx = {base[i]: i for i in range(len(names)) if tf[i] == 'raw'}

    if all(n in names for n in NEW):
        print('research_prep: all derived channels already present -> no-op'); return

    # ---- hour-of-day from ticker window-open time (UTC), cyclic, per-window const ----
    hours = np.empty(nWin, np.float32)
    for w in range(nWin):
        m = ticker[w].split('-')[1]            # e.g. '26JUN241730'
        hh = int(m[-4:-2]); mm = int(m[-2:])
        hours[w] = hh + mm / 60.0
    ang = 2.0 * np.pi * (hours / 24.0)
    hod_sin = np.repeat(np.sin(ang)[:, None], BPW, axis=1).astype(np.float32)   # (nWin,BPW)
    hod_cos = np.repeat(np.cos(ang)[:, None], BPW, axis=1).astype(np.float32)

    # ---- contemporaneous interaction products (same-bin -> no leak) ----
    sprxtfi  = (Z[rawidx['spread']]    * Z[rawidx['tfi']]).astype(np.float32)
    bsprxobi = (Z[rawidx['btcspread']] * Z[rawidx['btcobi']]).astype(np.float32)

    add = {'hod_sin': hod_sin, 'hod_cos': hod_cos, 'sprxtfi': sprxtfi, 'bsprxobi': bsprxobi}
    rows = [add[n][None] for n in NEW]
    Znew = np.concatenate([Z] + rows, axis=0)
    names2 = names + NEW
    base2  = base  + NEW
    tf2    = tf    + ['raw'] * len(NEW)
    causal2 = np.concatenate([causal, np.ones(len(NEW), bool)])

    # ---- verify: shapes, finiteness, no-leak sanity ----
    assert Znew.shape == (C + len(NEW), nWin, BPW), Znew.shape
    for n in NEW:
        r = Znew[names2.index(n)]
        assert r.shape == (nWin, BPW)
        assert np.isfinite(r).all(), f'{n} has non-finite'
    # hod is window-constant (constant across the bin axis) => cannot encode intra-window future
    assert np.allclose(Znew[names2.index('hod_sin')].std(axis=1), 0.0, atol=1e-5), 'hod_sin not window-constant'
    # products equal the elementwise product of their (unchanged) source rows
    assert np.allclose(Znew[names2.index('sprxtfi')],  Znew[rawidx['spread']]    * Znew[rawidx['tfi']])
    assert np.allclose(Znew[names2.index('bsprxobi')], Znew[rawidx['btcspread']] * Znew[rawidx['btcobi']])
    # existing channels byte-unchanged (append-only)
    assert np.array_equal(Znew[:C], Z), 'existing channels changed!'

    out = {k: np.array(D[k]) for k in D.files}   # materialize BEFORE closing the NpzFile
    out['Zimp']  = Znew
    out['names'] = np.array(names2)
    out['base']  = np.array(base2)
    out['tfFam'] = np.array(tf2)
    out['causal'] = causal2
    D.close()                                    # release the lazy zip handle (Windows replace)

    fd, tmp = tempfile.mkstemp(dir=GD, suffix='.npz'); os.close(fd)
    np.savez_compressed(tmp, **out)
    # np.savez appends .npz to a path without one; mkstemp gave a .npz suffix already,
    # but savez may write tmp+'.npz' -> handle both.
    saved = tmp if os.path.exists(tmp) and os.path.getsize(tmp) > 0 else tmp + '.npz'
    if not os.path.exists(saved): saved = tmp + '.npz'
    # The live grok_queue.py runner holds grok_data.npz open for its whole lifetime
    # (module-level np.load keeps the NpzFile handle open). We must NOT restart it
    # (centralized, pending the CUDA-graphs agent). So: try the atomic swap; if the
    # target is locked, park the augmented file as grok_data.pending.npz for the next
    # centralized restart to apply (mv pending -> grok_data.npz while the runner is down).
    import time as _t
    locked = False
    for attempt in range(3):
        try:
            os.replace(saved, NPZ); break
        except PermissionError:
            if attempt == 2: locked = True
            else: _t.sleep(1.0)
    if locked:
        pend = os.path.join(GD, 'grok_data.pending.npz')
        os.replace(saved, pend)
        print('research_prep: grok_data.npz is LOCKED by the live runner (no-restart).')
        print(f'  Verified augmented dataset parked at: {pend}')
        print('  APPLY AT NEXT CENTRALIZED RESTART: stop grok_queue -> '
              'move grok_data.pending.npz onto grok_data.npz -> relaunch.')
        print(f'  (added {NEW}; Zimp {Znew.shape})')
        print('hours sample (first 5 windows):', [round(float(h), 2) for h in hours[:5]])
        return
    for stray in (tmp, tmp + '.npz'):
        if os.path.exists(stray) and stray != NPZ:
            try: os.remove(stray)
            except OSError: pass
    print(f'research_prep: added {NEW} -> Zimp {Znew.shape}; raw channels now',
          len([1 for i in range(len(names2)) if tf2[i] == 'raw']))
    print('hours sample (first 5 windows):', [round(float(h), 2) for h in hours[:5]])

if __name__ == '__main__':
    main()
