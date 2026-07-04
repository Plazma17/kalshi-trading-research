# rs_hello

A minimal Rust crate for checking the toolchain and getting a native-throughput baseline before
building `../cta_scan`. It times a tight 100M-iteration loop and prints the result.

## Requirements

- Rust toolchain (`cargo`)

## Run

```
cargo run --release
```
