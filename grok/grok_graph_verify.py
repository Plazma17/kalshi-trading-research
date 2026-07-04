"""
grok_graph_verify.py — NUMERIC GATE for the GROK_GRAPH CUDA-graph path.

Proves the captured-graph training step reproduces the EAGER batched step. Two
E-stacked ensembles A (eager) and B (graph-replay) are built from IDENTICAL init +
identical optimizer, run in LOCKSTEP on C's exact static sample set:
  * warmup epochs: both eager (LR ramps).
  * post-warmup:   A keeps stepping eagerly at const LR; B captures the step ONCE
                   (non-destructively, exactly as grok_batch._capture_step) then REPLAYS.
Because graph replay re-runs the SAME kernels on the SAME static tensors, A and B
must stay BIT-IDENTICAL every epoch (max|A-B| ~ 0) — a stronger criterion than the
batched-vs-reference check (no chaotic GEMM-order divergence: same op, same order).

Also compares holdout acc/AUC trajectories (must be identical).

Usage: python grok_graph_verify.py            (V=1500 epochs, warmup=200, E=2)
VERDICT PASS  <=>  weights bit-identical (<1e-6) AND holdout metrics identical.
"""
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, os, sys
torch.manual_seed(0); np.random.seed(0)
torch.backends.cuda.matmul.allow_tf32 = True; torch.backends.cudnn.allow_tf32 = True
GD = r'C:\Users\Noah\claude-workspace\grok'
assert torch.cuda.is_available(), 'CUDA required for graph verification'
dev = 'cuda'
V = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
WARMUP = 200
E = 2
KEEP = ['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol']
L, HZ, THR, WIDTH = 30, 12, 2.0, 128
LR = 1e-3
WDS = [0.05, 0.10]                       # per-net wd (exercise the decoupled-decay path)

# ---- C's exact sample set (mirrors grok_verify_batched / grok_bench) ----
d = np.load(os.path.join(GD,'grok_data.npz'), allow_pickle=True)
names=[str(x) for x in d['names']]; base=[str(x) for x in d['base']]; tf=[str(x) for x in d['tfFam']]
raw={base[i]:i for i in range(len(names)) if tf[i]=='raw'}; sel=[raw[k] for k in KEEP]
Zall=d['Zimp'].astype(np.float32); Zin=Zall[sel]; K,nWin,BPW=Zin.shape
mid=d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay=d['winDay']; distraw=Zall[raw['dist']]
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
    n=len(wv); X=np.empty((n,K*L),np.float32); bt=tv-(L-1)
    for o in range(L): X[:,o*K:(o+1)*K]=Zin[:,wv,bt+o].T
    stat=np.stack([secleft[wv,tv]/900.0,mid[wv,tv],distraw[wv,tv]],1).astype(np.float32)
    return np.concatenate([X,stat],1)
X=build_X(ws,ts); Din=X.shape[1]
Xt=torch.tensor(X,device=dev); yt=torch.tensor(ycls,device=dev)
trm=torch.tensor(tr_all,device=dev); tr_i=torch.where(trm)[0]; ho_i=torch.where(~trm)[0]
Xtr=Xt[tr_i].contiguous(); Xho=Xt[ho_i].contiguous()
Ytr=yt[tr_i].unsqueeze(0).expand(E,-1).contiguous()
cnt=np.bincount(ycls[tr_all],minlength=3).astype(np.float64); cnt[cnt==0]=1
cw=torch.tensor(cnt.sum()/(3*cnt),dtype=torch.float32,device=dev)
oneh=F.one_hot(Ytr,3).float(); SMOOTH=oneh*0.9+0.1/3
WSEL=(cw.view(1,1,3)*oneh).sum(-1)
WDv=torch.tensor(WDS,device=dev)
yho_np=ycls[ho_i.cpu().numpy()]

def auc(score,lab):
    lab=lab.astype(bool); p=score[lab]; n=score[~lab]
    if len(p)==0 or len(n)==0: return float('nan')
    o=np.argsort(np.concatenate([p,n]),kind='mergesort'); r=np.empty(len(o)); r[o]=np.arange(1,len(o)+1)
    return float((r[:len(p)].sum()-len(p)*(len(p)+1)/2)/(len(p)*len(n)))

def build_model():
    g=torch.Generator(device=dev).manual_seed(0)
    def lin(ein,out):
        w=torch.empty(E,ein,out,device=dev); b=torch.empty(E,1,out,device=dev)
        bd=1/np.sqrt(ein); w.uniform_(-bd,bd,generator=g); b.uniform_(-bd,bd,generator=g)
        return nn.Parameter(w), nn.Parameter(b)
    W1,b1=lin(Din,WIDTH); W2,b2=lin(WIDTH,WIDTH); Wd,bd=lin(WIDTH,3)
    P=[W1,b1,W2,b2,Wd,bd]
    opt=torch.optim.AdamW(P,lr=LR,weight_decay=0.0,fused=True,capturable=True)
    def fwd(x,pp):
        W1,b1,W2,b2,Wd,bd=pp
        h=F.gelu(torch.baddbmm(b1,x.unsqueeze(0).expand(E,-1,-1),W1))
        h=F.gelu(torch.baddbmm(b2,h,W2)); return torch.baddbmm(bd,h,Wd)
    def loss_():
        out=fwd(Xtr,P); logp=F.log_softmax(out,2)
        return (-(SMOOTH*logp).sum(-1)*WSEL).mean(1).sum()
    def decay(clr):
        with torch.no_grad():
            for p in P: p.mul_(1.0-clr*WDv.view(-1,*([1]*(p.dim()-1))))
    return P,opt,fwd,loss_,decay

