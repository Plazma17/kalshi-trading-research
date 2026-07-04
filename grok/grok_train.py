"""
grok_train.py  — local NN to predict FUTURE Kalshi mid (delta) + settle prob.

Modes:
  A  : chrono 6-day train / 3-day holdout generalization screen (early stop).
  B  : grokking probe (strong weight decay, thousands of epochs, dense curves).

Usage:
  python grok_train.py A
  python grok_train.py B

Checkpointed + resumable. Writes progress_{mode}.json (dense curves) every eval,
and ckpt_{mode}.pt each checkpoint. Safe to run detached in background.

Target = Delta-mid in CENTS over {60,120,240}s (6/12/24 bins). No-change (Delta=0)
is THE martingale null; we log the net's edge over it every eval.
Inputs are CAUSAL only (context strictly <= t; integral channels excluded).
"""
import numpy as np, torch, torch.nn as nn, json, os, sys, time, math
torch.manual_seed(0); np.random.seed(0)

MODE = (sys.argv[1] if len(sys.argv)>1 else 'A').upper()
GD  = r'C:\Users\Noah\claude-workspace\grok'
dev = 'cuda' if torch.cuda.is_available() else 'cpu'

# ---------------- config ----------------
L        = 30           # context bins (5 min)
H        = [6,12,24]    # horizons in bins (60/120/240 s)
HMAX     = max(H)
if MODE=='A':
    WD=1e-4; EPOCHS=400; LR=1.5e-3; EVAL_EVERY=2; CKPT_EVERY=10; PATIENCE=40; WIDTH=128
else:  # B grokking
    WD=3e-2; EPOCHS=8000; LR=1e-3; EVAL_EVERY=10; CKPT_EVERY=50; PATIENCE=10**9; WIDTH=96

d = np.load(os.path.join(GD,'grok_data.npz'), allow_pickle=True)
causal = d['causal']
Zin = d['Zimp'][causal].astype(np.float32)      # (K,nWin,BPW)
K,nWin,BPW = Zin.shape
mid = d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay = d['winDay']; label=d['label']
ya=d['ya']; na=d['na']; yb=d['yb']; nb=d['nb']

# ---- chrono split: first 6 present days train, last 3 holdout ----
days = sorted(set(winDay.tolist()))
train_days = set(days[:6]); hold_days=set(days[6:])
is_tr = np.array([winDay[w] in train_days for w in range(nWin)])
print('days',days,'train_days',sorted(train_days),'hold_days',sorted(hold_days),
      'train win',int(is_tr.sum()),'hold win',int((~is_tr).sum()),flush=True)

# ---- per-channel standardize using TRAIN bins only (remove any global-fit leak) ----
trmask = np.zeros((nWin,BPW),bool); trmask[is_tr,:]=True
mu = Zin[:,trmask].mean(1).astype(np.float32)
sd = Zin[:,trmask].std(1).astype(np.float32); sd[sd<1e-6]=1
Zin = (Zin - mu[:,None,None]) / sd[:,None,None]

# ---- build sample index list (w,t): t in [L-1, BPW-1-HMAX] ----
t_lo, t_hi = L-1, BPW-1-HMAX
ws=[]; ts=[]
for w in range(nWin):
    for tt in range(t_lo, t_hi+1):
        ws.append(w); ts.append(tt)
ws=np.array(ws); ts=np.array(ts)
tr = is_tr[ws];
tr_idx=np.where(tr)[0]; ho_idx=np.where(~tr)[0]
print('samples total',len(ws),'train',len(tr_idx),'hold',len(ho_idx),flush=True)

# ---- targets (cents) ----
def dmid_cents(w,tt,h): return (mid[w,tt+h]-mid[w,tt])*100.0
DM = np.stack([ (mid[ws,ts+h]-mid[ws,ts])*100.0 for h in H ],1).astype(np.float32)  # (N,3)
STAT = np.stack([ secleft[ws,ts]/900.0, mid[ws,ts], np.maximum(mid[ws,ts],1-mid[ws,ts]) ],1).astype(np.float32)
LAB = label[ws].astype(np.float32)         # window settle (repeated); -1 = none
LABM = (LAB>=0).astype(np.float32)
SDAY = winDay[ws]

