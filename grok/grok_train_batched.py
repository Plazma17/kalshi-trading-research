"""
grok_train_batched.py — BATCHED-ENSEMBLE grok trainer.

Trains MANY grok-regime nets SIMULTANEOUSLY as one stacked GPU computation. The
farm's nets are tiny (24-56k params, full-batch) so a single run leaves an RTX
5070 ~99% idle; stacking E nets' weight matrices into [E, in, out] tensors and
using one `baddbmm` pass trains the whole group at the near-identical wall-clock
cost of one net. Measured ~= (see speed_report.md) net-epochs/sec vs single.

Each net still writes its OWN progress_<id>.json in the EXACT curves format the
GROK MONITOR auto-discovers (diracc_*=[acc,aucA,aucB], mae_*, nc_*, edge_*,
settle_*, acc_*, aucUD_ho, aucEC_ho) + ckpt_<BATCH>.pt (all nets, resumable) +
run_<BATCH>.log.  Progress writes are ATOMIC (temp + os.replace, kills monitor
torn-reads at the source) and THROTTLED to <=1 write / 2 s per run.

WHAT CAN SHARE A BATCH (the queue's grouping key): nets with the SAME
  * sample set  (samp: 'event' = C's event+matched-control (w,t) set, or
                 'window' = one sample per window per decision T in {180,360}s)
  * class count NC (all 3-class dir/mag, OR all 2-class settle/osc/event)
Within a batch, nets may DIFFER freely in: input DIET (channel keep-list ->
per-net input mask over a shared superset feature bank), TARGET labeling of the
shared sample set, weight decay, label smoothing, and seed.  This is exactly the
C-sweep (C1 wd=.05 / C2 wd=.10) and the D diet-fleet (D1..D9) — see BATCHES.

Numerics identity: per-channel z-scoring is INDEPENDENT per channel, so a channel
standardized in the shared superset bank equals that channel standardized inside
any diet subset.  Masked-out input columns contribute exactly 0 to the forward
AND receive 0 gradient, so a masked net is functionally identical to the real
diet net (decoupled-AdamW weight-decay on the dead rows never touches live
weights).  VERIFIED (grok_verify_batched.py): batched vs single-net is BIT-EXACT
through the linear-descent phase (ep 0-~350, diff ~1e-5); past that, full-batch GD
is chaotic and the two GEMM reduction orders (baddbmm vs F.linear) diverge like a
chaotic system -- this PERSISTS in float64, so it is intrinsic to full-batch
training, NOT a batched-trainer defect (the original trainer is likewise not
bit-reproducible across driver/hardware/batch-order). Holdout acc/AUC agree within
~1-2% throughout => the SAME statistical grok curve, fully adequate for the
qualitative late-holdout-rise readout.

Usage:  python grok_train_batched.py C          # C-sweep: C1(wd.05)+C2(wd.10) as ONE 2-net batch
        python grok_train_batched.py Dflow      # D-family 3-class event nets in one batch
        GROKB_EPOCHS=1000000 python grok_train_batched.py C   # extension pass
Env:    GROKB_EPOCHS (default 100000), GROKB_CPU=1 to force cpu.
"""
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F, json, os, sys, time
torch.manual_seed(0); np.random.seed(0)

BATCH = (sys.argv[1] if len(sys.argv) > 1 else 'C')
GD  = r'C:\Users\Noah\claude-workspace\grok'
dev = 'cpu' if os.environ.get('GROKB_CPU') else ('cuda' if torch.cuda.is_available() else 'cpu')
if dev == 'cuda':
    torch.backends.cuda.matmul.allow_tf32 = True     # tensor-core matmul (free ~1.1x, grok is wd-tolerant)
    torch.backends.cudnn.allow_tf32 = True

# ---------------- shared grok-regime config ----------------
L, HZ, THR = 30, 12, 2.0
WIDTH, LR, WARMUP, LS_DEFAULT = 128, 1e-3, 1000, 0.1
EPOCHS = int(os.environ.get('GROKB_EPOCHS', 100000))
EVAL_EVERY, CKPT_EVERY = 50, 200
WRITE_MIN_INTERVAL = 2.0        # s; throttle per-run progress json writes
TBINS = [18, 36]                # window-sample decision times (180s, 360s)
PRUNED = ['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol']

