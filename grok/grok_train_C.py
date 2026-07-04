"""
grok_train_C.py  — MODE C: grokking-optimized CLASSIFIER for CTA local NN.

Design (per Noah's grok-mode-C directive):
  * INPUT PRUNING: raw base channels only, one representative per entanglement
    class. Keep-list (10 ch): mid, spread, dist, tfi, btcobi, tvol, btcspread,
    sig, eth, sol.  ALL transform families (ma/deriv/integral/pastmean/std)
    dropped -- the 30-bin context window makes them derivable; integrals are a
    leak.  ~10 channels x 30-bin context.
  * TARGET = CLASSIFICATION (grokking is a classification phenomenon):
      primary head = 3-class direction of Delta-mid@120s {down<-2c, flat, up>+2c},
      class-balanced CE + label-smoothing 0.1.
      secondary head = settle YES/NO (real labels, the known generalizer), BCE.
      NO regression head.
  * EVENT-FOCUSED SAMPLE SET: funnel path checked but NOT taken (funnel tick
    index space 1,082,692 != mega grid 1,079,690, and funnel events are
    OUTCOME-defined / not-yet-predictable).  Used the sanctioned approximate
    branch: keep samples where |Delta-mid@120s|>2c (events) + an equal number of
    secleft-bucket x mid-bucket MATCHED flat controls (|Delta|<=2c).
  * GROK REGIME: tiny 2-layer MLP on flattened context (~56k params), STRONG
    weight decay (C1=0.05, C2=0.10), full-batch AdamW, low LR w/ warmup,
    label-smoothing 0.1, TRAIN LONG (100,000 epochs), checkpointed + resumable.
  * HOLDOUT: chrono days 7-9 (same split as A/B).  Baselines in-file:
    majority-class, trailing-drift direction, no-change(=flat).
  * GROK READOUT (pre-registered signature): holdout class-accuracy (or
    up-vs-down AUC) rising >5 pts AFTER train accuracy has been >95% for >5000
    epochs.

Usage:  python grok_train_C.py C1        # wd=0.05
        python grok_train_C.py C2        # wd=0.10
Writes progress_<RUN>.json (curves format the GROK MONITOR auto-discovers) +
ckpt_<RUN>.pt (resumable).  Safe to run detached.
"""
import numpy as np, torch, torch.nn as nn, json, os, sys, time
torch.manual_seed(0); np.random.seed(0)

RUN = (sys.argv[1] if len(sys.argv)>1 else 'C1').upper()
WD  = {'C1':0.05, 'C2':0.10}.get(RUN, 0.10)
GD  = r'C:\Users\Noah\claude-workspace\grok'
dev = 'cpu' if os.environ.get('GROKC_CPU') else ('cuda' if torch.cuda.is_available() else 'cpu')

# ---------------- config ----------------
KEEP   = ['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol']
L      = 30            # context bins (5 min)
HZ     = 12            # 120s horizon in bins
THR    = 2.0          # cents: |Delta|>THR = event ; <=THR = flat
WIDTH  = 128
LR     = 1e-3
WARMUP = 1000
LS     = 0.1          # label smoothing
EPOCHS = int(os.environ.get('GROKC_EPOCHS', 100000))
EVAL_EVERY = 50
CKPT_EVERY = 200

# ---------------- load + select pruned raw channels ----------------
d = np.load(os.path.join(GD,'grok_data.npz'), allow_pickle=True)
names=[str(x) for x in d['names']]; base=[str(x) for x in d['base']]; tf=[str(x) for x in d['tfFam']]
raw = {base[i]:i for i in range(len(names)) if tf[i]=='raw'}
sel = [raw[k] for k in KEEP]                       # indices into full 331 stack
Zall = d['Zimp'].astype(np.float32)                # (331,nWin,BPW)
Zin = Zall[sel]                                     # (10,nWin,BPW)
K,nWin,BPW = Zin.shape
mid=d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay=d['winDay']; label=d['label']
distraw = Zall[raw['dist']]                         # for a static feature (already z)
print(f'RUN {RUN} wd={WD} | keep {KEEP} | K={K} nWin={nWin} BPW={BPW} dev={dev}',flush=True)

