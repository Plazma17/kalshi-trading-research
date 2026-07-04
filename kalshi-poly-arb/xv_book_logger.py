"""#9 CROSS-VENUE rich book logger — Kalshi <-> Polymarket US political TWINS.

WHY (future_markets_candidates.md #9): the SAME political/global event priced on two venues with
different user bases (Polymarket = international/crypto, Kalshi = US retail) reacts to news at
different speeds -> 1-5% (up to 8c) divergences lasting seconds-to-minutes. The biggest, most
PERSISTENT gaps are in politics/global (not crypto/sports, which close in 15-30s bot-only). The
deeper structural angle is settlement-criteria mismatch. We PRE-LOG both legs' books NOW to build
the divergence-vs-time dataset BEFORE trading (limited backfill -> must log forward).

WHAT IT DOES:
  - Reads a curated watchlist of political twin pairs (xv_politics_watchlist.json): each entry pins a
    Kalshi ticker <-> a Polymarket US slug that resolve on the SAME real-world question. Curated +
    human-verified by design (the poly-arb memory's #1 hard part: a wrong match turns "divergence"
    into a naked directional bet). Pairs flagged verify_resolution are logged but tagged.
  - Per cycle, per pair: pulls Kalshi top-of-book (kalshi_source.fetch_market -> yes/no ask+bid in
    dollars) AND Polymarket US real /book (poly_source.fetch_book -> bids/offers w/ depth) + /bbo.
    Logs BOTH venues' executable prices + DEPTH + the cross-venue divergence (both directions),
    atomic append-only jsonl.
  - DATA-INTEGRITY FIRST (the hard-won poly-arb lesson): PM /bbo is STALE in fast moves; the real
    /book is the truth. We log BOTH and stamp pm_book_depth so a downstream study can tell a real
    gap from a phantom /bbo mirage. Never asserts an arb; this is a READ-ONLY monitor/logger.
  - Robust: every venue/pair call is error-isolated (one bad pair never stops the sweep); missing
    quotes -> None, never a phantom 0; gentle on PM's 60 req/min public limit (req_delay).
  - Heartbeat with internal `t` (freshness, not file mtime) -> xv_politics_hb.json sidecar.

RUN:  python xv_book_logger.py [--interval 20] [--req-delay 0.4] [--once]
  Env RICH_LOG_DIR overrides the output dir (default ../future_logs). NEVER trades. No creds needed
  for reads (Kalshi public; PM US reads are on the public gateway — poly_source handles it).
"""
from __future__ import annotations

import argparse
import json
import os
import time

import kalshi_source
import poly_source

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.environ.get("RICH_LOG_DIR", os.path.join(HERE, "..", "future_logs"))
WATCHLIST = os.path.join(HERE, "xv_politics_watchlist.json")
OUT = os.path.join(LOG_DIR, "xv_politics_book.jsonl")
HB = os.path.join(LOG_DIR, "xv_politics_hb.json")


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def load_watchlist():
    """Curated twin pairs. Falls back to a small SEED so the logger is runnable out of the box and
    documents the schema; replace/extend xv_politics_watchlist.json with human-verified pairs."""
    try:
        with open(WATCHLIST, encoding="utf-8") as f:
            d = json.load(f)
        pairs = d.get("pairs") if isinstance(d, dict) else d
        if pairs:
            return pairs
    except FileNotFoundError:
        log(f"no {os.path.basename(WATCHLIST)} -> writing a documented SEED (edit it with real twins)")
        _write_seed()
    except Exception as e:
        log("watchlist read err:", str(e)[:80])
    try:
        with open(WATCHLIST, encoding="utf-8") as f:
            return json.load(f).get("pairs", [])
    except Exception:
        return []


def _write_seed():
    """A documented, EMPTY-by-default seed. Politics twins must be human-verified (resolution
    criteria match), so we do NOT ship guessed pairs — only the schema + an example, commented."""
    os.makedirs(LOG_DIR, exist_ok=True)
    seed = {
        "_README": (
            "Curated Kalshi<->Polymarket US POLITICAL twin pairs. Each pair MUST resolve on the same "
            "real-world question (verify the rulebooks — a wrong match = naked directional bet). "
            "Fill 'pairs' with verified entries. verify_resolution=true logs the pair but tags it as "
            "rulebook-unconfirmed."
        ),
        "_schema": {
            "name": "human label",
            "kalshi_ticker": "KX... exact market ticker (YES = the event happening)",
            "poly_slug": "polymarket US market slug (YES instrument)",
            "verify_resolution": "bool: true if the two rulebooks are not yet confirmed identical",
        },
        "_example": {
            "name": "EXAMPLE - 2026 NYC mayoral winner (DISABLED, verify before use)",
            "kalshi_ticker": "KXMAYORNYC-26-XXX",
            "poly_slug": "will-xxx-win-the-2026-nyc-mayoral-election",
            "verify_resolution": True,
        },
        "pairs": [],
    }
    with open(WATCHLIST, "w", encoding="utf-8") as f:
        json.dump(seed, f, indent=2)