# ============================================================ BATCH DEFINITIONS
# Each net: id, diet (channel specs), target, wd, ls(optional), seed(optional).
# channel spec: raw name in PRUNED, or special 'secleft'/'absmid'/'concord'.
# A batch shares samp + NC (enforced below).
def _dir(idbase, diet, wds):   # helper: same diet/target, wd sweep
    return [dict(id=f'{idbase}{i+1}', diet=diet, target='dir', wd=w, seed=s)
            for i,(w,s) in enumerate(wds)]

BATCHES = {
    # --- C-sweep reproduced as ONE batch (drop-in for launch_grok_C.sh) ---
    'C': dict(samp='event', nets=[
        dict(id='C1', diet=PRUNED, target='dir', wd=0.05, seed=0, settle_head=True),
        dict(id='C2', diet=PRUNED, target='dir', wd=0.10, seed=0, settle_head=True),
    ]),
    # --- D diet-fleet, 3-class event family, all in ONE batch ---
    'Dflow': dict(samp='event', nets=[
        dict(id='D1', diet=['tfi','btcobi','tvol'],                 target='dir',  wd=0.10, seed=0),
        dict(id='D2', diet=['mid','dist'],                          target='dir',  wd=0.10, seed=0),
        dict(id='D4', diet=['eth','sol'],                           target='dir',  wd=0.10, seed=0),
        dict(id='D9', diet=['tfi','btcobi','tvol','concord'],       target='dir',  wd=0.10, seed=0),
        dict(id='D3', diet=['sig','btcspread','spread','tvol'],     target='mag',  wd=0.10, seed=0),
        dict(id='D10',diet=['__rand3__'],                           target='dirshuf', wd=0.10, seed=0),
    ]),
    # --- wd x seed grok sweep example (12 nets, identical diet/target) ---
    'sweep': dict(samp='event', nets=_dir('S',
        PRUNED, [(w,s) for w in (0.02,0.05,0.1,0.2) for s in (0,1,2)])),
}

spec = BATCHES[BATCH]
SAMP = spec['samp']
NETS = spec['nets']

# ---------------- load data ----------------
d = np.load(os.path.join(GD,'grok_data.npz'), allow_pickle=True)
names=[str(x) for x in d['names']]; base=[str(x) for x in d['base']]; tf=[str(x) for x in d['tfFam']]
raw={base[i]:i for i in range(len(names)) if tf[i]=='raw'}
Zall=d['Zimp'].astype(np.float32); nAll,nWin,BPW=Zall.shape
mid=d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay=d['winDay']; label=d['label']
days=sorted(set(winDay.tolist())); train_days=set(days[:6])
is_tr=np.array([winDay[w] in train_days for w in range(nWin)])
trmask=np.zeros((nWin,BPW),bool); trmask[is_tr,:]=True

# resolve D10 random-3 diet with its own rng (matches grok_train_D)
if BATCH=='Dflow':
    rr=np.random.default_rng(1010); picks=list(rr.choice(PRUNED,size=3,replace=False))
    for n in NETS:
        if n['diet']==['__rand3__']: n['diet']=list(picks)
    print(f'D10 random picks: {picks}',flush=True)

# ---------------- superset feature bank (channels used by ANY net) ----------------
def chan_array(nm):
    if nm in raw:        return Zall[raw[nm]].copy()
    if nm=='secleft':    return (secleft/900.0).astype(np.float32)
    if nm=='absmid':     return np.abs(mid-0.5).astype(np.float32)
    if nm=='concord':    return (np.sign(Zall[raw['tfi']])*np.sign(Zall[raw['btcobi']])).astype(np.float32)
    raise ValueError(nm)
SUPER = []                                        # ordered superset channel names
for n in NETS:
    for c in n['diet']:
        if c not in SUPER: SUPER.append(c)
Ksup = len(SUPER); ci = {c:i for i,c in enumerate(SUPER)}
Zsup = np.stack([chan_array(c) for c in SUPER],0)                 # (Ksup,nWin,BPW)
# per-channel z on TRAIN bins only (independent per channel => diet-faithful)
mu=Zsup[:,trmask].mean(1); sd=Zsup[:,trmask].std(1); sd[sd<1e-6]=1
Zsup=(Zsup-mu[:,None,None])/sd[:,None,None]
print(f'BATCH {BATCH} | samp={SAMP} | {len(NETS)} nets | superset K={Ksup} {SUPER} | dev={dev}',flush=True)

