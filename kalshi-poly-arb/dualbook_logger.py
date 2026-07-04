"""Dual-book divergence logger (READ-ONLY, no orders).

Records BOTH venues' real top-of-book (Polymarket /book + Kalshi orderbook) for each live World
Cup outcome at ~1s round-robin, so we can answer: do the two exchanges actually react in lockstep,
or do real (fillable) gaps open for a few seconds — especially around goals? Writes a CSV for
later analysis; flags big cross-venue divergences and sudden mid-price jumps (goal proxies) live.

No trading. Safe to run continuously. Run:  python dualbook_logger.py
"""
from __future__ import annotations
import os, time, json, csv, datetime as dt
import creds; creds.load()
import poly_source, kalshi_source
from model import parse_iso
from arb_executor import kalshi_fee

TICK = float(os.environ.get("DB_TICK", "1.0"))         # seconds per single-pair sample
MINUTES = float(os.environ.get("DB_MINUTES", "180"))
FLAG = float(os.environ.get("DB_FLAG", "0.03"))        # |net| above this = notable divergence
here = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(here, "dualbook.csv")

def log(*a): print(f"[{dt.datetime.now().strftime('%H:%M:%S')}]", *a, flush=True)

now = dt.datetime.now(dt.timezone.utc)
wl = json.load(open(os.path.join(here, "watchlist.json")))["pairs"]
live = [p for p in wl if p.get("game_start")
        and -12 < (now - parse_iso(p["game_start"])).total_seconds() / 60 < 150]
if not live:
    # if nothing live, take the next match's pairs so the logger is ready at kickoff
    fut = sorted([p for p in wl if p.get("game_start") and parse_iso(p["game_start"]) > now],
                 key=lambda p: parse_iso(p["game_start"]))
    if fut:
        first = fut[0]["label"].split("—")[0].strip()
        live = [p for p in wl if p["label"].split("—")[0].strip() == first]
        log(f"no match live; pre-loading next: {first}")

log(f"dual-book logger | {len(live)} outcomes | {TICK}s/sample | -> {os.path.basename(OUT)}")
for p in live:
    log(f"  {p['label']}")

new = not os.path.exists(OUT)
f = open(OUT, "a", newline="", encoding="utf-8")
w = csv.writer(f)
if new:
    w.writerow(["ts", "match", "outcome", "pm_yes_bid", "pm_yes_ask", "pm_depth_ask",
                "kx_yes_ask", "kx_no_ask", "net_PMyes_KXno", "net_KXyes_PMno"])

prev_mid = {}
ticks = int(MINUTES * 60 / TICK) if live else 0
idx = 0
for tk in range(ticks):
    p = live[idx % len(live)]; idx += 1
    label = p["label"]; match = label.split("—")[0].strip().replace("WC ", "")
    oc = label.split("—")[1].strip()
    try:
        bk = poly_source.fetch_book(p["polymarket_slug"])
        km = kalshi_source.fetch_market(p["kalshi_ticker"])
        pm_ask = bk["offers"][0][0] if bk["offers"] else None
        pm_depth = bk["offers"][0][1] if bk["offers"] else 0
        pm_bid = bk["bids"][0][0] if bk["bids"] else None
        if pm_ask is None or km is None or km.no_ask is None:
            time.sleep(TICK); continue
        kx_yes, kx_no = km.yes_ask, km.no_ask
        # our direction: buy YES on PM + NO on Kalshi ; other: buy YES on KX + NO on PM
        net_a = 1.0 - (pm_ask + (kx_no or 1) + kalshi_fee(kx_no or 0))
        pm_no = (1.0 - pm_bid) if pm_bid is not None else None    # buy NO on PM = sell YES at bid
        net_b = (1.0 - ((kx_yes or 1) + pm_no + kalshi_fee(kx_yes or 0))) if pm_no is not None else None
        ts = dt.datetime.now(dt.timezone.utc).isoformat()
        w.writerow([ts, match, oc, pm_bid, pm_ask, int(pm_depth), kx_yes, kx_no,
                    round(net_a, 3), round(net_b, 3) if net_b is not None else ""])
        f.flush()
        # live flags
        mid = (pm_ask + (pm_bid or pm_ask)) / 2
        jump = abs(mid - prev_mid.get(oc, mid)); prev_mid[oc] = mid
        notes = []
        if net_a >= FLAG: notes.append(f"GAP PMyes+KXno {net_a:+.2f}")
        if net_b is not None and net_b >= FLAG: notes.append(f"GAP KXyes+PMno {net_b:+.2f}")
        if jump >= 0.05: notes.append(f"JUMP {jump:+.2f} (goal?)")
        if notes:
            log(f"{match} {oc:4} PM {pm_bid}/{pm_ask} KX y{kx_yes}/n{kx_no}  " + " | ".join(notes))
        elif tk % (len(live) * 20) == 0:
            log(f"sample {match} {oc:4} PMask {pm_ask} KXyes {kx_yes} netA {net_a:+.2f} netB {net_b if net_b is None else round(net_b,2)}")
    except Exception as e:  # noqa: BLE001
        log("err", oc, str(e)[:60])
    time.sleep(TICK)
f.close()
log("=== logger window ended ===")
