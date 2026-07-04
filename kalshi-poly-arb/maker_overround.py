"""
MAKER-on-the-overround edge estimator (ideation direction #2).

Question: the within-Kalshi gross overround (Sigma(no_ask) < N-1 on an exhaustive
mutually-exclusive basket) is TAKER-DEAD (>=1c/leg fee floor). The one unfalsified
lever: as a MAKER (fee ~0), rest BUY-NO limits on the legs and lock the basket cheaply
IF filled. Estimate that edge, gated by:
  (a) EXHAUSTIVENESS  -- is it a true ME partition or a "field"/longshot-subset illusion?
  (b) LEG-RISK        -- P(all N legs fill) + loss on a partial (directional) basket.
  (c) LIQUIDITY       -- real two-sided depth to rest into, not 0-size phantoms.

Static-snapshot, single-point-in-time estimate from the 130MB full /events dump
(_kx_events_dump.json, 2026-06-29 03:38). NO live order-book replay -> persistence /
queue-position / time-to-fill cannot be measured here; flagged explicitly.

Mechanic of the maker basket:
  Buy NO on every leg -> at settlement every loser's NO pays $1, winner's NO pays $0
  => basket pays exactly (N-1). As a MAKER you rest a BUY-NO limit. The most aggressive
  *maker* (non-crossing) buy-NO sits at the current no_bid (joining the bid) or one tick
  better but still <= no_ask-tick (else it crosses = taker). We model two entry regimes:
     - JOIN  : rest at no_bid (passive, back of/behind queue). cost leg = no_bid.
     - IMPROVE: rest one tick above no_bid (front of book) but only if < no_ask
                (i.e. there's a >=2-tick spread to step into). cost leg = no_bid + tick.
  Gross maker capture = (N-1) - Sigma(entry) - Sigma(maker_fee).
  maker_fee(p) = ceil(0.0175 * p * (1-p) * 100) cents  [Kalshi maker schedule].
"""
from __future__ import annotations
import json, math, sys
from collections import Counter

DUMP = "_kx_events_dump.json"

def f(v):
    try:
        x = float(v)
        return x
    except (TypeError, ValueError):
        return None

def maker_fee(p):
    # dollars; Kalshi maker fee schedule (0.25x taker)
    return math.ceil(0.0175 * p * (1 - p) * 100) / 100.0

def taker_fee(p):
    return math.ceil(0.07 * p * (1 - p) * 100) / 100.0

def tick_for(p):
    # Kalshi tick: 1c on the 0.01-0.99 body; deci-cent in the tails for tapered books.
    # Conservative: assume 1c (the body) unless price is in a sub-1c/over-99c tail.
    if p < 0.10 or p > 0.90:
        return 0.001  # tapered tails use deci-cent on many ME longshot books
    return 0.01

def load_me_events():
    data = json.load(open(DUMP))
    me = []
    for e in data:
        if not e.get("mutually_exclusive"):
            continue
        mks = [m for m in (e.get("markets") or []) if m.get("status") == "active"]
        if len(mks) < 2:
            continue
        me.append((e, mks))
    return data, me

def leg_view(m):
    """Return per-leg quote view in dollars, or None if unquotable."""
    na = f(m.get("no_ask_dollars"))   # price to BUY NO as a taker
    nb = f(m.get("no_bid_dollars"))   # best resting bid to BUY NO (maker joins here)
    ya = f(m.get("yes_ask_dollars"))
    yb = f(m.get("yes_bid_dollars"))
    # size resting on the NO ask = how many NO contracts you can BUY as a taker = yes_bid_size
    no_ask_size = f(m.get("yes_bid_size_fp")) or 0.0
    # size on the NO bid (other makers already queued ahead of you at no_bid) = yes_ask_size
    no_bid_size = f(m.get("yes_ask_size_fp")) or 0.0
    vol = f(m.get("volume_fp")) or 0.0
    oi = f(m.get("open_interest_fp")) or 0.0
    return {
        "ticker": m.get("ticker"),
        "sub": m.get("yes_sub_title") or m.get("no_sub_title") or "",
        "no_ask": na, "no_bid": nb, "yes_ask": ya, "yes_bid": yb,
        "no_ask_size": no_ask_size, "no_bid_size": no_bid_size,
        "vol": vol, "oi": oi,
    }

