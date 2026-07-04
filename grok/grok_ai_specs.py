#!/usr/bin/env python3
"""grok_ai_specs.py -- fire a batch of cross-AI prompts asking the panel for NEW
grokking-farm DIET/TARGET specs, given the channel catalog + what is flat so far.

Pattern copied from ai_panel_hunt.py.  Appends one row per (prompt x model) to
grok_ai_specs_raw.jsonl (resumable).  A later harvest pass converts the best
answers into experiments_queue.jsonl lines by hand / by grok_ai_harvest.py.
NO trading, NO deployments.
"""
import os, sys, json, time, threading, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, r"C:\Users\Noah\claude-workspace")
import ai_bridge

HERE = r"C:\Users\Noah\claude-workspace\grok"
RAW  = os.path.join(HERE, "grok_ai_specs_raw.jsonl")
MODELS = ["minimax", "kimi", "deepseek", "nemotron-super", "step", "llama"]

CATALOG = """GROK FARM CONTEXT — a local self-feeding NN training farm for KXBTC15M (Kalshi 15-min BTC up/down; settles on CF BRTI index).
We train tiny (~56k param) 2-layer MLPs full-batch with STRONG weight decay + label smoothing for MANY epochs (1e5-1e6) hunting a GROKKING transition (a LATE holdout jump after the train set is memorized). Each experiment = a DIET (input channel subset) + a TARGET (what to predict) + a SAMPLE SET (which (window,tick) samples).

DATA: archive of 627 windows (~8.3 days), ~90 five-second bins/window, 30-bin (5-min) causal context.
RAW BASE CHANNELS available (per bin): mid (Kalshi YES mid 0..1), fair, dev (model fair & deviation),
  pf, cfmean (CF BRTI settlement index level), btc/eth/sol (spot), strike, dist/sdist/zstrike (dist-to-strike),
  spread, sig (smoothed vol), calk, ya/na/yb/nb (YES/NO ask/bid cents), tfi (trade-flow imbalance),
  tvol (trade volume), btcobi (BTC book order-imbalance), btcspread (BTC top-of-book spread),
  mid_d1/mid_d2 (mid derivatives), tfi_cum (cumulative flow).
TRANSFORM FAMILIES also precomputed per base: ma (moving avg), deriv, integral (LEAK-prone/per-window future-mean -> avoid), pastmean, std.
STATIC per-sample: secleft/900 (fraction of window remaining), mid, dist.

TARGETS we can build labels for: (a) 3-class direction of Delta-mid over H bins {down<-2c, flat, up>+2c};
  (b) real settle YES/NO (the known generalizer); (c) chop-take-profit profitability (did buy-28..30c / sell-55c hit TP before window end); (d) favgate-style settle conditioned on {pf, dist, sl, trailing-rv};
  (e) 'reaches an extreme' (mid touches >=0.9 or <=0.1 before settle); (f) magnitude / vol-of-move regression.
HORIZONS: H in bins where 1 bin = ~5s: {6,12,24,48,120} bins = {30,60,120,240,600}s.

WHAT IS FLAT / DEAD so far (design AROUND these):
- mid is a near-efficient martingale ~ Phi(z); single mid-coupled direction signals don't beat martingale after 5-7c taker fee.
- order-flow (tfi/btcobi) leads the INDEX (cfmean) but the Kalshi MID already prices it.
- strike-reversion, snap-back/fade, momentum x volume, slow-creep, overround: all fee-walled or underpowered as takers.
- In the grok fleet so far: swapping INPUT channels has NOT rescued 120s DIRECTION (holdout stuck ~majority). => prefer DIFFERENT TARGETS over different inputs.
- Direction-agnostic + hold-to-settle framings survive the fee wall more often."""

