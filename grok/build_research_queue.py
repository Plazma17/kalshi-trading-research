#!/usr/bin/env python3
"""build_research_queue.py -- merge the 52 research-claim specs (research_specs_
{lore,academic,pm}.jsonl) into the grok farm queue (experiments_queue.jsonl),
translating each into the runner's vocabulary (grok_queue.build_run).

- Idempotent: skips ids already present in the queue.
- Atomic APPEND ONLY (open 'a', single write) + verify/retry so it never clobbers
  the runner's status-field rewrites.
- Preserves claim linkage: queue id == original spec id; queue note contains the
  ORIGINAL note (claim + URLs) VERBATIM, prefixed with the translation mapping.
- Deferred specs (unbanked feed OR pending the research_prep channel swap) go to
  research_specs_deferred.jsonl instead of the live queue.
"""
import json, os, time

GD = r'C:\Users\Noah\claude-workspace\grok'
QF = os.path.join(GD, 'experiments_queue.jsonl')
DEF = os.path.join(GD, 'research_specs_deferred.jsonl')
SRC = ['research_specs_lore.jsonl', 'research_specs_academic.jsonl', 'research_specs_pm.jsonl']

# ---- original notes (verbatim) keyed by original id ----
ORIG = {}
for fn in SRC:
    for ln in open(os.path.join(GD, fn), encoding='utf-8'):
        ln = ln.strip()
        if not ln: continue
        o = json.loads(ln); ORIG[o['id']] = o

MODEL = {"width": 128, "wd": 0.1, "epochs": 200000, "lr": 0.001, "ls": 0.1, "warmup": 1000}

def T(kind, **kw):
    d = {"kind": kind}; d.update(kw); return d

