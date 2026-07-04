"""Live arb capture — MULTI-SHOT, quality-weighted sizing, ROUND-ROBIN polling.

Instead of scanning every pair each cycle (which bursts the rate limit and forces a long pause),
we check ONE pair per tick and rotate. This spreads Polymarket requests evenly (~50/min at 1.2s/
tick, under the ~60/min cap) so each outcome gets polled more often (~every tick*N_pairs) and gaps
are detected earlier in their ~15s life.

On a qualifying gap (buy YES on Polymarket + NO on Kalshi — our only built direction) size by
GAP QUALITY: target $/side = PER_VENUE * min(1, net/FULL_GAP) (25% net -> full $10/side), capped by
remaining per-venue budget. Executor crosses aggressively (up to ~6c/leg, scaled to edge) to fill
fleeting quotes, matches Kalshi to the actual PM fill, unwinds any excess. Per-outcome cooldown
avoids re-firing one gap. Stops when $10/side deployed; holds to settlement.

Real orders only if ARB_LIVE=1.  Run:  ARB_LIVE=1 python arb_live.py
"""
from __future__ import annotations
import os, time, json, datetime as dt
import creds; creds.load()
import poly_source, kalshi_source
from model import parse_iso
from arb_executor import ArbExecutor, kalshi_fee, MIN_NET_EDGE, PER_VENUE, LIVE, MAX_CONTRACTS, log

DETECT_EDGE = MIN_NET_EDGE + 0.03
FULL_GAP = float(os.environ.get("ARB_FULL_GAP", "0.25"))
COOLDOWN = float(os.environ.get("ARB_COOLDOWN", "90"))
TICK = float(os.environ.get("ARB_TICK", "1.2"))        # seconds per single-pair check (rate-safe)
MINUTES = float(os.environ.get("ARB_MINUTES", "45"))   # how long to run

ex = ArbExecutor()
now = dt.datetime.now(dt.timezone.utc)
wl = json.load(open(os.path.join(os.path.dirname(__file__), "watchlist.json")))["pairs"]
live = [p for p in wl if p.get("game_start")
        and -12 < (now - parse_iso(p["game_start"])).total_seconds() / 60 < 150]
poly_left = PER_VENUE
kx_left = PER_VENUE
last_fire, last_net, deployed = {}, {}, []

log(f"ARB_LIVE={LIVE} | ROUND-ROBIN {TICK}s/pair (~{60/TICK:.0f} PM req/min, each pair ~{TICK*max(len(live),1):.1f}s)")
log(f"detect {DETECT_EDGE} | full-budget gap {FULL_GAP:.0%} | ${PER_VENUE:.0f}/side | {len(live)} live pairs")
log(f"balances: poly ${ex.poly.usd_available():.2f} | kalshi ${ex.kx.usd_available():.2f}")
for p in live:
    log(f"  watching {p['label']}")

ticks = int(MINUTES * 60 / TICK) if live else 0
idx = 0
for tk in range(ticks):
    if poly_left < 0.5 or kx_left < 0.5:
        log(f"=== budget deployed (poly ${PER_VENUE-poly_left:.2f}, kalshi ${PER_VENUE-kx_left:.2f}); "
            f"{len(deployed)} captures. Holding to settlement. ===")
        break
    p = live[idx % len(live)]
    idx += 1
    slug = p["polymarket_slug"]
    oc = p['label'].split('—')[1].strip()[:4]
    try:
        book = poly_source.fetch_book(slug)     # /book is truth; /bbo is stale (filled 0 twice)
        offers = book["offers"]
        km = kalshi_source.fetch_market(p["kalshi_ticker"])
        if offers and km is not None and km.no_ask is not None:
            pm_yes, pm_depth = offers[0]        # REAL best ask + its size
            net = 1.0 - (pm_yes + km.no_ask + kalshi_fee(km.no_ask))
            last_net[oc] = net
            cooling = (time.time() - last_fire.get(slug, 0)) < COOLDOWN
            if net >= DETECT_EDGE and not cooling:
                frac = min(1.0, net / FULL_GAP)
                target = PER_VENUE * frac
                qty = min(MAX_CONTRACTS, int(pm_depth),     # cap by REAL available depth
                          int(min(target, poly_left) / max(pm_yes, .01)),
                          int(min(target, kx_left) / max(km.no_ask, .01)))
                log(f"*** GAP {p['label']} net {net:+.3f} (PM real ask {pm_yes:.2f} x{int(pm_depth)}) "
                    f"-> size {frac:.0%} qty {qty}")
                log("    PM ask depth: " + str([(round(px, 3), int(q)) for px, q in offers[:5]]))
                try:
                    if ex.kx.ready:
                        ob = ex.kx.c.get_orderbook(p["kalshi_ticker"], depth=4)
                        log("    KX book: " + json.dumps(ob.get("orderbook", ob), default=str)[:180])
                except Exception as e:  # noqa: BLE001
                    log("    KX book err", str(e)[:50])
                if qty >= 1:
                    res = ex.capture(poly_slug=slug, kalshi_ticker=p["kalshi_ticker"],
                                     poly_yes_ask=pm_yes, kalshi_no_ask=km.no_ask, qty=qty)
                    log("RESULT: " + json.dumps(res, default=str)[:240])
                    last_fire[slug] = time.time()
                    # HARD-KILL: a 2-strike leg-risk or session $-loss halt stops the whole run.
                    if getattr(ex, "halted", False):
                        log(f"=== HARD STOP — {ex.halt_reason} — ending run, holding positions ===")
                        break
                    lq = res.get("locked", 0) or 0
                    if lq > 0:
                        poly_left -= lq * res.get("pm_px", pm_yes)
                        kx_left -= lq * res.get("kx_px", km.no_ask)
                        deployed.append((oc, lq, net))
                        log(f"  ✓ captured {lq}x {oc} @ net{net:+.2f} | left poly ${poly_left:.2f} kx ${kx_left:.2f}")
    except Exception as e:  # noqa: BLE001
        log("err", p["label"][:26], str(e)[:60])
    if tk % len(live) == 0:   # one status line per full rotation
        log(f"t{tk:<4} " + "  ".join(f"{k} {v:+.2f}" for k, v in last_net.items())
            + f"  | left poly ${poly_left:.1f} kx ${kx_left:.1f}")
    time.sleep(TICK)

if deployed:
    tot = sum(lq * net for _, lq, net in deployed)
    log(f"=== DONE: {len(deployed)} arbs, est locked profit ~${tot:.2f}. Settles at match end. ===")
else:
    log("=== window ended — no qualifying gap captured ===")