def classify(e, mks):
    """Build a structured record + exhaustiveness/liquidity diagnostics for one ME event."""
    legs = [leg_view(m) for m in mks]
    N = len(legs)

    # --- quote completeness ---
    no_ask_all = all(l["no_ask"] not in (None, 0.0) for l in legs)
    # two-sided on a leg = it has BOTH a yes_bid and a yes_ask (real market, not 1-sided phantom)
    two_sided = [l for l in legs if l["yes_bid"] not in (None, 0.0) and l["yes_ask"] not in (None, 0.0)]
    all_two_sided = len(two_sided) == N

    # --- EXHAUSTIVENESS test ---
    # A true ME partition prices to ~1.0: Sigma over legs of P(leg wins) ~ 1.
    # Use yes mid as the fair-prob proxy. yes_mid = (yes_bid+yes_ask)/2 where both exist,
    # else last_price proxy via (1 - no_ask) is contaminated by spread; use yes side only.
    yes_mids = []
    for l in legs:
        if l["yes_bid"] is not None and l["yes_ask"] is not None:
            yes_mids.append((l["yes_bid"] + l["yes_ask"]) / 2.0)
        elif l["yes_bid"] is not None:
            yes_mids.append(l["yes_bid"])
        elif l["yes_ask"] is not None:
            yes_mids.append(l["yes_ask"])
    sum_yes_mid = sum(yes_mids)
    # field/longshot-subset illusion: the listed legs only cover a fraction of prob mass.
    # If Sigma(yes_mid) << 1, the basket is NOT exhaustive (there's an unlisted "other" outcome).
    exhaustive = sum_yes_mid >= 0.90  # within ~10% of full partition

    # --- the NO-basket arithmetic (taker, for reference) ---
    if no_ask_all:
        sum_no_ask = sum(l["no_ask"] for l in legs)
        gross_taker = (N - 1) - sum_no_ask
        fee_taker = sum(taker_fee(l["no_ask"]) for l in legs)
        net_taker = gross_taker - fee_taker
        depth_taker = min(l["no_ask_size"] for l in legs)
    else:
        sum_no_ask = gross_taker = fee_taker = net_taker = None
        depth_taker = 0.0

    # --- the MAKER basket (rest BUY-NO on each leg) ---
    # need a no_bid on every leg to JOIN; need a >=2-tick spread to IMPROVE.
    no_bid_all = all(l["no_bid"] not in (None, 0.0) for l in legs)
    maker = {}
    if no_bid_all and no_ask_all:
        # JOIN regime: cost = no_bid per leg
        sum_join = sum(l["no_bid"] for l in legs)
        fee_join = sum(maker_fee(l["no_bid"]) for l in legs)
        gross_join = (N - 1) - sum_join
        net_join = gross_join - fee_join
        # IMPROVE regime: one tick above no_bid where spread allows; else join
        sum_imp = 0.0
        fee_imp = 0.0
        for l in legs:
            t = tick_for(l["no_bid"])
            entry = l["no_bid"] + t if (l["no_bid"] + t) < l["no_ask"] else l["no_bid"]
            sum_imp += entry
            fee_imp += maker_fee(entry)
        gross_imp = (N - 1) - sum_imp
        net_imp = gross_imp - fee_imp
        # liquidity to rest into: on the NO-bid we JOIN a queue (others ahead = no_bid_size);
        # the size we can realistically GET filled depends on incoming sells = harder to model.
        # Report the min across legs of (a) queue ahead and (b) the opposing ask depth.
        min_queue_ahead = min(l["no_bid_size"] for l in legs)
        min_opp_depth = min(l["no_ask_size"] for l in legs)
        maker = {
            "sum_join": sum_join, "gross_join": gross_join, "net_join": net_join,
            "sum_imp": sum_imp, "gross_imp": gross_imp, "net_imp": net_imp,
            "min_queue_ahead": min_queue_ahead, "min_opp_depth": min_opp_depth,
        }

    # spread per leg (mean) -- proxy for how "fillable" a passive order is
    spreads = []
    for l in two_sided:
        spreads.append(l["yes_ask"] - l["yes_bid"])
    mean_spread = sum(spreads) / len(spreads) if spreads else None

    return {
        "event": e.get("event_ticker"), "title": (e.get("title") or "")[:60], "N": N,
        "no_ask_all": no_ask_all, "all_two_sided": all_two_sided,
        "n_two_sided": len(two_sided),
        "sum_yes_mid": round(sum_yes_mid, 4), "exhaustive": exhaustive,
        "sum_no_ask": round(sum_no_ask, 4) if sum_no_ask is not None else None,
        "gross_taker": round(gross_taker, 4) if gross_taker is not None else None,
        "net_taker": round(net_taker, 4) if net_taker is not None else None,
        "depth_taker": depth_taker,
        "maker": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in maker.items()},
        "mean_spread": round(mean_spread, 4) if mean_spread is not None else None,
        "tot_vol": round(sum(l["vol"] for l in legs), 1),
    }

