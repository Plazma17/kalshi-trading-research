# composite_streams.md — the COMPOSITE-STREAM FACTORY (50 channels)

_Built 2026-07-03 by `composite_prep.py` per Noah's directive: "make a ton of different
data streams like my integral of distance-to-strike minus price-distance-to-0.5 since the
last time they intercepted — create stuff like that and like 50 more, and diet some nets
on that."_

Channel **#1 (`cs_divint`) IS Noah's original np_divint stream** (C-014): the integral of
`(sy_pct − mid_pct)` since the two curves last crossed, reset every window. See
`np_divint.py` / `np_divint_report.md`.

**All 50 are CAUSAL / TRAILING-ONLY** — each bin reads only past+current bins of the SAME
window; per-window reset where the "reset" column says so (state cleared at each window's
bin 0 → no cross-window bleed). Verified by a prefix-identity leak audit (recompute on
truncated windows == full-computation prefix): **1200 checks, 0 violations.**

Appended to `grok_data.npz` as raw channels 31–80 (dataset 335 → **385 channels**), parked
at `grok_data.pending2.npz` (live runner holds the real file — swap at next natural stop).

### Scale caveat (honest)
`grok_data.npz` stores only **z-scored** price channels (dollar BTC price is irrecoverable).
Noah's dollar symlog `sy_pct(d)=50+50·sign(d)·min(1,log10(1+|d|)/log10(201))` is
reconstructed in z-space as `sy_z = 50 + 50·tanh(0.6·sdist_z)` (`sdist` = the z-scored
SIGNED distance-to-strike channel, corr +0.69 with mid−0.5). This is a monotone squash of
signed distance → 0..100, differing from the dollar version only by the squash's horizontal
scale — which the grok trainer's per-channel z-score absorbs anyway. The reset geometry
(gap sign-crossover + window reset) and the integral are preserved exactly. `mid_pct` uses
the **true 0-1 mid** (`D['mid']`). Event thresholds are in native z-units: vol-burst
`|Δcfmean_z|>0.5`/bin; spread-spike `spread_z` rising above 2.0.

Definitions below use: `mp`=true mid×100 (cents); `m50`=mid−0.5; `sdist`=z signed
dist-to-strike; `sy_z`=symlog-analog above; `gap`=`sy_z−mp`; `tfi,cfmean,spread,btcobi,
tvol`=z raw channels; `secfrac`=secleft/900; `dt`=10 s/bin.

---

