"""
grok_eval.py — baselines + tradability + charts from the grok NN runs.

Reads progress_{A,B}.json (dense curves, works mid-run) and best_{MODE}.pt
(for tradability / calibration on the holdout). Produces:
  grok_chart.png   (grokking curves + calibration + tradability panels)
  grok_report.md   (numbers + honest read)

Usage:  python grok_eval.py [A|B]   (default A for the trade panel)
"""
import numpy as np, torch, torch.nn as nn, json, os, sys
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt

GD=r'C:\Users\Noah\claude-workspace\grok'; dev='cuda' if torch.cuda.is_available() else 'cpu'
MODE=(sys.argv[1] if len(sys.argv)>1 else 'A').upper()
L=30; H=[6,12,24]; HMAX=24; WIDTH={'A':128,'B':96}

d=np.load(os.path.join(GD,'grok_data.npz'),allow_pickle=True)
causal=d['causal']; Zin=d['Zimp'][causal].astype(np.float32); K,nWin,BPW=Zin.shape
mid=d['mid'].astype(np.float32); secleft=d['secleft'].astype(np.float32)
winDay=d['winDay']; label=d['label']; ya=d['ya']; na=d['na']
days=sorted(set(winDay.tolist())); train_days=set(days[:6])
is_tr=np.array([winDay[w] in train_days for w in range(nWin)])
trmask=np.zeros((nWin,BPW),bool); trmask[is_tr,:]=True
mu=Zin[:,trmask].mean(1); sd=Zin[:,trmask].std(1); sd[sd<1e-6]=1
Zin=(Zin-mu[:,None,None])/sd[:,None,None]
t_lo,t_hi=L-1,BPW-1-HMAX
ws=[];ts=[]
for w in range(nWin):
    for tt in range(t_lo,t_hi+1): ws.append(w); ts.append(tt)
ws=np.array(ws); ts=np.array(ts); tr=is_tr[ws]
tr_idx=np.where(tr)[0]; ho_idx=np.where(~tr)[0]
DM=np.stack([(mid[ws,ts+h]-mid[ws,ts])*100.0 for h in H],1).astype(np.float32)
STAT=np.stack([secleft[ws,ts]/900.0,mid[ws,ts],np.maximum(mid[ws,ts],1-mid[ws,ts])],1).astype(np.float32)

# ---------- baselines ----------
def mae(a,b): return np.abs(a-b).mean(0)
nc_ho=np.abs(DM[ho_idx]).mean(0)                     # no-change (martingale null)
# linear ridge probe on flattened causal context (subsample train for speed)
def ctx_np(idx):
    B=len(idx); X=np.empty((B,K,L),np.float32); base=ts[idx]-(L-1)
    for o in range(L): X[:,:,o]=Zin[:,ws[idx],base+o].T
    return X.reshape(B,-1)
sub=np.random.RandomState(0).choice(tr_idx,min(6000,len(tr_idx)),replace=False)
Xtr=ctx_np(sub); Xho=ctx_np(ho_idx)
Xm=Xtr.mean(0); Xtr-=Xm; Xho-=Xm
lam=50.0; A=Xtr.T@Xtr+lam*np.eye(Xtr.shape[1]);
lin_ho=np.zeros((len(ho_idx),3)); lin_mae=np.zeros(3); lin_dir=np.zeros(3)
Ainv=np.linalg.inv(A)
for j in range(3):
    wj=Ainv@(Xtr.T@DM[sub,j]); p=Xho@wj; lin_ho[:,j]=p
    lin_mae[j]=np.abs(p-DM[ho_idx,j]).mean()
    m=np.abs(DM[ho_idx,j])>=0.5; lin_dir[j]=((p[m]>0)==(DM[ho_idx,j][m]>0)).mean()
