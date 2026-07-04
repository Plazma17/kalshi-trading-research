# grok_monitor

An Electron desktop app that displays the training farm (`../grok`) in real time. It watches the
farm's `progress_<id>.json` curve files and renders a grid of every training run — loss curves,
holdout metrics, edge-over-baseline, epoch progress, and run status.

## What it does

- Tails the farm's progress files and streams updated curves into the UI as nets train.
- Shows the fleet as a grid of mini training charts with per-run status (running / done / stalled)
  and key metrics.
- Reads the progress files read-only, so it can be opened, closed, or restarted without disturbing
  a running GPU job.

## Requirements

- Node.js and npm

## Run

```
npm install
npm start
```

## Notes

Pairs with the Python/PyTorch farm in `../grok`; point it at the same folder the farm writes its
`progress_*.json` files to.