# static features appended after the L*Ksup context block (only 'event' family uses mid/dist/secleft static)
STAT_NAMES = ['secleft_s','mid_s','dist_s']       # matches grok_train_C static block
distz = chan_array('dist'); distz=(distz-distz[trmask].mean())/(distz[trmask].std()+1e-9)

# ---------------- build shared sample set (ws,ts) ----------------
if SAMP=='event':
    t_lo,t_hi=L-1,BPW-1-HZ
    ws=[];ts=[]
    for w in range(nWin):
        for tt in range(t_lo,t_hi+1): ws.append(w);ts.append(tt)
    ws=np.array(ws);ts=np.array(ts)
    DM=(mid[ws,ts+HZ]-mid[ws,ts])*100.0
    is_event=np.abs(DM)>THR; tr_all0=is_tr[ws]
    sb=np.clip((secleft[ws,ts]/900.0*6).astype(int),0,5); mb=np.clip((mid[ws,ts]*5).astype(int),0,4)
    strat=sb*5+mb; rng=np.random.default_rng(0); keep=np.zeros(len(ws),bool)
    for split in [tr_all0,~tr_all0]:
        ev=split&is_event; ct=split&(~is_event); keep|=ev
        ev_idx=np.where(ev)[0]; ct_idx=np.where(ct)[0]; ev_str=strat[ev_idx]; ct_str=strat[ct_idx]
        for s in np.unique(ev_str):
            need=int((ev_str==s).sum()); pool=ct_idx[ct_str==s]
            if len(pool)==0: continue
            pick=rng.choice(pool,size=min(need,len(pool)),replace=False); keep[pick]=True
    si=np.where(keep)[0]; ws,ts,DM,is_event=ws[si],ts[si],DM[si],is_event[si]
else:  # window
    ws=[];ts=[]
    for w in range(nWin):
        for tt in TBINS: ws.append(w);ts.append(tt)
    ws=np.array(ws);ts=np.array(ts)
tr_all=is_tr[ws]; N=len(ws); Ntr=int(tr_all.sum()); Nho=N-Ntr

# ---------------- per-net targets over the shared sample set ----------------
def make_target(target):
    if SAMP=='event':
        if target in ('dir','dirshuf'):
            y=np.where(DM<-THR,0,np.where(DM>THR,2,1)).astype(np.int64); nc=3
        elif target=='mag':
            a=np.abs(DM); y=np.where(a<1.0,0,np.where(a<=4.0,1,2)).astype(np.int64); nc=3
        elif target=='event':
            y=is_event.astype(np.int64); nc=2
        if target=='dirshuf':
            rs=np.random.default_rng(7)
            for split in [tr_all,~tr_all]:
                idx=np.where(split)[0]; y[idx]=y[idx][rs.permutation(len(idx))]
    else:
        if target=='settle':
            y=np.clip(label[ws],0,1).astype(np.int64); nc=2
        else:  # osc
            y=np.empty(N,np.int64)
            for i,(w,tt) in enumerate(zip(ws,ts)):
                s=np.sign(mid[w,tt+1:]-0.5); s=s[s!=0]
                y[i]=1 if (len(s)>=2 and int((np.diff(s)!=0).sum())>=2) else 0
            nc=2
    return y,nc

TARG=[make_target(n['target']) for n in NETS]
NC=TARG[0][1]
assert all(nc==NC for _,nc in TARG), f'batch {BATCH} mixes NC (must group same class count)'
Y=np.stack([y for y,_ in TARG],0)                                # (E,N)

# ---------------- flattened context superset X (N, L*Ksup + [statics]) ----------------
USE_STAT = (SAMP=='event')
Dstat = 3 if USE_STAT else 0
Dsup = L*Ksup + Dstat
def build_X(wv,tv):
    n=len(wv); X=np.empty((n,Dsup),np.float32); base_t=tv-(L-1)
    for o in range(L):
        cols=np.clip(base_t+o,0,None); cols=np.minimum(cols,tv)   # causal + clamp
        X[:,o*Ksup:(o+1)*Ksup]=Zsup[:,wv,cols].T
    if USE_STAT:
        X[:,L*Ksup+0]=secleft[wv,tv]/900.0; X[:,L*Ksup+1]=mid[wv,tv]; X[:,L*Ksup+2]=distz[wv,tv]
    return X