# A = eager, B = graph. Identical init (same generator seed) + copy A->B to be exact.
PA,optA,fwdA,lossA,decayA = build_model()
PB,optB,fwdB,lossB,decayB = build_model()
with torch.no_grad():
    for pa,pb in zip(PA,PB): pb.copy_(pa)

def eager_step(P,opt,loss_,decay,clr):
    for g in opt.param_groups: g['lr']=clr
    for p in P:
        if p.grad is not None: p.grad.zero_()
    loss_().backward(); opt.step(); decay(clr)

# capture B non-destructively (mirrors grok_batch._capture_step)
GB={'g':None,'loss':None}
def capture_B():
    for g in optB.param_groups: g['lr']=LR
    psnap=[p.detach().clone() for p in PB]
    gsnap=[(p.grad.detach().clone() if p.grad is not None else None) for p in PB]
    ost=[optB.state[p] for p in PB]
    osnap=[{k:(v.detach().clone() if torch.is_tensor(v) else v) for k,v in st.items()} for st in ost]
    s=torch.cuda.Stream(); s.wait_stream(torch.cuda.current_stream())
    with torch.cuda.stream(s):
        for _ in range(3):
            for p in PB:
                if p.grad is not None: p.grad.zero_()
            lossB().backward(); optB.step(); decayB(LR)
    torch.cuda.current_stream().wait_stream(s)
    g=torch.cuda.CUDAGraph()
    with torch.cuda.graph(g):
        for p in PB: p.grad.zero_()
        sl=lossB(); sl.backward(); optB.step(); decayB(LR)
    with torch.no_grad():
        for p,sv in zip(PB,psnap): p.copy_(sv)
        for p,gv in zip(PB,gsnap):
            if gv is not None and p.grad is not None: p.grad.copy_(gv)
        for st,sv in zip(ost,osnap):
            for k,v in sv.items():
                if torch.is_tensor(st.get(k)) and torch.is_tensor(v): st[k].copy_(v)
    GB['g']=g; GB['loss']=sl

@torch.no_grad()
def ho_metrics(P,fwd):
    out=fwd(Xho,P); prob=torch.softmax(out,2).cpu().numpy()
    res=[]
    for e in range(E):
        pr=prob[e]; pred=pr.argmax(1); acc=float((pred==yho_np).mean())
        ud=(yho_np!=1); a=auc((pr[:,2]-pr[:,0])[ud],(yho_np[ud]==2).astype(int)) if ud.any() else float('nan')
        res.append((acc,a))
    return res

max_w=0.0; max_m=0.0; captured=False
for ep in range(V):
    if ep < WARMUP:
        clr=LR*min(1.0,(ep+1)/WARMUP)
        eager_step(PA,optA,lossA,decayA,clr)
        eager_step(PB,optB,lossB,decayB,clr)
    else:
        clr=LR
        eager_step(PA,optA,lossA,decayA,clr)
        if GB['g'] is None: capture_B(); captured=True
        GB['g'].replay()
    if ep%50==0 or ep==V-1:
        wd_ = max(float((pa.detach()-pb.detach()).abs().max()) for pa,pb in zip(PA,PB))
        mA=ho_metrics(PA,fwdA); mB=ho_metrics(PB,fwdB)
        md = max(abs(mA[e][0]-mB[e][0]) + (abs(mA[e][1]-mB[e][1]) if mA[e][1]==mA[e][1] else 0) for e in range(E))
        max_w=max(max_w,wd_);
        if ep>=WARMUP: max_m=max(max_m,md)
        tag='(graph active)' if ep>=WARMUP else '(warmup, both eager)'
        print(f'ep{ep:5d} {tag:22s} max|Wa-Wb|={wd_:.3e}  max|metricA-metricB|={md:.3e}  '
              f'accHO A{mA[0][0]:.4f} B{mB[0][0]:.4f}',flush=True)

print(f'\ncaptured graph: {captured}   (epochs post-warmup replayed)')
print(f'MAX weight divergence  A(eager) vs B(graph), whole run : {max_w:.3e}   [expect <1e-6: replay==eager]')
print(f'MAX holdout-metric divergence, post-warmup             : {max_m:.3e}   [expect <1e-6]')
ok = (max_w < 1e-6) and (max_m < 1e-6)
print('VERDICT:', 'PASS — CUDA-graph replay is BIT-IDENTICAL to the eager batched step (same kernels, static tensors)'
      if ok else f'FAIL — graph diverges from eager (w={max_w:.2e}, m={max_m:.2e})')
