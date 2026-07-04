# kalshi-cta — market data feeds + Electron dashboard

A set of authenticated WebSocket feed clients that stream and fuse live market data, and an
Electron dashboard that displays the feeds, order books, derived signals, and a fleet of
paper-trading strategies. The paper-trading fleet is simulation only.

## Feed clients

Each feed is an independent, auto-reconnecting `asyncio` WebSocket client that writes a compact JSON
snapshot atomically (`.tmp` + `os.replace`, so a reader never sees a torn file):

- **`kalshi_feed.py`** — authenticated Kalshi market-data socket (RSA-PSS request signing).
  Subscribes to the current market's ticker + order-book channels, tracks top-of-book depth,
  re-subscribes when the trading window rolls, and logs a throttled order-book time series.
- **`cf_feed.py`** — a composite BTC index: streams trades from several spot venues (Coinbase,
  Kraken, Bitstamp, Gemini), maintains rolling per-exchange volume, and publishes a volume-weighted
  index at ~25 writes/sec. Each exchange reconnects independently; the index uses whichever venues
  are currently fresh.
- **`btc_feed.py`** — lightweight spot price feed.
- **`brti_book_feed.py`** — multi-venue order-book reconstruction feed: maintains live L2 books
  across constituents at sub-second resolution.

## Dashboard (`dashboard/`)

A packaged Electron application that displays the running system:

- Live cards and charts for the market quote, composite index, order-book depth, and derived
  streams.
- A streams picker with rolling time-series history across dozens of derived channels.
- Window-analysis tooling (Node worker plus optional R sidecar) producing pivot/heatmap and
  lag-matrix explorers over the recorded streams, including a 3D isometric view.
- A built-in remote-sync stream (a single persistent SSH stream run inside the app) that mirrors a
  remote compute node's data locally with an mtime-gated atomic writer.

## Requirements

- Python 3.10+ with `websockets` and `cryptography`
- Node.js and npm for the dashboard
- Optionally R (for the analysis sidecar)
- Kalshi API credentials (see Notes)

## Run

Feeds:

```
python kalshi_feed.py
python cf_feed.py
```

Dashboard:

```
cd dashboard
npm install
npm start
```

## Notes

- Credentials are read from a local, git-ignored file; none are included. The feed clients expect
  `KALSHI_API_KEY` and a path to an RSA private key (`KALSHI_PRIVATE_KEY_PATH`).
- Feeds use freshness tracking so a stale venue is dropped rather than trusted.
- The dashboard resolves data paths differently in packaged vs. dev builds; run it from this folder
  so it finds the snapshot files.
