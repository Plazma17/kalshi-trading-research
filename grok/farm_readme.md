# GROK FARM — readme

A self-feeding grok-training farm for the CTA local NN. One process owns the GPU
and works a queue; many agents (research, ladder) only *emit specs* — they never
touch the GPU.

## Pieces
- **grok_queue.py** — the runner that OWNS the GPU. Waits until the GPU is idle
  (no other `grok_train*`/fleet proc, no foreign `progress_*.json` written in the
  last 180 s), then trains `experiments_queue.jsonl` line-by-line forever, writing
  `progress_<id>.json` in the GROK MONITOR `curves` format and marking each line
  `done`. Checkpoint-resumable (`ckpt_q_<id>.pt`). Stop with `grok_queue.STOP`.
  Launch detached: `nohup python grok_queue.py > grok_queue.out 2>&1 &`
- **experiments_queue.jsonl** — the shared work list. Append-only by convention;
  agents add specs by *id*, the runner rewrites only the `status` field.
- **grok_data.npz** — the dataset. 627 windows × 90 bins, **10 s/bin** (900 s /
  15 min windows). Chrono split: 6 train days / 3 holdout. 26 raw channels.

### Spec format (one JSON object per queue line)
```
{ "id":"LAD1_tfi_dir", "inputs":["tfi"], "statics":["secleft"],
  "target":{"kind":"dir","horizon_s":120,"thr":2.0},
  "sample_set":"event_matched", "model":{"width":128,"wd":0.10,"epochs":100000,
  "lr":1e-3,"ls":0.1,"warmup":1000}, "source":"ladder", "note":"..." }
```
- `target.kind`: `dir` (3-class up/flat/down) · `bigmove` (binary |Δmid|>thr) ·
  `settle` · `extreme` · `chop_tp` · `magbin`.
- `target.shuffle` (forward-compat, FARM-5): set `true` on the ladder's
  `LAD<t>_NULL` specs to request a shuffled-target permutation null. **The runner
  does not yet honor it** (a random-diet floor until `build_run` gains one line —
  see the FARM-5 note under the ladder); ignored on all other specs.
- `sample_set`: `all|event_matched|final5|lowvol|choppy|nearstrike|buyzone`.
- **`statics`** (added 2026-07-03): which always-on static features to append —
  subset of `["secleft","mid","dist"]`. **Default = all three (back-compat).**
  The ablation ladder sets `["secleft"]` so a single channel's 30-bin context is
  isolated WITHOUT leaking mid/dist as free statics.
- Horizon→bins is derived from the data (`BIN_S`, currently 10 s), so
  `horizon_s:120 → HZ 12 bins` (matches Mode C). Fixed a hardcoded `/5.0` that
  had been doubling every horizon to 240 s.

## THE ABLATION LADDER (grok_ladder.py)
Noah's "which data predicts the price" map. Single-channel grok nets for every
stream → see which memorize/generalize → greedy-forward escalation to 2/3/4-channel
diets. Emits specs into the queue; harvests results; regenerates the map.

**Channels** (10 raw + secleft-as-only-input): `mid, spread, dist, tfi, btcobi,
tvol, btcspread, sig, eth, sol` + `secleft` (inputs=[] , statics=["secleft"] — a
pure time-of-window probe, e.g. the turn-of-candle claim).

**Targets** per single: (1) `dir` = 3-class Δmid@120s {down<−2c, flat, up>+2c} on
the event+matched-control set; (2) `evc` = event-vs-control binary (`bigmove`
|Δ|>2c) on the same set. Combos (tier ≥2) use `dir` only (the predict-the-price
question) to respect the ~30-run/tier cap.

**Per-run stats** (harvested from `progress_<id>.json`):
- **memorization ceiling** = max train acc reached (1–2 ch diets: input
  distinguishability / data-sufficiency).
- **holdout over baseline (`hob`)** = the ranking currency. **The LATE-WINDOW MEAN**
  of the holdout metric (mean over the last **`LATE_FRAC` = 20%** of logged epochs,
  post-memorization) minus the diet-appropriate baseline. **NOT the curve-max**
  (see FARM-6 below). Headline metric follows **FARM-1/2**: AUC−0.5 whenever the
  majority baseline **> 0.55** (raw accuracy is banned there — it flatters a
  below-majority classifier, the "D6 0.614 acc = edge −0.094" trap); dir
  (majority 0.385) headlines acc−majority. **The majority baseline is printed per
  row.**
