# kalshi-poly-arb

A scanner that compares Kalshi and Polymarket prices on matching real-world events and reports
where a cross-venue spread appears after fees. It is read-only: v1 is a scanner only and does not
place orders.

## How it works

For one binary event, buying YES on the cheaper venue and NO on the other locks a $1 payout
(exactly one side resolves true):

```
pay    = ask(YES on venue A) + ask(NO on venue B) + fees
payoff = $1.00
profit = 1.00 - pay
```

If `pay < 1.00` net of fees the pair is flagged. The scanner checks both directions
(YES@Kalshi+NO@PM and YES@PM+NO@Kalshi) and reports the better one, ranked by modeled net profit.

The fee model: Kalshi charges a per-contract fee (`ceil(0.07 · P · (1−P))` dollars); Polymarket
charges 0% trading fee but has Polygon gas and USDC ramp friction. Reported profit is net of the
modeled fees, not gross.

## Data sources (both public, no auth for reading)

- **Kalshi:** `https://api.elections.kalshi.com/trade-api/v2/markets` — no signature needed for
  market data (auth only gates portfolio/orders). Prices in integer cents.
- **Polymarket:** `https://gamma-api.polymarket.com/markets` — public. `outcomePrices` are
  probabilities in dollars; `clobTokenIds` link to the CLOB order book.

## Requirements

- Python 3.10+ (standard library only for the scanner; no pip install required)
- The authenticated probes (`authbook_probe.py`, `arb_executor.py`, `monitor_fast.py`) additionally
  need `cryptography` and credentials (see Notes)

## Run

```
python scan.py                                  # full scan, prints ranked results, writes reports/<ts>.json
python scan.py --min-profit 0.02 --limit 30
```

## Layout

```
kalshi-poly-arb/
  model.py          # the common Market record (venue-agnostic, prices in DOLLARS)
  kalshi_source.py  # public Kalshi market-data fetch -> Market[]
  poly_source.py    # public Polymarket Gamma fetch  -> Market[]
  matcher.py        # normalize + block + score candidate equivalent pairs across venues
  arbmath.py        # fee model + best cross-venue arb for a matched pair
  scan.py           # orchestrator: fetch both -> match -> score -> ranked report (+ JSON)
  reports/          # timestamped JSON scan outputs
```

## Notes

- **Resolution mismatch.** Two markets can read identically yet resolve on different dates, sources,
  or fine print. Matching is conservative and advisory: the scanner flags candidate pairs with a
  similarity score, and a human must confirm the resolution criteria match before any execution. The
  scanner never auto-executes.
- **Indicative vs. executable prices.** The bulk feeds give mid/last (Polymarket `outcomePrices`)
  and top-of-book (Kalshi `yes_ask`/`no_ask`). A real fill needs the executable ask with depth, so
  flagged pairs should be re-checked against the live order book (Polymarket CLOB `/book`, Kalshi
  `/markets/{t}/orderbook`) for the size intended. v1 scans the cheap feeds and marks results
  "indicative".
- Credentials for the authenticated probes are read from a git-ignored `creds.env`
  (`KALSHI_API_KEY`, `KALSHI_PRIVATE_KEY_PATH`, `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY`); none
  are included.

## Status

- [x] Public data fetch from both venues
- [x] Cross-venue market matcher (advisory similarity score + date compatibility)
- [x] Fee-aware arb math + ranked report
- [ ] Executable-depth re-check of flagged pairs against live CLOB / Kalshi orderbooks
- [ ] Resolution-criteria assist (surface both venues' rules side by side)
- [ ] Continuous monitor + alerting on fresh spreads
- [ ] Execution (Kalshi key + Polymarket USDC wallet)