# trailing-drift momentum direction baseline: sign of recent mid change over last L bins
drift=(mid[ws,ts]-mid[ws,ts-(L-1)])
mom_dir=np.zeros(3)
for j in range(3):
    m=np.abs(DM[ho_idx,j])>=0.5
    mom_dir[j]=((drift[ho_idx][m]>0)==(DM[ho_idx,j][m]>0)).mean()

# ---------- load net ----------
class Net(nn.Module):
    def __init__(s,K,W):
        super().__init__(); s.c1=nn.Conv1d(K,W,5,padding=2); s.c2=nn.Conv1d(W,W,3,padding=1)
        s.bn1=nn.BatchNorm1d(W); s.bn2=nn.BatchNorm1d(W)
        s.head=nn.Sequential(nn.Linear(2*W+3,W),nn.GELU(),nn.Linear(W,W),nn.GELU())
        s.reg=nn.Linear(W,3); s.dir=nn.Linear(W,3); s.settle=nn.Linear(W,1)
    def forward(s,ctx,st):
        x=torch.relu(s.bn1(s.c1(ctx))); x=torch.relu(s.bn2(s.c2(x)))
        x=torch.cat([x.mean(-1),x.amax(-1)],1); h=s.head(torch.cat([x,st],1))
        return s.reg(h),s.dir(h),s.settle(h).squeeze(-1)

net_mae=net_dir=net_setl=None; pred_ho=None; setl_ho=None
bp=os.path.join(GD,f'best_{MODE}.pt')
if os.path.exists(bp):
    W=WIDTH[MODE]; net=Net(K,W).to(dev); net.load_state_dict(torch.load(bp,map_location=dev)['net']); net.eval()
    Zt=torch.tensor(Zin,device=dev)
    def gather(idx):
        w=torch.tensor(ws[idx],device=dev); tt=torch.tensor(ts[idx],device=dev); B=len(idx)
        ctx=torch.empty(B,K,L,device=dev); base=tt-(L-1)
        for o in range(L): ctx[:,:,o]=Zt[:,w,base+o].transpose(0,1)
        return ctx, torch.tensor(STAT[idx],device=dev)
    P=[]; S=[]
    with torch.no_grad():
        for i in range(0,len(ho_idx),4096):
            b=ho_idx[i:i+4096]; ctx,st=gather(b); r,dl,sl=net(ctx,st)
            P.append(r.cpu().numpy()); S.append(torch.sigmoid(sl).cpu().numpy())
    pred_ho=np.concatenate(P); setl_ho=np.concatenate(S)
    net_mae=np.abs(pred_ho-DM[ho_idx]).mean(0)
    net_dir=np.array([ (( (pred_ho[:,j]>0)==(DM[ho_idx,j]>0))[np.abs(DM[ho_idx,j])>=0.5]).mean() for j in range(3)])

# ---------- tradability (horizon idx 1 = 120s) at real quotes + fee ----------
def kalshi_fee_c(p): return np.ceil(0.07*100*p*(1-p))/1.0  # cents/contract, rounded up
trade=None
if pred_ho is not None:
    j=1; hb=H[j]; wI=ws[ho_idx]; tI=ts[ho_idx]
    pr=pred_ho[:,j]; realized_mid=mid[wI,tI+hb]
    rows=[]
    for thr_pct in [50,70,80,90,95]:
        cut=np.percentile(np.abs(pr),thr_pct); sel=np.abs(pr)>=cut
        if sel.sum()<20: rows.append((thr_pct,sel.sum(),np.nan,np.nan,np.nan)); continue
        pnl=[]; wins=0
        for k in np.where(sel)[0]:
            if pr[k]>0:  # buy YES at ask ya, exit at future mid
                entry=ya[wI[k],tI[k]]; fee=kalshi_fee_c(entry)
                pnl.append((realized_mid[k]-entry)*100 - fee); wins+= realized_mid[k]>entry
            else:        # buy NO at ask na, exit at future NO-mid=(1-mid)
                entry=na[wI[k],tI[k]]; fee=kalshi_fee_c(entry)
                pnl.append(((1-realized_mid[k])-entry)*100 - fee); wins+= (1-realized_mid[k])>entry
        pnl=np.array(pnl)
        rows.append((thr_pct,int(sel.sum()),float(pnl.mean()),float(wins/len(pnl)),float(pnl.std()/np.sqrt(len(pnl)))))
    trade=rows

