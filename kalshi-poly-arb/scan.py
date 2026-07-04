"""Orchestrator: fetch both venues -> match equivalent markets -> compute fee-aware arb ->
ranked report (stdout + reports/<timestamp>.json).

Usage:
  PY=C:/Users/Noah/AppData/Local/Programs/Python/Python312/python.exe
  $PY scan.py                          # global PM fixture + live Kalshi
  $PY scan.py --backend us             # live Polymarket US (needs Ed25519 creds in env)
  $PY scan.py --min-profit 0.02 --match-threshold 0.6 --limit 40

This is a SCANNER. Every printed opportunity is a CANDIDATE requiring human verification of
(1) resolution-criteria equivalence and (2) executable depth on the live order books before
any trade. Prices from the bulk feeds are indicative.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time

# Windows consoles default to cp1252 and choke on non-ASCII — force UTF-8 so the report
# (and any market title with a non-ASCII char) prints instead of crashing the run.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

import creds
creds.load()  # pull Polymarket US keys from gitignored creds.env into the environment

import arbmath
import authbook_probe
import kalshi_source
import matcher
import poly_source

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")

# ── phantom-depth gate (World-Cup-arb watcher recommendation, 2026-07-02) ─────────────────
# The public /markets snapshot's top-of-book PERSISTS even when the live book is EMPTY —
# gross net>0 "arbs" against zero real depth are the recurring phantom-arb illusion. Before
# REPORTING any net>0 candidate, read the REAL resting book via the authenticated /orderbook
# and require >= MIN_REAL_DEPTH contracts on the BINDING Kalshi leg (the side the arb needs
# to take). Also re-check the real executable price: if the true ask erases the net, it was
# a stale quote, not an arb.
MIN_REAL_DEPTH = 10


def depth_gate(opps: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split net>0 candidates into (verified, phantom). Each opp gets a `depth_check` dict.
    If the authenticated read itself fails (no creds / network) the candidate is KEPT but
    marked verified=False/reason=unavailable — depth UNKNOWN is not depth ZERO, but it must
    never be silently presented as a confirmed arb."""
    verified, phantom = [], []
    for o in opps:
        a = o["arb"]
        if o["net_profit"] <= 0:  # only positive candidates need the gate
            o["depth_check"] = {"verified": None, "reason": "net<=0 (not gated)"}
            verified.append(o)
            continue
        ticker = o["kalshi"]["id"]
        binding = "buy_yes" if a["buy_yes_on"] == "kalshi" else "buy_no"
        snap_ask = a["yes_ask"] if binding == "buy_yes" else a["no_ask"]
        d = authbook_probe.real_depth(ticker)
        time.sleep(0.15)  # be gentle on the authenticated endpoint
        if not d["ok"]:
            o["depth_check"] = {"verified": False, "binding_leg": binding,
                                "reason": f"auth book unavailable ({d['error']}) — UNVERIFIED"}
            verified.append(o)
            continue
        lvl = d.get(binding)
        if lvl is None:
            o["depth_check"] = {"verified": False, "binding_leg": binding, "real_size": 0,
                                "reason": "EMPTY real book on the binding leg (phantom top-of-book)"}
            phantom.append(o)
            continue
        real_px, real_size = lvl
        if real_size < MIN_REAL_DEPTH:
            o["depth_check"] = {"verified": False, "binding_leg": binding,
                                "real_ask": real_px, "real_size": real_size,
                                "reason": f"real depth {real_size:.0f} < {MIN_REAL_DEPTH} contracts"}
            phantom.append(o)
            continue
        # depth is real — re-check the price: net after replacing the snapshot ask with the
        # REAL executable ask on the binding leg (fees move too; approximate with the delta).
        net_real = o["net_profit"] - max(0.0, real_px - (snap_ask or real_px))
        if net_real <= 0:
            o["depth_check"] = {"verified": False, "binding_leg": binding,
                                "real_ask": real_px, "real_size": real_size,
                                "reason": f"stale quote: real ask {real_px:.3f} erases the net "
                                          f"({net_real:+.3f})"}
            phantom.append(o)
            continue
        o["depth_check"] = {"verified": True, "binding_leg": binding,
                            "real_ask": real_px, "real_size": real_size,
                            "net_at_real_ask": round(net_real, 4)}
        verified.append(o)
    return verified, phantom


