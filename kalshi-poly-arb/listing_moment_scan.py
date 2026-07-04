"""Listing-moment overround probe.

The prior 10 cycles measured overround on TIGHTENED, liquid ~102% books where the
fee-wall is an arithmetic identity. This probe samples the UNTESTED cell: freshly-listed,
illiquid, small-N, high-overround (>120%) books AT/NEAR listing, before market-makers
tighten them.

For a true mutually-exclusive event (exactly one YES resolves $1):
  - YES-basket overround%  = Sigma(yes_ask) * 100         (should be ~100 when tight; >120 = fat)
  - NO-basket cost         = Sigma(no_ask); pays (N-1); gross NO-lock iff Sigma(no_ask) < N-1

We compute BOTH sides, tag each event with liquidity/recency proxies (open_interest,
volume, time-since-open), and surface the highest-overround / thinnest / newest books.
Then we compute the after-ALL-cost 2-sided lock on the fresh cell specifically.

Discipline:
  - report the exhaustiveness/partition status (is it a TRUE partition? sum of yes_bid should
    also be < 1 if there's real overround, and every leg must be active+quoted).
  - use real ceiled Kalshi taker fees both legs.
  - NEUTRAL: describe what's found + what would confirm/deny. No dead/works verdict.
"""
from __future__ import annotations
import json, math, time, urllib.parse, urllib.request, sys
from collections import Counter

BASE = "https://api.elections.kalshi.com/trade-api/v2"

def _get(path, params, retries=4):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "listing-scan/0.1", "Accept": "application/json"})
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e; time.sleep(0.5 * (i + 1))
    raise last

def _f(v):
    if v in (None, "", 0, 0.0): return None
    try:
        x = float(v); return x if x > 0 else None
    except (TypeError, ValueError): return None

def kalshi_fee(price, contracts=1):
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

