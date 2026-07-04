"""Confirm/deny the listing-moment 2-sided lock on TRUE partitions with REAL books.

Takes the fresh (<=24h) ME candidates from listing_moment_snapshot.json, restricts to
N=2 game/match markets (structural partitions: exactly one side wins, modulo void), reads
the AUTHENTICATED live orderbook for both legs, and computes the after-fee 2-sided lock
using REAL resting ask prices + sizes (not the phantom snapshot fields).

For each: YES-basket cost = ya1+ya2 (buy both YES; pays $1); lock iff <1 after fees.
Also reports min fillable size = min over legs of the real ask size on the side bought.
"""
from __future__ import annotations
import os, sys, json, time, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import authbook_probe as ab

def kalshi_fee(price):
    return math.ceil(0.07 * price * (1 - price) * 100) / 100.0

def leg_book(ticker):
    d = ab.auth_get(f"/markets/{ticker}/orderbook", {"depth": 5})
    ob = d.get("orderbook_fp") or {}
    yes = ob.get("yes_dollars") or []
    no  = ob.get("no_dollars")  or []
    def best(levels):
        if not levels: return None
        p, s = max(levels, key=lambda x: float(x[0]))
        return (float(p), float(s))
    bno, byes = best(no), best(yes)
    ya = (round(1 - bno[0], 2), bno[1]) if bno else (None, 0.0)   # buy-YES ask + size
    na = (round(1 - byes[0], 2), byes[1]) if byes else (None, 0.0) # buy-NO  ask + size
    return ya, na

def main():
    snap = json.load(open("listing_moment_snapshot.json"))
    rows = {r["event"]: r for r in snap["rows"]}
    # fresh N=2 partition candidates: games/matches, <=24h, gross-positive-ish snapshot
    prefixes = ("KXMLBGAME", "KXATPMATCH", "KXWTAMATCH", "KXITFMATCH", "KXITFWMATCH",
                "KXNHLGAME", "KXNBAGAME", "KXWCADVANCE", "KXNCAA", "KXLOLGAME", "KXWCTEAMH2H")
    fresh2 = [r for r in snap["rows"]
              if r["N"] == 2 and r["min_age_h"] is not None and r["min_age_h"] <= 24
              and r["event"].startswith(prefixes)]
    # sort by best snapshot YES-gross so we test the most promising first
    fresh2.sort(key=lambda r: -(r["yes_gross"] if r["yes_gross"] is not None else -9))
    print(f"fresh (<=24h) N=2 partition candidates: {len(fresh2)}; testing top 30 with REAL books\n")
    best_real = None
    for r in fresh2[:30]:
        ev = r["event"]
        # need the two market tickers
        legs = []
        try:
            d = ab.auth_get(f"/events/{ev}", {"with_nested_markets": "true"})
        except Exception as e:
            print(f"  {ev}: event fetch ERR {e}"); continue
        mkts = [m for m in (d.get("event", {}).get("markets") or []) if m.get("status") == "active"]
        if len(mkts) != 2:
            continue
        ya_sum = 0.0; ymin = 1e9; ok = True; detail = []
        for m in mkts:
            t = m.get("ticker")
            ya, na = leg_book(t)
            time.sleep(0.1)
            if ya[0] is None or ya[1] <= 0:
                ok = False
            ya_sum += (ya[0] or 0)
            ymin = min(ymin, ya[1])
            detail.append(f"{t.split('-')[-1]}:ya={ya[0]}x{ya[1]:.0f}")
        fees = sum(kalshi_fee(mm) for mm in [ya[0] or 0 for m in mkts])  # rough; recompute below
        # recompute fees per real leg price
        fee_sum = 0.0
        # (reread to be exact)
        yprices = []
        for m in mkts:
            ya, _ = leg_book(m.get("ticker")); time.sleep(0.05)
            yprices.append(ya[0] or 0)
        fee_sum = sum(kalshi_fee(p) for p in yprices if p)
        gross = 1.0 - ya_sum
        net = gross - fee_sum
        flag = "FILLABLE" if ok else "PHANTOM-LEG(size0)"
        print(f"  {ev:34} sumYESask={ya_sum:.3f} gross={gross:+.3f} net={net:+.3f} "
              f"minYESsize={ymin:.0f} [{flag}] age_h={r['min_age_h']:.1f} | {detail}")
        if ok and (best_real is None or net > best_real[1]):
            best_real = (ev, net, ymin, ya_sum)
    print()
    if best_real:
        print(f"BEST REAL-BOOK FILLABLE 2-sided YES lock (fresh cell): {best_real[0]} "
              f"net={best_real[1]:+.3f}/basket minsize={best_real[2]:.0f} sumYES={best_real[3]:.3f}")
    else:
        print("No fresh N=2 partition had BOTH YES-ask legs fillable (size>0) with a real book.")

if __name__ == "__main__":
    main()
