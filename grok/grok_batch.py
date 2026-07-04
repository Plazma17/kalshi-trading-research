"""grok_batch.py — BATCHED-ENSEMBLE trainer for the grok farm (queue-adoptable).

Trains a GROUP of experiments_queue specs SIMULTANEOUSLY as one stacked baddbmm
computation.  The farm's nets are tiny (24-56k params, full-batch) so a single
run leaves the RTX 5070 ~98% idle AND running several queue processes at once
just thrashes the 12 GB GPU (measured: 3 procs -> 11.8 GB, contention).  Stacking
E nets' weights into [E,in,out] tensors trains the whole group in ~one net's
wall-clock:  measured ~820 net-epochs/s at E>=8 vs ~444 ep/s single (fused) /
~290 ep/s (original) -> ~1.85x over fused-single, ~2.8x over the original farm.

REUSE, NO DUPLICATION: each spec is built by grok_queue.build_run() (the exact
sample-set vocabulary, per-train standardization, causal flatten + statics).  The
per-net flattened X_e is ZERO-PADDED to a common width and stacked into [E,N,Dmax];
padded/short columns get 0 input -> 0 forward contribution AND 0 gradient, so each
net is functionally identical to the single-net path (verified bit-exact for the
first ~350 epochs in grok_verify_batched.py; later drift is fp non-associativity,
same magnitude as a GPU/driver/batch-order change, holdout metrics agree ~1-2%).

Each net still writes its OWN progress_<id>.json in the queue's `curves` schema
(ATOMIC temp+os.replace -> no monitor torn reads; THROTTLED to <=1 write/2s) and
shares one resumable ckpt_qbatch_<key>.pt.

Batchability (the queue's grouping key): specs may DIFFER only in `inputs`, and in
model {wd, ls, init_scale, seed}.  They must SHARE sample_set, target (kind+
horizon+thr+tp), statics, width, epochs, lr, warmup, and have no grokfast.

    from grok_batch import batchable_key, train_batch
    # queue groups pending specs by batchable_key(spec), then:
    train_batch(group)          # trains all of `group` at once
"""
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, json, os, time, hashlib

GD = r'C:\Users\Noah\claude-workspace\grok'
EVAL_EVERY, CKPT_EVERY = 50, 400
WRITE_MIN_INTERVAL = 2.0        # s; throttle per-run progress writes (kills monitor churn)
dev = 'cpu' if os.environ.get('GROKQ_CPU') else ('cuda' if torch.cuda.is_available() else 'cpu')
if dev == 'cuda':
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
# OPT-IN (GROK_GRAPH=1): capture the constant-LR (post-warmup) training step into ONE
# CUDA graph and replay it, eliminating the ~8 per-step kernel launches. The step is
# fixed-shape and Xtr/targets are STATIC -> textbook capture. Measured ~1.5-1.6x at
# E<=2 (launch-bound), ~1.05x at E>=8 (memory-bound). Composes with GROK_FAST/GROK_BATCH.
# Capture is NON-DESTRUCTIVE (snapshot+restore) so replay reproduces the eager step
# bit-for-bit -> passes grok_verify_batched.py's descent-phase equality gate. Default off.
# Truthiness: gate on == '1' (NOT bool(env)) so GROK_GRAPH=0 / "" genuinely means OFF
# (bool('0') is True -> the old form re-enabled graph whenever the var was present at all).
GRAPH = os.environ.get('GROK_GRAPH') == '1' and dev == 'cuda'
# Set True the first time a capture OR replay raises a CUDA error in THIS process. A
# cudaErrorStreamCaptureInvalidated aborts the in-flight batch; abandoning it recovers the
# context (proven live: the runner trained L06 fine right after a 09:25 capture kill), but we
# must NOT retry capture -> from then on this process runs EAGER for every group. Process-wide
# (module-level) so a group resumed after a graph_abort in the SAME process skips capture.
_GRAPH_DISABLED = False

