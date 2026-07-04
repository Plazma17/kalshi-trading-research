"""
grok_train_D.py  — MODE D: the DIET FLEET.  Many grok-regime nets, each fed a
DIFFERENT restricted channel diet aimed at a DIFFERENT target, to see whether
giving a net a specific slice of data reveals a pattern it can follow (grok).

Extends grok_train_C.py's machinery (same tiny-MLP grok regime: ~24-56k params,
wd 0.1, label-smoothing 0.1, full-batch AdamW, LR 1e-3 + 1000-ep warmup, 100k
epochs, class-balanced CE, chrono holdout days 7-9, checkpoint-resumable).  Each
run writes progress_D<k>.json in the EXACT curves format the GROK MONITOR auto-
discovers (diracc_*=[acc, aucA, aucB]) + ckpt_D<k>.pt + logs to run_D<k>.log.

DIETS (channel keep-list per run is printed at launch + stored in the json):
  D1  FLOW         {tfi,btcobi,tvol}                        -> 3-class dir Dmid@120s
  D2  PRICE        {mid,dist}                               -> 3-class dir  (momentum control)
  D3  VOL/LIQ      {sig,btcspread,spread,tvol}              -> 3-class |Dmid|@120s magnitude
  D4  CROSS-ASSET  {eth,sol}  (NO btc/mid, pure exogenous)  -> 3-class dir
  D5  GEOM/TIME    {dist,secleft,|mid-0.5|,spread}          -> settle YES/NO (real labels)
  D6  GEOM/TIME    same inputs                              -> oscillatory-vs-lockout
  D7  FULL PRUNED  (C's 10 ch)                              -> oscillatory-vs-lockout
  D8  FULL PRUNED  (C's 10 ch)                              -> big-move-coming (event-vs-control)
  D9  FLOW+CONCORD {tfi,btcobi,tvol, sign(tfi)*sign(btcobi)}-> 3-class dir
  D10 RANDOM-CTRL  3 random pruned ch, SHUFFLED targets     -> 3-class dir (null diet)

Sample sets: 'event' = C's event+matched-control (w,t) set (dir/mag/event targets);
             'window'= all-windows, one sample per window per decision time T in
                       {180s,360s} (settle / oscillatory targets).
Chrono split identical to A/B/C: train days[:6], holdout days[6:].

Usage:  python grok_train_D.py D1        (GROKD_EPOCHS overrides 100000; GROKD_CPU forces cpu)
"""
import numpy as np, torch, torch.nn as nn, json, os, sys, time
torch.manual_seed(0); np.random.seed(0)

RUN = (sys.argv[1] if len(sys.argv) > 1 else 'D1').upper()
GD  = r'C:\Users\Noah\claude-workspace\grok'
dev = 'cpu' if os.environ.get('GROKD_CPU') else ('cuda' if torch.cuda.is_available() else 'cpu')

# ---------------- shared config (C's grok regime) ----------------
L      = 30            # context bins (5 min, 10s/bin)
HZ     = 12            # 120s horizon in bins
THR    = 2.0          # cents: |Dmid|>THR = direction event ; <=THR = flat
WIDTH  = 128
LR     = 1e-3
WARMUP = 1000
LS     = 0.1
WD     = 0.10         # strong weight decay (grok regime)
EPOCHS = int(os.environ.get('GROKD_EPOCHS', 100000))
EVAL_EVERY = 50
CKPT_EVERY = 200
TBINS  = [18, 36]     # decision times T=180s, 360s (secleft 720/540) for window sampleset
PRUNED = ['mid','spread','dist','tfi','btcobi','tvol','btcspread','sig','eth','sol']

# channel spec: ('raw',name) | ('secleft',) | ('absmid',) | ('concord',)
CONFIGS = {
 'D1' : dict(chan=[('raw','tfi'),('raw','btcobi'),('raw','tvol')],                 target='dir',    samp='event'),
 'D2' : dict(chan=[('raw','mid'),('raw','dist')],                                   target='dir',    samp='event'),
 'D3' : dict(chan=[('raw','sig'),('raw','btcspread'),('raw','spread'),('raw','tvol')], target='mag', samp='event'),
 'D4' : dict(chan=[('raw','eth'),('raw','sol')],                                    target='dir',    samp='event'),
 'D5' : dict(chan=[('raw','dist'),('secleft',),('absmid',),('raw','spread')],       target='settle', samp='window'),
 'D6' : dict(chan=[('raw','dist'),('secleft',),('absmid',),('raw','spread')],       target='osc',    samp='window'),
 'D7' : dict(chan=[('raw',c) for c in PRUNED],                                      target='osc',    samp='window'),
 'D8' : dict(chan=[('raw',c) for c in PRUNED],                                      target='event',  samp='event'),
 'D9' : dict(chan=[('raw','tfi'),('raw','btcobi'),('raw','tvol'),('concord',)],     target='dir',    samp='event'),
 'D10': dict(chan='random3',                                                        target='dirshuf',samp='event'),
}
cfg = CONFIGS[RUN]
NC  = 2 if cfg['target'] in ('settle','osc','event') else 3

