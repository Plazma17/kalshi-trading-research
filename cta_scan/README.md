# cta_scan — Rust scan engine

A multithreaded Rust query engine used by the kalshi-cta dashboard's "Window Analysis" tooling. It
reads an append-only tick-log archive per query, computes derived and forward-looking metrics, and
answers pivot / correlation / window-catalog / distribution queries. It reads a JSON query on stdin
and writes a compact JSON result on stdout, so it can be called as a sidecar from any process.

## Requirements

- Rust toolchain (`cargo`)

## Build & run

```
cargo build --release
echo '{"kind":"pivot", ...}' | ./target/release/cta_scan
```

## Notes

- Uses a hand-written byte scanner for the parse path (no `serde`) and `rayon` for parallel parsing
  and per-window aggregation.
- A two-pass forward-fill per 15-minute window ensures the `+Hs` forward columns use only ticks
  strictly after time `t`, so no look-ahead enters the forward-looking metrics.
- Per-tick structs use `f32` for analytics and `f64` only for the epoch timestamp; the release
  profile sets `lto`, `codegen-units = 1`, and `panic = abort`.