# ---------- charts ----------
def load(mode):
    p=os.path.join(GD,f'progress_{mode}.json')
    return json.load(open(p)) if os.path.exists(p) else None
PA=load('A'); PB=load('B')
fig,ax=plt.subplots(2,3,figsize=(17,9)); fig.suptitle('grok — future-Kalshi-price NN (Delta-mid vs martingale null)',fontsize=13)
def curve(P,axm,axd,tag):
    if not P: return
    c=P['curves']; ep=[r['epoch'] for r in c]
    for j,h in enumerate([60,120,240]):
        axm.plot(ep,[r['edge_ho'][j] for r in c],label=f'{tag} {h}s')
    axm.axhline(0,color='k',lw=.7,ls='--')
    for j,h in enumerate([60,120,240]):
        axd.plot(ep,[r['diracc_ho'][j] for r in c],label=f'{tag} {h}s')
    axd.axhline(0.5,color='k',lw=.7,ls='--')
# panel 0: mode A edge over no-change (holdout)
if PA:
    c=PA['curves']; ep=[r['epoch'] for r in c]
    for j,h in enumerate([60,120,240]):
        ax[0,0].plot(ep,[r['edge_ho'][j] for r in c],label=f'{h}s HO')
        ax[0,0].plot(ep,[r['edge_tr'][j] for r in c],ls=':',alpha=.5)
    ax[0,0].axhline(0,color='k',lw=.7,ls='--'); ax[0,0].set_title('A: edge over no-change (c) — HO solid, TR dotted')
    ax[0,0].set_xlabel('epoch'); ax[0,0].set_ylabel('nochange_MAE - net_MAE (c)'); ax[0,0].legend(fontsize=7)
# panel 1: mode A direction acc
if PA:
    c=PA['curves']; ep=[r['epoch'] for r in c]
    for j,h in enumerate([60,120,240]):
        ax[0,1].plot(ep,[r['diracc_ho'][j] for r in c],label=f'{h}s HO')
    ax[0,1].axhline(0.5,color='k',lw=.7,ls='--'); ax[0,1].set_title('A: holdout direction accuracy')
    ax[0,1].set_xlabel('epoch'); ax[0,1].legend(fontsize=7); ax[0,1].set_ylim(0.45,0.75)
# panel 2: mode A settle acc + train loss
if PA:
    c=PA['curves']; ep=[r['epoch'] for r in c]
    ax[0,2].plot(ep,[r['settle_ho'] for r in c],label='settle acc HO',color='green')
    ax[0,2].plot(ep,[r['settle_tr'] for r in c],label='settle acc TR',color='green',ls=':')
    ax[0,2].axhline(0.5,color='k',lw=.7,ls='--'); ax[0,2].set_title('A: settle P(YES) accuracy'); ax[0,2].legend(fontsize=7)
# panel 3: GROKKING readout mode B (train vs holdout over many epochs)
if PB:
    c=PB['curves']; ep=[r['epoch'] for r in c]
    ax[1,0].plot(ep,[r['diracc_tr'][2] for r in c],label='TRAIN dir 240s',color='tab:blue')
    ax[1,0].plot(ep,[r['diracc_ho'][2] for r in c],label='HOLDOUT dir 240s',color='tab:red')
    ax[1,0].axhline(0.5,color='k',lw=.7,ls='--'); ax[1,0].set_title('B GROKKING: train vs holdout dir acc (240s)')
    ax[1,0].set_xlabel('epoch'); ax[1,0].legend(fontsize=7)
    ax[1,1].plot(ep,[r['edge_ho'][2] for r in c],label='HO edge 240s',color='tab:red')
    ax[1,1].plot(ep,[r['edge_tr'][2] for r in c],label='TR edge 240s',color='tab:blue')
    ax[1,1].axhline(0,color='k',lw=.7,ls='--'); ax[1,1].set_title('B: edge over no-change (c)'); ax[1,1].legend(fontsize=7); ax[1,1].set_xlabel('epoch')
