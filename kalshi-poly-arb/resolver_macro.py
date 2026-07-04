"""Macro data-release resolver — the HONEST cross-venue matcher.

Fuzzy text matching fails here (proven: best score 0.39, all garbage) because the two venues
phrase the same event differently and their feeds are sports-dominated. The fix: for each
standardized macro family, fetch BOTH venues' markets directly (Polymarket US by category via
the public gateway; Kalshi by SERIES TICKER) and align on the STRUCTURED fields
`(metric, period, threshold)`. Both venues express these as identical "≥ threshold" YES/NO
ladders on the same government release, so a match is exact and resolution-safe BY
CONSTRUCTION — it sidesteps the resolution-mismatch trap instead of guessing around it.

Confirmed live example: PM `nfpc-…-atl150k` ("At least 150,000") ↔ Kalshi
`KXPAYROLLS-26JUN-T150000` ("Above 150,000") — both the same June-2026 BLS jobs report.

Prices are executable top-of-book (PM bestAskQuote/bestBidQuote == /bbo; Kalshi
yes/no_ask_dollars). Depth is often THIN at the touch — size with the /book recheck before
trading. This is a SCANNER; it never trades.
"""

from __future__ import annotations

import json
import re
import urllib.request

import arbmath
import kalshi_source
import poly_source
from model import Market, parse_iso

# Each family ties a Polymarket-US question pattern to a Kalshi series ticker. `unit` picks
# the threshold tolerance: counts (jobs) match exactly on the shared grid; percents match to
# 0.05 to absorb 4.9 vs 4.90 rounding.
FAMILIES = [
    {"key": "jobs/NFP",       "pm": r"jobs added",        "series": "KXPAYROLLS",    "unit": "count"},
    {"key": "unemployment",   "pm": r"unemployment rate", "series": "KXU3",          "unit": "pct"},
    {"key": "CPI inflation",  "pm": r"\bcpi\b|inflation", "series": "KXCPIYOY",      "unit": "pct"},
]

_TOL = {"count": 0.5, "pct": 0.05}


def _num(s):
    """First number in a label: 'At least 175,000' -> 175000.0, 'Above 4.9%' -> 4.9."""
    if s is None:
        return None
    m = re.search(r"-?\$?([\d,]+(?:\.\d+)?)", str(s))
    return float(m.group(1).replace(",", "")) if m else None


def _kx_series_markets(series: str) -> list[dict]:
    """All open raw Kalshi markets in a series (paginated)."""
    out, cursor = [], None
    while True:
        url = (f"{kalshi_source.KALSHI_BASE}/markets?series_ticker={series}"
               f"&status=open&limit=200" + (f"&cursor={cursor}" if cursor else ""))
        req = urllib.request.Request(url, headers={"Accept": "application/json",
                                                   "User-Agent": "kpa-macro/0.1"})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        ms = d.get("markets") or []
        out += ms
        cursor = d.get("cursor")
        if not cursor or not ms:
            break
    return out


def find_macro_pairs() -> list[dict]:
    """Return aligned cross-venue pairs (one per shared threshold) with arb math attached."""
    pm_all = poly_source.fetch_markets(max_markets=3000, backend="us")
    # index PM markets by slug for the raw threshold/title (poly_source already parsed prices)
    pm_by_id = {m.market_id: m for m in pm_all}
    pm_raw = {m.market_id: m.raw for m in pm_all}

    results = []
    for fam in FAMILIES:
        rx = re.compile(fam["pm"], re.I)
        pm_fam = [m for m in pm_all if rx.search(m.question)]
        kx_raw = _kx_series_markets(fam["series"])
        tol = _TOL[fam["unit"]]

        # PM threshold lives in the market `title` ("At least 150,000"), not the shared
        # `question` ("Jobs Added in June 2026") — pull from the raw fields.
        pm_th = []
        for m in pm_fam:
            raw = pm_raw.get(m.market_id) or {}
            t = _num(raw.get("title")) or _num(raw.get("slug", "").rsplit("-", 1)[-1])
            if t is not None:
                pm_th.append((m, t))
        kx_th = [(km, _num(r.get("yes_sub_title"))) for r in kx_raw
                 if (km := kalshi_source._to_market(r)) and _num(r.get("yes_sub_title")) is not None]

        for pm_m, pt in pm_th:
            for kx_m, kt in kx_th:
                if abs(pt - kt) > tol:
                    continue
                # same metric + same threshold; require resolution windows within ~45d
                if (pm_m.close_time and kx_m.close_time
                        and abs((pm_m.close_time - kx_m.close_time).days) > 45):
                    continue
                arb = arbmath.best_arb(pm_m, kx_m)
                results.append({
                    "family": fam["key"], "threshold": pt,
                    "pm": pm_m, "kx": kx_m, "arb": arb,
                })
    results.sort(key=lambda r: -(r["arb"]["net_profit"] if r["arb"] else -9))
    return results


# A live, liquid binary book has yes_ask + no_ask ≈ 1.0–1.05 (the spread). A sum well above
# that means a stale/illiquid quote — the #1 source of phantom cross-venue "arbs".
_TIGHT = 1.06


def _spread(m: Market):
    if m.yes_ask is None or m.no_ask is None:
        return None
    return m.yes_ask + m.no_ask


def main() -> int:
    pairs = find_macro_pairs()
    print("=" * 84)
    print(f"  MACRO CROSS-VENUE RESOLVER — {len(pairs)} aligned (metric, threshold) pairs")
    print("  Polymarket US  vs  Kalshi   |   executable top-of-book")
    print("  Every Kalshi 'Above X' (>) vs PM 'At least X' (>=) pair carries BOUNDARY risk at X.")
    print("=" * 84)

    clean = []
    for r in pairs:
        pm, kx, arb = r["pm"], r["kx"], r["arb"]
        sp_pm, sp_kx = _spread(pm), _spread(kx)
        stale = (sp_pm is not None and sp_pm > _TIGHT) or (sp_kx is not None and sp_kx > _TIGHT)
        r["stale"] = stale
        if arb and arb["net_profit"] > 0 and not stale:
            clean.append(r)

    for r in pairs:
        pm, kx, arb = r["pm"], r["kx"], r["arb"]
        if not (arb and arb["net_profit"] > 0):
            continue
        tag = "STALE/ILLIQUID — discard" if r["stale"] else "tight books — REAL CANDIDATE"
        print(f"\n[{r['family']}] threshold {r['threshold']:g}  net "
              f"+${arb['net_profit']:.3f}/ct ({arb['net_profit_pct']:.1f}%)  <{tag}>")
        print(f"   PM[{pm.market_id}]  yes_ask={_f(pm.yes_ask)} no_ask={_f(pm.no_ask)}  spread={_f(_spread(pm))}")
        print(f"   KX[{kx.market_id}]  yes_ask={_f(kx.yes_ask)} no_ask={_f(kx.no_ask)}  spread={_f(_spread(kx))}")
        print(f"   best: {arb['buy_yes_on']}->YES @{arb['yes_ask']:.3f} + "
              f"{arb['buy_no_on']}->NO @{arb['no_ask']:.3f}  fees ${arb['fees']:.3f}")

    print("\n" + "-" * 84)
    print(f"  {len(clean)} candidate(s) survive the staleness filter (tight books on BOTH venues).")
    print("  Even these are NOT risk-free: confirm (1) >= vs > boundary at the threshold, and")
    print("  (2) executable DEPTH via /book — the touch is often only a few contracts.")
    return 0


def _f(v):
    return f"{v:.3f}" if isinstance(v, float) else "—"


if __name__ == "__main__":
    raise SystemExit(main())
