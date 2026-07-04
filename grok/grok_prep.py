"""
grok_prep.py  — build grok_data.npz for the local NN experiment.

Reconstructs RAW per-bin price panels (mid/ya/na/yb/nb) aligned EXACTLY to the
mega_Z bin grid (BPW=90 bins of 10s per window, bin=floor((t-t_start)/10)),
reshapes the 331 z-scored channels to (K,nWin,BPW), maps window->ticker->settle
label, and flags causal channels (drops the 'integral' tfFam which uses a
per-window mean over ALL 90 bins == look-ahead leak).

Output: C:/Users/Noah/claude-workspace/grok/grok_data.npz
"""
import numpy as np, json, os
WS = r'C:\Users\Noah\claude-workspace'
BIN = 10.0

mp  = np.load(os.path.join(WS,'mega_parsed.npz'))
aux = np.load(os.path.join(WS,'_aux_parsed.npz'), allow_pickle=True)
Z   = np.load(os.path.join(WS,'mega_Z.npz'), allow_pickle=True)
sy  = json.load(open(os.path.join(WS,'sy_map.json')))

nWin = int(Z['nWin']); BPW = int(Z['BPW'])
print('nWin', nWin, 'BPW', BPW)

t   = mp['t'].astype(np.float64)
win = mp['win'].astype(np.int64)
n   = len(t)
bounds = np.searchsorted(win, np.arange(nWin+1))
starts, ends = bounds[:-1], bounds[1:]

# ---- replicate bin index exactly as mega_build ----
binidx = np.empty(n, np.int64)
for s,e in zip(starts,ends):
    if e-s < 1: continue
    b = np.floor((t[s:e]-t[s])/BIN).astype(np.int64)
    np.clip(b,0,BPW-1,out=b)
    binidx[s:e] = b
gi = win*BPW + binidx
totalBins = nWin*BPW

def bin_mean(vals):
    vals = vals.astype(np.float64)
    fin = np.isfinite(vals)
    sm = np.bincount(gi[fin], weights=vals[fin], minlength=totalBins)
    ct = np.bincount(gi[fin], minlength=totalBins).astype(np.float64)
    out = np.full(totalBins, np.nan); nz = ct>0
    out[nz] = sm[nz]/ct[nz]
    return out.reshape(nWin,BPW)

# raw price panels (0..1 units)
mid = bin_mean(mp['mid']); ya = bin_mean(mp['ya']); na = bin_mean(mp['na'])
yb  = bin_mean(mp['yb']);  nb = bin_mean(mp['nb'])
tmean = bin_mean(t)  # mean epoch per bin

# forward-fill NaNs within each window along bins (a bin with no ticks inherits last price)
def ffill(A):
    A = A.copy()
    for w in range(nWin):
        row = A[w]; last = np.nan
        for b in range(BPW):
            if np.isnan(row[b]): row[b]=last
            else: last=row[b]
        # back-fill leading nans
        first = np.nan
        for b in range(BPW-1,-1,-1):
            if np.isnan(row[b]): row[b]=first
            else: first=row[b]
        A[w]=row
    return A
mid,ya,na,yb,nb = map(ffill,(mid,ya,na,yb,nb))

# secleft per bin: window close ~ open+900 ; secleft = (t_open+900) - t_bin
topen = np.array([t[s] for s,e in zip(starts,ends)])
tbin  = np.where(np.isnan(tmean), topen[:,None]+ (np.arange(BPW)[None,:]*BIN), tmean)
secleft = np.clip((topen[:,None]+900.0) - tbin, 0, 900).astype(np.float32)

# ---- window -> ticker -> settle label ----
aw = aux['win'].astype(np.int64); at = aux['t'].astype(np.float64)
ab = np.searchsorted(aw, np.arange(aw.max()+2)); aopen = at[ab[:-1]]
tkw = np.array([str(x) for x in aux['tk_of_win']])
label = np.full(nWin, -1, np.int64)   # -1 = no label
ticker = np.empty(nWin, dtype=object)
matched=0
for w in range(nWin):
    j = int(np.argmin(np.abs(aopen - topen[w])))
    tk = tkw[j] if j < len(tkw) else ''
    ticker[w] = tk
    if tk in sy:
        label[w] = int(sy[tk]); matched+=1
print('windows with settle label:', matched, 'of', nWin)

# ---- channels: reshape Zimp to (K,nWin,BPW), flag causal ----
Zimp = Z['Zimp'].astype(np.float32).reshape(-1, nWin, BPW)
names = np.array([str(x) for x in Z['names']])
tfFam = np.array([str(x) for x in Z['tfFam']])
base  = np.array([str(x) for x in Z['base']])
causal = tfFam != 'integral'    # integral uses per-window (future-inclusive) mean
print('channels', Zimp.shape[0], 'causal', int(causal.sum()), 'integral(dropped from causal)', int((~causal).sum()))

# winDay for chrono split
winDay = Z['winDay'].astype(np.int64)

out = os.path.join(WS,'grok','grok_data.npz')
np.savez_compressed(out,
    Zimp=Zimp, names=names, tfFam=tfFam, base=base, causal=causal,
    mid=mid.astype(np.float32), ya=ya.astype(np.float32), na=na.astype(np.float32),
    yb=yb.astype(np.float32), nb=nb.astype(np.float32),
    secleft=secleft, winDay=winDay, label=label, ticker=ticker.astype('U32'),
    BPW=BPW, nWin=nWin)
print('saved', out)
# quick sanity
print('mid nan frac', float(np.isnan(mid).mean()))
print('days', sorted(set(winDay.tolist())))
print('label balance (labeled):', np.bincount(label[label>=0]))
