"""Generate the monitor's watchlist of cross-venue pairs to poll.

The durable edge isn't a standing arb — it's a FLEETING gap during fast price moves. So we
watch VOLATILE, REPEATING markets that re-list constantly. Right now the one family that is
volatile + recurring + on BOTH venues is **World Cup match winners** (the tournament is live;
matches move fast in-play; both venues carry every match with the SAME 3-way structure).

Both encode a match as {teamA-win, teamB-win, draw} using FIFA 3-letter codes + date:
  Polymarket US:  atc-fwc-<a>-<b>-<YYYY-MM-DD>-<outcome>     outcome in {<a>,<b>,draw}
  Kalshi:         KXWCGAME-<DDMMMYY><AB>-<OUTCOME>           outcome in {<A>,<B>,TIE}

This builder enumerates both series, pairs matches by (date, {teams}), and emits a watchlist
entry per shared outcome (teamA / teamB / draw). Re-run it daily to refresh the slate; the
output `watchlist.json` is hand-editable (add/remove pairs, flag resolution caveats).

RESOLUTION CAVEAT (encoded per entry, never assumed): the 3-way "Winner?/Tie" market resolves
on the 90-min regulation result. For KNOCKOUT matches that go to extra time/penalties the two
venues may treat the "draw"/"tie" leg differently — so knockout draws are flagged
`verify_resolution: true`. Group-stage matches resolve cleanly on 90 min.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request

import kalshi_source
import poly_source

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watchlist.json")
_MONTHS = {"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05", "JUN": "06",
           "JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12"}

# The two venues sometimes use different 3-letter country codes (PM=FIFA, Kalshi=IOC).
# Normalize both sides to one canonical code so the same match pairs. Extend as mismatches
# surface (Kalshi/IOC -> PM/FIFA).
_TEAM_ALIAS = {"iri": "irn"}  # Iran: IOC 'IRI' (Kalshi) == FIFA 'IRN' (Polymarket)


def _canon(code: str) -> str:
    c = code.lower()
    return _TEAM_ALIAS.get(c, c)


def _pm_wc_markets() -> dict:
    """Parse PM US World Cup match markets -> {(date, frozenset{teamA,teamB}): {outcome: slug}}."""
    out: dict = {}
    # 2026-07-02: the gateway carries 7,700+ markets; a 3,000 cap silently TRUNCATED the
    # slate (looked like a PM "listing gap" for COL-GHA gha/draw in cycle 16 — it wasn't).
    for m in poly_source.fetch_markets(max_markets=15000, backend="us"):
        slug = m.raw.get("slug", "")
        # atc-fwc-<a>-<b>-<YYYY-MM-DD>-<outcome>
        mo = re.match(r"^atc-fwc-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})-([a-z]+)$", slug)
        if not mo:
            continue
        a, b, date, outcome = mo.groups()
        a, b, outcome = _canon(a), _canon(b), _canon(outcome)
        key = (date, frozenset({a, b}))
        out.setdefault(key, {"teams": (a, b), "outcomes": {}, "game_start": None})
        out[key]["outcomes"][outcome] = slug
        if m.raw.get("gameStartTime") and not out[key]["game_start"]:
            out[key]["game_start"] = m.raw["gameStartTime"]
    return out


def _kx_wc_markets() -> dict:
    """Parse Kalshi KXWCGAME markets -> {(date, frozenset{teamA,teamB}): {outcome: ticker}}."""
    out: dict = {}
    cursor = None
    while True:
        url = (f"{kalshi_source.KALSHI_BASE}/markets?series_ticker=KXWCGAME&status=open"
               f"&limit=200" + (f"&cursor={cursor}" if cursor else ""))
        req = urllib.request.Request(url, headers={"Accept": "application/json",
                                                   "User-Agent": "kpa-wl/0.1"})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        for m in d.get("markets") or []:
            t = m.get("ticker", "")
            # KXWCGAME-<YY><MMM><DD><AAA><BBB>-<OUTCOME>  (e.g. 26JUN21 = 2026-06-21)
            mo = re.match(r"^KXWCGAME-(\d{2})([A-Z]{3})(\d{2})([A-Z]{3})([A-Z]{3})-([A-Z]+)$", t)
            if not mo:
                continue
            yy, mon, dd, ta, tb, outcome = mo.groups()
            if mon not in _MONTHS:
                continue
            date = f"20{yy}-{_MONTHS[mon]}-{dd}"
            key = (date, frozenset({_canon(ta), _canon(tb)}))
            out.setdefault(key, {"outcomes": {}})
            out[key]["outcomes"][_canon(outcome)] = t
        cursor = d.get("cursor")
        if not cursor or not (d.get("markets")):
            break
    return out


def build(dates: set[str] | None = None) -> list[dict]:
    """Pair PM↔Kalshi WC matches. If `dates` is given (YYYY-MM-DD), keep only those days."""
    pm, kx = _pm_wc_markets(), _kx_wc_markets()
    entries = []
    for key in sorted(set(pm) & set(kx)):
        date, teams = key
        if dates and date not in dates:
            continue
        a, b = pm[key]["teams"]
        # shared outcomes: each team win + draw/tie (PM 'draw' == Kalshi 'tie')
        outcome_map = [(a, a), (b, b), ("draw", "tie")]
        for pm_oc, kx_oc in outcome_map:
            pm_slug = pm[key]["outcomes"].get(pm_oc)
            kx_tic = kx[key]["outcomes"].get(kx_oc)
            if not pm_slug or not kx_tic:
                continue
            is_draw = pm_oc == "draw"
            entries.append({
                "id": f"wc-{date}-{a}{b}-{pm_oc}",
                "label": f"WC {date} {a.upper()} v {b.upper()} — "
                         f"{'DRAW' if is_draw else pm_oc.upper()+' win'}",
                "category": "soccer-wc",
                "polymarket_slug": pm_slug,
                "kalshi_ticker": kx_tic,
                "game_start": pm[key].get("game_start"),  # ISO kickoff; drives live-focus polling
                "invert": False,  # both YES = the same outcome
                "verify_resolution": is_draw,  # knockout draw/tie handling differs
                "note": "Both YES resolve on the 90-min regulation result.",
            })
    return entries


def main() -> int:
    import sys
    # optional date filter: `build_watchlist.py 2026-06-21[,2026-06-22]` to target a slate
    dates = None
    if len(sys.argv) > 1:
        dates = {d.strip() for d in sys.argv[1].split(",") if d.strip()}
    entries = build(dates)
    doc = {"description": "Cross-venue pairs for the continuous monitor. Auto-built for the "
                          "live World Cup; hand-editable. Re-run build_watchlist.py to refresh."
                          + (f" Filtered to dates: {sorted(dates)}." if dates else ""),
           "pairs": entries}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    print(f"wrote {len(entries)} watch pairs -> {OUT}")
    for e in entries[:12]:
        print(f"  {e['id']:34} PM[{e['polymarket_slug']}] <> KX[{e['kalshi_ticker']}]")
    if len(entries) > 12:
        print(f"  ... +{len(entries) - 12} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