# tensors on device
Zt   = torch.tensor(Zin, device=dev)                 # (K,nWin,BPW)
wsT  = torch.tensor(ws, device=dev)
tsT  = torch.tensor(ts, device=dev)
DMt  = torch.tensor(DM, device=dev)
STt  = torch.tensor(STAT, device=dev)
LABt = torch.tensor(np.clip(LAB,0,1), device=dev)
LABMt= torch.tensor(LABM, device=dev)

def gather(idx):
    """idx: LongTensor of sample indices -> (B,K,L) context + (B,3) static."""
    w = wsT[idx]; tt = tsT[idx]; B=idx.shape[0]
    ctx = torch.empty(B,K,L, device=dev)
    base = tt - (L-1)
    for o in range(L):
        cols = base + o
        ctx[:,:,o] = Zt[:, w, cols].transpose(0,1)   # (K,B)->(B,K)
    return ctx, STt[idx]

# ---------------- model ----------------
class Net(nn.Module):
    def __init__(self, K, W):
        super().__init__()
        self.c1=nn.Conv1d(K,W,5,padding=2); self.c2=nn.Conv1d(W,W,3,padding=1)
        self.bn1=nn.BatchNorm1d(W); self.bn2=nn.BatchNorm1d(W)
        self.head=nn.Sequential(nn.Linear(2*W+3, W), nn.GELU(), nn.Linear(W, W), nn.GELU())
        self.reg=nn.Linear(W,3); self.dir=nn.Linear(W,3); self.settle=nn.Linear(W,1)
    def forward(self, ctx, stat):
        x=torch.relu(self.bn1(self.c1(ctx))); x=torch.relu(self.bn2(self.c2(x)))
        x=torch.cat([x.mean(-1), x.amax(-1)],1)
        h=self.head(torch.cat([x,stat],1))
        return self.reg(h), self.dir(h), self.settle(h).squeeze(-1)

net=Net(K,WIDTH).to(dev)
opt=torch.optim.AdamW(net.parameters(), lr=LR, weight_decay=WD)
huber=nn.HuberLoss(delta=2.0); bce=nn.BCEWithLogitsLoss(reduction='none')
nparams=sum(p.numel() for p in net.parameters()); print('params',nparams,'dev',dev,flush=True)

CKPT=os.path.join(GD,f'ckpt_{MODE}.pt'); PROG=os.path.join(GD,f'progress_{MODE}.json')
start_ep=0; best_val=1e9; curves=[]
if os.path.exists(CKPT):
    ck=torch.load(CKPT, map_location=dev)
    net.load_state_dict(ck['net']); opt.load_state_dict(ck['opt'])
    start_ep=ck['epoch']+1; best_val=ck.get('best_val',1e9); curves=ck.get('curves',[])
    print('resumed from epoch',start_ep,flush=True)

# no-change baseline MAE (per split) — the martingale null
def nochange_mae(idx):
    return DMt[idx].abs().mean(0).cpu().numpy()   # (3,)
nc_tr=nochange_mae(torch.tensor(tr_idx,device=dev))
nc_ho=nochange_mae(torch.tensor(ho_idx,device=dev))

@torch.no_grad()
def evaluate(idx):
    net.eval(); mae=np.zeros(3); diracc=np.zeros(3); nnz=np.zeros(3)
    setl_correct=0; setl_n=0; N=idx.shape[0]; preds=[]
    for i in range(0,N,4096):
        b=idx[i:i+4096]; ctx,stat=gather(b)
        r,dl,sl=net(ctx,stat)
        y=DMt[b]
        mae+=((r-y).abs().sum(0)).cpu().numpy()
        # direction accuracy on samples where |actual|>=0.5c (ignore dead-flat)
        for j in range(3):
            m=y[:,j].abs()>=0.5
            if m.any():
                acc=((r[m,j]>0)==(y[m,j]>0)).float().sum().item()
                diracc[j]+=acc; nnz[j]+=m.sum().item()
        # settle acc (labeled)
        lm=LABMt[b]>0
        if lm.any():
            pr=(torch.sigmoid(sl[lm])>0.5).float()
            setl_correct+=(pr==LABt[b][lm]).float().sum().item(); setl_n+=lm.sum().item()
    net.train()
    return (mae/N, np.where(nnz>0,diracc/np.maximum(nnz,1),np.nan),
            (setl_correct/setl_n if setl_n else np.nan), setl_n)