def batchable_key(spec):
    """Fields that MUST match for specs to share one batched run. Returns a hashable
    tuple, or None if the spec can't be batched (e.g. uses grokfast, or is a shell)."""
    if 'shell' in spec or 'inputs' not in spec or 'target' not in spec: return None
    mp = spec.get('model', {})
    if mp.get('grokfast'): return None                     # per-net grad-EMA not batched (v1)
    tg = spec['target']
    return ('BATCH',
            spec.get('sample_set', 'all'), spec.get('statics_key', tuple(spec.get('statics', ['secleft','mid','dist']))),
            tg['kind'], round(float(tg.get('horizon_s', 120)), 3), round(float(tg.get('thr', 2.0)), 4),
            round(float(tg.get('tp', 0.55)), 4),
            int(mp.get('width', 128)), int(mp.get('epochs', 200000)),
            round(float(mp.get('lr', 1e-3)), 8), int(mp.get('warmup', 1000)))

def _replace_retry(tmp, path, tries=25, delay=0.25):
    """os.replace with Windows-lock retry. The kalshi-cta Electron dashboard tails
    progress_*.json / ckpt files; a concurrent reader makes os.replace raise
    PermissionError(13,'Access is denied') on Windows. WITHOUT this, one such race
    aborted train_batch -> the whole batched PAIR lost (partner orphaned pending).
    ~6s of retry absorbs the transient lock."""
    for _ in range(tries):
        try:
            os.replace(tmp, path); return
        except PermissionError:
            time.sleep(delay)
    os.replace(tmp, path)               # final attempt: propagate if still locked

