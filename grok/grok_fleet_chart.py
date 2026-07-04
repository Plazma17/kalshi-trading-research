"""grok_fleet_chart.py — the money chart: a GRID of holdout-curve sparklines, one
per diet (D1..D10).  Bold = holdout accuracy over epochs; faint = train accuracy;
horizontal lines = majority baseline (dashed), drift baseline (dotted, dir runs),
and the pre-registered GROK threshold = majority+0.05 (red).  A late holdout rise
above the red line AFTER train has been >0.95 for a while = the grok signature.
Re-runnable while the fleet trains (reads whatever progress_D*.json exist)."""
import json, os, numpy as np
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt

GD=r'C:\Users\Noah\claude-workspace\grok'
ORDER=['D1','D2','D3','D4','D5','D6','D7','D8','D9','D10']
TITLE={'D1':'FLOW->dir','D2':'PRICE->dir','D3':'VOL/LIQ->mag','D4':'XASSET->dir',
       'D5':'GEOM->settle','D6':'GEOM->osc','D7':'FULL->osc','D8':'FULL->bigmove',
       'D9':'FLOW+concord->dir','D10':'RANDOM/shuffled(null)'}

fig,axes=plt.subplots(2,5,figsize=(20,8)); axes=axes.ravel()
for i,R in enumerate(ORDER):
    ax=axes[i]; P=os.path.join(GD,f'progress_{R}.json')
    if not os.path.exists(P):
        ax.text(0.5,0.5,f'{R}\n(pending)',ha='center',va='center',transform=ax.transAxes,color='gray')
        ax.set_title(f'{R}  {TITLE[R]}',fontsize=9); ax.set_xticks([]); ax.set_yticks([]); continue
    try: J=json.load(open(P))
    except Exception:
        ax.text(0.5,0.5,f'{R}\n(writing...)',ha='center',va='center',transform=ax.transAxes,color='gray')
        ax.set_title(f'{R}  {TITLE[R]}',fontsize=9); continue
    c=J['curves']; ep=np.array([r['epoch'] for r in c])
    atr=np.array([r['acc_tr'] for r in c]); aho=np.array([r['acc_ho'] for r in c])
    maj=J['baselines']['majority']; dr=J['baselines'].get('drift',float('nan'))
    thr=maj+0.05
    ax.plot(ep,atr,color='0.75',lw=0.9,label='train acc')
    ax.plot(ep,aho,color='C0',lw=1.6,label='holdout acc')
    ax.axhline(maj,color='k',ls='--',lw=0.8)
    if np.isfinite(dr): ax.axhline(dr,color='green',ls=':',lw=0.9)
    ax.axhline(thr,color='red',ls='-',lw=0.7,alpha=0.7)
    # mark epoch where train first >0.90 (strong memorization; grok precondition)
    mem=np.where(atr>0.90)[0]
    if len(mem): ax.axvline(ep[mem[0]],color='orange',ls='-',lw=0.6,alpha=0.5)
    amax=float(np.nanmax(aho)); amax_ep=int(ep[int(np.nanargmax(aho))]); afin=float(aho[-1])
    ax.set_title(f'{R}  {TITLE[R]}',fontsize=9)
    ax.set_xlabel('epoch',fontsize=7)
    ax.text(0.02,0.97,f'maj {maj:.3f}\nhoFIN {afin:.3f}\nhoMAX {amax:.3f}@{amax_ep//1000}k\nedge {afin-maj:+.3f}',
            transform=ax.transAxes,va='top',fontsize=7,
            bbox=dict(boxstyle='round',fc='white',ec='0.7',alpha=0.8))
    ax.tick_params(labelsize=7)
    lo=min(np.nanmin(aho),maj)-0.03; hi=max(np.nanmax(atr),thr)+0.03
    ax.set_ylim(lo,hi)
axes[0].legend(fontsize=6,loc='lower right')
fig.suptitle('GROK MODE-D DIET FLEET — holdout accuracy vs epoch (bold=holdout, faint=train; '
             'k--=majority, g:=drift, red=grok thr maj+0.05, orange=train>0.95)',fontsize=11)
fig.tight_layout(rect=[0,0,1,0.96])
out=os.path.join(GD,'grok_fleet_chart.png'); fig.savefig(out,dpi=110); print('wrote',out)
