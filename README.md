# kalshi-trading-research

A collection of projects for prediction-market data and analytics, plus a couple of
supporting tools. Each subfolder is a self-contained project with its own README.

## Projects

- **[news-trader-app/](news-trader-app/)** — Electron + React + TypeScript desktop app that runs
  a local LLM (via Ollama) to classify financial headlines and backtest the classifications
  against historical price moves. Includes QLoRA fine-tuning scripts for a Qwen2.5 base.
- **[grok/](grok/)** — Python/PyTorch neural-net training farm. One process owns the GPU and works
  a queue of experiment specs; other scripts only generate specs. Checkpoint-resumable.
- **[grok_monitor/](grok_monitor/)** — Electron app that reads the training farm's progress files
  and renders a live grid of every run.
- **[kalshi-cta/](kalshi-cta/)** — Python `asyncio` WebSocket feed clients for Kalshi and several
  crypto spot venues, writing atomic JSON snapshots, plus an Electron dashboard that displays the
  live data and a set of paper-trading strategies.
- **[kalshi-poly-arb/](kalshi-poly-arb/)** — Python scanner that compares Kalshi and Polymarket
  prices on matching events and reports fee-adjusted cross-venue spreads. Read-only; no order
  placement.
- **[cta_scan/](cta_scan/)** — Rust query engine (stdin/stdout) that reads a tick-log archive and
  answers pivot/correlation/distribution queries for the kalshi-cta dashboard.
- **[rs_hello/](rs_hello/)** — Minimal Rust crate for checking the toolchain and a native-throughput
  baseline.

## Notes

No credentials, keys, model weights, or private data are included. Each service reads secrets from
a local, git-ignored file you supply (see each project's README). The trading components are
research and simulation tools.
