"""
HONEST maker-overround edge: strip the spread-capture fantasy, model leg-risk + adverse selection.

The naive model (maker_overround.py) rests BUY-NO at no_bid on every leg and books
(N-1) - sum(no_bid) as "edge". That number is dominated by the SUM OF HALF-SPREADS across
legs (e.g. KXNBAWEST1SEED: 15 wide legs => phantom +$1.93). It is NOT executable, because:

  1. Resting a buy-NO at no_bid only fills when someone SELLS NO into you at the bid. On a
     well-quoted book that happens when the leg's fair value moved DOWN -> ADVERSE SELECTION.
     The half-spread you "captured" is exactly the MM's compensation for that adverse fill.
  2. To LOCK the basket you need ALL N legs filled. A passive multi-leg fill is a coupon-
     collector problem: the probability all N fill (before the overround re-prices) shrinks
     fast in N, and a PARTIAL fill leaves you holding a directional sub-basket.

This script models the maker basket as a portfolio with:
  - fair value per leg  p_i = yes_mid (the consensus prob the leg wins). NO fair = 1 - p_i.
  - maker entry per leg at no_bid_i. Edge-vs-fair on a fill = (1 - p_i) - no_bid_i  ... but
    the realistic fill is ADVERSE: conditional on a resting buy-NO filling, the leg's value
    has drifted against you. We charge an adverse-selection haircut = a fraction `adv` of the
    half-spread (adv in {0, .5, 1}: 0 = no adverse selection / free spread capture [the fantasy],
    1 = full half-spread is pure adverse selection [efficient-market]).
  - independent per-leg fill probability q_i (whether a seller hits your bid in the window).
    We DON'T know q_i from a static snapshot; we sweep it (q in {.3,.5,.7,.9,1.0}) and also a
    depth-informed variant (q scales with opposing ask depth / queue).

Outcome accounting (Monte Carlo over leg-fill realizations):
  - If ALL N fill: you hold the full NO-basket -> locked payoff (N-1) - sum(no_bid) - maker_fees,
    BUT each fill was adverse so subtract adv * half_spread_i on every filled leg.
  - If a strict SUBSET fills: you hold a directional partial NO-basket. Its value at settlement
    is sum over filled legs of (1{leg loses} - no_bid_i) i.e. you're long "NO" on a subset =
    SHORT that subset's outcome. Expected partial PnL = sum_filled[(1 - p_i) - no_bid_i]
    (fair-value mark) minus adverse haircut; variance is real (could be a big loss if a filled
    leg wins). We report BOTH the expected partial PnL and the worst-case (a filled leg wins).

The point: does ANY exhaustive two-sided overround basket show positive EXPECTED maker PnL
once the spread-capture is charged as adverse selection and leg-risk is Monte-Carlo'd?
"""
from __future__ import annotations
import json, math, random, sys
from statistics import mean

DUMP = "_kx_events_dump.json"
random.seed(7)