- **peak (biased)** = the OLD `np.nanmax`-over-curve edge, reported but **never
  ranked on**; **infl** = peak − late = the selection inflation the FARM-6 fix
  removes.
- **`hob_se`** = AR(1)-corrected SE of the late window (`_ar1_se`: the ~400
  late checkpoints are strongly autocorrelated, so `std/√n` understates SE; we
  correct with `n_eff = n·(1−r1)/(1+r1)`).
- **best-EV (DET-EV)** = best-case after-fee cents/trade (taker/maker) at the
  detected strength: strength → optimistic top-decile win-rate (= up/down AUC) →
  `EV = (2p−1)·EDGE_CAPTURE_C − fee`, vs the ~**3.5c taker / 1.4c maker** cost
  wall. **DETECTED-NOT-TRADABLE** = even the optimistic EV can't clear the taker
  wall (a real but *economically competed* detection → route to composition/veto,
  NOT an entry edge). These constants are deliberately OPTIMISTIC; the
  authoritative bridge is the tradability backtest in `grok_report.md`.
- **SICK** = train never within 95% of its ceiling by 20k epochs (broken run,
  distinct from a healthy grok-negative).

**FARM-6 — robust escalation currency (2026-07-03):** the old currency was
`np.nanmax(holdout)` over the whole 100k-epoch curve = a maximum over ~2000
correlated checkpoints ⇒ upward-biased, so greedy-forward ranked/escalated on eval
noise and "synergy" was a difference of two inflated maxima. **Now the currency is
the late-window mean, and a diet may seed a tier only if its late edge clears the
baseline by `> SE_MULT·SE` (= 2·SE) AND the tier's permuted NULL floor (FARM-5).**
Screened-out singles are still RANKED in the report but do not spawn pairs.

**FARM-5 — permuted NULL floor (2026-07-03):** every tier the harvester seeds also
seeds **`LAD<tier>_NULL`** — a deterministic random-3-channel, **shuffled-target**
run = the queue/ladder analog of the D-fleet's D10, the pipeline's own
false-positive floor. Every survivor in that tier must beat it. `--report`
tabulates each tier's null floor. **Shuffle caveat:** the runner
(`grok_queue.build_run`) is not touched by this change and does not yet honor
`target.shuffle`, so as-run `LAD<t>_NULL` is a *random-diet* floor (real labels, 3
arbitrary channels); adding one line to `build_run`
(`if tg.get('shuffle'): permute y within each split`) upgrades it to a TRUE
permutation floor **with no spec change** — exactly parallel to how the ladder
already depends on the back-compatibly-added `statics` field. See
`make_null_spec()`.