def analyze(events, now):
    rows = []
    for ev in events:
        if not ev.get("mutually_exclusive"): continue
        mkts = [m for m in (ev.get("markets") or []) if (m.get("status") == "active")]
        n = len(mkts)
        if n < 2: continue
        legs = []
        for m in mkts:
            ya = _f(m.get("yes_ask_dollars"))
            na = _f(m.get("no_ask_dollars"))
            yb = _f(m.get("yes_bid_dollars"))
            # depth we could hit:
            #   BUY YES -> we hit the yes-ask, resting size = no_bid_size_fp
            #   BUY NO  -> we hit the no-ask,  resting size = yes_bid_size_fp
            yes_ask_depth = float(m.get("no_bid_size_fp") or 0)
            no_ask_depth  = float(m.get("yes_bid_size_fp") or 0)
            oi = float(m.get("open_interest") or 0)
            vol = float(m.get("volume_fp") or m.get("volume") or 0)
            # time since market opened (listing recency proxy)
            ot = m.get("open_time")
            age_h = None
            if ot:
                try:
                    import datetime as _dt
                    t = _dt.datetime.fromisoformat(ot.replace("Z", "+00:00")).timestamp()
                    age_h = (now - t) / 3600.0
                except Exception:
                    age_h = None
            legs.append({"ticker": m.get("ticker"), "yes_ask": ya, "no_ask": na, "yes_bid": yb,
                         "yes_ask_depth": yes_ask_depth, "no_ask_depth": no_ask_depth,
                         "oi": oi, "vol": vol, "age_h": age_h})
        yes_quoted = all(l["yes_ask"] is not None for l in legs)
        no_quoted  = all(l["no_ask"] is not None for l in legs)
        sum_yes_ask = sum(l["yes_ask"] for l in legs) if yes_quoted else None
        sum_no_ask  = sum(l["no_ask"] for l in legs) if no_quoted else None
        # YES-side overround pct (100 = fair). >100 = vig against a YES-basket buyer.
        # A YES-basket buyer LOCKS a profit iff sum_yes_ask < 1 (pays exactly $1 total).
        yes_overround_pct = round(sum_yes_ask * 100, 1) if sum_yes_ask is not None else None
        yes_gross = (1.0 - sum_yes_ask) if yes_quoted else None
        yes_fees  = sum(kalshi_fee(l["yes_ask"]) for l in legs) if yes_quoted else None
        yes_net   = (yes_gross - yes_fees) if yes_quoted else None
        # NO-side: buy all N no -> pays (N-1). lock iff sum_no_ask < N-1
        no_gross = (n - 1 - sum_no_ask) if no_quoted else None
        no_fees  = sum(kalshi_fee(l["no_ask"]) for l in legs) if no_quoted else None
        no_net   = (no_gross - no_fees) if no_quoted else None
        # depths
        yes_depth = min((l["yes_ask_depth"] for l in legs), default=0.0)
        no_depth  = min((l["no_ask_depth"]  for l in legs), default=0.0)
        tot_vol = sum(l["vol"] for l in legs)
        tot_oi  = sum(l["oi"]  for l in legs)
        ages = [l["age_h"] for l in legs if l["age_h"] is not None]
        min_age = min(ages) if ages else None
        # partition sanity: sum of yes_bid should be < 1 too if real (bid<ask). record it.
        yb_quoted = all(l["yes_bid"] is not None for l in legs)
        sum_yes_bid = sum(l["yes_bid"] for l in legs) if yb_quoted else None
        rows.append({
            "event": ev.get("event_ticker"), "series": ev.get("series_ticker"),
            "title": (ev.get("title") or "")[:46], "N": n,
            "yes_quoted": yes_quoted, "no_quoted": no_quoted,
            "sum_yes_ask": round(sum_yes_ask, 4) if sum_yes_ask is not None else None,
            "sum_no_ask": round(sum_no_ask, 4) if sum_no_ask is not None else None,
            "sum_yes_bid": round(sum_yes_bid, 4) if sum_yes_bid is not None else None,
            "yes_overround_pct": yes_overround_pct,
            "yes_gross": round(yes_gross, 4) if yes_gross is not None else None,
            "yes_net": round(yes_net, 4) if yes_net is not None else None,
            "no_gross": round(no_gross, 4) if no_gross is not None else None,
            "no_net": round(no_net, 4) if no_net is not None else None,
            "yes_depth": yes_depth, "no_depth": no_depth,
            "tot_vol": tot_vol, "tot_oi": tot_oi, "min_age_h": min_age,
        })
    return rows

