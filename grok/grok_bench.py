"""
grok_bench.py — profile the grok trainer step and measure the throughput delta
of each optimization, culminating in the BATCHED ENSEMBLE.

Replicates grok_train_C.py's exact hot loop (full-batch 2-layer MLP, ~56k params,
AdamW, CE + settle BCE) on the real grok_data.npz sample set, then layers on:
  0. baseline (fp32, unfused AdamW)          -> ep/s
  1. + TF32 matmul                            -> ep/s
  2. + fused AdamW                            -> ep/s
  3. + torch.compile (default)                -> ep/s
  4. BATCHED ENSEMBLE E in {2,4,8,16,32,64}   -> aggregate net-ep/s

Read-only w.r.t. the farm: writes NOTHING except stdout. Safe to run while other
grok runs are paused (checks GPU is free-ish first is the caller's job).

Usage: python grok_bench.py            (full sweep)
       python grok_bench.py quick      (fewer iters)
"""
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, os, sys, time
torch.manual_seed(0); np.random.seed(0)
GD = r'C:\Users\Noah\claude-workspace\grok'
dev = 'cuda'
QUICK = len(sys.argv) > 1 and sys.argv[1] == 'quick'
ITERS = 400 if QUICK else 1500
WARM  = 50

# ---------- build C's exact sample set (event + matched controls) ----------
KEEP = ['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol']
L, HZ, THR, WIDTH = 30, 12, 2.0, 128
d = np.load(os.path.join(GD,'grok_data.npz'), allow_pickle=True)
names=[str(x) for x in d['names']]; base=[str(x) for x in d['base']]; tf=[str(x) for x in d['tfFam']]
raw={base[i]:i for i in range(len(names)) if tf[i]=='raw'}
sel=[raw[k] for k in KEEP]
Zall=d['Zimp'].astype(np.float32); Zin=Zall[sel]
K,nWin,BPW=Zin.shape
mid=d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay=d['winDay']; label=d['label']; distraw=Zall[raw['dist']]
days=sorted(set(winDay.tolist())); train_days=set(days[:6])
is_tr=np.array([winDay[w] in train_days for w in range(nWin)])
trmask=np.zeros((nWin,BPW),bool); trmask[is_tr,:]=True
mu=Zin[:,trmask].mean(1); sd=Zin[:,trmask].std(1); sd[sd<1e-6]=1
Zin=(Zin-mu[:,None,None])/sd[:,None,None]
t_lo,t_hi=L-1,BPW-1-HZ
ws=[];ts=[]
for w in range(nWin):
    for tt in range(t_lo,t_hi+1): ws.append(w);ts.append(tt)
ws=np.array(ws);ts=np.array(ts)
DM=(mid[ws,ts+HZ]-mid[ws,ts])*100.0
ycls=np.where(DM<-THR,0,np.where(DM>THR,2,1)).astype(np.int64)
is_event=np.abs(DM)>THR; tr_all=is_tr[ws]
sb=np.clip((secleft[ws,ts]/900.0*6).astype(int),0,5); mb=np.clip((mid[ws,ts]*5).astype(int),0,4)
strat=sb*5+mb; rng=np.random.default_rng(0); keep=np.zeros(len(ws),bool)
for split in [tr_all,~tr_all]:
    ev=split&is_event; ct=split&(~is_event); keep|=ev
    ev_idx=np.where(ev)[0]; ct_idx=np.where(ct)[0]; ev_str=strat[ev_idx]; ct_str=strat[ct_idx]
    for s in np.unique(ev_str):
        need=int((ev_str==s).sum()); pool=ct_idx[ct_str==s]
        if len(pool)==0: continue
        pick=rng.choice(pool,size=min(need,len(pool)),replace=False); keep[pick]=True
si=np.where(keep)[0]
ws,ts,DM,ycls,tr_all=ws[si],ts[si],DM[si],ycls[si],tr_all[si]