else:
    ax[1,0].text(.5,.5,'mode B not started yet',ha='center'); ax[1,1].text(.5,.5,'mode B pending',ha='center')
# panel 5: tradability + settle calibration
if trade:
    thr=[r[0] for r in trade]; ed=[r[2] for r in trade]; se=[r[4] for r in trade]
    ax[1,2].errorbar(thr,ed,yerr=se,marker='o',capsize=3,label='120s conf-tail net c/trade')
    ax[1,2].axhline(0,color='k',lw=.7,ls='--'); ax[1,2].set_title('Tradability: conf-tail edge (net of fee)')
    ax[1,2].set_xlabel('|pred| percentile cutoff'); ax[1,2].set_ylabel('cents/contract'); ax[1,2].legend(fontsize=7)
plt.tight_layout(rect=[0,0,1,.97]); plt.savefig(os.path.join(GD,'grok_chart.png'),dpi=110)
print('wrote grok_chart.png')

# ---------- report ----------
def f3(a): return '['+' '.join(f'{x:+.3f}' for x in a)+']'
lines=[]
lines.append('# grok — local NN: predict FUTURE Kalshi price (Delta-mid) + settle\n')
lines.append(f'- device: {dev} | causal channels K={K} | context L={L} bins (5min) | horizons {H} bins = 60/120/240s')
lines.append(f'- chrono split: train days {sorted(train_days)} ({int(is_tr.sum())} win) / holdout {sorted(set(winDay.tolist())-train_days)} ({int((~is_tr).sum())} win)')
lines.append(f'- samples: train {len(tr_idx)}, holdout {len(ho_idx)} (t in [{t_lo},{t_hi}])')
lines.append(f'- LEAK GUARDS: integral channels dropped (per-window future-mean); inputs standardized on TRAIN bins only; context strictly <= t; target=Delta so current-mid identity is worthless.\n')
lines.append('## Baselines vs net (holdout MAE in cents, per horizon 60/120/240s)')
lines.append(f'- no-change (martingale null): {f3(nc_ho)}')
lines.append(f'- linear ridge probe:          {f3(lin_mae)}   dir-acc {f3(lin_dir)}')
lines.append(f'- trailing-drift momentum dir:  n/a MAE            dir-acc {f3(mom_dir)}')
if net_mae is not None:
    lines.append(f'- **NET ({MODE}, best ckpt):**    {f3(net_mae)}   dir-acc {f3(net_dir)}')
    lines.append(f'- **NET edge over no-change:**   {f3(nc_ho-net_mae)}  (positive = beats martingale)')
lines.append('')
if trade:
    lines.append('## Tradability — 120s horizon, confident tail, real quotes + Kalshi fee')
    lines.append('| |pred| pct | n | net c/trade | win% | SE |')
    lines.append('|---|---|---|---|---|')
    for thr,n,m,wr,se in trade:
        lines.append(f'| {thr} | {n} | {m:+.2f} | {wr:.3f} | {se:.2f} |' if not np.isnan(m) else f'| {thr} | {n} | - | - | - |')
    lines.append('\nNet-of-fee cents/contract; must clear >0 to beat the taker cost wall.')
lines.append('\n## Read')
lines.append('See grok_chart.png. Mode-A panels = generalization screen; Mode-B bottom-left = the grokking readout (train vs holdout dir-acc over thousands of epochs — a late holdout jump = grok).')
open(os.path.join(GD,'grok_report.md'),'w').write('\n'.join(lines))
print('wrote grok_report.md'); print('\n'.join(lines))