# queue_id -> (orig_id, inputs, target, sample_set, xlate_tag)
# order here == append order (expiry family FIRST, then conditional lore, then rest)
SPECS = [
    # ===== 1. expiry / near-expiry FIRST =====
    ("RP4",  "RP4",  ["mid","dist","sig"], T("settle"), "final5",
     "settle on final5 (secleft<=300, closest built-in to secleft<120); cheap-side mid<0.20 is a post-hoc calibration cut; secleft via default static"),
    ("RP11", "RP11", ["dist","sig","cfmean","mid"], T("dir",horizon_s=120,thr=2.0), "nearstrike",
     "expiry-pin. runner has NO signed dist-change head -> dir@120 on nearstrike (dist<=med) as the faithful proxy for within-window drift toward the strike (dist mean-reverts to 0); mid/dist static. PARTIAL translation (target substituted)"),
    ("RP13", "RP13", ["mid","dist"], T("settle"), "all",
     "settle calibration net {mid,dist,+secleft static} on all-labeled -- the SHARED trained model for RP1/RP2/RP3/RP7 (each = a distinct DOWNSTREAM calibration cut the runner can't gate: cheap-tail/duration-bucket/extreme-vs-mid/two-sided). MERGES RP1,RP2,RP3,RP7"),
    ("RA7",  "RA7",  ["cfmean","mid","tfi"], T("dir",horizon_s=60,thr=2.0), "all",
     "turn-of-the-candle. secleft (default static) encodes candle phase directly; boundary_phase/near_turn flags -> secleft. target dcfmean_60s -> dir@60 on MID (proxy: mid tracks cfmean; runner has no cfmean head)"),

    # ===== 2. conditional lore =====
    ("RL1",  "RL1",  ["mid_d1","tfi_cum","tfi","tvol","btcobi","dist"], T("dir",horizon_s=120,thr=2.0), "event_matched",
     "CVD/order-flow divergence -> absorption reversal. mid.d1_120->mid_d1. divergence subset (sign(mid_d1)!=sign(slope tfi_cum)) is ungateable by the runner -> queued ungated on event_matched; the net learns the divergence interaction from mid_d1+tfi_cum inputs"),
    ("RL5",  "RL5",  ["dev","mid","fair","sig","dist"], T("dir",horizon_s=120,thr=2.0), "all",
     "VWAP/fair-value magnet mean-reversion. mid.ma600->mid (30-bin context supplies the MA). outer-band |dev|>2*sig conditional is encoded via the dev input (ungateable); net learns the band"),
    ("RL6",  "RL6",  ["mid","mid_d1","mid_d2","tvol","btcobi"], T("dir",horizon_s=120,thr=2.0), "lowvol",
     "failed-breakout fade, LOW-VOLUME conditional -> sample_set lowvol (sig<=med). mid.d1_30->mid_d1, mid.d2_120->mid_d2. PAIR with RL7 (two-sided; SAME sign required)"),
    ("RL7",  "RL7",  ["mid_d1","tvol","btcobi","tfi","tfi_cum"], T("dir",horizon_s=120,thr=2.0), "event_matched",
     "breakout CONTINUATION, volume+book-confirmed. high-vol conditional -> event_matched (big-move events; no 'highvol' built-in). PAIR with RL6 (direction-symmetry, same sign)"),
    ("RL11", "RL11", ["mid_d1","mid_d2","tvol","tfi","tfi_cum"], T("dir",horizon_s=120,thr=2.0), "event_matched",
     "momentum-ignition fizzle/revert. ignition subset (short-lived d1 spike NOT backed by tfi_cum) ungateable -> event_matched; net distinguishes via tfi_cum backing"),

    # ===== 3. lore, rest =====
    ("RL2",  "RL2",  ["tvol","mid_d1","sig","tfi"], T("dir",horizon_s=120,thr=2.0), "event_matched",
     "volume-climax reversal (high vol + no price progress = exhaustion, fade). tvol.std120->tvol, mid.d1_30->mid_d1. climax subset ungateable -> event_matched"),
    ("RL4",  "RL4",  ["dist","zstrike","sdist","sig","mid"], T("settle"), "final5",
     "round-number/strike PIN near expiry -> settle. near-expiry pin (secleft<180 & small dist) -> final5 + dist input; primary settle leg"),
    ("RL4b", "RL4",  ["dist","zstrike","sdist","sig","mid"], T("bigmove",horizon_s=120,thr=2.0), "final5",
     "PIN magnitude leg: pin => small |dmid| -> bigmove@120 (dir-agnostic) on final5; complements RL4 settle leg"),
    ("RL8",  "RL8",  ["spread","btcspread","sig","tvol"], T("magbin",horizon_s=120), "all",
     "spread-widening as impending-move/vol tell. spread.d1/btcspread.d1->context of base. target=|dmid| MAGNITUDE -> magbin@120 terciles (not direction)"),
    ("RL9",  "RL9",  ["tfi_cum","tfi","sig","tvol","btcspread"], T("magbin",horizon_s=120), "all",
     "VPIN/order-flow-toxicity -> vol. VPIN proxy=|tfi_cum|/tvol learnable from tfi_cum+tvol context. realized_vol -> magbin@120. high-sig vs low-sig regime split via sig input"),
    ("RL13", "RL13", ["mid_d1","tvol","tfi","dist"], T("settle"), "all",
     "opening-drive/early-window TS-momentum -> settle, volume-backed. mid.d1_30->mid_d1. early-window (high secleft) via secleft static; no early-window built-in -> all. Mirror both signs (dir-symmetry)"),
    ("RL14", "RL14", ["sig","tvol","spread","btcspread"], T("magbin",horizon_s=240), "lowvol",
     "vol compression -> expansion. sig.d1->context. compression regime (low sig+tvol+tight spread) -> lowvol. target future |dmid| expansion -> magbin@240"),
    ("RL15", "RL15", ["mid_d1","mid_d2","tvol","tfi"], T("dir",horizon_s=120,thr=2.0), "event_matched",
     "liquidity-void/FVG ~50% fill then reverse. mid.d1_30->mid_d1, mid.d2_120->mid_d2. retrace_frac_and_dir -> dir@120 reversal. liquidity-void (large fast d1) -> event_matched"),
    ("RL16", "RL16", ["mid","dist","zstrike","sig","tfi"], T("dir",horizon_s=120,thr=2.0), "nearstrike",
     "trapped-trader extreme-quote fade toward 50, CONDITIONAL on small dist -> nearstrike (the NEW test vs the prior unconditional MID extreme-fade Phi-illusion). mid input encodes the extreme band; secleft static"),
    ("RL16b","RL16", ["mid","dist","zstrike","sig","tfi"], T("settle"), "nearstrike",
     "settle leg of the extreme+near-strike fade -> settle on nearstrike; complements RL16 dir leg"),
    ("RL17", "RL17", ["btc","eth","sol","tfi","cfmean"], T("dir",horizon_s=120,thr=2.0), "all",
     "cross-asset confirmation continues / divergence fades. btc/eth/sol.d1_120 & cfmean.d1_120 -> base channels (context supplies d1). confirm-vs-divergence two-sided via the btc/eth/sol inputs"),

    # ===== 4. academic, rest =====
    ("RA2",  "RA2",  ["btcobi","eth","sol","tfi"], T("dir",horizon_s=60,thr=2.0), "all",
     "lagged cross-asset OFI -> short-horizon dir. lag1..3 collapse into the runner's 30-bin (300s) context -> base channels; encodable today"),
    ("RA3",  "RA3",  ["tfi","tvol","tfi_cum","sig","btcspread"], T("bigmove",horizon_s=120,thr=3.0), "all",
     "VPIN/order-flow toxicity -> price JUMPS (direction-free). vpin_volbucket_cumimb -> tfi_cum (proxy). absmove_120s -> bigmove@120 thr3c"),
    ("RA10", "RA10", ["tvol","tfi","btcobi","sig"], T("dir",horizon_s=120,thr=2.0), "all",
     "trade-size asymmetry: net large-trade imbalance -> returns. large-trade flags -> tvol/tfi (rolling-quantile flag learnable from context)"),
    ("RA11", "RA11", ["tfi","tfi_cum","tvol"], T("dir",horizon_s=30,thr=2.0), "all",
     "trade-sign self-excitation (Hawkes) -> short-horizon sign continuation. signrun/autocorr/intensity/arrival -> tfi,tfi_cum,tvol context (flow-run not price drift)"),
    ("RA12", "RA12", ["tvol","sig","btcspread"], T("magbin",horizon_s=120), "all",
     "trade intensity / short duration -> realized vol (HAR). intensity/duration -> tvol context. rv_120s -> magbin@120 (direction-free)"),
    ("RA13", "RA13", ["tvol","sig"], T("bigmove",horizon_s=120,thr=3.0), "all",
     "unexpected volume shock has 2-13x vol impact. tvol_surprise/expected -> tvol minus rolling-mean, learnable from tvol context. absmove -> bigmove@120 (direction-free)"),
    ("RA15", "RA15", ["tfi","btcobi","spread","btcspread","sprxtfi","bsprxobi"], T("dir",horizon_s=120,thr=2.0), "all",
     "spread as predictability GATE (interaction terms). sprxtfi/bsprxobi are prepped derived channels (grok_data.pending.npz); until applied the runner drops them and trains on the 4 base channels (graceful degradation), then gains explicit products post-restart"),
    ("RA17", "RA17", ["tvol","tfi","mid","cfmean"], T("dir",horizon_s=60,thr=2.0), "all",
     "VWAP-to-mid deviation -> transient pressure then reversion. vwap_proxy=tvol-weighted price -> learnable from tvol+mid+cfmean context. non-momentum reversion sign"),
    ("RA18", "RA18", ["mid","dist"], T("settle"), "nearstrike",
     "Kalshi favorite-longshot bias (fade cheap far-from-money YES). cheap_longshot_flag -> mid/dist. LABELED CROSS-CHECK (overlaps L07/RP13 nearstrike cheap-YES), not a fresh edge -- per the spec's own caution"),

    # ===== 5. pm, rest =====
    ("RP5",  "RP5",  ["cfmean","btcobi","mid","tfi"], T("dir",horizon_s=60,thr=2.0), "all",
     "latency asymmetry / BRTI-lead: Kalshi mid lags spot ~3-7s. dmid_h6 -> dir@60. direction-symmetry: sign-inversion across the 3-class up/down = hard fail"),
    ("RP6",  "RP6",  ["tfi","btcobi","tvol","mid","dist"], T("settle"), "all",
     "order-flow/large-trader imbalance -> settlement. tfi ~70% BTC-direction all-time; settle leg"),
    ("RP6b", "RP6",  ["tfi","btcobi","tvol","mid","dist"], T("dir",horizon_s=120,thr=2.0), "all",
     "tradable confident-tail leg: dmid_h12 -> dir@120; score confident tail vs the 5c cost wall. complements RP6 settle leg"),
    ("RP9",  "RP9",  ["cfmean","sig","mid","tvol"], T("dir",horizon_s=240,thr=2.0), "event_matched",
     "overreaction to fast BTC moves -> intraday REVERSAL. high-|move| bins -> event_matched (big-move matched). dmid_h24 -> dir@240 (expect reversion sign). Pairs w/ RP10. Mirror"),
    ("RP10", "RP10", ["cfmean","mid","sig"], T("dir",horizon_s=60,thr=2.0), "event_matched",
     "short-lived UNDERreaction to large shocks -> brief same-direction drift. big-move bins -> event_matched. dmid_h6 -> dir@60 (continuation). Complement of RP9. Mirror"),
    ("RP15", "RP15", ["spread","btcspread","sig","tvol"], T("magbin",horizon_s=120), "all",
     "spread/liquidity -> dislocation MAGNITUDE (not direction). l2_depth_delta unbanked -> dropped; spread/btcspread/secleft retained. absdmid_h12 -> magbin@120"),
    ("RP16", "RP16", ["tvol","tfi","mid"], T("dir",horizon_s=120,thr=2.0), "final5",
     "herding rush near expiry: one-sided volume spike overshoots then reverts. secleft<180 -> final5; high-tvol via input. dmid_h12 -> dir@120. Mirror the rush"),
]