def f(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def maker_fee(p):
    return math.ceil(0.0175 * p * (1 - p) * 100) / 100.0

def load():
    data = json.load(open(DUMP))
    out = []
    for e in data:
        if not e.get("mutually_exclusive"): continue
        mks = [m for m in (e.get("markets") or []) if m.get("status") == "active"]
        if len(mks) < 2: continue
        legs = []
        ok = True
        for m in mks:
            yb, ya = f(m.get("yes_bid_dollars")), f(m.get("yes_ask_dollars"))
            nb, na = f(m.get("no_bid_dollars")), f(m.get("no_ask_dollars"))
            if None in (yb, ya, nb, na) or 0.0 in (yb, ya, nb, na):
                ok = False; break
            legs.append({
                "yb": yb, "ya": ya, "nb": nb, "na": na,
                "ymid": (yb + ya) / 2.0,
                "half_spread": (ya - yb) / 2.0,
                "no_ask_size": f(m.get("yes_bid_size_fp")) or 0.0,  # depth you'd buy NO into as taker
                "no_bid_queue": f(m.get("yes_ask_size_fp")) or 0.0, # makers queued ahead at no_bid
            })
        if not ok: continue
        N = len(legs)
        sum_ymid = sum(l["ymid"] for l in legs)
        exhaustive = 0.90 <= sum_ymid <= 1.15   # genuine partition (allow modest vig either side)
        out.append({"event": e["event_ticker"], "title": (e.get("title") or "")[:55],
                    "N": N, "legs": legs, "sum_ymid": round(sum_ymid, 4),
                    "exhaustive": exhaustive})
    return out

def mc_basket(rec, q, adv, n_sims=4000):
    """Monte-Carlo the maker basket. q=per-leg fill prob, adv=adverse-selection fraction of half-spread.
    Returns dict of metrics over simulations (each sim: draw fills, draw outcome, compute PnL)."""
    legs = rec["legs"]; N = rec["N"]
    # fair prob each leg WINS, renormalised to a true partition (so settlement is consistent)
    s = sum(l["ymid"] for l in legs)
    p_win = [l["ymid"] / s for l in legs]  # sums to 1 -> exactly one winner
    pnls = []
    all_fill_pnls = []
    partial_pnls = []
    n_allfill = 0
    for _ in range(n_sims):
        # 1) draw which legs fill (independent Bernoulli q)
        filled = [random.random() < q for _ in range(N)]
        # 2) draw the winner of the event (one leg wins, by p_win)
        r = random.random(); cum = 0.0; winner = N - 1
        for i, p in enumerate(p_win):
            cum += p
            if r <= cum: winner = i; break
        # 3) PnL: for each FILLED leg we bought NO at no_bid (adverse-haircut applied).
        #    NO pays $1 if that leg LOSES (i != winner), $0 if it wins.
        pnl = 0.0
        nf = 0
        for i in range(N):
            if not filled[i]: continue
            nf += 1
            entry = legs[i]["nb"] + adv * legs[i]["half_spread"]   # adverse: filled higher than bid
            payoff = 0.0 if i == winner else 1.0
            pnl += payoff - entry - maker_fee(legs[i]["nb"])
        pnls.append(pnl)
        if nf == N:
            n_allfill += 1; all_fill_pnls.append(pnl)
        elif nf > 0:
            partial_pnls.append(pnl)
    return {
        "q": q, "adv": adv,
        "E_pnl": mean(pnls),
        "p_allfill": n_allfill / n_sims,
        "E_pnl_allfill": mean(all_fill_pnls) if all_fill_pnls else float("nan"),
        "E_pnl_partial": mean(partial_pnls) if partial_pnls else float("nan"),
        "worst": min(pnls), "best": max(pnls),
        "p_loss": sum(1 for x in pnls if x < 0) / n_sims,
    }

def main():
    recs = load()
    exh = [r for r in recs if r["exhaustive"]]
    print(f"two-sided ME baskets: {len(recs)};  exhaustive (0.90<=sum_ymid<=1.15): {len(exh)}", file=sys.stderr)

    # only the ones with a gross overround at the bid (the candidates the naive model liked)
    cand = []
    for r in exh:
        sum_nb = sum(l["nb"] for l in r["legs"])
        gross_bid = (r["N"] - 1) - sum_nb
        if gross_bid > 0:
            r["gross_bid"] = round(gross_bid, 3)
            r["mean_half_spread"] = round(mean(l["half_spread"] for l in r["legs"]), 4)
            cand.append(r)
    cand.sort(key=lambda r: -r["gross_bid"])
    print(f"exhaustive two-sided baskets with bid-basket gross>0: {len(cand)}\n", file=sys.stderr)

    # The KEY experiment: sweep adverse-selection. adv=0 is the fantasy (free spread); adv=1 is
    # efficient-market (the half-spread is pure adverse selection). Real life is somewhere in between,
    # but for a RESTING order on a competitively-quoted book the literature says adv is close to 1.
    print("Legend: E_pnl over MC (dollars/basket). q=per-leg fill prob, adv=adverse frac of half-spread.\n", file=sys.stderr)
    for r in cand[:12]:
        print(f"--- {r['event']} N={r['N']} sum_ymid={r['sum_ymid']} gross_bid=+{r['gross_bid']} "
              f"mean_half_spread={r['mean_half_spread']} | {r['title']}", file=sys.stderr)
        for adv in (0.0, 0.5, 1.0):
            row = []
            for q in (0.5, 0.9, 1.0):
                m = mc_basket(r, q, adv, n_sims=3000)
                row.append(f"q={q}:E={m['E_pnl']:+.3f}(pAll={m['p_allfill']:.2f},Epart={m['E_pnl_partial']:+.2f})")
            print(f"   adv={adv:>3}: " + "  ".join(row), file=sys.stderr)
        print(file=sys.stderr)

    # Aggregate verdict: at the realistic setting (adv=1.0 full adverse selection, q<1 real fills),
    # how many baskets have E_pnl>0 ?
    print("=== AGGREGATE VERDICT across all exhaustive overround candidates ===", file=sys.stderr)
    for adv in (0.0, 0.5, 1.0):
        for q in (0.7, 0.9, 1.0):
            npos = 0; epnls = []
            for r in cand:
                m = mc_basket(r, q, adv, n_sims=1500)
                epnls.append(m["E_pnl"])
                if m["E_pnl"] > 0: npos += 1
            print(f"  adv={adv} q={q}: baskets with E_pnl>0 = {npos}/{len(cand)}; "
                  f"mean E_pnl={mean(epnls):+.3f}, max={max(epnls):+.3f}", file=sys.stderr)

if __name__ == "__main__":
    main()
