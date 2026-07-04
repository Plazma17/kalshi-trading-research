"""Continuous cross-venue monitor — watch a curated list of pairs for FLEETING arb gaps.

The thesis (the user's): a durable standing arb doesn't exist (it's competed away or is a
stale/boundary artifact). The real opportunity is a TRANSIENT gap that opens when one venue's
price jumps during a fast move and the other lags. So we hand-pick VOLATILE, REPEATING markets
(World Cup matches today) and poll them on a fast loop, alerting the instant a real,
fee-surviving, tight-book gap appears.

Reads `watchlist.json` (see build_watchlist.py). For each pair it pulls the executable
top-of-book on BOTH venues, runs the fee-aware arb math, applies the staleness filter, and:
  - prints a compact per-cycle status line per pair, and
  - on a real candidate (net profit >= --min-profit AND both books tight), prints a loud
    ALERT and appends it to alerts.jsonl (with a UTC timestamp) for later review.

It NEVER trades. A flagged gap still needs (1) depth via /book and (2) the per-pair
resolution caveat (verify_resolution) confirmed before acting.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time

import arbmath
import authbook_probe
import kalshi_source
import poly_source
from model import Market, parse_iso

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHLIST = os.path.join(HERE, "watchlist.json")
ALERTS = os.path.join(HERE, "alerts.jsonl")
GAPS_CSV = os.path.join(HERE, "inplay_gaps.csv")  # --log-all: every in-play cycle row
_GAPS_HEADER = ("ts,match,leg,kx_yes_bid,kx_yes_ask,pm_yes_bid,pm_yes_ask,"
                "raw_gap,net_gap,state,kx_depth,pm_depth,verified\n")
_TIGHT = 1.06  # yes_ask+no_ask above this => stale/illiquid book, ignore

# Phantom-depth gate (2026-07-02): the public snapshot's top-of-book persists even when the
# real book is EMPTY, so a net>0 gap must be confirmed against the AUTHENTICATED /orderbook
# (>= MIN_REAL_DEPTH real contracts on the binding Kalshi leg) before it is alerted.
MIN_REAL_DEPTH = 10
_DEPTH_TTL = 60.0
_depth_cache: dict = {}   # ticker -> (fetched_ts, real_depth result)

# TWO-SIDED depth gate (2026-07-03): _kx_depth_check authenticates only the Kalshi leg — the
# Polymarket leg was public top-of-book, UNVERIFIED, so every "verified" alert was still
# phantom-until-both-legs (the overround lesson). _pm_depth_check reads the PUBLIC PM CLOB
# book (poly_source.fetch_book) and measures the size actually resting AT/BETTER-THAN the
# quoted arb price on the PM leg. A gap is only truly `verified` when BOTH legs clear
# >= their min real depth. PM books are re-fetched only on CANDIDATE gaps (never every poll)
# and cached per-slug for a short TTL to respect the 60/min PM rate limit.
PM_MIN_DEPTH = 1.0        # >= 1 contract-equivalent resting at/better than the quoted PM price
_PM_DEPTH_TTL = 3.0
_pm_book_cache: dict = {}   # slug -> (fetched_ts, book)
# log-all rows only trigger a PM book fetch when the pre-fee gap is at least this close to
# money (candidate band). Deeply-negative rows (the fee wall — most in-play legs) skip the
# fetch, so PM books are pulled only for gaps worth verifying.
_CHEAP_GAP = 0.0


def _kx_depth_check(pair: dict, arb: dict) -> dict:
    """Authenticated real-depth check for the arb's binding Kalshi leg.
    Returns {verified: True|False|None, reason, real_ask, real_size, binding_leg}.
    verified=None means the auth read is unavailable (depth UNKNOWN, not zero)."""
    ticker = pair["kalshi_ticker"]
    side = "buy_yes" if arb["buy_yes_on"] == "kalshi" else "buy_no"
    # invert=True pairs swapped YES/NO meaning inside _kx_leg, so translate the arb-space
    # side back to the VENUE's book side before reading real depth.
    if pair.get("invert"):
        side = "buy_no" if side == "buy_yes" else "buy_yes"
    now = time.time()
    cached = _depth_cache.get(ticker)
    d = cached[1] if cached and (now - cached[0]) < _DEPTH_TTL else None
    if d is None:
        d = authbook_probe.real_depth(ticker)
        _depth_cache[ticker] = (now, d)
    if not d["ok"]:
        return {"verified": None, "binding_leg": side,
                "reason": f"auth book unavailable ({d['error']})"}
    lvl = d.get(side)
    if lvl is None:
        return {"verified": False, "binding_leg": side, "real_size": 0,
                "reason": "EMPTY real book on binding leg (phantom top-of-book)"}
    px, size = lvl
    if size < MIN_REAL_DEPTH:
        return {"verified": False, "binding_leg": side, "real_ask": px, "real_size": size,
                "reason": f"real depth {size:.0f} < {MIN_REAL_DEPTH}"}
    return {"verified": True, "binding_leg": side, "real_ask": px, "real_size": size,
            "reason": None}


def _pm_depth_check(pair: dict, arb: dict) -> dict:
    """PUBLIC PM CLOB-book real-depth check for the arb's Polymarket leg.
    Returns {verified: True|False|None, reason, pm_side, price, pm_depth}.
    verified=None means the PM book read is unavailable (depth UNKNOWN, not zero).

    Book prices (poly_source.fetch_book) are YES prices; qty is in contract-equivalents.
      * buy YES on PM  -> cross the OFFERS (YES asks): fillable size = sum(qty) at px <= yes_ask
      * buy NO  on PM  -> buying NO == selling YES, so cross the BIDS (YES bids): fillable size
                          = sum(qty) at px >= (1 - no_ask)  [= the YES bid we sell into]"""
    slug = pair["polymarket_slug"]
    if arb.get("buy_yes_on") == "polymarket":
        side, price = "buy_yes", arb["yes_ask"]
    elif arb.get("buy_no_on") == "polymarket":
        side, price = "buy_no", arb["no_ask"]
    else:
        return {"verified": None, "pm_side": None, "reason": "no polymarket leg in arb"}
    now = time.time()
    cached = _pm_book_cache.get(slug)
    book = cached[1] if cached and (now - cached[0]) < _PM_DEPTH_TTL else None
    if book is None:
        try:
            book = poly_source.fetch_book(slug)
        except Exception as e:  # noqa: BLE001 — degrade to UNKNOWN, never crash the loop
            return {"verified": None, "pm_side": side, "price": price,
                    "reason": f"pm book unavailable ({type(e).__name__}: {str(e)[:60]})"}
        _pm_book_cache[slug] = (now, book)
    if side == "buy_yes":
        depth = sum(q for px, q in book.get("offers", [])
                    if px is not None and px <= price + 1e-9)
    else:
        need = 1.0 - price
        depth = sum(q for px, q in book.get("bids", [])
                    if px is not None and px >= need - 1e-9)
    if depth < PM_MIN_DEPTH:
        return {"verified": False, "pm_side": side, "price": price, "pm_depth": depth,
                "reason": f"PM real depth {depth:.2f} < {PM_MIN_DEPTH:.0f} at {price:.3f}"}
    return {"verified": True, "pm_side": side, "price": price, "pm_depth": depth,
            "reason": None}


def _combine_verified(kxdc: dict, pmdc: dict):
    """Two-sided verdict: True only if BOTH legs are confirmed fillable, False if EITHER leg
    is confirmed empty/thin (phantom), else None (at least one leg UNKNOWN, none empty)."""
    kx, pm = kxdc.get("verified"), pmdc.get("verified")
    if kx is False or pm is False:
        return False
    if kx is True and pm is True:
        return True
    return None


def _load_pairs() -> list[dict]:
    with open(WATCHLIST, encoding="utf-8") as f:
        return json.load(f).get("pairs", [])


def _pm_leg(slug: str) -> Market:
    ya, yb = poly_source.fetch_bbo(slug)
    return Market(venue="polymarket", market_id=slug, question=slug,
                  yes_ask=ya, no_ask=(1.0 - yb) if yb is not None else None,
                  yes_bid=yb, no_bid=(1.0 - ya) if ya is not None else None,
                  fee_coeff=0.05)


def _kx_leg(ticker: str, invert: bool) -> Market | None:
    m = kalshi_source.fetch_market(ticker)
    if m and invert:  # PM YES corresponds to Kalshi NO — swap so both legs share YES meaning
        m.yes_ask, m.no_ask = m.no_ask, m.yes_ask
        m.yes_bid, m.no_bid = m.no_bid, m.yes_bid
    return m


def _spread(m: Market):
    return None if (m.yes_ask is None or m.no_ask is None) else m.yes_ask + m.no_ask


def _phase(pair: dict, now: dt.datetime, pre_min: float, match_min: float) -> str:
    """'live' (within [kickoff-pre, kickoff+match_min]), 'upcoming', or 'done'/'unknown'."""
    gs = parse_iso(pair.get("game_start"))
    if gs is None:
        return "unknown"
    start = gs - dt.timedelta(minutes=pre_min)
    end = gs + dt.timedelta(minutes=match_min)
    if now < start:
        return "upcoming"
    return "live" if now <= end else "done"


def _check(pair: dict) -> dict:
    """Poll one pair; return a status dict (or an error)."""
    try:
        pm = _pm_leg(pair["polymarket_slug"])
        kx = _kx_leg(pair["kalshi_ticker"], pair.get("invert", False))
        if kx is None:
            return {"id": pair["id"], "error": "kalshi market not found"}
        arb = arbmath.best_arb(pm, kx)
        sp_pm, sp_kx = _spread(pm), _spread(kx)
        stale = (sp_pm is not None and sp_pm > _TIGHT) or (sp_kx is not None and sp_kx > _TIGHT)
        return {"id": pair["id"], "label": pair.get("label", pair["id"]), "arb": arb,
                "stale": stale, "pm": pm, "kx": kx, "sp_pm": sp_pm, "sp_kx": sp_kx,
                "verify_resolution": pair.get("verify_resolution", False)}
    except Exception as e:  # noqa: BLE001 — one bad pair must not kill the loop
        return {"id": pair["id"], "error": f"{type(e).__name__}: {e}"}


def _alert(st: dict) -> None:
    arb = st["arb"]
    dc = st.get("depth_check") or {}          # KALSHI leg only (kept for continuity)
    pmdc = st.get("pm_depth_check") or {}      # POLYMARKET leg (two-sided verification)
    verified = st.get("verified2")             # two-valued: kx_ok AND pm_ok
    rec = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "id": st["id"],
           "label": st["label"], "net_profit": arb["net_profit"],
           "net_profit_pct": arb["net_profit_pct"], "legs": arb,
           "verify_resolution": st["verify_resolution"],
           "depth_check": dc, "pm_depth_check": pmdc,
           # two-sided verdict + per-leg detail; `phantom` now reflects EITHER leg empty.
           "verified": verified,
           "kx_verified": dc.get("verified"), "pm_verified": pmdc.get("verified"),
           "kx_depth": dc.get("real_size"), "pm_depth": pmdc.get("pm_depth"),
           "phantom": verified is False}
    with open(ALERTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


def _csv_field(v) -> str:
    """CSV-safe stringify: numbers rounded, None -> '', text quoted if needed."""
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.4f}"
    s = str(v)
    if any(c in s for c in ',"\n'):
        return '"' + s.replace('"', '""') + '"'
    return s


def _split_label(st: dict):
    """Return (match, leg) from a pair label like 'WC ... POR v CRO — POR win'."""
    lbl = st.get("label", st["id"])
    for sep in ("—", " - ", " – "):  # em/en dash or hyphen
        if sep in lbl:
            m, l = lbl.split(sep, 1)
            return m.strip(), l.strip()
    return lbl, ""


def _log_gap_row(st: dict, state: str) -> None:
    """Append one per-leg in-play cross-venue gap row to inplay_gaps.csv (--log-all)."""
    new = not os.path.exists(GAPS_CSV)
    kx = st.get("kx")
    pm = st.get("pm")
    arb = st.get("arb")
    match, leg = _split_label(st)
    raw_gap = (1.0 - arb["gross_cost"]) if arb else None
    net_gap = arb["net_profit"] if arb else None
    dc = st.get("depth_check") or {}           # KALSHI-leg real resting depth (auth)
    pmdc = st.get("pm_depth_check") or {}       # POLYMARKET-leg real resting depth (public book)
    row = [
        dt.datetime.now(dt.timezone.utc).isoformat(),
        match, leg,
        getattr(kx, "yes_bid", None), getattr(kx, "yes_ask", None),
        getattr(pm, "yes_bid", None), getattr(pm, "yes_ask", None),
        raw_gap, net_gap, state,
        dc.get("real_size"), pmdc.get("pm_depth"), st.get("verified2"),
    ]
    with open(GAPS_CSV, "a", encoding="utf-8") as f:
        if new:
            f.write(_GAPS_HEADER)
        f.write(",".join(_csv_field(v) for v in row) + "\n")


def _next_kickoff(pairs, now):
    ups = [parse_iso(p.get("game_start")) for p in pairs]
    ups = [g for g in ups if g and g > now]
    return min(ups) if ups else None


def run(interval: float, min_profit: float, cycles: int, req_delay: float, max_pairs: int,
        live_only: bool, pre_min: float, match_min: float, idle: float, log_all: bool = False):
    pairs = _load_pairs()
    if max_pairs:
        pairs = pairs[:max_pairs]
    mode = "LIVE-ONLY (fast-poll only in-play matches)" if live_only else "all pairs"
    print(f"monitor: {len(pairs)} pairs | {mode} | interval {interval}s | "
          f"min_profit ${min_profit:.3f} | alerts -> {os.path.basename(ALERTS)}"
          + (f" | log-all -> {os.path.basename(GAPS_CSV)}" if log_all else ""))
    if not pairs:
        print("  watchlist.json has no pairs — run build_watchlist.py first.")
        return
    cycle = 0
    while cycles == 0 or cycle < cycles:
        cycle += 1
        now = dt.datetime.now(dt.timezone.utc)
        ts = now.strftime("%H:%M:%S")
        active = pairs
        if live_only:
            active = [p for p in pairs if _phase(p, now, pre_min, match_min) == "live"]
            if not active:
                nxt = _next_kickoff(pairs, now)
                wait = f"next kickoff {nxt.strftime('%H:%MZ')}" if nxt else "no upcoming kickoffs"
                print(f"\n— cycle {cycle} @ {ts}Z — no match live ({wait}); idling {idle:g}s")
                time.sleep(idle)
                continue
        best = -9.0
        alerts_this = 0
        live_lbl = f" | {len(active)} live pair(s)" if live_only else ""
        print(f"\n— cycle {cycle} @ {ts}Z{live_lbl} " + "-" * 30)
        for p in active:
            st = _check(p)
            if "error" in st:
                print(f"  {st['id']:34} ERR {st['error'][:48]}")
                time.sleep(req_delay)
                continue
            arb = st["arb"]
            np_ = arb["net_profit"] if arb else None
            if np_ is not None:
                best = max(best, np_)
            flag = ""
            state = "live" if arb else "unquoted"
            is_alert = arb and np_ is not None and np_ >= min_profit and not st["stale"]
            # TWO-SIDED DEPTH GATE: confirm BOTH legs have REAL resting size at the arb prices
            # before alerting — net>0 against an empty book on EITHER venue is the phantom-arb
            # illusion. Run the (public) PM book check + the (auth) Kalshi check on every alert
            # candidate, and on --log-all rows whose pre-fee gap is a candidate (>= _CHEAP_GAP)
            # so the CSV records depth without pulling a PM book on every poll.
            is_cheap = arb and np_ is not None and (1.0 - arb["gross_cost"]) >= _CHEAP_GAP
            if is_alert or (log_all and is_cheap and not st["stale"]):
                dc = _kx_depth_check(p, arb)
                pmdc = _pm_depth_check(p, arb)
                st["depth_check"] = dc
                st["pm_depth_check"] = pmdc
                st["verified2"] = _combine_verified(dc, pmdc)
            if is_alert:
                verified = st["verified2"]
                if verified is False:
                    dc, pmdc = st["depth_check"], st["pm_depth_check"]
                    why = dc["reason"] if dc.get("verified") is False else pmdc.get("reason")
                    flag = f"  (PHANTOM depth: {why})"
                    state = "phantom"
                    _alert(st)          # recorded for review, marked phantom — NOT alerted
                else:
                    unv = "  [depth UNVERIFIED]" if verified is None else ""
                    flag = ("  *** ALERT ***" + unv
                            + ("  [verify resolution!]" if st["verify_resolution"] else ""))
                    state = "alert"
                    _alert(st)
                    alerts_this += 1
            elif st["stale"]:
                flag = "  (stale book)"
                state = "stale"
            if log_all:
                _log_gap_row(st, state)
            if arb:
                # edge = raw cross-venue gap before fees (1 - cost to buy both legs).
                # It must exceed `fees` to profit; net = edge - fees.
                edge = 1.0 - arb["gross_cost"]
                fees = arb["fees"]
                detail = f"edge {edge:+.3f} | needs > fee {fees:.3f} | net {np_:+.3f}"
                if np_ is not None and np_ < 0:
                    detail += f"  (short {-np_:.3f})"
            else:
                detail = "n/a (a leg is unquoted)"
            print(f"  {st['label'][:30]:30} {detail}{flag}")
            time.sleep(req_delay)  # be gentle on the 60/min PM rate limit
        print(f"  cycle best net=${best:+.3f}  alerts={alerts_this}")
        if cycles != 0 and cycle >= cycles:
            break
        time.sleep(max(0.0, interval))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Continuous cross-venue arb monitor")
    ap.add_argument("--interval", type=float, default=15.0, help="seconds between cycles")
    ap.add_argument("--min-profit", type=float, default=0.02, help="net $/contract to alert")
    ap.add_argument("--cycles", type=int, default=0, help="0 = run forever")
    ap.add_argument("--req-delay", type=float, default=0.4, help="seconds between requests")
    ap.add_argument("--max-pairs", type=int, default=0, help="0 = all pairs")
    ap.add_argument("--live-only", action="store_true",
                    help="only fast-poll matches that are in-play (uses game_start)")
    ap.add_argument("--pre-min", type=float, default=10.0,
                    help="minutes before kickoff to start polling a match")
    ap.add_argument("--match-min", type=float, default=150.0,
                    help="minutes after kickoff a match stays 'live' (90m + half + stoppage)")
    ap.add_argument("--idle", type=float, default=60.0,
                    help="seconds to sleep when no match is live (live-only mode)")
    ap.add_argument("--log-all", action="store_true",
                    help="append EVERY in-play cycle's per-leg cross-venue gap to "
                         "inplay_gaps.csv (transient-desync trajectory study)")
    args = ap.parse_args(argv)
    try:
        run(args.interval, args.min_profit, args.cycles, args.req_delay, args.max_pairs,
            args.live_only, args.pre_min, args.match_min, args.idle, args.log_all)
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