# ---- deferred (parked, NOT queued) ----
DEFERRED = [
    # unbanked feed / no absolute price
    ("RL3",  "data", "absolute BTC price / cfmean-in-$ joined to the $100/$500/$1000 round grid (npz stores only z-scored price -> round-distance irrecoverable)"),
    ("RL10", "data", "OKX perp funding + open-interest + liquidation feeds banked and joined to the 10s bin grid"),
    ("RA1",  "data", "L2 / BRTI constituent order-book feed (multi-level OFI, PCA across levels)"),
    ("RA4",  "data", "OKX liquidations feed (signed/long/short liq vol + OI change)"),
    ("RA4b", "data", "OKX liquidations feed (reversal leg; sign should invert vs RA4)"),
    ("RA5",  "data", "OKX funding-rate feed (extreme-funding flag + perp basis)"),
    ("RA6",  "data", "OKX perp mark-price feed (mark - cfmean basis)"),
    ("RA9",  "data", "absolute BTC price / cfmean-in-$ for round-$500/$1000 distance"),
    ("RA14", "data", "L2 / BRTI book depth + slope feed"),
    ("RA16", "data", "OKX perp mid feed (derivatives seconds-scale lead-lag)"),
    ("RP8",  "data", "Kalshi L2 depth-delta banking channel (quote-skew is derivable from ya/na/yb/nb but depth-delta is unbanked)"),
    ("RP12", "data", "absolute BTC price / cfmean-in-$ for the $250/$500/$1000 round magnet"),
    # prep built+verified but pending the grok_data.npz channel swap (no-restart)
    ("RL12", "prep", "research_prep.py hod_sin/hod_cos (killzone hour-of-day) applied to grok_data.npz; verified & parked in grok_data.pending.npz -> needs the centralized restart to swap. Then: dir@120 + magbin@120 (absdmid), inputs [hod_sin,hod_cos,tfi,sig,tvol,btcobi], all"),
    ("RA8",  "prep", "research_prep.py hod_sin/hod_cos (hour-of-day seasonality) applied to grok_data.npz (parked in grok_data.pending.npz; needs centralized restart). Then: magbin@120 (rv), inputs [hod_sin,hod_cos,sig,cfmean], all"),
    ("RP14", "prep", "research_prep.py hod_sin/hod_cos (time-of-day retail flow) applied to grok_data.npz (parked in grok_data.pending.npz; needs centralized restart). Then: settle, inputs [tfi,btcobi,mid,spread,hod_sin,hod_cos], all"),
]