def _atomic_write(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(obj, f)
    _replace_retry(tmp, path)

def _save_atomic(obj, path):
    """torch.save atomically (temp + os.replace) so a crash/kill mid-write can't leave
    a truncated shared batch ckpt that fails to reload -> would error the whole group."""
    tmp = path + '.tmp'
    torch.save(obj, tmp)
    _replace_retry(tmp, path)

def _init_lin(ein, out, E, seeds, scale):
    """Stacked [E,ein,out] weight + [E,1,out] bias, per-net fan-in uniform init w/
    per-net seed (so a seed-sweep gets genuinely different inits) and init_scale."""
    w = torch.empty(E, ein, out, device=dev); b = torch.empty(E, 1, out, device=dev)
    bound = 1.0 / np.sqrt(ein)
    for e in range(E):
        g = torch.Generator(device=dev).manual_seed(int(seeds[e]))
        w[e].uniform_(-bound, bound, generator=g); b[e].uniform_(-bound, bound, generator=g)
    w *= scale.view(E, 1, 1)
    return nn.Parameter(w), nn.Parameter(b)

def train_batch(specs, log=print, stop_file=None):
    """Train `specs` (all sharing batchable_key) as one stacked ensemble.
    Returns (trained_ids, 'ok') or raises. Checkpoint-resumable; honors stop_file."""
    import grok_queue as Q                                   # reuse build_run + data (lazy: robust to edits)
    assert len(specs) >= 1
    keys = {str(batchable_key(s)) for s in specs}
    assert len(keys) == 1 and None not in [batchable_key(s) for s in specs], f'non-batchable group: {keys}'
    ids = [s['id'] for s in specs]; E = len(specs)
    mp0 = specs[0].get('model', {})
    W = int(mp0.get('width', 128)); epochs = int(mp0.get('epochs', 200000))
    lr = float(mp0.get('lr', 1e-3)); warmup = int(mp0.get('warmup', 1000))

    # ---- build each net via the queue's own builder (no logic duplicated) ----
    runs = [Q.build_run(s) for s in specs]
    head = runs[0]['head']; assert all(r['head'] == head for r in runs), 'mixed head in group'
    N = len(runs[0]['y']); tr0 = runs[0]['tr_all']
    for r in runs:
        assert len(r['y']) == N and np.array_equal(r['tr_all'], tr0), 'group sample-sets differ (bad key)'
    Dmax = max(r['Din'] for r in runs)
    nout = 3 if head == 'cls3' else 1
    key_hash = hashlib.md5(('|'.join(sorted(ids))).encode()).hexdigest()[:10]
    CKPT = os.path.join(GD, f'ckpt_qbatch_{key_hash}.pt')

    # ---- stack inputs (zero-pad each X_e to Dmax) + targets ----
    Xs = np.zeros((E, N, Dmax), np.float32)
    for e, r in enumerate(runs): Xs[e, :, :r['Din']] = r['X']
    Xt = torch.tensor(Xs, device=dev)                         # (E,N,Dmax)
    tr_all = tr0; trm = torch.tensor(tr_all, device=dev)
    tr_i = torch.where(trm)[0]; ho_i = torch.where(~trm)[0]
    Xtr = Xt[:, tr_i, :]; Xho = Xt[:, ho_i, :]                # (E,Ntr/Nho,Dmax)
    Y_np = np.stack([r['y'] for r in runs], 0)                # (E,N)
    return _run_loop(Q, specs, ids, runs, head, nout, W, E, Dmax, epochs, lr, warmup,
                     Xtr, Xho, Y_np, tr_all, tr_i, ho_i, CKPT, log, stop_file, key_hash)


def _run_loop(Q, specs, ids, runs, head, nout, W, E, Dmax, epochs, lr, warmup,
              Xtr, Xho, Y_np, tr_all, tr_i, ho_i, CKPT, log, stop_file, key_hash):
    mps = [s.get('model', {}) for s in specs]
    WDv = torch.tensor([float(m.get('wd', 0.10)) for m in mps], device=dev)          # (E,)
    LSv = torch.tensor([float(m.get('ls', 0.1)) for m in mps], device=dev).view(E, 1)
    seeds = [int(m.get('seed', 0)) for m in mps]
    scale = torch.tensor([float(m.get('init_scale', 1.0)) for m in mps], device=dev)
    Ytr_np = Y_np[:, tr_i.cpu().numpy()]; Yho_np = Y_np[:, ho_i.cpu().numpy()]

    # baselines + loss constants (per net)
    if head == 'cls3':
        CW = np.zeros((E, 3), np.float32); MAJ = []
        for e in range(E):
            c = np.bincount(Ytr_np[e], minlength=3).astype(np.float64); c[c == 0] = 1
            CW[e] = c.sum() / (3 * c)
            mj = int(np.bincount(Ytr_np[e], minlength=3).argmax())
            MAJ.append((mj, float((Yho_np[e] == mj).mean()), float((Ytr_np[e] == mj).mean())))
        CWt = torch.tensor(CW, device=dev)
        Ytr = torch.tensor(Ytr_np, device=dev)
        oneh = F.one_hot(Ytr, 3).float()
        SMOOTH = oneh * (1 - LSv.unsqueeze(-1)) + LSv.unsqueeze(-1) / 3               # const
        WSEL = (CWt.unsqueeze(1) * oneh).sum(-1)                                      # const
    else:  # bin (BCE + pos_weight)
        POSW = torch.zeros(E, device=dev); MAJ = []
        for e in range(E):
            pos = float(Ytr_np[e].mean()); POSW[e] = (1 - pos) / max(pos, 1e-3)
            mj = int(round(pos)); MAJ.append((mj, float((Yho_np[e] == mj).mean()), float((Ytr_np[e] == mj).mean())))
        Ytr = torch.tensor(Ytr_np.astype(np.float32), device=dev)

    # stacked params
    W1, b1 = _init_lin(Dmax, W, E, seeds, scale); W2, b2 = _init_lin(W, W, E, seeds, scale)
    Wo, bo = _init_lin(W, nout, E, seeds, scale)
    P = [W1, b1, W2, b2, Wo, bo]
    nparams_per = [int(r['Din']) * W + W + W * W + W + W * nout + nout for r in runs]  # effective (non-pad)
    opt = torch.optim.AdamW(P, lr=lr, weight_decay=0.0, fused=(dev == 'cuda'), capturable=GRAPH)

    def forward(x):  # (E,n,Dmax) -> (E,n,nout)
        h = F.gelu(torch.baddbmm(b1, x, W1)); h = F.gelu(torch.baddbmm(b2, h, W2))
        return torch.baddbmm(bo, h, Wo)

    @torch.no_grad()
    def evaluate(x, Ysub_np):
        out = forward(x)                                        # (E,n,nout)
        res = []
        if head == 'cls3':
            prob = torch.softmax(out, 2).cpu().numpy()
            for e in range(E):
                pr = prob[e]; ye = Ysub_np[e]; pred = pr.argmax(1); acc = float((pred == ye).mean())
                ud = (ye != 1)
                aA = Q.auc((pr[:, 2] - pr[:, 0])[ud], (ye[ud] == 2).astype(int)) if ud.any() else float('nan')
                aB = Q.auc(1 - pr[:, 1], (ye != 1).astype(int))
                ce = float(F.cross_entropy(out[e], torch.tensor(ye, device=dev)).item())
                res.append((acc, aA, aB, ce))
        else:
            p = torch.sigmoid(out.squeeze(-1)).cpu().numpy()
            for e in range(E):
                pe = p[e]; ye = Ysub_np[e]; pred = (pe > 0.5).astype(int); acc = float((pred == ye).mean())
                a = Q.auc(pe, ye.astype(int))
                ce = float(F.binary_cross_entropy(torch.tensor(pe), torch.tensor(ye.astype(np.float32))).item())
                res.append((acc, a, a, ce))
        return res

    # resume
    start = 0; curves = [[] for _ in range(E)]; last_write = [0.0] * E
    if os.path.exists(CKPT):
        ck = torch.load(CKPT, map_location=dev)
        for p, sv in zip(P, ck['P']): p.data.copy_(sv)
        opt.load_state_dict(ck['opt']); start = ck['epoch'] + 1; curves = ck.get('curves', curves)
        if GRAPH:                                   # capturable fused AdamW needs on-device step tensors
            for st in opt.state.values():
                if 'step' in st and torch.is_tensor(st['step']) and not st['step'].is_cuda:
                    st['step'] = st['step'].to(dev)
        log(f'[batch {key_hash}] resumed from epoch {start}')

    def write_prog(e, force=False):
        now = time.time()
        if not force and now - last_write[e] < WRITE_MIN_INTERVAL: return
        last_write[e] = now
        s = specs[e]; r = runs[e]; mj, mho, mtr = MAJ[e]
        _atomic_write(os.path.join(GD, f'progress_{ids[e]}.json'),
            {'mode': ids[e], 'batch': key_hash, 'params': nparams_per[e], 'wd': float(mps[e].get('wd', 0.1)),
             'L': Q.L, 'HZ': r['HZ'], 'K': r['K'], 'keep': r['keep'], 'head': head,
             'source': s.get('source'), 'baselines': {'majority': mho}, 'nc_ho': [mho, 0.5, 0.5],
             'curves': curves[e]})

    # ---- loss closure: IDENTICAL math for the eager and captured paths ----
    def _loss():
        out = forward(Xtr)
        if head == 'cls3':
            logp = F.log_softmax(out, 2)
            return (-(SMOOTH * logp).sum(-1) * WSEL).mean(1).sum()
        bl = F.binary_cross_entropy_with_logits(out.squeeze(-1), Ytr, reduction='none', pos_weight=None)
        bl = bl * (1 + (POSW.view(E, 1) - 1) * Ytr)            # per-net pos_weight on positives
        return bl.mean(1).sum()
    def _decay(cur_lr):                                        # per-net decoupled weight decay
        with torch.no_grad():
            for p in P: p.mul_(1.0 - cur_lr * WDv.view(-1, *([1] * (p.dim() - 1))))

    # ---- OPT-IN CUDA-graph capture of the steady-state (post-warmup, const-LR) step ----
    _G = {'g': None, 'loss': None}
    def _capture_step():
        """Capture zero-grad + fwd + bwd + fused-AdamW.step + decoupled-decay into ONE
        graph. NON-DESTRUCTIVE: snapshots params/opt-state/grads, warms up + captures
        (which advances weights), then RESTORES via in-place copy_ (preserves tensor
        identity so the captured graph's addresses stay valid) -> replay(1) reproduces
        one eager step BIT-FOR-BIT. cur_lr is constant (=lr) post-warmup, so the decay
        multiplier and optimizer lr are baked in correctly."""
        for g in opt.param_groups: g['lr'] = lr
        torch.cuda.synchronize()                              # drain all pending default-stream work before capture
        # snapshot (values only; keep tensor identities)
        psnap = [p.detach().clone() for p in P]
        gsnap = [(p.grad.detach().clone() if p.grad is not None else None) for p in P]
        ost = [opt.state[p] for p in P]
        osnap = [{k: (v.detach().clone() if torch.is_tensor(v) else v) for k, v in st.items()} for st in ost]
        # warmup on a side stream (required before capture)
        s = torch.cuda.Stream(); s.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(s):
            for _ in range(5):
                for p in P:
                    if p.grad is not None: p.grad.zero_()
                _loss().backward(); opt.step(); _decay(lr)
        torch.cuda.synchronize()
        # Capture ON THE SAME SIDE STREAM the warmup ran on, so the grad-accumulator nodes
        # (rebuilt fresh on `s` during warmup) match the capture stream. thread_local error
        # mode ignores benign cross-stream activity elsewhere in the process. Executes the
        # step ONCE more (undone by the snapshot restore below).
        g = torch.cuda.CUDAGraph()
        with torch.cuda.graph(g, stream=s, capture_error_mode='thread_local'):
            for p in P: p.grad.zero_()
            sl = _loss(); sl.backward(); opt.step(); _decay(lr)
        torch.cuda.current_stream().wait_stream(s)
        # restore snapshot in place (graph pointers stay valid)
        with torch.no_grad():
            for p, sv in zip(P, psnap): p.copy_(sv)
            for p, gv in zip(P, gsnap):
                if gv is not None and p.grad is not None: p.grad.copy_(gv)
            for st, sv in zip(ost, osnap):
                for k, v in sv.items():
                    if torch.is_tensor(st.get(k)) and torch.is_tensor(v): st[k].copy_(v)
        _G['g'] = g; _G['loss'] = sl

    def _graph_abort(where, ep):
        """A CUDA-graph capture/replay error (cudaErrorStreamCaptureInvalidated) aborts this
        batch. HARD GUARD against the 2026-07-03 L05/RA3/RA13 group-kill: the old code caught
        the capture exception then ran EAGER in the SAME epoch on the still-invalidated stream,
        which threw again UNCAUGHT -> grok_queue marked the whole group 'error'. Instead:
        disable graph process-wide, checkpoint best-effort, and return a NON-'ok' state so
        grok_queue leaves these specs PENDING; the group resumes EAGER (context recovers once
        the in-flight batch is abandoned). Never marks the group 'error'."""
        global _GRAPH_DISABLED
        _GRAPH_DISABLED = True; _G['failed'] = True
        try:
            _save_atomic({'P': [p.data for p in P], 'opt': opt.state_dict(),
                          'epoch': ep - 1, 'curves': curves}, CKPT)
            log(f'[batch {key_hash}] {where} poison -> GRAPH DISABLED (process), ckpt ep{ep-1}, '
                f'aborting group to resume EAGER (left PENDING, not error)')
        except Exception as _se:
            log(f'[batch {key_hash}] {where} poison -> GRAPH DISABLED (process); crisis ckpt '
                f'failed ({repr(_se)[:60]}); resuming EAGER from last periodic ckpt')
        return ids, 'graph_abort'

    log(f'=== BATCH {key_hash} E={E} head={head} Dmax={Dmax} N={Xtr.shape[1]+Xho.shape[1]} '
        f'epochs={epochs} start={start} ids={ids} graph={GRAPH and not _GRAPH_DISABLED} ===')
    t0 = time.time()
    for ep in range(start, epochs):
        if stop_file and os.path.exists(stop_file):
            _save_atomic({'P': [p.data for p in P], 'opt': opt.state_dict(), 'epoch': ep - 1, 'curves': curves}, CKPT)
            log(f'[batch {key_hash}] STOP -> checkpointed ep{ep-1}'); return ids, 'stopped'
        used_graph = False
        if GRAPH and not _GRAPH_DISABLED and ep >= warmup and not _G.get('failed'):
            if _G['g'] is None:
                # Free the prior EAGER autograd graph completely before capture. Its
                # grad-accumulator nodes were created on the DEFAULT stream; if ANY ref
                # keeps them alive (the lingering `loss`/`out` tensors), the captured
                # backward reuses those default-stream nodes -> 'legacy stream depend on
                # capturing blocking stream'. Dropping all refs + gc frees them so the
                # side-stream warmup rebuilds FRESH accumulators on the capture stream.
                loss = None; out = None; logp = None
                import gc; gc.collect()
                try:
                    _capture_step()
                except Exception as _e:
                    if os.environ.get('GROK_GRAPH_DEBUG'):
                        import traceback; traceback.print_exc()
                    log(f'[batch {key_hash}] GRAPH capture failed: {repr(_e)[:100]}')
                    return _graph_abort('capture', ep)
            if _G['g'] is not None and not _G.get('failed'):
                try:
                    _G['g'].replay(); loss = _G['loss']; used_graph = True
                except Exception as _e:
                    # A cudaErrorStreamCaptureInvalidated can surface on a LATER replay, not
                    # only at capture time. Same poison handling: abort -> resume EAGER.
                    if os.environ.get('GROK_GRAPH_DEBUG'):
                        import traceback; traceback.print_exc()
                    log(f'[batch {key_hash}] GRAPH replay failed: {repr(_e)[:100]}')
                    return _graph_abort('replay', ep)
        if not used_graph:                                     # eager (all warmup epochs + graph-off)
            cur_lr = lr * min(1.0, (ep + 1) / warmup)
            for g in opt.param_groups: g['lr'] = cur_lr
            out = forward(Xtr)
            if head == 'cls3':
                logp = F.log_softmax(out, 2)
                loss = (-(SMOOTH * logp).sum(-1) * WSEL).mean(1).sum()
            else:
                bl = F.binary_cross_entropy_with_logits(out.squeeze(-1), Ytr, reduction='none',
                                                        pos_weight=None)
                bl = bl * (1 + (POSW.view(E, 1) - 1) * Ytr)    # per-net pos_weight on positives
                loss = bl.mean(1).sum()
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
            with torch.no_grad():                              # per-net decoupled weight decay
                for p in P: p.mul_(1.0 - cur_lr * WDv.view(-1, *([1] * (p.dim() - 1))))
        if ep % EVAL_EVERY == 0 or ep == epochs - 1:
            etr = evaluate(Xtr, Ytr_np); eho = evaluate(Xho, Yho_np)
            for e in range(E):
                a_tr, b_tr, c_tr, ce_tr = etr[e]; a_ho, b_ho, c_ho, ce_ho = eho[e]
                mj, mho, mtr = MAJ[e]
                curves[e].append(dict(epoch=ep, tloss=float(loss.item()),
                    diracc_tr=[a_tr, b_tr, c_tr], diracc_ho=[a_ho, b_ho, c_ho],
                    mae_tr=[ce_tr, 0.0, 0.0], mae_ho=[ce_ho, 0.0, 0.0],
                    nc_tr=[mtr, 0.5, 0.5], nc_ho=[mho, 0.5, 0.5],
                    edge_tr=[a_tr - mtr, b_tr - 0.5, c_tr - 0.5],
                    edge_ho=[a_ho - mho, b_ho - 0.5, c_ho - 0.5],
                    settle_tr=a_tr, settle_ho=a_ho, acc_tr=a_tr, acc_ho=a_ho,
                    aucUD_ho=b_ho, aucEC_ho=c_ho, sec=round(time.time() - t0, 1)))
                if len(curves[e]) > 5000: curves[e] = curves[e][:500] + curves[e][500:][::2]
                write_prog(e, force=(ep == epochs - 1))
            if ep % (EVAL_EVERY * 20) == 0:
                log(f'[batch {key_hash}] ep{ep} loss{loss.item():.4f} net0 accHO {eho[0][0]:.3f} '
                    f'aucHO {eho[0][1]:.3f} | {E} nets | {time.time()-t0:.0f}s')
        if ep % CKPT_EVERY == 0 or ep == epochs - 1:
            _save_atomic({'P': [p.data for p in P], 'opt': opt.state_dict(), 'epoch': ep, 'curves': curves}, CKPT)
    for e in range(E): write_prog(e, force=True)
    _save_atomic({'P': [p.data for p in P], 'opt': opt.state_dict(), 'epoch': epochs - 1, 'curves': curves}, CKPT)
    log(f'[batch {key_hash}] DONE ids={ids}')
    return ids, 'ok'