# ---------------- chrono split (same as A/B) ----------------
days=sorted(set(winDay.tolist()))
train_days=set(days[:6]); hold_days=set(days[6:])
is_tr=np.array([winDay[w] in train_days for w in range(nWin)])
print('days',days,'train',sorted(train_days),'hold',sorted(hold_days),
      'train_win',int(is_tr.sum()),'hold_win',int((~is_tr).sum()),flush=True)

# ---------------- standardize channels on TRAIN bins only ----------------
trmask=np.zeros((nWin,BPW),bool); trmask[is_tr,:]=True
mu=Zin[:,trmask].mean(1).astype(np.float32); sd=Zin[:,trmask].std(1).astype(np.float32); sd[sd<1e-6]=1
Zin=(Zin-mu[:,None,None])/sd[:,None,None]

# ---------------- candidate samples (w,t) ----------------
t_lo, t_hi = L-1, BPW-1-HZ
ws=[]; ts=[]
for w in range(nWin):
    for tt in range(t_lo,t_hi+1):
        ws.append(w); ts.append(tt)
ws=np.array(ws); ts=np.array(ts)
DM = (mid[ws,ts+HZ]-mid[ws,ts])*100.0               # Delta-mid@120s in cents
# 3-class label: 0 down, 1 flat, 2 up
ycls = np.where(DM<-THR,0, np.where(DM>THR,2,1)).astype(np.int64)
is_event = np.abs(DM)>THR
tr_all = is_tr[ws]

# ---------------- event-focused sampling w/ matched flat controls ----------------
# match controls to events on (secleft-bucket x mid-bucket), per split separately
def secbucket(w,t): return np.clip((secleft[w,t]/900.0*6).astype(int),0,5)
def midbucket(w,t): return np.clip((mid[w,t]*5).astype(int),0,4)
sb = secbucket(ws,ts); mb = midbucket(ws,ts)
strat = sb*5+mb
rng=np.random.default_rng(0)
keep_mask=np.zeros(len(ws),bool)
for split_mask in [tr_all, ~tr_all]:
    ev = split_mask & is_event
    ct = split_mask & (~is_event)
    keep_mask |= ev                                 # keep all events in this split
    # per stratum, sample flats to match the event count
    ev_idx=np.where(ev)[0]; ct_idx=np.where(ct)[0]
    ev_str=strat[ev_idx]; ct_str=strat[ct_idx]
    for s in np.unique(ev_str):
        need=int((ev_str==s).sum())
        pool=ct_idx[ct_str==s]
        if len(pool)==0: continue
        pick=rng.choice(pool, size=min(need,len(pool)), replace=False)
        keep_mask[pick]=True
sel_idx=np.where(keep_mask)[0]
ws=ws[sel_idx]; ts=ts[sel_idx]; DM=DM[sel_idx]; ycls=ycls[sel_idx]; tr_all=tr_all[sel_idx]
Ntr=int(tr_all.sum()); Nho=int((~tr_all).sum())
def cls_counts(m):
    c=np.bincount(ycls[m],minlength=3); return c.tolist()
print(f'SAMPLES kept {len(ws)} | train {Ntr} {cls_counts(tr_all)} | hold {Nho} {cls_counts(~tr_all)}  (classes=[down,flat,up])',flush=True)

# ---------------- precompute flattened context X (N, K*L) + static ----------------
def build_X(wv,tv):
    N=len(wv); X=np.empty((N,K*L),np.float32)
    base_t=tv-(L-1)
    for o in range(L):
        cols=base_t+o
        X[:,o*K:(o+1)*K] = Zin[:,wv,cols].T          # (N,K)
    stat=np.stack([secleft[wv,tv]/900.0, mid[wv,tv], distraw[wv,tv]],1).astype(np.float32)
    return np.concatenate([X,stat],1)