def main():
    data, me = load_me_events()
    print(f"events in dump: {len(data)};  active-ME with >=2 legs: {len(me)}", file=sys.stderr)
    recs = [classify(e, mks) for e, mks in me]

    # ---- 1. EXHAUSTIVENESS BREAKDOWN ----
    exhaustive = [r for r in recs if r["exhaustive"]]
    non_exh = [r for r in recs if not r["exhaustive"]]
    print(f"\n=== (a) EXHAUSTIVENESS ===", file=sys.stderr)
    print(f"  Sigma(yes_mid)>=0.90 (genuine partition): {len(exhaustive)}", file=sys.stderr)
    print(f"  Sigma(yes_mid)<0.90  (field/longshot illusion): {len(non_exh)}", file=sys.stderr)
    # distribution of sum_yes_mid
    buckets = Counter()
    for r in recs:
        s = r["sum_yes_mid"]
        b = "<0.5" if s<0.5 else "0.5-0.9" if s<0.9 else "0.9-1.05" if s<1.05 else "1.05-1.2" if s<1.2 else ">1.2"
        buckets[b]+=1
    print(f"  sum_yes_mid buckets: {dict(buckets)}", file=sys.stderr)

    # ---- 2. GROSS OVERROUND, gated by exhaustiveness + two-sided ----
    # a real maker-overround candidate must be: exhaustive AND fully two-sided AND have a gross overround
    over_taker = [r for r in exhaustive if r["gross_taker"] is not None and r["gross_taker"] > 0]
    print(f"\n=== (gross overround on EXHAUSTIVE baskets) ===", file=sys.stderr)
    print(f"  exhaustive baskets with gross_taker>0 (Sigma no_ask < N-1): {len(over_taker)}", file=sys.stderr)
    real = [r for r in over_taker if r["all_two_sided"]]
    print(f"  ...AND fully two-sided (every leg has bid+ask): {len(real)}", file=sys.stderr)

    # ---- 3. MAKER EDGE on the real, exhaustive, two-sided overround baskets ----
    print(f"\n=== (b)+(c) MAKER EDGE on genuine exhaustive two-sided overround baskets ===", file=sys.stderr)
    cand = [r for r in real if r["maker"]]
    cand.sort(key=lambda r: -(r["maker"].get("net_join") or -9))
    hdr = f"{'event':38} N {'sYmid':>6} {'grossTk':>7} {'netTk':>6} {'mJoin':>6} {'mImp':>6} {'qAhead':>7} {'oppDep':>7} {'spread':>6}"
    print(hdr, file=sys.stderr)
    for r in cand[:40]:
        mk = r["maker"]
        print(f"{r['event']:38.38} {r['N']:>2} {r['sum_yes_mid']:>6.3f} "
              f"{r['gross_taker']:>+7.3f} {r['net_taker']:>+6.3f} "
              f"{mk.get('net_join',0):>+6.3f} {mk.get('net_imp',0):>+6.3f} "
              f"{mk.get('min_queue_ahead',0):>7.0f} {mk.get('min_opp_depth',0):>7.0f} "
              f"{(r['mean_spread'] or 0):>6.3f}  {r['title']}", file=sys.stderr)

    pos_join = [r for r in cand if (r["maker"].get("net_join") or -9) > 0]
    pos_imp  = [r for r in cand if (r["maker"].get("net_imp") or -9) > 0]
    print(f"\n  exhaustive two-sided baskets with MAKER net_join > 0 : {len(pos_join)}", file=sys.stderr)
    print(f"  exhaustive two-sided baskets with MAKER net_imp  > 0 : {len(pos_imp)}", file=sys.stderr)

    # ---- 4. For the positive maker candidates, dump full leg-risk diagnostics ----
    print(f"\n=== POSITIVE MAKER CANDIDATES (full diagnostics) ===", file=sys.stderr)
    for r in sorted(set(id(x) for x in pos_join+pos_imp) and (pos_join or pos_imp), key=lambda r:-(r['maker'].get('net_join') or -9)):
        mk=r["maker"]
        print(json.dumps({k:r[k] for k in ('event','title','N','sum_yes_mid','gross_taker','net_taker','depth_taker','maker','mean_spread','tot_vol')}), file=sys.stderr)

    # save for the report
    out = {
        "ts": data and None, "n_me": len(me),
        "n_exhaustive": len(exhaustive),
        "n_over_taker_exh": len(over_taker),
        "n_over_real": len(real),
        "n_maker_join_pos": len(pos_join),
        "n_maker_imp_pos": len(pos_imp),
        "candidates": [r for r in cand],
        "positive_join": pos_join, "positive_imp": pos_imp,
    }
    json.dump(out, open("maker_overround_result.json", "w"), indent=0)
    print(f"\nwrote maker_overround_result.json", file=sys.stderr)

if __name__ == "__main__":
    main()