def existing_ids():
    ids = set()
    if os.path.exists(QF):
        for ln in open(QF, encoding='utf-8'):
            ln = ln.strip()
            if not ln: continue
            try: ids.add(json.loads(ln).get('id'))
            except Exception: pass
    return ids

def build_line(qid, oid, inputs, target, ss, tag):
    onote = ORIG[oid]['note']
    note = f"[merge->runner: {tag}] ORIG({oid}): {onote}"
    return {"id": qid, "inputs": inputs, "target": target, "sample_set": ss,
            "model": dict(MODEL), "source": "research-merge", "note": note}

def main():
    have = existing_ids()
    new_lines = []
    queued, dup = [], []
    for qid, oid, inputs, target, ss, tag in SPECS:
        if qid in have:
            dup.append(qid); continue
        new_lines.append(build_line(qid, oid, inputs, target, ss, tag))
        queued.append(qid)

    # ---- atomic append + verify/retry (never rewrite existing lines) ----
    if new_lines:
        payload = ''.join(json.dumps(s, ensure_ascii=False) + '\n' for s in new_lines)
        for attempt in range(5):
            with open(QF, 'a', encoding='utf-8') as f:
                f.write(payload); f.flush(); os.fsync(f.fileno())
            landed = existing_ids()
            missing = [s['id'] for s in new_lines if s['id'] not in landed]
            if not missing: break
            new_lines = [s for s in new_lines if s['id'] in missing]
            payload = ''.join(json.dumps(s, ensure_ascii=False) + '\n' for s in new_lines)
            time.sleep(0.5)

    # ---- deferred file (rewrite ok; it's ours) ----
    have_def = set()
    if os.path.exists(DEF):
        for ln in open(DEF, encoding='utf-8'):
            ln = ln.strip()
            if ln:
                try: have_def.add(json.loads(ln).get('id'))
                except Exception: pass
    with open(DEF, 'a', encoding='utf-8') as f:
        added_def = []
        for oid, why, waiting in DEFERRED:
            if oid in have_def: continue
            rec = {"id": oid, "disposition": f"DEFERRED-ON-{why.upper()}",
                   "waiting_on": waiting, "orig": ORIG[oid]}
            f.write(json.dumps(rec, ensure_ascii=False) + '\n'); added_def.append(oid)

    print("QUEUED (%d):" % len(queued), queued)
    print("SKIPPED already-present (%d):" % len(dup), dup)
    print("DEFERRED written (%d):" % len(added_def), added_def)

if __name__ == '__main__':
    main()
