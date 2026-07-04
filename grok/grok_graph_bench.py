"""
grok_graph_bench.py — CUDA GRAPHS throughput probe for the batched-ensemble grok step.

The workload is LAUNCH-BOUND (see speed_report.md): the batched baddbmm path
plateaus ~820 net-ep/s at E>=8 because each epoch is a handful of tiny kernels and
we pay per-launch overhead. The full-batch input Xtr is STATIC (never changes
epoch-to-epoch) and the step is fixed-shape -> textbook CUDA-graph capture target.

This probe measures, same-shape same-workload as grok_bench.run_batched:
  A. eager batched            (the 820 net-ep/s baseline)
  B. single-step graph        (capture fwd+bwd+fusedAdamW.step+decay, replay 1/epoch)
  C. multi-step graph K       (capture K steps into ONE graph -> amortize replay launch)

Post-warmup LR is constant (warmup is the first ~1000 of 100k epochs), so the graph
is captured at the steady-state LR and the warmup runs eagerly before capture. The
per-net decoupled weight-decay (p*= 1-lr*wd) is captured too (constant mult @ const lr).
fused+capturable AdamW is graph-safe in torch 2.11. No .item()/no eval inside capture.

Read-only w.r.t. the farm (writes only stdout). Keep E/iters modest to contend politely.

Usage: python grok_graph_bench.py            (E in {8,16,32}, K in {1,10,25,50})
       python grok_graph_bench.py quick
"""
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, os, sys, time
torch.manual_seed(0); np.random.seed(0)
GD = r'C:\Users\Noah\claude-workspace\grok'
dev = 'cuda'
QUICK = len(sys.argv) > 1 and sys.argv[1] == 'quick'
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

# ---------- build C's exact sample set (event + matched controls) — mirrors grok_bench ----------
KEEP = ['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol']
L, HZ, THR, WIDTH = 30, 12, 2.0, 128
d = np.load(os.path.join(GD,'grok_data.npz'), allow_pickle=True)
names=[str(x) for x in d['names']]; base=[str(x) for x in d['base']]; tf=[str(x) for x in d['tfFam']]
raw={base[i]:i for i in range(len(names)) if tf[i]=='raw'}; sel=[raw[k] for k in KEEP]
Zall=d['Zimp'].astype(np.float32); Zin=Zall[sel]; K,nWin,BPW=Zin.shape
mid=d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay=d['winDay']; label=d['label']; distraw=Zall[raw['dist']]
days=sorted(set(winDay.tolist())); train_days=set(days[:6])
is_tr=np.array([winDay[w] in train_days for w in range(nWin)])
trmask=np.zeros((nWin,BPW),bool); trmask[is_tr,:]=True
mu=Zin[:,trmask].mean(1); sd=Zin[:,trmask].std(1); sd[sd<1e-6]=1; Zin=(Zin-mu[:,None,None])/sd[:,None,None]
t_lo,t_hi=L-1,BPW-1-HZ; ws=[];ts=[]
for w in range(nWin):
    for tt in range(t_lo,t_hi+1): ws.append(w);ts.append(tt)
ws=np.array(ws);ts=np.array(ts); DM=(mid[ws,ts+HZ]-mid[ws,ts])*100.0
ycls=np.where(DM<-THR,0,np.where(DM>THR,2,1)).astype(np.int64); is_event=np.abs(DM)>THR; tr_all=is_tr[ws]
sb=np.clip((secleft[ws,ts]/900.0*6).astype(int),0,5); mb=np.clip((mid[ws,ts]*5).astype(int),0,4)
strat=sb*5+mb; rng=np.random.default_rng(0); keep=np.zeros(len(ws),bool)
for split in [tr_all,~tr_all]:
    ev=split&is_event; ct=split&(~is_event); keep|=ev
    ev_idx=np.where(ev)[0]; ct_idx=np.where(ct)[0]; ev_str=strat[ev_idx]; ct_str=strat[ct_idx]
    for s in np.unique(ev_str):
        need=int((ev_str==s).sum()); pool=ct_idx[ct_str==s]
        if len(pool)==0: continue
        keep[rng.choice(pool,size=min(need,len(pool)),replace=False)]=True
si=np.where(keep)[0]; ws,ts,ycls,tr_all=ws[si],ts[si],ycls[si],tr_all[si]
def build_X(wv,tv):
    N=len(wv); X=np.empty((N,K*L),np.float32); bt=tv-(L-1)
    for o in range(L): X[:,o*K:(o+1)*K]=Zin[:,wv,bt+o].T
    stat=np.stack([secleft[wv,tv]/900.0,mid[wv,tv],distraw[wv,tv]],1).astype(np.float32)
    return np.concatenate([X,stat],1)