BS=2048 if MODE=='A' else 4096
tr_t=torch.tensor(tr_idx,device=dev); ho_t=torch.tensor(ho_idx,device=dev)
print(f'=== MODE {MODE}  WD={WD} EPOCHS={EPOCHS} start={start_ep} ===',flush=True)
t0=time.time(); bad=0
for ep in range(start_ep, EPOCHS):
    net.train(); perm=tr_t[torch.randperm(tr_t.shape[0],device=dev)]
    tot=0.0
    for i in range(0,perm.shape[0],BS):
        b=perm[i:i+BS]; ctx,stat=gather(b)
        r,dl,sl=net(ctx,stat); y=DMt[b]
        lreg=huber(r,y)
        ldir=bce(dl, (y>0).float()).mean()
        lm=LABMt[b]
        lset=(bce(sl,LABt[b])*lm).sum()/(lm.sum()+1e-6)
        loss=lreg + 0.3*ldir + 0.3*lset
        opt.zero_grad(); loss.backward(); opt.step(); tot+=loss.item()
    if ep%EVAL_EVERY==0 or ep==EPOCHS-1:
        mae_tr,da_tr,st_tr,_=evaluate(tr_t)
        mae_ho,da_ho,st_ho,stn=evaluate(ho_t)
        row=dict(epoch=ep, tloss=tot,
                 mae_tr=mae_tr.tolist(), mae_ho=mae_ho.tolist(),
                 nc_tr=nc_tr.tolist(), nc_ho=nc_ho.tolist(),
                 edge_tr=(nc_tr-mae_tr).tolist(), edge_ho=(nc_ho-mae_ho).tolist(),
                 diracc_tr=da_tr.tolist(), diracc_ho=da_ho.tolist(),
                 settle_tr=st_tr, settle_ho=st_ho, settle_n=stn,
                 sec=round(time.time()-t0,1))
        curves.append(row)
        val=float(mae_ho.mean())
        json.dump({'mode':MODE,'params':nparams,'wd':WD,'L':L,'H':H,'K':K,
                   'nc_ho':nc_ho.tolist(),'curves':curves}, open(PROG,'w'))
        msg=(f'ep{ep:4d} loss{tot:7.2f} | MAEho {mae_ho.round(3)} '
             f'edgeHO {(nc_ho-mae_ho).round(3)} dirHO {np.round(da_ho,3)} '
             f'setHO {st_ho:.3f} | {row["sec"]}s')
        print(msg,flush=True)
        if val<best_val-1e-4:
            best_val=val; bad=0
            torch.save({'net':net.state_dict(),'opt':opt.state_dict(),'epoch':ep,
                        'best_val':best_val,'curves':curves,'best':True}, os.path.join(GD,f'best_{MODE}.pt'))
        else:
            bad+=EVAL_EVERY
    if ep%CKPT_EVERY==0 or ep==EPOCHS-1:
        torch.save({'net':net.state_dict(),'opt':opt.state_dict(),'epoch':ep,
                    'best_val':best_val,'curves':curves}, CKPT)
    if MODE=='A' and bad>=PATIENCE:
        print('early stop at',ep,'best_val',best_val,flush=True); break
torch.save({'net':net.state_dict(),'opt':opt.state_dict(),'epoch':EPOCHS-1,
            'best_val':best_val,'curves':curves}, CKPT)
print('DONE mode',MODE,'best_val',best_val,flush=True)
