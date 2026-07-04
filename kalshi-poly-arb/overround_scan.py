"""Within-Kalshi OVERROUND arb scanner / measurement.

On a mutually-exclusive Kalshi event with N outcomes, buying ALL N no-sides pays exactly
$(N-1) at settlement (every outcome but the winner resolves NO -> $1 each; the winner's NO
resolves $0). Cost = Sigma(no_ask). Gross arb iff Sigma(no_ask) < (N-1). Edge per basket =
(N-1) - Sigma(no_ask) - Sigma(fees).

Kalshi taker fee (general): ceil(0.07 * P * (1-P) * C) cents per contract, C=#contracts.
Here C=1 per leg, P=no_ask (price you pay). Peak ~1.75c at P=0.5.

This script SNAPSHOTS all open mutually-exclusive events, computes the basket cost vs N-1,
reports any overround (and near-overround), with executable depth (min no_ask size across
legs) and the after-fee edge. Single venue, real books, no cross-feed.
"""
from __future__ import annotations
import json, math, time, urllib.parse, urllib.request, sys

BASE = "https://api.elections.kalshi.com/trade-api/v2"

def _get(path, params, retries=4):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "overround-scan/0.1", "Accept": "application/json"})
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                # read fully then parse so a mid-stream chunked drop is retryable, not fatal
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # IncompleteRead / transient HTTP / timeout
            last = e
            time.sleep(0.5 * (i + 1))
    raise last

def _f(v):
    if v in (None, "", 0, 0.0): return None
    try:
        x = float(v); return x if x > 0 else None
    except (TypeError, ValueError): return None

def kalshi_fee(price, contracts=1):
    # general taker fee, dollars
    return math.ceil(0.07 * price * (1 - price) * contracts * 100) / 100.0

def fetch_all_events(status="open", max_events=20000):
    out = []; cursor = None
    while len(out) < max_events:
        params = {"limit": 200, "status": status, "with_nested_markets": "true"}
        if cursor: params["cursor"] = cursor
        d = _get("/events", params)
        evs = d.get("events") or []
        out.extend(evs)
        cursor = d.get("cursor")
        if not cursor or not evs: break
        time.sleep(0.05)
    return out

def analyze(events):
    rows = []
    for ev in events:
        if not ev.get("mutually_exclusive"): continue
        mkts = [m for m in (ev.get("markets") or []) if (m.get("status") == "active")]
        # collect a no_ask + size per outcome
        legs = []
        for m in mkts:
            na = _f(m.get("no_ask_dollars"))
            sz = m.get("no_bid_size_fp") or m.get("yes_ask_size_fp")  # size on the side we'd hit
            # the contracts available to BUY NO = size resting on the no-ask = yes_bid_size
            sz = m.get("yes_bid_size_fp")
            legs.append({"ticker": m.get("ticker"), "no_ask": na,
                         "size": float(sz) if sz else 0.0,
                         "vol": float(m.get("volume_fp") or 0)})
        n = len(legs)
        if n < 2: continue
        # need a no_ask quote on EVERY leg to lock the basket
        quoted = [l for l in legs if l["no_ask"] is not None]
        all_quoted = len(quoted) == n
        sum_no = sum(l["no_ask"] for l in quoted)
        payout = n - 1
        # gross edge if all legs quoted
        gross = payout - sum_no if all_quoted else None
        fees = sum(kalshi_fee(l["no_ask"]) for l in quoted) if all_quoted else None
        net = (gross - fees) if all_quoted else None
        depth = min((l["size"] for l in quoted), default=0.0) if all_quoted else 0.0
        tot_vol = sum(l["vol"] for l in legs)
        rows.append({
            "event": ev.get("event_ticker"), "series": ev.get("series_ticker"),
            "title": (ev.get("title") or "")[:50], "N": n, "all_quoted": all_quoted,
            "sum_no": round(sum_no, 4), "payout": payout,
            "gross": round(gross, 4) if gross is not None else None,
            "net": round(net, 4) if net is not None else None,
            "min_depth": depth, "tot_vol": tot_vol,
        })
    return rows

def main():
    t0 = time.time()
    evs = fetch_all_events()
    me = [e for e in evs if e.get("mutually_exclusive")]
    print(f"fetched {len(evs)} open events in {time.time()-t0:.1f}s; {len(me)} mutually-exclusive", file=sys.stderr)
    rows = analyze(evs)
    fully = [r for r in rows if r["all_quoted"]]
    print(f"mutually-exclusive events with EVERY leg quoted: {len(fully)} (of {len(rows)} ME w/ >=2 active mkts)", file=sys.stderr)
    # distribution of N
    from collections import Counter
    print("N distribution (fully-quoted ME):", dict(Counter(r["N"] for r in fully)), file=sys.stderr)
    # overround hits
    over = [r for r in fully if r["gross"] is not None and r["gross"] > 0]
    over.sort(key=lambda r: -r["gross"])
    print(f"\n=== GROSS OVERROUND (Sigma no_ask < N-1): {len(over)} events ===", file=sys.stderr)
    for r in over[:40]:
        print(f"  {r['event']:42} N={r['N']} sumNO={r['sum_no']:.3f} pay={r['payout']} "
              f"GROSS={r['gross']:+.3f} NET={r['net']:+.3f} depth={r['min_depth']:.0f} vol={r['tot_vol']:.0f} | {r['title']}", file=sys.stderr)
    net_pos = [r for r in over if r["net"] is not None and r["net"] > 0]
    print(f"\n=== AFTER-FEE POSITIVE (net>0): {len(net_pos)} ===", file=sys.stderr)
    for r in sorted(net_pos, key=lambda r: -r["net"])[:40]:
        print(f"  {r['event']:42} N={r['N']} NET={r['net']:+.3f} depth={r['min_depth']:.0f} vol={r['tot_vol']:.0f} | {r['title']}", file=sys.stderr)
    # how close is the tightest book? show min sum_no relative to payout
    fully.sort(key=lambda r: r["sum_no"] - r["payout"])
    print(f"\n=== TIGHTEST 25 (smallest sum_no - (N-1), i.e. closest to overround) ===", file=sys.stderr)
    for r in fully[:25]:
        slack = r["sum_no"] - r["payout"]
        print(f"  {r['event']:42} N={r['N']} sumNO={r['sum_no']:.3f} pay={r['payout']} slack={slack:+.4f} net={r['net']:+.4f} depth={r['min_depth']:.0f} vol={r['tot_vol']:.0f} | {r['title']}", file=sys.stderr)
    # dump json for downstream
    with open("overround_snapshot.json", "w") as f:
        json.dump({"ts": time.time(), "rows": rows}, f)
    print(f"\nwrote overround_snapshot.json ({len(rows)} ME rows)", file=sys.stderr)

if __name__ == "__main__":
    main()