SYS = ("You are a sharp quantitative ML researcher helping design GROKKING experiments (tiny MLP, heavy weight "
       "decay, very long training, hunting a late holdout generalization jump) on a Kalshi 15-min BTC prediction "
       "market. You know microstructure, index construction, and the grokking literature. Propose experiments as "
       "a DIET (input channels) + TARGET + SAMPLE-SET. Prefer NON-direction / hold-to-settle targets and regimes "
       "the analyst has NOT tried. Every proposal must be buildable from the listed channels/labels. Be concrete: "
       "give exact channel lists, the exact target definition, the sample restriction, and WHY it might grok "
       "(a learnable structured relation the memorizing net could suddenly generalize).")

PROMPTS = {
 "T_targets": ("The fleet shows INPUT swaps don't rescue 120s direction. Propose 5 DIFFERENT TARGETS (not raw "
   "direction) most likely to reveal a grokkable structured relation on this data, given the channel catalog. "
   "For each: exact label definition, the 6-12 channel diet, sample restriction, and the mechanism that makes it "
   "learnable-then-generalizable. Rank them."),
 "H_horizon": ("Horizon study. For the SAME best non-direction target, which horizon(s) in {30,60,120,240,600}s "
   "should grok most readily and why? Give 3 concrete (target,horizon,diet) specs."),
 "S_sample": ("Sample-set design. Propose 4 sample RESTRICTIONS (e.g. final-5-min-only, low-vol-only, choppy-path-"
   "only, near-strike-only) that would concentrate a learnable relation and make grokking more likely. For each, "
   "the exact filter, the target it best pairs with, and the diet."),
 "C_concord": ("Concordance / interaction diets. Which 2-3 channel INTERACTIONS (e.g. tfi x dist, btcobi x sig, "
   "cfmean-vs-mid divergence) are most likely to encode a hidden rule a grokking net could crystallize? Give 4 "
   "specs (diet = the interacting channels + minimal context) with target + sample-set."),
 "G_technique": ("Grokking ACCELERATION. Given tiny MLP + full-batch AdamW + heavy wd + label smoothing, what "
   "concrete hyperparameter / regularization variants (weight-decay value, init scale, LR schedule, "
   "gradient-filtering a la grokfast) would most raise the chance/speed of a holdout jump? Give 3 variant recipes "
   "as {wd, init, lr, epochs, extra} I can encode as model params."),
}
TEMPS = [0.6, 1.0]

def jobs():
    out=[]; pid=0
    for fam, body in PROMPTS.items():
        for t in TEMPS:
            for m in MODELS:
                pid+=1; out.append(dict(pid=pid, family=fam, model=m, temp=t, prompt=body))
    return out

_lock=threading.Lock()
def done_set():
    s=set()
    if os.path.exists(RAW):
        for ln in open(RAW, encoding="utf-8"):
            try: r=json.loads(ln); s.add((r["pid"], r["model"]))
            except Exception: pass
    return s

def fire(j):
    t0=time.time()
    try:
        ans=ai_bridge.ask(j["prompt"], context_text=CATALOG, system=SYS,
                          max_tokens=3500, temperature=j["temp"], model=j["model"])
    except Exception as e:
        ans="[EXC] "+repr(e)[:200]
    rec=dict(pid=j["pid"], family=j["family"], model=j["model"], temp=j["temp"],
             secs=round(time.time()-t0,1), ok=not str(ans).startswith("[ai_bridge"),
             len=len(str(ans)), answer=str(ans))
    with _lock:
        with open(RAW,"a",encoding="utf-8") as f: f.write(json.dumps(rec,ensure_ascii=False)+"\n")
    print(f"[{'OK ' if rec['ok'] else 'ERR'}] pid{j['pid']:>3} {j['model']:<14} {j['family']:<12} {rec['secs']}s len={rec['len']}", flush=True)
    return rec

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--workers",type=int,default=8)
    a=ap.parse_args()
    try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass
    js=jobs(); have=done_set(); js=[j for j in js if (j["pid"],j["model"]) not in have]
    print(f"total new jobs={len(js)} workers={a.workers}", flush=True)
    t0=time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for _ in as_completed([ex.submit(fire,j) for j in js]): pass
    print(f"DONE in {round(time.time()-t0)}s -> {RAW}", flush=True)

if __name__=="__main__": main()