# ---------------- load ----------------
d = np.load(os.path.join(GD,'grok_data.npz'), allow_pickle=True)
names=[str(x) for x in d['names']]; base=[str(x) for x in d['base']]; tf=[str(x) for x in d['tfFam']]
raw = {base[i]:i for i in range(len(names)) if tf[i]=='raw'}
Zall = d['Zimp'].astype(np.float32)                # (331,nWin,BPW) already global-z; we re-z on train
nAll,nWin,BPW = Zall.shape
mid=d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay=d['winDay']; label=d['label']

# resolve random3 diet (D10) w/ its own rng so it's a genuine random pick
if cfg['chan']=='random3':
    rr=np.random.default_rng(1010)
    picks=[str(x) for x in rr.choice(PRUNED, size=3, replace=False)]
    cfg=dict(cfg); cfg['chan']=[('raw',c) for c in picks]
    print(f'D10 random picks: {picks}',flush=True)

# build selected channel stack (K,nWin,BPW)
def chan_array(spec):
    kind=spec[0]
    if kind=='raw':      return Zall[raw[spec[1]]].copy()
    if kind=='secleft':  return (secleft/900.0).astype(np.float32)
    if kind=='absmid':   return np.abs(mid-0.5).astype(np.float32)
    if kind=='concord':  return (np.sign(Zall[raw['tfi']])*np.sign(Zall[raw['btcobi']])).astype(np.float32)
    raise ValueError(spec)
CHAN_NAMES=[s[1] if s[0]=='raw' else s[0] for s in cfg['chan']]
Zsel=np.stack([chan_array(s) for s in cfg['chan']],0)   # (K,nWin,BPW)
K=Zsel.shape[0]
print(f'RUN {RUN} target={cfg["target"]}(NC={NC}) samp={cfg["samp"]} | diet {CHAN_NAMES} | K={K} nWin={nWin} BPW={BPW} dev={dev}',flush=True)

# ---------------- chrono split (same as A/B/C) ----------------
days=sorted(set(winDay.tolist()))
train_days=set(days[:6]); hold_days=set(days[6:])
is_tr=np.array([winDay[w] in train_days for w in range(nWin)])
print('days',days,'train',sorted(train_days),'hold',sorted(hold_days),
      'train_win',int(is_tr.sum()),'hold_win',int((~is_tr).sum()),flush=True)

# ---------------- standardize selected channels on TRAIN bins only ----------------
trmask=np.zeros((nWin,BPW),bool); trmask[is_tr,:]=True
mu=Zsel[:,trmask].mean(1).astype(np.float32); sd=Zsel[:,trmask].std(1).astype(np.float32); sd[sd<1e-6]=1
Zsel=(Zsel-mu[:,None,None])/sd[:,None,None]

# ---------------- build sample set (ws,ts,y,tr_all) ----------------
def build_dir_mag_event():
    """C's event+matched-control (w,t) set. Returns ws,ts,ycls,tr_all + DM for reuse."""
    t_lo,t_hi=L-1,BPW-1-HZ
    ws=[];ts=[]
    for w in range(nWin):
        for tt in range(t_lo,t_hi+1): ws.append(w);ts.append(tt)
    ws=np.array(ws);ts=np.array(ts)
    DM=(mid[ws,ts+HZ]-mid[ws,ts])*100.0
    is_event=np.abs(DM)>THR
    tr_all=is_tr[ws]
    sb=np.clip((secleft[ws,ts]/900.0*6).astype(int),0,5)
    mb=np.clip((mid[ws,ts]*5).astype(int),0,4)
    strat=sb*5+mb
    rng=np.random.default_rng(0)
    keep=np.zeros(len(ws),bool)
    for split in [tr_all,~tr_all]:
        ev=split&is_event; ct=split&(~is_event)
        keep|=ev
        ev_idx=np.where(ev)[0]; ct_idx=np.where(ct)[0]
        ev_str=strat[ev_idx]; ct_str=strat[ct_idx]
        for s in np.unique(ev_str):
            need=int((ev_str==s).sum()); pool=ct_idx[ct_str==s]
            if len(pool)==0: continue
            pick=rng.choice(pool,size=min(need,len(pool)),replace=False); keep[pick]=True
    si=np.where(keep)[0]
    return ws[si],ts[si],DM[si],is_event[si],tr_all[si]