X = build_X(ws,ts)
Din = X.shape[1]
LAB = label[ws].astype(np.float32); LABM=(LAB>=0).astype(np.float32)
# trailing-drift direction baseline: sign of mid[t]-mid[t-6] (last 60s)
drift = (mid[ws,ts]-mid[ws,np.maximum(ts-6,0)])
drift_dir = np.where(drift>0,2,np.where(drift<0,0,1))

Xt=torch.tensor(X,device=dev); yt=torch.tensor(ycls,device=dev)
LABt=torch.tensor(np.clip(LAB,0,1),device=dev); LABMt=torch.tensor(LABM,device=dev)
trm=torch.tensor(tr_all,device=dev); hom=~trm
tr_i=torch.where(trm)[0]; ho_i=torch.where(hom)[0]

# class weights (inverse freq on train) for balanced CE
cnt=np.bincount(ycls[tr_all],minlength=3).astype(np.float64); cnt[cnt==0]=1
cw=torch.tensor((cnt.sum()/(3*cnt)),dtype=torch.float32,device=dev)

# ---------------- baselines ----------------
maj_cls=int(np.bincount(ycls[tr_all],minlength=3).argmax())
maj_acc_ho=float((ycls[~tr_all]==maj_cls).mean())
drift_acc_ho=float((drift_dir[~tr_all]==ycls[~tr_all]).mean())
nochange_acc_ho=float((ycls[~tr_all]==1).mean())   # predict flat always
print(f'BASELINES holdout | majority(cls{maj_cls}) {maj_acc_ho:.3f} | trailing-drift {drift_acc_ho:.3f} | no-change(flat) {nochange_acc_ho:.3f}',flush=True)

# ---------------- model (~56k params) ----------------
class MLP(nn.Module):
    def __init__(self,Din,W):
        super().__init__()
        self.f=nn.Sequential(nn.Linear(Din,W),nn.GELU(),nn.Linear(W,W),nn.GELU())
        self.dir=nn.Linear(W,3); self.settle=nn.Linear(W,1)
    def forward(self,x):
        h=self.f(x); return self.dir(h), self.settle(h).squeeze(-1)
net=MLP(Din,WIDTH).to(dev)
nparams=sum(p.numel() for p in net.parameters()); print('params',nparams,flush=True)
opt=torch.optim.AdamW(net.parameters(),lr=LR,weight_decay=WD)
ce=nn.CrossEntropyLoss(weight=cw,label_smoothing=LS)
bce=nn.BCEWithLogitsLoss(reduction='none')

def auc(score,lab):
    # Mann-Whitney AUC ; lab in {0,1}
    lab=lab.astype(bool)
    p=score[lab]; n=score[~lab]
    if len(p)==0 or len(n)==0: return float('nan')
    order=np.argsort(np.concatenate([p,n]),kind='mergesort')
    ranks=np.empty(len(order),float); ranks[order]=np.arange(1,len(order)+1)
    rp=ranks[:len(p)].sum()
    return float((rp-len(p)*(len(p)+1)/2)/(len(p)*len(n)))

@torch.no_grad()
def evaluate(idx):
    net.eval()
    logits,sl=net(Xt[idx])
    prob=torch.softmax(logits,1).cpu().numpy()
    pred=prob.argmax(1); yy=ycls[idx.cpu().numpy()]
    acc=float((pred==yy).mean())
    # up-vs-down AUC (among true up/down), score=P(up)-P(down)
    ud=(yy!=1); sUD=prob[:,2]-prob[:,0]
    aucUD=auc(sUD[ud],(yy[ud]==2).astype(int)) if ud.any() else float('nan')
    # event-vs-control AUC, score=1-P(flat)
    aucEC=auc(1-prob[:,1],(yy!=1).astype(int))
    ce_loss=float(nn.functional.cross_entropy(logits,torch.tensor(yy,device=dev)).item())
    # settle acc (labeled only)
    lm=(LABMt[idx]>0)
    if lm.any():
        pr=(torch.sigmoid(sl[lm])>0.5).float()
        set_acc=float((pr==LABt[idx][lm]).float().mean().item())
    else: set_acc=float('nan')
    net.train()
    return acc,aucUD,aucEC,ce_loss,set_acc