**FARM-8 — settle × quote-input mid-baseline comparator (2026-07-03):** a **settle**-kind
run whose inputs include a **quote-family channel** (`mid`/`pf`/`ya`/`na`/`yb`/`nb`) scores
0.81–0.996 holdout **NOT because it learned anything** — the mid AT DECISION TIME already
*is* the settle predictor (`corr(mid_T-10, settle) ≈ 0.99`; on `final5` the target is a
near-tautology of the input). The majority baseline (FARM-1) is the WRONG comparator here.
**The right one is the trivial rule `settle YES iff mid>0.5`** at decision time, scored on
the SAME sample set + holdout days (`_mid_baseline`, reusing `grok_queue.build_run` for
byte-identical sample construction; cached per (kind × sample_set × horizon) so harvest
stays fast). **Ranking currency becomes `margin-over-mid` = net headline − mid-baseline**,
and the DET-EV bridge is fed that margin. Measured on the live queue every settle-quote
margin is ~0 or NEGATIVE (RP4 −0.044, RP13 −0.043, L07 −0.050, L09 −0.070 AUC) — the nets
add nothing the mid already prices. **Tautology tripwire:** any run whose peak holdout
headline > **0.95** on ANY target gets an automatic **⚠TAUT** flag ("target recoverable
from inputs — check before celebrating"; nothing here is 95%+ predictable OOS). `--report`/
`--harvest` emit a dedicated **FARM-8 scorecard** (net / mid-base / margin / ⚠ / EV-state
for every settle-quote run in the queue); `python grok_ladder.py --score <ids…>` scores
specs ad-hoc. *(This rule was requested as "FARM-7"; in `quantification_report.md` that
number was already the eff-n rule, so it is documented there as FARM-8 for consistency.)*
The runner (`grok_queue.py`) is NOT touched.

**Escalation (encoded):** rank singles by the **late-window-mean** holdout-over-
baseline; a diet is ELIGIBLE only if it passes the >2·SE + null-floor gate. Tier 2 =
all pairs among the top-5 **eligible** + each top-3 eligible single × every
remaining channel (greedy forward), cap 28. **Synergy(diet)** = holdout(diet) −
best 1-drop sub-diet (also vs additive expectation); tier ≥3 extends every
positive-synergy **AND gate-passing** combo by one channel. Cap ~28/tier (batched
mode lifts this).

**Commands:**
- `python grok_ladder.py --seed`    — seed tier 1 into the queue (done 2026-07-03).
- `python grok_ladder.py --harvest` — compute stats, seed the next tier if the
  current one finished, regenerate chart+report. **Run when a tier completes.**
- `python grok_ladder.py --watch`   — cheap poller (5 min, no GPU) that auto-runs
  harvest each time the current tier finishes.
- `python grok_ladder.py --report`  — regenerate chart+report only.
- `python grok_ladder.py --score <ids…>` — FARM-8: score settle×quote specs vs the
  mid>0.5 baseline (net / mid-base / margin-over-mid / ⚠TAUT). Defaults to
  `RP4 RP13 L07_favgate_settle L09_final5_settle`. Read-only.

**Outputs:** `research_specs_ladder.jsonl` (canonical spec source, mine),
`grok_ladder_chart.png` (the ladder map: rows = diets by tier; cols = ceiling |
late-mean holdout-vs-baseline | synergy), `grok_ladder_report.md` (table with
maj-base / hob(late) / ±2·SE / pass / peak(biased) / infl / AUC(late) / best-EV /
EV-state / synergy / **taut** / sick, the **FARM-8 settle×quote mid-baseline
scorecard** (net / mid-base / margin-over-mid / ⚠ / EV-state), a per-tier NULL-floor
table, + next-tier state).

**State (2026-07-03):** Tier 1 = **23 specs** (11 channels × 2 targets **+
`LAD1_NULL`**, the FARM-5 permuted floor) seeded into `experiments_queue.jsonl`.
Awaiting the queue runner to train them; then `--harvest` computes the late-mean
stats + EV bridge and, if every tier-1 spec (incl. the null) is finished, generates
tier 2 from the >2·SE + null-gated eligible singles.

## BATCHED-ENSEMBLE MODE — speed (2026-07-03, opt-in)
The farm's nets are tiny (24-56k params, full-batch), so one run leaves the RTX
5070 Ti ~90% idle and running several trainer procs at once just thrashes the 12 GB
GPU. **Batched mode trains a GROUP of same-shape specs SIMULTANEOUSLY** as one
stacked `baddbmm` pass. Measured **~820 net-epochs/s at E≥8 vs ~444 ep/s fused-single
/ ~290 ep/s original → ~1.85x/net, ~2.8x over the original farm** — and it removes
all multi-process GPU thrash. See `speed_report.md` for the full profile.

**Three opt-in env switches (default OFF = behavior byte-unchanged):**
- **`GROK_FAST=1`** — sequential path uses TF32 matmul + fused AdamW → **1.42x**, no
  code change. Zero-risk fused; TF32 opt-in (wd-sensitive) so left off by default.
- **`GROK_BATCH=1`** (+ optional `GROK_BATCH_MAX`, default 16) — the runner groups
  all PENDING specs sharing `grok_batch.batchable_key(spec)` and trains each group at
  once via `grok_batch.train_batch`. Each net still writes its own
  `progress_<id>.json` (ATOMIC temp+os.replace, THROTTLED ≤1/2 s — also fixes monitor
  torn reads), shares `ckpt_qbatch_<hash>.pt`, honors `grok_queue.STOP`.
- **`GROK_GRAPH=1`** (2026-07-03) — CUDA-graph capture of the batched steady-state step
  (composes with GROK_BATCH). **~1.5-1.6x at E≤2 (launch-bound), ~1.05x at E≥8** (already
  memory-bound — batching ate the launch overhead; graphs can't move the bandwidth wall).
  Warmup runs eager, the constant-LR step is captured once and replayed. NON-DESTRUCTIVE
  capture → replay is BIT-IDENTICAL to eager (`grok_graph_verify.py`: max|ΔW|=0.0;
  `grok_graph_smoke.py`: identical curves). **RETIRED 2026-07-03 (default OFF; `farm_handoff.ps1`
  sets `GROK_GRAPH=0`).** A `cudaErrorStreamCaptureInvalidated` fired during capture; the old
  fallback caught the CAPTURE exception but then ran EAGER in the SAME epoch on the still-
  invalidated stream, which threw again UNCAUGHT -> grok_queue marked the whole L05/RA3/RA13
  group `error`. `grok_batch` now HARD-GUARDS this: any capture OR replay CUDA error disables
  graph process-wide, checkpoints, and returns `graph_abort` -> the group is left **PENDING**
  (never `error`) and resumes **EAGER** from its ckpt (the context recovers once the in-flight
  batch is abandoned - proven live). Env is read as `== '1'`, so `GROK_GRAPH=0` is truly OFF.
  `GROK_GRAPH_DEBUG=1` prints the capture/replay traceback.
  `nohup env GROK_FAST=1 GROK_BATCH=1 GROK_GRAPH=1 python grok_queue.py > grok_queue.out 2>&1 &`
  **The pending queue-runner restart enables all three at once** (the runner reads these
  envs at launch; grok_batch reads GROK_GRAPH at import).

  **CANONICAL WINDOWS LAUNCH (2026-07-03) — ALWAYS redirect; never hidden-without-log.**
  Streams merged (stdout+stderr) and APPENDED to `runner.log` so a traceback can never be
  lost again (the 08:09 hidden-no-redirect launch lost the L02/L03 error tracebacks):
  ```powershell
  $gd='C:\Users\Noah\claude-workspace\grok'
  $env:GROK_FAST='1'; $env:GROK_BATCH='1'; $env:GROK_GRAPH='1'
  Add-Content "$gd\runner.log" ("===== relaunch {0} =====" -f (Get-Date -Format o)) -Encoding utf8
  Start-Process cmd -ArgumentList '/c','python grok_queue.py 1>> runner.log 2>&1' -WorkingDirectory $gd -WindowStyle Hidden
  ```
  Find the runner PID: `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | ? {$_.CommandLine -like '*grok_queue.py*'}`.
  NOTE: the atomic-save helpers now RETRY os.replace ~6s on Windows `PermissionError(13)`
  (the kalshi-cta Electron dashboard tails `progress_*.json`/ckpts → concurrent-reader
  lock race; was the root cause of the L02+RP10 / L03+RP9 batch aborts). The main-loop
  error handler now marks the WHOLE batched group `error` (not just the first spec) so a
  pair's partner can't be orphaned `pending` and silently retrain from scratch under a new
  ckpt hash.

**Batchability key** = specs may DIFFER only in `inputs` and model `{wd,ls,init_scale,
seed}`; they must SHARE `sample_set`, `target{kind,horizon_s,thr,tp}`, `statics`,
`width`, `epochs`, `lr`, `warmup`, and have **no grokfast** (per-net grad-EMA not
batched in v1 → those fall back to sequential automatically). This makes the ablation
ladder's per-tier fan-out (many diets, one target/sample_set/width) the ideal batch:
a whole tier trains in ~one run's wall-clock. Different `inputs` → different Din are
zero-padded to a common width (padded cols get 0 input → 0 forward/grad → each net is
functionally identical to the single-net path). The batch cap (`GROK_BATCH_MAX`) can
replace the ladder's ~28/tier cap for throughput (memory: E×~30 MB activations here;
16 safe alongside other GPU use, 32-64 when the GPU is free).

**Numeric equivalence** (`python grok_verify_batched.py`): batched vs single-net is
BIT-EXACT through the descent phase (ep 0-~350); later ~1-2% drift is chaotic
full-batch-GD sensitivity to GEMM reduction order — persists in float64, so intrinsic
(the original trainer isn't bit-reproducible across driver/hardware either). Holdout
acc/AUC stay in the same band → same grok curve. Adequate for the late-rise readout.

**Files:** `grok_batch.py` (queue-adoptable `train_batch` + `batchable_key`; reuses
`grok_queue.build_run`, no logic duplicated; houses the `GROK_GRAPH` capture) ·
`grok_train_batched.py` (standalone batched trainer w/ C-sweep & D-fleet presets:
`python grok_train_batched.py C`) · `grok_bench.py` (batched profiler) ·
`grok_graph_bench.py` (CUDA-graph vs eager throughput ladder) ·
`grok_verify_batched.py` (batched-vs-single numeric check) ·
`grok_graph_verify.py` (graph-vs-eager bit-identical gate) ·
`grok_graph_smoke.py` (end-to-end eager-vs-graph curve equivalence).

## GROK MONITOR — 4×4 grid console (`../grok_monitor/`)
The Electron monitor now has a **GRID VIEW** in addition to the single-run view.
- **Default = grid** whenever ≥3 `progress_*.json` runs exist. Press **G** to
  toggle grid↔single. **Click a card** to open that run's single view.
- Each card = one run: name + **state badge** (RUNNING = its `progress_<id>.json`
  mtime <60 s / DONE / QUEUED), a mini dual-curve chart (train faint, holdout
  bright, 0.5 ref, grok-jump dot), and the **last 5 logged rows** (`ep | ho | tr`).
- **QUEUED placeholder cards** are read straight from `experiments_queue.jsonl`
  (any pending line with no `progress_*.json` yet) so you can see the backlog.
- Order: RUNNING first → QUEUED → most-recent DONE. Live cards pulse; a grokking
  card gets an orange inset glow + the header shows `GROK ↑ <id>`. Polls 2.5 s,
  reuses the tolerant `curves` parser + a per-run anti-flash cache.
- Restart after editing `index.html`: kill only the grok_monitor electron procs,
  relaunch `grok_monitor/launch_monitor.cmd`; it writes `selfcheck.png` ~10 s after
  load for headless verification.

## How to add a spec by hand
Append one JSON object (one line) to `experiments_queue.jsonl` with a **unique
`id`**. Minimum fields: `id`, `inputs` (raw channel bases) OR `shell` (a backlog
command string), `target`, `sample_set`, `model`, `source`, `note`. The runner
picks up new pending lines automatically on its next queue scan. Append-only —
don't rewrite existing lines (the runner owns the `status` field).

## How to stop the farm
`touch grok_queue.STOP` in `grok/` → the runner checkpoints the current run and
exits at the next epoch/queue boundary. Delete the file before relaunching.

## Resetting errored specs (`_reset_graph_errors.py` and friends) — RUNNER-STOPPED ONLY
Any script that REWRITES `experiments_queue.jsonl` status fields (flipping `error`→`pending`
to retry, editing specs) must run with the **runner STOPPED** (`grok_queue.STOP` present +
process gone). The runner OWNS the `status` field via `mark()` (read-modify-rewrite under the
`experiments_queue.lock` sentinel `_qlock`). A reset that overlaps a live `mark()` can clobber
a status the runner just wrote (last-writer-wins on the whole-file rewrite). Reset helpers
acquire the SAME `experiments_queue.lock` sentinel as a best-effort guard (fixed 2026-07-03 —
`_reset_graph_errors.py` had used a mismatched `experiments_queue.jsonl.lock`, i.e. no real
exclusion), but the lock degrades to unlocked after a 15 s timeout, so **stopped-only is the
rule, the lock is only a backstop.** Ckpts survive a reset, so reset→relaunch resumes (never
restarts) each spec from `ckpt_q_<id>.pt` / `ckpt_qbatch_<hash>.pt`.

## Coordination note (2026-07-03)
The **queue runner OWNS all future GPU work** and idle-gates on `grok_train*` /
`grok_fleet` / `launch_grok*` processes + foreign `progress_*.json` freshness, so
it never contends with the mode-D fleet (`launch_grok_D.sh`). The C1/C2 **1M-epoch
extensions** are queued as `shell` backlog items (`C1_ext1M`, `C2_ext1M`) that
resume the real `grok_train_C.py` ckpts — **resume-guarded, so they are a NO-OP if
the fleet already extended them** (no duplication).