def build_window():
    """all-windows, one sample per window per decision T in TBINS. osc always; settle drops label==-1."""
    ws=[];ts=[]
    for w in range(nWin):
        if cfg['target']=='settle' and label[w]<0: continue
        for tt in TBINS: ws.append(w);ts.append(tt)
    ws=np.array(ws);ts=np.array(ts)
    if cfg['target']=='settle':
        y=np.clip(label[ws],0,1).astype(np.int64)
    else:  # osc: remaining |mid-0.5| crossings >=2 after decision bin t
        y=np.empty(len(ws),np.int64)
        for i,(w,tt) in enumerate(zip(ws,ts)):
            s=np.sign(mid[w,tt+1:]-0.5); s=s[s!=0]
            y[i]= 1 if (len(s)>=2 and int((np.diff(s)!=0).sum())>=2) else 0
    return ws,ts,y,is_tr[ws]

if cfg['samp']=='event':
    ws,ts,DM,is_event,tr_all=build_dir_mag_event()
    if cfg['target'] in ('dir','dirshuf'):
        y=np.where(DM<-THR,0,np.where(DM>THR,2,1)).astype(np.int64)
    elif cfg['target']=='mag':
        aDM=np.abs(DM); y=np.where(aDM<1.0,0,np.where(aDM<=4.0,1,2)).astype(np.int64)
    elif cfg['target']=='event':
        y=is_event.astype(np.int64)
    if cfg['target']=='dirshuf':      # NULL: shuffle labels within each split
        rs=np.random.default_rng(7)
        for split in [tr_all,~tr_all]:
            idx=np.where(split)[0]; y[idx]=y[idx][rs.permutation(len(idx))]
else:
    ws,ts,y,tr_all=build_window()

Ntr=int(tr_all.sum()); Nho=int((~tr_all).sum())
def cc(m): return np.bincount(y[m],minlength=NC).tolist()
print(f'SAMPLES kept {len(ws)} | train {Ntr} {cc(tr_all)} | hold {Nho} {cc(~tr_all)}  (NC={NC})',flush=True)

# ---------------- flattened context X (N, K*L), causal + clamped (leak-safe) ----------------
def build_X(wv,tv):
    N=len(wv); X=np.empty((N,K*L),np.float32); base_t=tv-(L-1)
    for o in range(L):
        cols=np.clip(base_t+o,0,None); cols=np.minimum(cols,tv)   # never index > t (causal), clamp>=0
        X[:,o*K:(o+1)*K]=Zsel[:,wv,cols].T
    return X
X=build_X(ws,ts); Din=X.shape[1]

# trailing-drift dir baseline (dir targets only)
drift=(mid[ws,ts]-mid[ws,np.maximum(ts-6,0)])
drift_dir=np.where(drift>0,2,np.where(drift<0,0,1))

Xt=torch.tensor(X,device=dev); yt=torch.tensor(y,device=dev)
trm=torch.tensor(tr_all,device=dev); tr_i=torch.where(trm)[0]; ho_i=torch.where(~trm)[0]

cnt=np.bincount(y[tr_all],minlength=NC).astype(np.float64); cnt[cnt==0]=1
cw=torch.tensor((cnt.sum()/(NC*cnt)),dtype=torch.float32,device=dev)

# ---------------- baselines ----------------
maj_cls=int(np.bincount(y[tr_all],minlength=NC).argmax())
maj_acc_ho=float((y[~tr_all]==maj_cls).mean())
if cfg['target'] in ('dir','dirshuf'):
    drift_acc_ho=float((drift_dir[~tr_all]==y[~tr_all]).mean())
else:
    drift_acc_ho=float('nan')
print(f'BASELINES holdout | majority(cls{maj_cls}) {maj_acc_ho:.3f} | drift {drift_acc_ho:.3f}',flush=True)

# ---------------- model (single primary head, NC classes) ----------------
class MLP(nn.Module):
    def __init__(self,Din,W,NC):
        super().__init__()
        self.f=nn.Sequential(nn.Linear(Din,W),nn.GELU(),nn.Linear(W,W),nn.GELU())
        self.head=nn.Linear(W,NC)
    def forward(self,x): return self.head(self.f(x))
net=MLP(Din,WIDTH,NC).to(dev)
nparams=sum(p.numel() for p in net.parameters()); print('params',nparams,'Din',Din,flush=True)
opt=torch.optim.AdamW(net.parameters(),lr=LR,weight_decay=WD)
ce=nn.CrossEntropyLoss(weight=cw,label_smoothing=LS)

def auc(score,lab):
    lab=lab.astype(bool); p=score[lab]; n=score[~lab]
    if len(p)==0 or len(n)==0: return float('nan')
    order=np.argsort(np.concatenate([p,n]),kind='mergesort')
    ranks=np.empty(len(order),float); ranks[order]=np.arange(1,len(order)+1)
    return float((ranks[:len(p)].sum()-len(p)*(len(p)+1)/2)/(len(p)*len(n)))