def main():
    now = time.time()
    t0 = now
    evs = fetch_all_events()
    rows = analyze(evs, now)
    print(f"fetched {len(evs)} open events in {time.time()-t0:.1f}s; {len(rows)} ME w/ >=2 active mkts", file=sys.stderr)

    yq = [r for r in rows if r["yes_quoted"]]
    print(f"ME fully YES-quoted: {len(yq)}", file=sys.stderr)

    # ---- FRESH / THIN cell: age, oi, volume ----
    aged = [r for r in yq if r["min_age_h"] is not None]
    print(f"with open_time age: {len(aged)}", file=sys.stderr)
    fresh = [r for r in aged if r["min_age_h"] is not None and r["min_age_h"] <= 24]
    print(f"listed <=24h ago (FRESH cell): {len(fresh)}", file=sys.stderr)
    fresh6 = [r for r in aged if r["min_age_h"] <= 6]
    print(f"listed <=6h ago: {len(fresh6)}", file=sys.stderr)

    # overround distribution across the whole ME YES-quoted set
    ors = [r["yes_overround_pct"] for r in yq if r["yes_overround_pct"] is not None]
    if ors:
        ors_sorted = sorted(ors)
        def pct(p): return ors_sorted[min(len(ors_sorted)-1, int(p/100*len(ors_sorted)))]
        print(f"\nYES-overround%% distribution (all ME YES-quoted): "
              f"min={min(ors):.0f} p25={pct(25):.0f} med={pct(50):.0f} p75={pct(75):.0f} "
              f"p90={pct(90):.0f} p99={pct(99):.0f} max={max(ors):.0f}", file=sys.stderr)
    fat = [r for r in yq if r["yes_overround_pct"] is not None and r["yes_overround_pct"] >= 120]
    print(f"HIGH-OVERROUND books (YES-overround >=120%%): {len(fat)}", file=sys.stderr)

    # ---- the KEY table: high-overround AND fresh/thin ----
    def liq_tag(r):
        return f"oi={r['tot_oi']:.0f} vol={r['tot_vol']:.0f} age_h={r['min_age_h'] if r['min_age_h'] is not None else -1:.1f}"

    print("\n=== HIGH-OVERROUND (>=120%) books, sorted by overround desc ===", file=sys.stderr)
    for r in sorted(fat, key=lambda r: -r["yes_overround_pct"])[:40]:
        print(f"  {r['event']:40} N={r['N']:2} OVR={r['yes_overround_pct']:6.1f}%% "
              f"sumYESask={r['sum_yes_ask']:.3f} YESnet={r['yes_net']:+.3f} NOnet={r['no_net'] if r['no_net'] is not None else float('nan'):+.3f} "
              f"yD={r['yes_depth']:.0f} nD={r['no_depth']:.0f} {liq_tag(r)} | {r['title']}", file=sys.stderr)

    # ---- FRESH cell after-cost locks (both sides) ----
    print("\n=== FRESH cell (<=24h since open): best 2-sided after-cost locks ===", file=sys.stderr)
    # YES-lock candidates in the fresh cell
    fy = [r for r in fresh if r["yes_net"] is not None]
    fy_pos = [r for r in fy if r["yes_net"] > 0]
    print(f"  fresh YES-basket net>0 (sum_yes_ask<1 after fees): {len(fy_pos)}", file=sys.stderr)
    for r in sorted(fy, key=lambda r: -r["yes_net"])[:20]:
        print(f"  YES {r['event']:40} N={r['N']:2} OVR={r['yes_overround_pct']:6.1f}%% "
              f"gross={r['yes_gross']:+.3f} net={r['yes_net']:+.3f} minYESdepth={r['yes_depth']:.0f} {liq_tag(r)}", file=sys.stderr)
    fn = [r for r in fresh if r["no_net"] is not None]
    fn_pos = [r for r in fn if r["no_net"] > 0]
    print(f"  fresh NO-basket net>0: {len(fn_pos)}", file=sys.stderr)
    for r in sorted(fn, key=lambda r: -r["no_net"])[:20]:
        print(f"  NO  {r['event']:40} N={r['N']:2} gross={r['no_gross']:+.3f} net={r['no_net']:+.3f} minNOdepth={r['no_depth']:.0f} {liq_tag(r)}", file=sys.stderr)

    # ---- whole-market best after-cost lock either side (for reference) ----
    all_yes = [r for r in yq if r["yes_net"] is not None]
    all_no  = [r for r in rows if r["no_net"] is not None]
    best_yes = max(all_yes, key=lambda r: r["yes_net"]) if all_yes else None
    best_no  = max(all_no,  key=lambda r: r["no_net"])  if all_no  else None
    print("\n=== WHOLE-MARKET best after-cost lock (reference) ===", file=sys.stderr)
    if best_yes: print(f"  best YES-net: {best_yes['event']} N={best_yes['N']} net={best_yes['yes_net']:+.3f} OVR={best_yes['yes_overround_pct']}%% yesD={best_yes['yes_depth']:.0f} vol={best_yes['tot_vol']:.0f}", file=sys.stderr)
    if best_no:  print(f"  best NO-net:  {best_no['event']} N={best_no['N']} net={best_no['no_net']:+.3f} noD={best_no['no_depth']:.0f} vol={best_no['tot_vol']:.0f}", file=sys.stderr)

    with open("listing_moment_snapshot.json", "w") as f:
        json.dump({"ts": now, "n_rows": len(rows), "n_fresh24h": len(fresh),
                   "n_fat120": len(fat), "rows": rows}, f)
    print(f"\nwrote listing_moment_snapshot.json ({len(rows)} rows)", file=sys.stderr)

if __name__ == "__main__":
    main()