X=build_X(ws,ts)

# ---------------- per-net input MASK over Dsup (diet fidelity) ----------------
def diet_mask(diet):
    m=np.zeros(Dsup,np.float32)
    for c in diet:
        j=ci[c]
        for o in range(L): m[o*Ksup+j]=1.0
    if USE_STAT: m[L*Ksup:]=1.0        # statics available to all event nets (as in C)
    return m
MASK=np.stack([diet_mask(n['diet']) for n in NETS],0)            # (E,Dsup)
E=len(NETS)

# ---------------- to GPU ----------------
Xt=torch.tensor(X,device=dev)
Yt=torch.tensor(Y,device=dev)                                    # (E,N)
Mt=torch.tensor(MASK,device=dev)                                 # (E,Dsup)
trm=torch.tensor(tr_all,device=dev); tr_i=torch.where(trm)[0]; ho_i=torch.where(~trm)[0]
Xtr=Xt[tr_i]; Xho=Xt[ho_i]                                       # (Ntr,Dsup),(Nho,Dsup)
Ytr=Yt[:,tr_i]; Yho=Yt[:,ho_i]                                   # (E,Ntr),(E,Nho)
# masked inputs per net (E,·,Dsup) — expand is a view; multiply materializes once per eval, cheap
def masked(xrows):  # (n,Dsup) -> (E,n,Dsup)
    return xrows.unsqueeze(0)*Mt.unsqueeze(1)

# settle head (event family, C nets) — optional per net; batched as extra head, masked in loss
HAS_SETTLE = any(n.get('settle_head') for n in NETS) and SAMP=='event'
if HAS_SETTLE:
    LAB=label[ws].astype(np.float32); LABM=(LAB>=0).astype(np.float32)
    LABt=torch.tensor(np.clip(LAB,0,1),device=dev); LABMt=torch.tensor(LABM,device=dev)
    SETW=torch.tensor([1.0 if n.get('settle_head') else 0.0 for n in NETS],device=dev)  # (E,)
    LABtr=LABt[tr_i]; LABMtr=LABMt[tr_i]; LABho=LABt[ho_i]; LABMho=LABMt[ho_i]

# per-net class weights (inverse-freq on train)
CW=np.zeros((E,NC),np.float32)
for e in range(E):
    cnt=np.bincount(Y[e][tr_all],minlength=NC).astype(np.float64); cnt[cnt==0]=1
    CW[e]=cnt.sum()/(NC*cnt)
CWt=torch.tensor(CW,device=dev)                                  # (E,NC)
LSv=torch.tensor([n.get('ls',LS_DEFAULT) for n in NETS],device=dev).view(E,1)  # (E,1)
WDv=[n['wd'] for n in NETS]

# baselines per net
def maj_stats(e):
    maj=int(np.bincount(Y[e][tr_all],minlength=NC).argmax())
    return maj, float((Y[e][~tr_all]==maj).mean()), float((Y[e][tr_all]==maj).mean())
MAJ=[maj_stats(e) for e in range(E)]

# ---------------- stacked model ----------------
def init_stack(gen):
    def lin(ein,out):
        w=torch.empty(E,ein,out,device=dev); b=torch.empty(E,1,out,device=dev)
        bound=1.0/np.sqrt(ein)
        w.uniform_(-bound,bound,generator=gen); b.uniform_(-bound,bound,generator=gen)
        return nn.Parameter(w), nn.Parameter(b)
    W1,b1=lin(Dsup,WIDTH); W2,b2=lin(WIDTH,WIDTH); Wd,bd=lin(WIDTH,NC)
    P=[W1,b1,W2,b2,Wd,bd]
    if HAS_SETTLE:
        Ws,bs=lin(WIDTH,1); P+=[Ws,bs]
    return P