def build_X(wv,tv):
    N=len(wv); X=np.empty((N,K*L),np.float32); base_t=tv-(L-1)
    for o in range(L): X[:,o*K:(o+1)*K]=Zin[:,wv,base_t+o].T
    stat=np.stack([secleft[wv,tv]/900.0,mid[wv,tv],distraw[wv,tv]],1).astype(np.float32)
    return np.concatenate([X,stat],1)
X=build_X(ws,ts); Din=X.shape[1]
LAB=label[ws].astype(np.float32); LABM=(LAB>=0).astype(np.float32)
Xt=torch.tensor(X,device=dev); yt=torch.tensor(ycls,device=dev)
LABt=torch.tensor(np.clip(LAB,0,1),device=dev); LABMt=torch.tensor(LABM,device=dev)
trm=torch.tensor(tr_all,device=dev); tr_i=torch.where(trm)[0]
cnt=np.bincount(ycls[tr_all],minlength=3).astype(np.float64); cnt[cnt==0]=1
cw=torch.tensor((cnt.sum()/(3*cnt)),dtype=torch.float32,device=dev)
Ntr=int(trm.sum())
print(f'sample set: N={len(ws)} train={Ntr} Din={Din} | dev={torch.cuda.get_device_name(0)}',flush=True)
Xtr=Xt[tr_i]; ytr=yt[tr_i]; LABtr=LABt[tr_i]; LABMtr=LABMt[tr_i]

# ============================================================ single-net
class MLP(nn.Module):
    def __init__(self,Din,W):
        super().__init__()
        self.f=nn.Sequential(nn.Linear(Din,W),nn.GELU(),nn.Linear(W,W),nn.GELU())
        self.dir=nn.Linear(W,3); self.settle=nn.Linear(W,1)
    def forward(self,x):
        h=self.f(x); return self.dir(h), self.settle(h).squeeze(-1)

def run_single(tf32=False, fused=False, compile_=False, tag=''):
    torch.backends.cuda.matmul.allow_tf32=tf32
    torch.backends.cudnn.allow_tf32=tf32
    torch.manual_seed(0)
    net=MLP(Din,WIDTH).to(dev)
    npar=sum(p.numel() for p in net.parameters())
    opt=torch.optim.AdamW(net.parameters(),lr=1e-3,weight_decay=0.05,fused=fused)
    ce=nn.CrossEntropyLoss(weight=cw,label_smoothing=0.1)
    bce=nn.BCEWithLogitsLoss(reduction='none')
    def step():
        logits,sl=net(Xtr)
        ldir=ce(logits,ytr)
        lset=(bce(sl,LABtr)*LABMtr).sum()/(LABMtr.sum()+1e-6)
        loss=ldir+0.3*lset
        opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
        return loss
    stepf = torch.compile(step) if compile_ else step
    for _ in range(WARM): stepf()
    torch.cuda.synchronize(); t0=time.time()
    for _ in range(ITERS): stepf()
    torch.cuda.synchronize(); dt=time.time()-t0
    eps=ITERS/dt
    print(f'  [{tag:32s}] {eps:8.1f} ep/s  ({npar} params)',flush=True)
    return eps

print('\n=== SINGLE-NET (replicates grok_train_C step) ===',flush=True)
b0=run_single(tag='0 baseline fp32')
b1=run_single(tf32=True, tag='1 +TF32')
b2=run_single(tf32=True, fused=True, tag='2 +TF32 +fused AdamW')
try:
    b3=run_single(tf32=True, fused=True, compile_=True, tag='3 +TF32 +fused +compile')
except Exception as e:
    b3=None; print(f'  compile FAILED: {repr(e)[:120]}',flush=True)