## Family A — SINCE-EVENT INTEGRALS (13)
| # | name | definition | reset |
|---|------|-----------|-------|
| 1 | `cs_divint` | **Noah #1.** ∫`gap`·dt (signed A) | gap sign-crossover + window |
| 2 | `cs_divint_abs` | \|`cs_divint`\| (the flip-magnitude headline) | (as #1) |
| 3 | `cs_avggap` | `cs_divint` / max(tsc, dt) — average gap since crossover | (as #1) |
| 4 | `cs_idist_touch` | ∫\|`sdist`\|·dt since last strike-touch | strike-touch (sdist sign chg) + window |
| 5 | `cs_flow_touch` | ∫`tfi`·dt since last strike-touch | strike-touch + window |
| 6 | `cs_im50_cross` | ∫`m50`·dt since last 0.5-cross (signed) | mid crosses 0.5 + window |
| 7 | `cs_itfi_flip` | ∫`tfi`·dt since last tfi sign-flip | tfi sign-flip + window |
| 8 | `cs_iobi_flip` | ∫`btcobi`·dt since last btcobi sign-flip | btcobi sign-flip + window |
| 9 | `cs_iconcord_disc` | ∫(concordant-flow)·dt since last discordance; concord=`tfi·sign(m50)` | concord sign-flip + window |
| 10 | `cs_iabsdmid_burst` | ∫\|Δmid\|·dt since last vol-burst | vol-burst + window |
| 11 | `cs_ispread_spike` | ∫`spread`·dt since last spread-spike | spread-spike + window |
| 12 | `cs_flow_open` | ∫`tfi`·dt since window open (signed cumulative flow) | window only |
| 13 | `cs_advexc_drift` | ∫ min(0, adverse move)·dt since current SMOOTHED drift-run start (EWMA-sign regime, so intra-run pullbacks register) | smoothed-drift sign-flip + window |

## Family B — EVENT CLOCKS + COUNTS (10)
| # | name | definition | reset |
|---|------|-----------|-------|
| 14 | `cs_tsc_gap` | seconds since last gap-crossover (divint tsc) | gap sign-crossover + window |
| 15 | `cs_ts50` | seconds since last 0.5-cross | 0.5-cross + window |
| 16 | `cs_ts_touch` | seconds since last strike-touch | strike-touch + window |
| 17 | `cs_ts_burst` | seconds since last vol-burst | vol-burst + window |
| 18 | `cs_ts_spike` | seconds since last spread-spike | spread-spike + window |
| 19 | `cs_ts_tfiflip` | seconds since last tfi sign-flip | tfi flip + window |
| 20 | `cs_cnt_cross50` | count of 0.5-crossings so far this window | window (expanding count) |
| 21 | `cs_cnt_touch` | count of strike-touches so far this window | window (expanding count) |
| 22 | `cs_cnt_burst` | count of vol-bursts so far this window | window (expanding count) |
| 23 | `cs_driftlen` | length (s) of current same-sign per-bin Δmid drift-run | Δmid sign-flip + window |

## Family C — DIVERGENCE / GEOMETRY COMPOSITES (11)
| # | name | definition | reset |
|---|------|-----------|-------|
| 24 | `cs_gap_lvl` | `gap` = `sy_z − mp` (instantaneous divergence LEVEL) | none (pointwise) |
| 25 | `cs_sy_lvl` | `sy_z` (the symlog-analog distance curve, 0..100) | none (pointwise) |
| 26 | `cs_mid_phi_wedge` | mid − Φ(sdist/trailing-cf-vol); Φ≈logistic (model-vs-market wedge) | trailing 30 s vol window |
| 27 | `cs_hilo_pos` | (mp − runmin)/(runmax − runmin) since window open | window (expanding hi/lo) |
| 28 | `cs_dd_extreme` | mp − expanding runmax (drawdown from window peak, ≤0) | window (expanding max) |
| 29 | `cs_range_open` | expanding (runmax − runmin) of mp since open | window (expanding range) |
| 30 | `cs_coil60` | range/\|net\| of mp over trailing 60 s (path coil) | trailing 6 bins |
| 31 | `cs_coil120` | range/\|net\| of mp over trailing 120 s | trailing 12 bins |
| 32 | `cs_dist_secleft` | \|`sdist`\| · secfrac (dist × time-left interaction) | none (pointwise) |
| 33 | `cs_absm50_sqrtsec` | \|m50\|·100 · √secfrac (the geometry the character-heads found) | none (pointwise) |
| 34 | `cs_gap_secleft` | `gap` · secfrac (divergence weighted by time remaining) | none (pointwise) |

## Family D — FLOW COMPOSITES (9)
| # | name | definition | reset |
|---|------|-----------|-------|
| 35 | `cs_concord_tfi` | `tfi · sign(m50)` (concordance-gated signed flow; >0 confirms) | none (pointwise) |
| 36 | `cs_flow_intensity` | Hawkes-lite: EWMA(α=0.7) of \|tfi\| gated to same-sign arrivals | window (EWMA from 0) |
| 37 | `cs_tfi_obi` | `tfi · btcobi` product (flow × book imbalance) | none (pointwise) |
| 38 | `cs_flow_price_div` | ∫ 1[sign(∫tfi) ≠ sign(Δmid)] ·dt (flow-vs-price mismatch accumulator) | window |
| 39 | `cs_ewma_tfi_fast` | EWMA(α=0.5) of tfi | window (EWMA from 0) |
| 40 | `cs_ewma_tfi_slow` | EWMA(α=0.9) of tfi | window (EWMA from 0) |
| 41 | `cs_tfi_accel` | tfi − `cs_ewma_tfi_slow` (flow surprise / acceleration) | window |
| 42 | `cs_signed_tvol` | `tvol · sign(tfi)` (signed trade volume) | none (pointwise) |
| 43 | `cs_concord_runlen` | seconds the concordant-flow has held one sign | concord sign-flip + window |

## Family E — VOL STRUCTURE (7)
| # | name | definition | reset |
|---|------|-----------|-------|
| 44 | `cs_rvratio_30_300` | trailing-30 s rv / trailing-300 s rv of mp | trailing 3 / 30 bins |
| 45 | `cs_rv30` | trailing-30 s realized vol (std of mp, 3 bins) | trailing 3 bins |
| 46 | `cs_rr_pos` | trailing-60 s realized range / its trailing-300 s max (range position) | trailing 6 / 30 bins |
| 47 | `cs_volofvol` | std of \|Δmid\| over trailing 120 s (vol-of-vol) | trailing 12 bins |
| 48 | `cs_postburst_decay` | exp(−ts_burst / 60 s) — post-burst decay clock | vol-burst + window |
| 49 | `cs_rv300` | trailing-300 s realized vol (std of mp, 30 bins) | trailing 30 bins |
| 50 | `cs_cfrv30` | trailing-30 s realized vol of cfmean_z (index vol) | trailing 3 bins |

---

## Leak-test (trailing-only audit) result
`composite_prep.py` recomputes every channel on **truncated** windows `[:T]` for
`T ∈ {20,45,70,89}` across 6 random windows and asserts byte-identical equality with the
full computation's `[:T]` prefix. A future-peeking channel would move its value at bin T−1
when later bins are removed. **Result: 1200/1200 checks pass, 0 violations** → all 50
channels are causal. Structural asserts also pass: `cs_divint_abs==|cs_divint|`; clocks ≥0;
counts integer & non-decreasing; `cs_dd_extreme≤0`; `cs_hilo_pos∈[0,1]`; existing 335
channels byte-unchanged (append-only).

## Seeded diets → see `experiments_queue.jsonl` (ids `CF_*`, source `composite-factory`)
All carry `"needs_pending2": true` — they train on `cs_*` channels that exist ONLY after
the pending2 swap. Do NOT let the runner reach them before the swap (48-deep backlog makes
this safe in practice). Model: width 128, wd 0.1, epochs 120k, lr 1e-3, warmup 1000,
`statics:["secleft"]` (isolate the composites; no free mid/dist leak). Settle results must
be read against the FARM-8 mid>0.5 baseline (many composites encode mid).