# ---------------- resume ----------------
CKPT=os.path.join(GD,f'ckpt_{RUN}.pt'); PROG=os.path.join(GD,f'progress_{RUN}.json')
start_ep=0; curves=[]
if os.path.exists(CKPT):
    ck=torch.load(CKPT,map_location=dev)
    net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt'])
    start_ep=ck['epoch']+1; curves=ck.get('curves',[])
    print('resumed from epoch',start_ep,flush=True)

def lr_at(ep):
    return LR*min(1.0,(ep+1)/WARMUP)

print(f'=== RUN {RUN} wd={WD} EPOCHS={EPOCHS} start={start_ep} Din={Din} ===',flush=True)
t0=time.time()
for ep in range(start_ep,EPOCHS):
    net.train()
    for g in opt.param_groups: g['lr']=lr_at(ep)
    logits,sl=net(Xt[tr_i])
    ldir=ce(logits, yt[tr_i])
    lm=LABMt[tr_i]
    lset=(bce(sl,LABt[tr_i])*lm).sum()/(lm.sum()+1e-6)
    loss=ldir+0.3*lset
    opt.zero_grad(); loss.backward(); opt.step()
    if ep%EVAL_EVERY==0 or ep==EPOCHS-1:
        a_tr,ud_tr,ec_tr,ce_tr,st_tr=evaluate(tr_i)
        a_ho,ud_ho,ec_ho,ce_ho,st_ho=evaluate(ho_i)
        # ---- curves-format keys the GROK MONITOR expects (arrays where noted) ----
        row=dict(epoch=ep, tloss=float(loss.item()),
                 # diracc_* = the grok readout: [overall_acc, up-vs-down AUC, event-vs-control AUC]
                 diracc_tr=[a_tr,ud_tr,ec_tr], diracc_ho=[a_ho,ud_ho,ec_ho],
                 # mae_* repurposed as loss stand-ins so the monitor's MAE panel shows CE falling
                 mae_tr=[ce_tr,0.0,0.0], mae_ho=[ce_ho,0.0,0.0],
                 nc_tr=[maj_cls*0+ (float((ycls[tr_all]==maj_cls).mean())),0.5,0.5],
                 nc_ho=[maj_acc_ho,0.5,0.5],
                 edge_tr=[a_tr-float((ycls[tr_all]==maj_cls).mean()), ud_tr-0.5, ec_tr-0.5],
                 edge_ho=[a_ho-maj_acc_ho, ud_ho-0.5, ec_ho-0.5],
                 settle_tr=st_tr, settle_ho=st_ho,
                 # explicit extras (clarity; monitor ignores unknown keys)
                 acc_tr=a_tr, acc_ho=a_ho, aucUD_ho=ud_ho, aucEC_ho=ec_ho,
                 sec=round(time.time()-t0,1))
        curves.append(row)
        # keep progress file bounded: log-thin OLDER entries; NEVER drop the early curve
        if len(curves) > 5000:
            curves = curves[:500] + curves[500:][::2]
        json.dump({'mode':RUN,'params':nparams,'wd':WD,'L':L,'HZ':HZ,'K':K,'keep':KEEP,
                   'baselines':{'majority':maj_acc_ho,'drift':drift_acc_ho,'nochange':nochange_acc_ho},
                   'nc_ho':[maj_acc_ho,0.5,0.5],'curves':curves}, open(PROG,'w'))
        print(f'ep{ep:6d} loss{loss.item():.4f} | accTR {a_tr:.3f} accHO {a_ho:.3f} '
              f'aucUD_HO {ud_ho:.3f} aucEC_HO {ec_ho:.3f} setHO {st_ho:.3f} | {row["sec"]:.0f}s',flush=True)
    if ep%CKPT_EVERY==0 or ep==EPOCHS-1:
        torch.save({'net':net.state_dict(),'opt':opt.state_dict(),'epoch':ep,'curves':curves},CKPT)
torch.save({'net':net.state_dict(),'opt':opt.state_dict(),'epoch':EPOCHS-1,'curves':curves},CKPT)
print('DONE run',RUN,flush=True)
