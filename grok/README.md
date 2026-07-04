# grok — neural-net training farm

A batch training harness for small PyTorch nets, driven by a queue of experiment specs. One
process owns the GPU and trains the queue one line at a time, forever; other scripts only append
specs to the queue and never touch the GPU. Each experiment is a one-line JSON spec (inputs,
target, sample subset, model hyperparameters). Runs are checkpoint-resumable and write uniform
progress files that the monitor app (`../grok_monitor`) reads.

## Components

- **`grok_queue.py`** — the runner that owns the GPU. Waits until the GPU is idle (no other trainer
  process, no foreign progress file written recently), then trains `experiments_queue.jsonl`
  line-by-line, writing `progress_<id>.json` in the monitor's curve format and marking each spec
  `done`. Checkpoint-resumable; safe to run detached.
- **Spec queue** — append-only `experiments_queue.jsonl`; each line is a self-describing experiment.
  Scripts add work by `id`; the runner rewrites only the `status` field.
- **Training cores** — `grok_train.py` (plus `_C`/`_D`/`_batched` variants): compact nets predicting
  a future delta / direction / settle probability, with a grokking-probe mode (heavy weight decay,
  many epochs) and a chronological train/holdout split with early stopping.
- **Spec generation & harvest** — `build_research_queue.py`, `seed_*` scripts, and `grok_ladder.py`
  generate and prioritize experiment ladders; `grok_eval.py` / `grok_fleet_summary.py` aggregate
  results.
- **Batched training & benchmarks** — `grok_train_batched.py` / `grok_bench.py` train multiple specs
  per launch.
- **Watchdogs** — `fleet_watchdog.sh`, `finalize_fleet.sh` keep long unattended runs alive.

## Requirements

- Python 3.10+
- PyTorch (CUDA build), NumPy
- The dataset file `grok_data.npz` (not included — see `farm_readme.md` for its format)

## Run

Start the runner detached:

```
nohup python grok_queue.py > grok_queue.out 2>&1 &
```

Add a spec by appending one JSON object (one line) with a unique `id` to
`experiments_queue.jsonl`; the runner picks up new pending lines on its next scan. Stop the farm by
creating the sentinel file `grok_queue.STOP` in this folder (the runner checkpoints and exits at
the next epoch/queue boundary); delete it before relaunching.

## Notes

- The training/holdout split is chronological, and the harness computes null baselines (no-change
  martingale, shuffled-target permutation floors) so a result is compared against a trivial baseline
  out-of-sample.
- Optional speed switches (`GROK_FAST`, `GROK_BATCH`, `GROK_GRAPH`) are documented in
  `farm_readme.md`; all default off.
- See **[`farm_readme.md`](farm_readme.md)** for the full operator's manual (spec format, sample
  sets, target kinds, scoring details) and **[`composite_streams.md`](composite_streams.md)** for the
  derived-channel definitions.