# ============================================================ batched ensemble
def run_batched(E, tf32=True, fused=True, tag=''):
    """E independent MLPs sharing X, stacked weights, one bmm pass trains all."""
    torch.backends.cuda.matmul.allow_tf32=tf32
    g=torch.Generator(device=dev).manual_seed(0)
    def init_lin(ein,out):
        # kaiming-uniform-ish; shape [E,ein,out] so forward is bmm(x,[E,ein,out])
        w=torch.empty(E,ein,out,device=dev); b=torch.empty(E,1,out,device=dev)
        bound=1/np.sqrt(ein)
        w.uniform_(-bound,bound,generator=g); b.uniform_(-bound,bound,generator=g)
        return nn.Parameter(w), nn.Parameter(b)
    W1,b1=init_lin(Din,WIDTH); W2,b2=init_lin(WIDTH,WIDTH)
    Wd,bd=init_lin(WIDTH,3);   Ws,bs=init_lin(WIDTH,1)
    params=[W1,b1,W2,b2,Wd,bd,Ws,bs]
    npar=sum(p.numel() for p in params)//E
    opt=torch.optim.AdamW(params,lr=1e-3,weight_decay=0.05,fused=fused)
    Xb=Xtr.unsqueeze(0).expand(E,-1,-1)          # [E,N,Din] (view, no copy)
    yb=ytr.unsqueeze(0).expand(E,-1)             # shared target here (bench)
    cwb=cw.view(1,1,3)
    def step():
        h=torch.baddbmm(b1,Xb,W1); h=F.gelu(h)   # [E,N,W]
        h=torch.baddbmm(b2,h,W2);  h=F.gelu(h)
        logits=torch.baddbmm(bd,h,Wd)            # [E,N,3]
        sl=torch.baddbmm(bs,h,Ws).squeeze(-1)    # [E,N]
        logp=F.log_softmax(logits,dim=2)
        # class-weighted label-smoothed CE, per ensemble, summed
        oneh=F.one_hot(yb,3).float()
        smooth=oneh*0.9+0.1/3
        wsel=(cwb*oneh).sum(-1)                   # [E,N] per-sample class weight
        ce=-(smooth*logp).sum(-1)*wsel
        ldir=ce.mean(1).sum()                     # sum over E
        lset=(F.binary_cross_entropy_with_logits(sl,LABtr.expand(E,-1),reduction='none')
              *LABMtr).sum()/(E*LABMtr.sum()+1e-6)*E
        loss=ldir+0.3*lset
        opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
        return loss
    for _ in range(WARM): step()
    torch.cuda.synchronize(); t0=time.time()
    it=max(ITERS//2,200)
    for _ in range(it): step()
    torch.cuda.synchronize(); dt=time.time()-t0
    eps=it/dt; neteps=eps*E
    print(f'  [{tag:32s}] {eps:8.1f} batch-ep/s  x{E} = {neteps:9.1f} NET-ep/s  ({npar}/net)',flush=True)
    return neteps

print('\n=== BATCHED ENSEMBLE (TF32 + fused, one bmm trains all E) ===',flush=True)
res={}
for E in ([4,16,64] if QUICK else [2,4,8,16,32,64,128]):
    try:
        res[E]=run_batched(E, tag=f'E={E}')
    except RuntimeError as e:
        print(f'  E={E} OOM/err: {repr(e)[:80]}',flush=True); break

print('\n=== SUMMARY ===',flush=True)
print(f'single baseline        : {b0:8.1f} ep/s',flush=True)
print(f'single +TF32           : {b1:8.1f} ep/s  ({b1/b0:.2f}x)',flush=True)
print(f'single +TF32+fused     : {b2:8.1f} ep/s  ({b2/b0:.2f}x)',flush=True)
if b3: print(f'single +compile        : {b3:8.1f} ep/s  ({b3/b0:.2f}x)',flush=True)
best_single=max(x for x in [b0,b1,b2,b3] if x)
for E,ne in res.items():
    print(f'batched E={E:<3d}          : {ne:8.1f} NET-ep/s  ({ne/best_single:.1f}x vs best single)',flush=True)
