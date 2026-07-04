# News-Trader

An Electron + React + TypeScript desktop app that runs a locally-hosted LLM (via Ollama) to
classify financial headlines and backtest those classifications against historical price moves.
It also includes scripts to QLoRA-fine-tune a Qwen2.5 base model on a headline-reaction dataset.
Everything runs locally; v1 is a research/backtesting tool and does not place live orders.

## What it does

1. **Ingest** — pulls historical headlines (FNSPID and other sources) and per-ticker price series
   (`yahoo-finance2`), caching them locally.
2. **Classify** — sends each headline to a local LLM through Ollama with a Zod → JSON-Schema
   constrained prompt, so the model returns a validated object (direction, magnitude, horizon,
   confidence, rationale) rather than free text.
3. **Review & tune** — a Review tab to inspect classifications, edit the active prompt, and A/B
   prompt variants; a Tuning tab drives the fine-tuning loop.
4. **Fine-tune** — `scripts/train-lora.py` runs a QLoRA (4-bit) fine-tune of a Qwen2.5 base
   (7B or 14B) on a headline → realized-move dataset, streaming step/loss/ETA and the loss curve
   back into the app's Running tab via a `TrainerCallback`. `merge-lora.py` merges the adapter and
   prepares it for Ollama serving.
5. **Backtest** — replays classifications against realized returns with several backtest engines
   (managed, overlay, per-ticker, long/short), reporting materiality-filtered performance.

## Requirements

- Node.js (v20+) and npm
- [Ollama](https://ollama.com/) installed and running locally, with a Qwen2.5 model pulled
- For fine-tuning: Python 3.10+, a CUDA GPU, and the packages used by `scripts/` (PyTorch, PEFT,
  TRL, bitsandbytes, transformers)

## Setup

```
cd news-trader-app
npm install
```

## Run

```
npm run dev        # start the app in development
npm run build      # build the packaged app
```

Fine-tuning and data steps are run directly from `scripts/`, e.g.:

```
python scripts/train-lora.py     # QLoRA fine-tune of Qwen2.5 on the reaction dataset
python scripts/merge-lora.py     # merge the adapter into a model for Ollama
```

## Layout

```
news-trader-app/
  src/
    main/         # Electron main: ollama.ts, backtest.ts, tuning.ts, data.ts, ipc.ts, state.ts …
    renderer/     # React UI: RunningView, ReviewView, BacktestView, PromptView, TopicsView …
    shared/       # Zod schemas shared across main, renderer, and Python
  scripts/        # data ingestion, LoRA training/merge, backtest + self-check harnesses
    train-lora.py       # QLoRA fine-tune of Qwen2.5 on the reaction dataset
    merge-lora.py       # merge adapter -> mergeable model for Ollama
    lora-out*/          # adapter configs + trainer state (weights excluded)
```

## Notes

- Shared Zod schemas (`src/shared/schema`) are compiled to JSON Schema and enforced at decode time,
  and the same schema types are reused across the main process, the renderer, and the Python trainer.
- The progress bar estimates completion by learning the typical token count per mode (EMA); the live
  token stream is the ground truth.
- Large model weights, tokenizer blobs, and cached datasets are excluded from the repo — only code,
  configs, and adapter metadata are checked in.