gen=torch.Generator(device=dev).manual_seed(0)
P=init_stack(gen)
if HAS_SETTLE: W1,b1,W2,b2,Wd,bd,Ws,bs=P
else:          W1,b1,W2,b2,Wd,bd=P
# per-net weight decay via param-group-less manual decay is awkward; AdamW takes ONE wd.
# Use a single optimizer but scale wd per net by folding it into a per-net multiplier on the
# decoupled decay: simplest exact route = one AdamW per distinct wd value (few groups).
groups=[]
uniq_wd=sorted(set(WDv))
# We can't split a stacked tensor across groups, so apply per-net wd as an explicit decoupled
# decay step (AdamW(weight_decay=0) + manual p -= lr*wd_e*p) — exact AdamW-decoupled semantics.
opt=torch.optim.AdamW(P,lr=LR,weight_decay=0.0,fused=(dev=='cuda'))
WDvec=torch.tensor(WDv,device=dev)                               # (E,)
nparams_per=[int(sum((p[e].numel() for p in P))) for e in range(E)]

def forward(xrows_masked):   # (E,n,Dsup) -> logits (E,n,NC), settle (E,n) or None
    h=F.gelu(torch.baddbmm(b1,xrows_masked,W1))
    h=F.gelu(torch.baddbmm(b2,h,W2))
    logits=torch.baddbmm(bd,h,Wd)
    sl=torch.baddbmm(bs,h,Ws).squeeze(-1) if HAS_SETTLE else None
    return logits,sl

def lr_at(ep): return LR*min(1.0,(ep+1)/WARMUP)

# ---------------- AUC (numpy, Mann-Whitney) ----------------
def auc(score,lab):
    lab=lab.astype(bool); p=score[lab]; n=score[~lab]
    if len(p)==0 or len(n)==0: return float('nan')
    order=np.argsort(np.concatenate([p,n]),kind='mergesort')
    ranks=np.empty(len(order),float); ranks[order]=np.arange(1,len(order)+1)
    return float((ranks[:len(p)].sum()-len(p)*(len(p)+1)/2)/(len(p)*len(n)))

@torch.no_grad()
def evaluate(xrows,Ysub,LABsub=None,LABMsub=None):
    xm=masked(xrows); logits,sl=forward(xm)
    prob=torch.softmax(logits,2).cpu().numpy()                  # (E,n,NC)
    yy=Ysub.cpu().numpy()                                       # (E,n)
    out=[]
    for e in range(E):
        pr=prob[e]; ye=yy[e]; pred=pr.argmax(1); acc=float((pred==ye).mean())
        if NC==3:
            ud=(ye!=1); aucA=auc((pr[:,2]-pr[:,0])[ud],(ye[ud]==2).astype(int)) if ud.any() else float('nan')
            aucB=auc(1-pr[:,1],(ye!=1).astype(int))
        else:
            aucA=aucB=auc(pr[:,1],(ye==1).astype(int))
        ce=float(F.cross_entropy(logits[e],Ysub[e]).item())
        st=float('nan')
        if HAS_SETTLE and NETS[e].get('settle_head') and LABsub is not None:
            lm=LABMsub>0
            if lm.any():
                p=(torch.sigmoid(sl[e][lm])>0.5).float(); st=float((p==LABsub[lm]).float().mean().item())
        out.append((acc,aucA,aucB,ce,st))
    return out

# ---------------- resume ----------------
CKPT=os.path.join(GD,f'ckpt_{BATCH}.pt')
start_ep=0; curves=[[] for _ in range(E)]; last_write=[0.0]*E
if os.path.exists(CKPT):
    ck=torch.load(CKPT,map_location=dev)
    for p,sv in zip(P,ck['P']): p.data.copy_(sv)
    opt.load_state_dict(ck['opt']); start_ep=ck['epoch']+1; curves=ck.get('curves',curves)
    print('resumed from epoch',start_ep,flush=True)

def atomic_write(path,obj):
    tmp=path+'.tmp'
    with open(tmp,'w') as f: json.dump(obj,f)
    os.replace(tmp,path)                                        # atomic on Windows+POSIX -> no torn reads

def write_progress(e,force=False):
    now=time.time()
    if not force and now-last_write[e]<WRITE_MIN_INTERVAL: return
    last_write[e]=now
    n=NETS[e]; maj,maj_ho,maj_tr=MAJ[e]
    atomic_write(os.path.join(GD,f'progress_{n["id"]}.json'),
        {'mode':n['id'],'batch':BATCH,'target':n['target'],'diet':n['diet'],
         'params':nparams_per[e],'wd':n['wd'],'L':L,'HZ':HZ,'K':len(n['diet']),'NC':NC,
         'baselines':{'majority':maj_ho},'nc_ho':[maj_ho,0.5,0.5],'curves':curves[e]})