X=build_X(ws,ts); Din=X.shape[1]
Xt=torch.tensor(X,device=dev); yt=torch.tensor(ycls,device=dev)
trm=torch.tensor(tr_all,device=dev); tr_i=torch.where(trm)[0]
cnt=np.bincount(ycls[tr_all],minlength=3).astype(np.float64); cnt[cnt==0]=1
cw=torch.tensor((cnt.sum()/(3*cnt)),dtype=torch.float32,device=dev)
Xtr=Xt[tr_i].contiguous(); ytr=yt[tr_i].contiguous(); Ntr=int(trm.sum())
print(f'sample set: N={len(ws)} train={Ntr} Din={Din} | dev={torch.cuda.get_device_name(0)}',flush=True)

LR, WD = 1e-3, 0.05

def make_batched(E, capturable=False):
    """Build a fresh E-stacked ensemble + a step() closure. Returns (P, opt, step, WDvec)."""
    g=torch.Generator(device=dev).manual_seed(0)
    def init_lin(ein,out):
        w=torch.empty(E,ein,out,device=dev); b=torch.empty(E,1,out,device=dev)
        bound=1/np.sqrt(ein)
        w.uniform_(-bound,bound,generator=g); b.uniform_(-bound,bound,generator=g)
        return nn.Parameter(w), nn.Parameter(b)
    W1,b1=init_lin(Din,WIDTH); W2,b2=init_lin(WIDTH,WIDTH); Wd,bd=init_lin(WIDTH,3)
    P=[W1,b1,W2,b2,Wd,bd]
    opt=torch.optim.AdamW(P,lr=LR,weight_decay=0.0,fused=True,capturable=capturable)
    Xb=Xtr.unsqueeze(0).expand(E,-1,-1)                 # [E,N,Din] view
    yb=ytr.unsqueeze(0).expand(E,-1)                    # shared target (bench)
    oneh=F.one_hot(yb,3).float(); smooth=oneh*0.9+0.1/3
    cwb=cw.view(1,1,3); wsel=(cwb*oneh).sum(-1)         # [E,N] const
    WDvec=torch.full((E,),WD,device=dev)
    decay_mul=(1.0-LR*WDvec)                            # const @ const post-warmup lr
    def fb():
        h=torch.baddbmm(b1,Xb,W1); h=F.gelu(h)
        h=torch.baddbmm(b2,h,W2);  h=F.gelu(h)
        logits=torch.baddbmm(bd,h,Wd)
        logp=F.log_softmax(logits,dim=2)
        ce=-(smooth*logp).sum(-1)*wsel
        return ce.mean(1).sum()
    def step():
        for p in P:
            if p.grad is not None: p.grad.zero_()
        loss=fb(); loss.backward(); opt.step()
        with torch.no_grad():
            for p in P: p.mul_(decay_mul.view(-1,*([1]*(p.dim()-1))))
        return loss
    return P, opt, step, fb

# ---------------- A. eager batched ----------------
def bench_eager(E, iters):
    P,opt,step,_=make_batched(E, capturable=False)
    for _ in range(50): step()
    torch.cuda.synchronize(); t0=time.time()
    for _ in range(iters): step()
    torch.cuda.synchronize(); dt=time.time()-t0
    return iters/dt*E

# ---------------- B/C. graph capture (K steps per replay) ----------------
def bench_graph(E, iters, K):
    P,opt,step,_=make_batched(E, capturable=True)
    # warmup on a side stream (required before capture: allocs grads/state, primes cublas)
    s=torch.cuda.Stream()
    s.wait_stream(torch.cuda.current_stream())
    with torch.cuda.stream(s):
        for _ in range(11): step()
    torch.cuda.current_stream().wait_stream(s)
    torch.cuda.synchronize()
    # capture K steps into one graph
    gr=torch.cuda.CUDAGraph()
    with torch.cuda.graph(gr):
        for _ in range(K): step()
    torch.cuda.synchronize()
    replays=max(iters//K,20)
    for _ in range(5): gr.replay()
    torch.cuda.synchronize(); t0=time.time()
    for _ in range(replays): gr.replay()
    torch.cuda.synchronize(); dt=time.time()-t0
    net_eps=(replays*K)/dt*E
    return net_eps

Es = [1,4,8,16] if QUICK else [1,2,4,8,16,32]
Ks = [1,10,50] if QUICK else [1,10,25,50]
ITERS = 800 if QUICK else 1500

print('\n=== EAGER BATCHED (baseline; ~820 net-ep/s target) ===',flush=True)
eager={}
for E in Es:
    eager[E]=bench_eager(E, ITERS)
    print(f'  E={E:<3d}  {eager[E]:9.1f} net-ep/s',flush=True)

print('\n=== CUDA GRAPH (K steps/replay) ===',flush=True)
for E in Es:
    for Kk in Ks:
        try:
            ne=bench_graph(E, ITERS, Kk)
            print(f'  E={E:<3d} K={Kk:<3d}  {ne:9.1f} net-ep/s   ({ne/eager[E]:4.2f}x vs eager E={E})',flush=True)
        except Exception as ex:
            print(f'  E={E:<3d} K={Kk:<3d}  FAILED: {repr(ex)[:100]}',flush=True)

print('\n=== SUMMARY ===',flush=True)
print(f'best eager  : {max(eager.values()):9.1f} net-ep/s',flush=True)