def run(backend: str, match_threshold: float, min_profit: float, limit: int,
        max_markets: int) -> dict:
    print(f"[1/3] fetching markets  (kalshi: public | polymarket backend={backend})", flush=True)
    kalshi = kalshi_source.fetch_markets(max_markets=max_markets)
    poly = poly_source.fetch_markets(max_markets=max_markets, backend=backend)
    k_quoted = [m for m in kalshi if m.quoted]
    p_quoted = [m for m in poly if m.quoted]
    print(f"      kalshi: {len(kalshi)} ({len(k_quoted)} quoted) | "
          f"polymarket: {len(poly)} ({len(p_quoted)} quoted)", flush=True)

    print(f"[2/3] matching equivalent markets (threshold={match_threshold})", flush=True)
    pairs = matcher.match(k_quoted, p_quoted, threshold=match_threshold)
    print(f"      {len(pairs)} candidate pairs above threshold", flush=True)

    print("[3/3] scoring arbs (fee-aware)", flush=True)
    opps = []
    for score, p, k, ev in pairs:
        arb = arbmath.best_arb(p, k)
        if not arb:
            continue
        opps.append({
            "match_score": round(score, 3),
            "net_profit": arb["net_profit"],
            "net_profit_pct": arb["net_profit_pct"],
            "arb": arb,
            "polymarket": {"id": p.market_id, "q": p.question, "yes_ask": p.yes_ask,
                           "no_ask": p.no_ask, "close": _iso(p.close_time), "url": p.url},
            "kalshi": {"id": k.market_id, "q": k.question, "yes_ask": k.yes_ask,
                       "no_ask": k.no_ask, "close": _iso(k.close_time), "url": k.url},
            "evidence": ev,
        })
    opps.sort(key=lambda o: -o["net_profit"])
    profitable = [o for o in opps if o["net_profit"] >= min_profit]

    # PHANTOM-DEPTH GATE: authenticated real-book check on every net>0 candidate BEFORE it
    # is reported (top-of-book snapshots with zero resting size are the recurring illusion).
    n_gated = sum(1 for o in profitable[:limit] if o["net_profit"] > 0)
    if n_gated:
        print(f"[3b/3] depth-gating {n_gated} net>0 candidates via authenticated /orderbook "
              f"(require >= {MIN_REAL_DEPTH} real contracts on the binding Kalshi leg)", flush=True)
    profitable, phantom = depth_gate(profitable[:limit])

    report = {
        "generated_at": _iso(dt.datetime.now(dt.timezone.utc)),
        "backend": backend, "match_threshold": match_threshold, "min_profit": min_profit,
        "min_real_depth": MIN_REAL_DEPTH,
        "counts": {"kalshi_quoted": len(k_quoted), "poly_quoted": len(p_quoted),
                   "candidate_pairs": len(pairs), "scored": len(opps),
                   "profitable": len(profitable), "phantom_filtered": len(phantom)},
        "opportunities": profitable[:limit],
        "phantom_filtered": phantom,
    }
    _print_report(report, backend)
    _save(report)
    return report


def _iso(d):
    return d.isoformat() if isinstance(d, dt.datetime) else None


def _print_report(report: dict, backend: str) -> None:
    opps = report["opportunities"]
    print("\n" + "=" * 78)
    print(f"  CROSS-VENUE ARB SCAN  —  {report['generated_at']}")
    print(f"  {report['counts']['profitable']} fee-surviving candidates "
          f"(of {report['counts']['scored']} scored pairs)")
    if backend == "global":
        print("  NOTE: backend=global (gamma) is a DEV FIXTURE — indicative mid prices, "
              "global market set.\n        Not Polymarket US executable prices. Do not trade off this.")
    n_phantom = len(report.get("phantom_filtered") or [])
    if n_phantom:
        print(f"  {n_phantom} net>0 candidate(s) FILTERED as phantom/stale depth "
              f"(real book < {report.get('min_real_depth', MIN_REAL_DEPTH)} contracts on the "
              f"binding leg) — see report JSON 'phantom_filtered'")
    print("=" * 78)
    if not opps:
        print("  No fee-surviving arbs found this scan. (This is the common, honest result.)")
    for i, o in enumerate(opps, 1):
        a = o["arb"]
        print(f"\n#{i}  net +${o['net_profit']:.3f}/contract ({o['net_profit_pct']:.1f}%)  "
              f"| match {o['match_score']:.2f}  | {a['buy_yes_on']}→YES @{a['yes_ask']:.3f} + "
              f"{a['buy_no_on']}→NO @{a['no_ask']:.3f}  (fees ${a['fees']:.3f})")
        print(f"     PM[{o['polymarket']['id']}]: {o['polymarket']['q'][:74]}")
        print(f"     KX[{o['kalshi']['id']}]: {o['kalshi']['q'][:74]}")
        dc = o.get("depth_check") or {}
        if dc.get("verified") is True:
            print(f"     depth OK: {dc['real_size']:.0f} real contracts on {dc['binding_leg']} "
                  f"@ {dc['real_ask']:.3f} (net at real ask {dc['net_at_real_ask']:+.3f})")
        elif dc.get("verified") is False:
            print(f"     ⚠ DEPTH UNVERIFIED: {dc.get('reason')}")
        ev = o["evidence"]
        print(f"     evidence: shared={ev.get('shared_tokens')} nums={ev.get('shared_numbers')} "
              f"{ev.get('date')}")
    print("\n  ⚠  CANDIDATES ONLY. Depth-gated on the Kalshi leg; still verify resolution-"
          "criteria match + the POLYMARKET leg's book before trading.\n")


def _save(report: dict) -> None:
    os.makedirs(REPORTS, exist_ok=True)
    name = "scan-" + report["generated_at"].replace(":", "").replace("-", "")[:15] + ".json"
    path = os.path.join(REPORTS, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"  saved -> {path}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Kalshi<->Polymarket US cross-venue arb scanner")
    ap.add_argument("--backend", default=os.environ.get("POLY_BACKEND", "global"),
                    choices=["global", "us"], help="polymarket data source")
    ap.add_argument("--match-threshold", type=float, default=0.6)
    ap.add_argument("--min-profit", type=float, default=0.0,
                    help="min net $/contract to report (0 = show all matched pairs)")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--max-markets", type=int, default=3000)
    args = ap.parse_args(argv)
    try:
        run(args.backend, args.match_threshold, args.min_profit, args.limit, args.max_markets)
    except Exception as e:  # noqa: BLE001 — surface a clean message for the CLI
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