print(f'=== BATCH {BATCH} E={E} NC={NC} EPOCHS={EPOCHS} start={start_ep} Dsup={Dsup} Ntr={Ntr} Nho={Nho} ===',flush=True)
Xtr_m=masked(Xtr)                                               # (E,Ntr,Dsup) — reused every epoch
# --- precompute the loss-target CONSTANTS (label-smoothed soft targets + per-sample
#     class weights are functions of Ytr only, so build them ONCE, not every epoch) ---
_oneh=F.one_hot(Ytr,NC).float()                                # (E,Ntr,NC)
SMOOTH=(_oneh*(1-LSv.unsqueeze(-1))+LSv.unsqueeze(-1)/NC)       # (E,Ntr,NC) const
WSEL=(CWt.unsqueeze(1)*_oneh).sum(-1)                           # (E,Ntr) const
del _oneh
t0=time.time()
for ep in range(start_ep,EPOCHS):
    lr=lr_at(ep)
    for g in opt.param_groups: g['lr']=lr
    logits,sl=forward(Xtr_m)
    logp=F.log_softmax(logits,2)                               # (E,Ntr,NC)
    ce=(-(SMOOTH*logp).sum(-1)*WSEL).mean(1)                   # (E,)
    loss=ce.sum()
    if HAS_SETTLE:
        lset=(F.binary_cross_entropy_with_logits(sl,LABtr.expand(E,-1),reduction='none')*LABMtr)
        lset=lset.sum(1)/(LABMtr.sum()+1e-6)*SETW              # (E,) only settle nets
        loss=loss+0.3*lset.sum()
    opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
    # per-net decoupled weight decay (exact AdamW semantics, per-net wd)
    with torch.no_grad():
        for p in P:
            p.mul_(1.0-lr*WDvec.view(-1,*([1]*(p.dim()-1))))
    if ep%EVAL_EVERY==0 or ep==EPOCHS-1:
        etr=evaluate(Xtr,Ytr, LABtr if HAS_SETTLE else None, LABMtr if HAS_SETTLE else None)
        eho=evaluate(Xho,Yho, LABho if HAS_SETTLE else None, LABMho if HAS_SETTLE else None)
        for e in range(E):
            a_tr,ua_tr,ub_tr,ce_tr,st_tr=etr[e]; a_ho,ua_ho,ub_ho,ce_ho,st_ho=eho[e]
            maj,maj_ho,maj_tr=MAJ[e]
            row=dict(epoch=ep, tloss=float(ce[e].item()),
                     diracc_tr=[a_tr,ua_tr,ub_tr], diracc_ho=[a_ho,ua_ho,ub_ho],
                     mae_tr=[ce_tr,0.0,0.0], mae_ho=[ce_ho,0.0,0.0],
                     nc_tr=[maj_tr,0.5,0.5], nc_ho=[maj_ho,0.5,0.5],
                     edge_tr=[a_tr-maj_tr,ua_tr-0.5,ub_tr-0.5],
                     edge_ho=[a_ho-maj_ho,ua_ho-0.5,ub_ho-0.5],
                     settle_tr=st_tr, settle_ho=st_ho,
                     acc_tr=a_tr, acc_ho=a_ho, aucUD_ho=ua_ho, aucEC_ho=ub_ho,
                     sec=round(time.time()-t0,1))
            curves[e].append(row)
            if len(curves[e])>5000: curves[e]=curves[e][:500]+curves[e][500:][::2]
            write_progress(e, force=(ep==EPOCHS-1))
        e0=eho[0]
        print(f'ep{ep:6d} loss{loss.item():.3f} | net0 accHO {e0[0]:.3f} aucA {e0[1]:.3f} | '
              f'{E} nets | {time.time()-t0:.0f}s',flush=True)
    if ep%CKPT_EVERY==0 or ep==EPOCHS-1:
        torch.save({'P':[p.data for p in P],'opt':opt.state_dict(),'epoch':ep,'curves':curves},CKPT)
for e in range(E): write_progress(e, force=True)
torch.save({'P':[p.data for p in P],'opt':opt.state_dict(),'epoch':EPOCHS-1,'curves':curves},CKPT)
print('DONE batch',BATCH,flush=True)