def _pm_top(book):
    """From poly_source.fetch_book() {'bids':[(px,qty)..],'offers':[(px,qty)..]} -> best YES
    ask/bid + their depth. offers = YES asks (what you BUY at), bids = YES bids (what you SELL at).
    Highest-priority levels are first per the gateway; we take the marketable extreme defensively."""
    offers = book.get("offers") or []
    bids = book.get("bids") or []
    yes_ask = min((p for p, q in offers if q > 0), default=None)
    yes_bid = max((p for p, q in bids if q > 0), default=None)
    ask_depth = sum(q for p, q in offers if yes_ask is not None and p == yes_ask)
    bid_depth = sum(q for p, q in bids if yes_bid is not None and p == yes_bid)
    return yes_ask, yes_bid, round(ask_depth, 1), round(bid_depth, 1)


def poll_pair(p, req_delay):
    """One twin -> a log row, or None to skip (both venues unreadable). Error-isolated per venue:
    a failure on one venue still logs the other side (the divergence study wants partial data too)."""
    name = p.get("name", "?")
    kt = p.get("kalshi_ticker")
    slug = p.get("poly_slug")
    now = time.time()
    row = {"ts": round(now, 2), "name": name, "kalshi_ticker": kt, "poly_slug": slug,
           "verify_resolution": bool(p.get("verify_resolution", False))}

    # --- Kalshi leg (public, no auth) ---
    try:
        m = kalshi_source.fetch_market(kt) if kt else None
        if m is not None:
            row["kx_yes_ask"] = m.yes_ask
            row["kx_no_ask"] = m.no_ask
            row["kx_yes_bid"] = m.yes_bid
            row["kx_no_bid"] = m.no_bid
    except Exception as e:
        row["kx_err"] = str(e)[:60]
    time.sleep(req_delay)

    # --- Polymarket US leg (public gateway; /book = the TRUTH, /bbo logged as the stale comparator) ---
    if slug:
        try:
            book = poly_source.fetch_book(slug)
            ya, yb, ad, bd = _pm_top(book)
            row["pm_yes_ask"] = ya
            row["pm_yes_bid"] = yb
            row["pm_ask_depth"] = ad
            row["pm_bid_depth"] = bd
        except Exception as e:
            row["pm_book_err"] = str(e)[:60]
        time.sleep(req_delay)
        try:
            bbo_ask, bbo_bid = poly_source.fetch_bbo(slug)   # KNOWN-stale-in-fast-moves comparator
            row["pm_bbo_ask"] = bbo_ask
            row["pm_bbo_bid"] = bbo_bid
        except Exception as e:
            row["pm_bbo_err"] = str(e)[:60]

    # --- cross-venue divergence (both directions), from EXECUTABLE prices, fee-naive (study layer) ---
    kx_ya, pm_yb = row.get("kx_yes_ask"), row.get("pm_yes_bid")
    pm_ya, kx_yb = row.get("pm_yes_ask"), row.get("kx_yes_bid")
    # buy YES cheap on one venue vs sell (=its bid) on the other; positive = a raw cross-venue gap
    if kx_ya is not None and pm_yb is not None:
        row["gap_buyKX_sellPM"] = round(pm_yb - kx_ya, 4)      # buy Kalshi YES, exit at PM YES bid
    if pm_ya is not None and kx_yb is not None:
        row["gap_buyPM_sellKX"] = round(kx_yb - pm_ya, 4)      # buy PM YES, exit at Kalshi YES bid
    return row


def append_atomic(rows):
    if not rows:
        return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = "".join(json.dumps(r) + "\n" for r in rows)
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())


def write_hb(sweep, pairs_n, logged, sample):
    hb = {"hb": "xv_politics", "t": round(time.time(), 2), "sweep": sweep,
          "pairs": pairs_n, "logged": logged}
    if sample:
        hb["sample"] = {k: sample.get(k) for k in
                        ("name", "kx_yes_ask", "pm_yes_ask", "gap_buyKX_sellPM", "gap_buyPM_sellKX")}
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(HB, "w", encoding="utf-8") as f:
            json.dump(hb, f)
    except Exception as e:
        log("hb-write err:", str(e)[:60])
    log("HB", json.dumps({k: hb.get(k) for k in ("sweep", "pairs", "logged")}),
        ("e.g. " + json.dumps(hb["sample"])) if "sample" in hb else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=20.0, help="seconds between sweeps")
    ap.add_argument("--req-delay", type=float, default=0.4, help="delay between API calls (PM 60/min)")
    ap.add_argument("--hb-every", type=int, default=10, help="heartbeat every N sweeps")
    ap.add_argument("--once", action="store_true", help="one sweep then exit (smoke test)")
    a = ap.parse_args()

    pairs = load_watchlist()
    log(f"xv_book_logger start: {len(pairs)} twin pairs -> {os.path.relpath(OUT, HERE)} "
        f"(interval={a.interval}s)")
    if not pairs:
        log("WARNING: empty watchlist. Edit xv_politics_watchlist.json with verified twins, then "
            "restart. (Seed written.) Exiting cleanly.")
        write_hb(0, 0, 0, None)
        return

    sweep = 0
    while True:
        sweep += 1
        rows = []
        for p in pairs:
            try:
                r = poll_pair(p, a.req_delay)
                if r is not None:
                    rows.append(r)
            except Exception as e:
                log(f"pair {p.get('name','?')} err:", str(e)[:80])   # isolate; never stop the sweep
        append_atomic(rows)
        if sweep % a.hb_every == 0 or sweep == 1:
            write_hb(sweep, len(pairs), len(rows), rows[0] if rows else None)
        if a.once:
            break
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
