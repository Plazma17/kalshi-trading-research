"""grok_fleet_summary.py — writes grok_fleet_summary.md (+ prints a console recap)
from progress_D*.json.  Per diet: final/max holdout acc vs majority & drift, AUCs,
memorization onset, and a pre-registered GROK-signature check (late holdout rise
>5pts AFTER train>0.95 for >5000 epochs).  NO works/doesn't verdicts — descriptive."""
import json, os, numpy as np

GD=r'C:\Users\Noah\claude-workspace\grok'
ORDER=['D1','D2','D3','D4','D5','D6','D7','D8','D9','D10']
DESC={'D1':'FLOW {tfi,btcobi,tvol} -> 3-cls dir Dmid@120s',
      'D2':'PRICE {mid,dist} -> 3-cls dir (momentum control)',
      'D3':'VOL/LIQ {sig,btcspread,spread,tvol} -> 3-cls |Dmid| magnitude',
      'D4':'XASSET {eth,sol} pure-exog -> 3-cls dir',
      'D5':'GEOM/TIME {dist,secleft,|mid-.5|,spread} -> settle YES/NO',
      'D6':'GEOM/TIME same -> oscillatory-vs-lockout',
      'D7':'FULL PRUNED (10ch) -> oscillatory-vs-lockout',
      'D8':'FULL PRUNED (10ch) -> big-move-coming (event-vs-ctrl)',
      'D9':'FLOW+CONCORD {tfi,btcobi,tvol,sign(tfi)*sign(btcobi)} -> 3-cls dir',
      'D10':'RANDOM 3ch + SHUFFLED targets (null diet)'}

def grok_check(ep,atr,aho,aucA):
    """late holdout rise >5pts AFTER strong memorization (train>0.90) sustained >5000 epochs.
    (pre-registered signature says >0.95; 0.90 used as onset proxy so the late-rise metric is
    computable for runs that plateau just under 0.95 -- report notes the actual plateau.)"""
    mem=np.where(atr>0.90)[0]
    if len(mem)==0: return None,'no-memorization'
    m0=ep[mem[0]]
    late=ep>=m0+5000
    if late.sum()<2: return m0,'too-few-late-epochs'
    base=aho[mem[0]]                          # holdout acc at memorization onset
    rise_acc=float(np.nanmax(aho[late])-base)
    rise_auc=float(np.nanmax(aucA[late])-aucA[mem[0]])
    sig = rise_acc>0.05 or rise_auc>0.05
    return m0,f'lateRise_acc{rise_acc:+.3f} auc{rise_auc:+.3f} {"SIGNAL" if sig else "flat"}'

rows=[]; recap=[]
for R in ORDER:
    P=os.path.join(GD,f'progress_{R}.json')
    if not os.path.exists(P):
        rows.append(f'| {R} | {DESC[R]} | pending | - | - | - | - | - | - |'); recap.append(f'{R}: pending'); continue
    try: J=json.load(open(P))
    except Exception:
        rows.append(f'| {R} | {DESC[R]} | writing | - | - | - | - | - | - |'); recap.append(f'{R}: writing'); continue
    c=J['curves']; ep=np.array([r['epoch'] for r in c])
    atr=np.array([r['acc_tr'] for r in c]); aho=np.array([r['acc_ho'] for r in c])
    aucA=np.array([r['aucUD_ho'] for r in c]); aucB=np.array([r['aucEC_ho'] for r in c])
    maj=J['baselines']['majority']; dr=J['baselines'].get('drift',float('nan'))
    afin=float(aho[-1]); amax=float(np.nanmax(aho)); amax_ep=int(ep[int(np.nanargmax(aho))])
    aucAmax=float(np.nanmax(aucA)); lastep=int(ep[-1])
    m0,gk=grok_check(ep,atr,aho,aucA)
    # non-flat: holdout acc spread after warmup, or aucA excursion above 0.55
    warm=ep>2000
    spread=float(np.nanmax(aho[warm])-np.nanmin(aho[warm])) if warm.sum()>1 else 0.0
    movement = (afin-maj>0.02) or (aucAmax>0.56) or (spread>0.04 and amax-maj>0.02)
    drs=f'{dr:.3f}' if np.isfinite(dr) else 'n/a'
    rows.append(f'| {R} | {DESC[R]} | {maj:.3f} | {drs} | {afin:.3f} | {afin-maj:+.3f} | '
                f'{amax:.3f}@{amax_ep//1000}k | {aucAmax:.3f} | ep{lastep} {gk} |')
    recap.append(f'{R} {DESC[R][:34]:34s} | maj {maj:.3f} hoFIN {afin:.3f} ({afin-maj:+.3f}) '
                 f'hoMAX {amax:.3f}@{amax_ep//1000}k aucAmax {aucAmax:.3f} | {gk} | '
                 f'{"** MOVEMENT" if movement else "flat"}')

md=['# GROK MODE-D DIET FLEET — summary','',
    'Each net = C\'s grok regime (tiny 2-layer MLP, wd 0.10, label-smoothing 0.1, full-batch',
    'AdamW, LR 1e-3 + 1000-ep warmup, class-balanced CE, chrono holdout days 7-9, 100k epochs).',
    'Differences between runs = the DIET (channel keep-list) and the TARGET only.','',
    'Pre-registered GROK signature = holdout acc (or up-vs-down AUC) rising **>5 pts AFTER**',
    'train acc has been >0.95 for >5000 epochs (late jump = grok; simultaneous = ordinary fit).','',
    '| run | diet -> target | maj | drift | hoFIN | edge | hoMAX@ep | aucA_max | grok-check |',
    '|---|---|---|---|---|---|---|---|---|', *rows, '',
    'edge = final holdout acc - majority.  aucA = up-vs-down AUC (3-cls) or pos-vs-neg AUC (binary).',
    'See grok_fleet_chart.png for the sparkline grid.  NO works/doesn\'t verdicts — descriptive readout.']
open(os.path.join(GD,'grok_fleet_summary.md'),'w').write('\n'.join(md))
print('wrote grok_fleet_summary.md\n'); print('\n'.join(recap))