@torch.no_grad()
def evaluate(idx):
    net.eval()
    logits=net(Xt[idx]); prob=torch.softmax(logits,1).cpu().numpy()
    pred=prob.argmax(1); yy=y[idx.cpu().numpy()]
    acc=float((pred==yy).mean())
    if NC==3:
        ud=(yy!=1); aucA=auc((prob[:,2]-prob[:,0])[ud],(yy[ud]==2).astype(int)) if ud.any() else float('nan')
        aucB=auc(1-prob[:,1],(yy!=1).astype(int))
    else:
        aucA=aucB=auc(prob[:,1],(yy==1).astype(int))
    ce_loss=float(nn.functional.cross_entropy(logits,torch.tensor(yy,device=dev)).item())
    net.train(); return acc,aucA,aucB,ce_loss

# ---------------- resume ----------------
CKPT=os.path.join(GD,f'ckpt_{RUN}.pt'); PROG=os.path.join(GD,f'progress_{RUN}.json')
start_ep=0; curves=[]
if os.path.exists(CKPT):
    try:
        ck=torch.load(CKPT,map_location=dev)
        net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt'])
        start_ep=ck['epoch']+1; curves=ck.get('curves',[]); print('resumed from epoch',start_ep,flush=True)
    except Exception as e:
        # corrupt/truncated ckpt (e.g. killed mid-save) -> start fresh instead of crashing the run
        print(f'WARN corrupt ckpt {CKPT} ({repr(e)[:80]}); starting fresh',flush=True)
        start_ep=0; curves=[]

def lr_at(ep): return LR*min(1.0,(ep+1)/WARMUP)
maj_tr=float((y[tr_all]==maj_cls).mean())
print(f'=== RUN {RUN} wd={WD} EPOCHS={EPOCHS} start={start_ep} Din={Din} NC={NC} ===',flush=True)
t0=time.time()
for ep in range(start_ep,EPOCHS):
    net.train()
    for g in opt.param_groups: g['lr']=lr_at(ep)
    loss=ce(net(Xt[tr_i]),yt[tr_i])
    opt.zero_grad(); loss.backward(); opt.step()
    if ep%EVAL_EVERY==0 or ep==EPOCHS-1:
        a_tr,ua_tr,ub_tr,ce_tr=evaluate(tr_i)
        a_ho,ua_ho,ub_ho,ce_ho=evaluate(ho_i)
        row=dict(epoch=ep, tloss=float(loss.item()),
                 diracc_tr=[a_tr,ua_tr,ub_tr], diracc_ho=[a_ho,ua_ho,ub_ho],
                 mae_tr=[ce_tr,0.0,0.0], mae_ho=[ce_ho,0.0,0.0],
                 nc_tr=[maj_tr,0.5,0.5], nc_ho=[maj_acc_ho,0.5,0.5],
                 edge_tr=[a_tr-maj_tr,ua_tr-0.5,ub_tr-0.5],
                 edge_ho=[a_ho-maj_acc_ho,ua_ho-0.5,ub_ho-0.5],
                 settle_tr=a_tr, settle_ho=a_ho,
                 acc_tr=a_tr, acc_ho=a_ho, aucUD_ho=ua_ho, aucEC_ho=ub_ho,
                 sec=round(time.time()-t0,1))
        curves.append(row)
        if len(curves)>5000: curves=curves[:500]+curves[500:][::2]
        json.dump({'mode':RUN,'target':cfg['target'],'samp':cfg['samp'],'diet':CHAN_NAMES,
                   'params':nparams,'wd':WD,'L':L,'HZ':HZ,'K':K,'NC':NC,
                   'baselines':{'majority':maj_acc_ho,'drift':drift_acc_ho},
                   'nc_ho':[maj_acc_ho,0.5,0.5],'curves':curves}, open(PROG,'w'))
        print(f'ep{ep:6d} loss{loss.item():.4f} | accTR {a_tr:.3f} accHO {a_ho:.3f} '
              f'aucA_HO {ua_ho:.3f} aucB_HO {ub_ho:.3f} (maj {maj_acc_ho:.3f}) | {row["sec"]:.0f}s',flush=True)
    if ep%CKPT_EVERY==0 or ep==EPOCHS-1:
        torch.save({'net':net.state_dict(),'opt':opt.state_dict(),'epoch':ep,'curves':curves},CKPT)
torch.save({'net':net.state_dict(),'opt':opt.state_dict(),'epoch':EPOCHS-1,'curves':curves},CKPT)
print('DONE run',RUN,flush=True)
