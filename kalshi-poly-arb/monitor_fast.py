"""WebSocket-driven cross-venue arb monitor — REAL-TIME PUSH (3+ Hz, observation-only).

The fast successor to monitor.py. Instead of REST-polling each pair every 5s (desyncs live ~7s
median / 35% vanish within one poll), this maintains LIVE in-memory order books for both venues
over WebSocket push feeds and re-evaluates the arb on a fast timer (default 4 Hz). WS delivers
~14 book updates/s (Polymarket US) and ~100 delta/s (Kalshi) during a live match, so detection is
always on the FRESHEST book — no poll-rate wall, no phantom-stale gap.

  * Polymarket US:  wss://api.polymarket.us/v1/ws/markets  (SUBSCRIPTION_TYPE_MARKET_DATA →
                    full bids/offers with real qty; Ed25519 auth). Full-book snapshot per msg.
  * Kalshi:         wss://api.elections.kalshi.com/trade-api/ws/v2  (orderbook_snapshot+delta;
                    RSA-PSS auth). Book reconstructed from deltas exactly like kalshi_l2_feed.py.

Two-sided depth is FREE from the live books (real qty is in the feed) — no extra REST call, so
every logged row already carries verified real depth on BOTH legs.

SAFETY: OBSERVATION-ONLY. Never sends an order. Fully independent of arb_live.py/arb_executor.py
(which do their own book fetch) — running this cannot disturb a live executor run. Writes to
inplay_gaps_fast.csv + alerts_fast.jsonl (distinct from monitor.py's files, so both can coexist).

Run (continuous, auto-covers each match's in-play window, idles between):
    python monitor_fast.py --min-profit 0.02
Env/flags mirror monitor.py where sensible. Offline check: python monitor_fast.py --selftest
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import datetime as dt
import json
import os
import sys
import time

import creds
creds.load()

import arbmath
from model import Market, parse_iso

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHLIST = os.path.join(HERE, "watchlist.json")
ALERTS = os.path.join(HERE, "alerts_fast.jsonl")
GAPS_CSV = os.path.join(HERE, "inplay_gaps_fast.csv")
_GAPS_HEADER = ("ts,match,leg,kx_yes_bid,kx_yes_ask,pm_yes_bid,pm_yes_ask,"
                "raw_gap,net_gap,state,kx_depth,pm_depth,verified\n")
_TIGHT = 1.06

PM_WS = "wss://api.polymarket.us/v1/ws/markets"
PM_WS_PATH = "/v1/ws/markets"
KX_WS = "wss://api.elections.kalshi.com/trade-api/ws/v2"
KX_WS_PATH = "/trade-api/ws/v2"

PM_MIN_DEPTH = 1.0        # contract-equiv resting at/better than the quoted PM arb price
MIN_REAL_DEPTH = 10.0     # Kalshi real resting size on the binding leg (matches monitor.py)


def log(*a):
    print(f"[{dt.datetime.now(dt.timezone.utc).strftime('%H:%M:%S')}Z]", *a, flush=True)


# ── shared live book state ────────────────────────────────────────────────────
class Books:
    """Thread-free (single event loop) live book store for both venues."""

    def __init__(self):
        # PM: slug -> {"offers":[(px,qty)..], "bids":[(px,qty)..], "ts":epoch}
        self.pm: dict[str, dict] = {}
        # KX: ticker -> {"yes":{px:sz}, "no":{px:sz}, "ts":epoch}
        self.kx: dict[str, dict] = {}

    # -- Polymarket full-book snapshot (each MARKET_DATA msg is a full book) --
    def pm_update(self, slug: str, md: dict, now: float):
        def lvls(key):
            out = []
            for x in md.get(key, []) or []:
                try:
                    px = float(x["px"]["value"]); qty = float(x.get("qty", 0) or 0)
                except (TypeError, ValueError, KeyError):
                    continue
                if px > 0:
                    out.append((px, qty))
            return out
        self.pm[slug] = {"offers": lvls("offers"), "bids": lvls("bids"), "ts": now}

    # -- Kalshi snapshot / delta (resting bids per leg, dollars) --
    def kx_snapshot(self, tk: str, d: dict, now: float):
        self.kx[tk] = {
            "yes": {float(p): float(s) for p, s in d.get("yes_dollars_fp", [])},
            "no": {float(p): float(s) for p, s in d.get("no_dollars_fp", [])},
            "ts": now}

    def kx_delta(self, tk: str, d: dict, now: float):
        b = self.kx.get(tk)
        if b is None:
            b = self.kx[tk] = {"yes": {}, "no": {}, "ts": now}
        side = d.get("side")
        if side not in ("yes", "no"):
            return
        try:
            px = float(d.get("price_dollars")); delta = float(d.get("delta_fp"))
        except (TypeError, ValueError):
            return
        newsz = b[side].get(px, 0.0) + delta
        if newsz <= 1e-9:
            b[side].pop(px, None)
        else:
            b[side][px] = newsz
        b["ts"] = now

    # -- venue books -> Market (dollars) --
    def pm_market(self, slug: str) -> Market | None:
        b = self.pm.get(slug)
        if not b:
            return None
        ya = b["offers"][0][0] if b["offers"] else None      # best ask = yes_ask
        yb = b["bids"][0][0] if b["bids"] else None           # best bid = yes_bid
        return Market(venue="polymarket", market_id=slug, question=slug,
                      yes_ask=ya, no_ask=(1.0 - yb) if yb is not None else None,
                      yes_bid=yb, no_bid=(1.0 - ya) if ya is not None else None,
                      fee_coeff=arbmath.POLY_US_FEE_COEFF_DEFAULT)

    def kx_market(self, tk: str, invert: bool) -> Market | None:
        b = self.kx.get(tk)
        if not b or (not b["yes"] and not b["no"]):
            return None
        yes_bid = max(b["yes"]) if b["yes"] else None         # best YES bid
        no_bid = max(b["no"]) if b["no"] else None            # best NO bid
        yes_ask = (1.0 - no_bid) if no_bid is not None else None
        no_ask = (1.0 - yes_bid) if yes_bid is not None else None
        m = Market(venue="kalshi", market_id=tk, question=tk,
                   yes_ask=yes_ask, no_ask=no_ask, yes_bid=yes_bid, no_bid=no_bid)
        if invert:
            m.yes_ask, m.no_ask = m.no_ask, m.yes_ask
            m.yes_bid, m.no_bid = m.no_bid, m.yes_bid
        return m

    # -- real resting depth at the arb price, straight from the live books --
    def pm_depth(self, slug: str, side: str, price: float) -> float | None:
        b = self.pm.get(slug)
        if not b:
            return None
        if side == "buy_yes":   # cross the offers (YES asks) at px <= yes_ask
            return sum(q for px, q in b["offers"] if px <= price + 1e-9)
        # buy NO == sell YES: cross the bids (YES bids) at px >= 1-no_ask
        need = 1.0 - price
        return sum(q for px, q in b["bids"] if px >= need - 1e-9)

    def kx_depth(self, tk: str, side: str, invert: bool) -> float | None:
        """Real resting size available to take the binding KX leg (arb-space side).
        buy YES @ yes_ask -> size resting at best NO bid; buy NO @ no_ask -> size at best YES bid."""
        b = self.kx.get(tk)
        if not b:
            return None
        if invert:
            side = "buy_no" if side == "buy_yes" else "buy_yes"
        # size resting AT the best-price level of the relevant leg (not the max size anywhere):
        #   buy YES @ yes_ask -> size at best NO bid ; buy NO @ no_ask -> size at best YES bid
        leg = b["no"] if side == "buy_yes" else b["yes"]
        if not leg:
            return 0.0
        return leg[max(leg)]


# ── CSV / alert writers ───────────────────────────────────────────────────────
def _csv_field(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.4f}"
    s = str(v)
    return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n') else s


def _split_label(label: str):
    for sep in ("—", " - ", " – "):
        if sep in label:
            m, l = label.split(sep, 1)
            return m.strip(), l.strip()
    return label, ""


def _write_gap_row(pair, pm: Market, kx: Market, arb, state, kx_dep, pm_dep, verified):
    new = not os.path.exists(GAPS_CSV)
    match, leg = _split_label(pair.get("label", pair["id"]))
    raw_gap = (1.0 - arb["gross_cost"]) if arb else None
    net_gap = arb["net_profit"] if arb else None
    row = [dt.datetime.now(dt.timezone.utc).isoformat(), match, leg,
           kx.yes_bid if kx else None, kx.yes_ask if kx else None,
           pm.yes_bid if pm else None, pm.yes_ask if pm else None,
           raw_gap, net_gap, state, kx_dep, pm_dep, verified]
    with open(GAPS_CSV, "a", encoding="utf-8") as f:
        if new:
            f.write(_GAPS_HEADER)
        f.write(",".join(_csv_field(v) for v in row) + "\n")


def _write_alert(pair, arb, kx_dep, pm_dep, verified):
    rec = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "id": pair["id"],
           "label": pair.get("label", pair["id"]), "net_profit": arb["net_profit"],
           "net_profit_pct": arb["net_profit_pct"], "legs": arb,
           "verify_resolution": pair.get("verify_resolution", False),
           "kx_depth": kx_dep, "pm_depth": pm_dep, "verified": verified,
           "phantom": verified is False, "src": "monitor_fast"}
    with open(ALERTS, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


# ── live-set / phase ──────────────────────────────────────────────────────────
def _load_pairs():
    with open(WATCHLIST, encoding="utf-8") as f:
        return json.load(f).get("pairs", [])


def _phase(pair, now, pre_min, match_min):
    gs = parse_iso(pair.get("game_start"))
    if gs is None:
        return "unknown"
    if now < gs - dt.timedelta(minutes=pre_min):
        return "upcoming"
    return "live" if now <= gs + dt.timedelta(minutes=match_min) else "done"


def _live_pairs(pairs, pre_min, match_min):
    now = dt.datetime.now(dt.timezone.utc)
    return [p for p in pairs if _phase(p, now, pre_min, match_min) == "live"]


# ── auth headers ──────────────────────────────────────────────────────────────
def _pm_headers():
    from polymarket_us.auth import create_auth_headers
    return create_auth_headers(os.environ["POLYMARKET_KEY_ID"],
                               os.environ["POLYMARKET_SECRET_KEY"], "GET", PM_WS_PATH)


def _kx_headers():
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    key = serialization.load_pem_private_key(
        open(os.environ["KALSHI_PRIVATE_KEY_PATH"], "rb").read(), password=None)
    ts = str(int(time.time() * 1000))
    sig = key.sign((ts + "GET" + KX_WS_PATH).encode(),
                   padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                               salt_length=padding.PSS.DIGEST_LENGTH), hashes.SHA256())
    return {"KALSHI-ACCESS-KEY": os.environ["KALSHI_API_KEY"],
            "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(),
            "KALSHI-ACCESS-TIMESTAMP": ts}


# ── per-venue WS receivers (auto-reconnect within a session) ──────────────────
async def _pm_ws(slugs, books: Books, stop: asyncio.Event, stats: dict):
    import websockets
    while not stop.is_set():
        try:
            async with websockets.connect(PM_WS, additional_headers=_pm_headers(),
                                          ping_interval=15, ping_timeout=15) as ws:
                await ws.send(json.dumps({"subscribe": {
                    "requestId": "mf-pm", "subscriptionType": "SUBSCRIPTION_TYPE_MARKET_DATA",
                    "marketSlugs": slugs}}))
                log(f"PM WS subscribed: {len(slugs)} slug(s)")
                while not stop.is_set():
                    raw = await asyncio.wait_for(ws.recv(), timeout=30)
                    m = json.loads(raw)
                    if "marketData" in m:
                        md = m["marketData"]
                        slug = md.get("marketSlug")
                        if slug:
                            books.pm_update(slug, md, time.time())
                            stats["pm"] += 1
                    elif "error" in m:
                        log("PM WS error:", str(m)[:160])
        except Exception as e:  # noqa: BLE001
            if stop.is_set():
                return
            log("PM WS reconnect in 2s:", f"{type(e).__name__}: {str(e)[:100]}")
            await asyncio.sleep(2)


async def _kx_ws(tickers, books: Books, stop: asyncio.Event, stats: dict):
    import websockets
    sub_id = 1
    while not stop.is_set():
        try:
            async with websockets.connect(KX_WS, additional_headers=_kx_headers(),
                                          ping_interval=10, ping_timeout=10, max_queue=1024) as ws:
                sub_id += 1
                await ws.send(json.dumps({"id": sub_id, "cmd": "subscribe", "params": {
                    "channels": ["orderbook_delta"], "market_tickers": tickers}}))
                log(f"KX WS subscribed: {len(tickers)} ticker(s)")
                while not stop.is_set():
                    raw = await asyncio.wait_for(ws.recv(), timeout=30)
                    m = json.loads(raw)
                    t = m.get("type"); d = m.get("msg", m)
                    tk = d.get("market_ticker")
                    now = time.time()
                    if t == "orderbook_snapshot":
                        books.kx_snapshot(tk, d, now); stats["kx"] += 1
                    elif t == "orderbook_delta":
                        books.kx_delta(tk, d, now); stats["kx"] += 1
                    elif t == "error":
                        log("KX WS error:", str(m)[:160])
        except Exception as e:  # noqa: BLE001
            if stop.is_set():
                return
            log("KX WS reconnect in 2s:", f"{type(e).__name__}: {str(e)[:100]}")
            await asyncio.sleep(2)


# ── evaluation loop (fast timer) ──────────────────────────────────────────────
def _evaluate_pair(pair, books: Books):
    """Return (pm, kx, arb, state, kx_dep, pm_dep, verified, is_alert_candidate)."""
    pm = books.pm_market(pair["polymarket_slug"])
    kx = books.kx_market(pair["kalshi_ticker"], pair.get("invert", False))
    if pm is None or kx is None:
        return pm, kx, None, "unquoted", None, None, None, False
    arb = arbmath.best_arb(pm, kx)
    if arb is None:
        return pm, kx, None, "unquoted", None, None, None, False
    sp_pm = (pm.yes_ask + pm.no_ask) if (pm.yes_ask and pm.no_ask) else None
    sp_kx = (kx.yes_ask + kx.no_ask) if (kx.yes_ask and kx.no_ask) else None
    stale = (sp_pm and sp_pm > _TIGHT) or (sp_kx and sp_kx > _TIGHT)
    # real depth on both legs, from the live books (free)
    if arb["buy_yes_on"] == "polymarket":
        pm_dep = books.pm_depth(pair["polymarket_slug"], "buy_yes", arb["yes_ask"])
        kx_dep = books.kx_depth(pair["kalshi_ticker"], "buy_no", pair.get("invert", False))
    else:
        pm_dep = books.pm_depth(pair["polymarket_slug"], "buy_no", arb["no_ask"])
        kx_dep = books.kx_depth(pair["kalshi_ticker"], "buy_yes", pair.get("invert", False))
    pm_ok = None if pm_dep is None else pm_dep >= PM_MIN_DEPTH
    kx_ok = None if kx_dep is None else kx_dep >= MIN_REAL_DEPTH
    verified = False if (pm_ok is False or kx_ok is False) else (
        True if (pm_ok and kx_ok) else None)
    state = "stale" if stale else "live"
    return pm, kx, arb, state, kx_dep, pm_dep, verified, (not stale)


async def _eval_loop(pairs, books: Books, stop: asyncio.Event, min_profit: float,
                     eval_ms: float, stats: dict):
    period = eval_ms / 1000.0
    while not stop.is_set():
        t0 = time.time()
        for pair in pairs:
            pm, kx, arb, state, kx_dep, pm_dep, verified, ok = _evaluate_pair(pair, books)
            np_ = arb["net_profit"] if arb else None
            is_alert = arb and np_ is not None and np_ >= min_profit and ok
            if is_alert:
                if verified is False:
                    state = "phantom"
                else:
                    state = "alert"
                    stats["alerts"] += 1
                    lbl = pair.get("label", pair["id"])
                    unv = " [depth UNVERIFIED]" if verified is None else ""
                    vr = " [verify resolution!]" if pair.get("verify_resolution") else ""
                    log(f"*** ALERT{unv}{vr} {lbl} net {np_:+.3f} "
                        f"(kx_dep {kx_dep} pm_dep {pm_dep})")
                _write_alert(pair, arb, kx_dep, pm_dep, verified)
            _write_gap_row(pair, pm, kx, arb, state, kx_dep, pm_dep, verified)
            stats["rows"] += 1
        dtt = time.time() - t0
        await asyncio.sleep(max(0.0, period - dtt))


async def _heartbeat(stop: asyncio.Event, stats: dict, pairs):
    """Periodic throughput line: rows/s, book msgs/s, alerts."""
    last = dict(stats); t_last = time.time()
    while not stop.is_set():
        await asyncio.sleep(10)
        now = time.time(); dtt = now - t_last
        rr = (stats["rows"] - last["rows"]) / dtt
        pm = (stats["pm"] - last["pm"]) / dtt
        kx = (stats["kx"] - last["kx"]) / dtt
        log(f"hb: {rr:.1f} rows/s | PM {pm:.1f} bk/s | KX {kx:.1f} d/s | "
            f"alerts {stats['alerts']} | {len(pairs)} live pair(s)")
        last = dict(stats); t_last = now


# ── session: run one live-set until it changes ────────────────────────────────
async def _session(pairs, live_pairs, min_profit, eval_ms, pre_min, match_min):
    slugs = [p["polymarket_slug"] for p in live_pairs]
    tickers = [p["kalshi_ticker"] for p in live_pairs]
    books = Books()
    stop = asyncio.Event()
    stats = {"rows": 0, "pm": 0, "kx": 0, "alerts": 0}

    async def _watch_liveset():
        sig = {p["id"] for p in live_pairs}
        while not stop.is_set():
            await asyncio.sleep(15)
            cur = {p["id"] for p in _live_pairs(pairs, pre_min, match_min)}
            if cur != sig:
                log(f"live-set changed ({len(sig)}→{len(cur)}) — cycling session")
                stop.set()

    tasks = [asyncio.create_task(_pm_ws(slugs, books, stop, stats)),
             asyncio.create_task(_kx_ws(tickers, books, stop, stats)),
             asyncio.create_task(_eval_loop(live_pairs, books, stop, min_profit, eval_ms, stats)),
             asyncio.create_task(_heartbeat(stop, stats, live_pairs)),
             asyncio.create_task(_watch_liveset())]
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _run(min_profit, eval_ms, pre_min, match_min, idle):
    pairs = _load_pairs()
    log(f"monitor_fast: {len(pairs)} pairs | WS push | eval {eval_ms:g}ms "
        f"(~{1000/eval_ms:.1f} Hz) | min_profit ${min_profit:.3f} | "
        f"gaps -> {os.path.basename(GAPS_CSV)}")
    while True:
        live = _live_pairs(pairs, pre_min, match_min)
        if not live:
            nxt = [parse_iso(p.get("game_start")) for p in pairs]
            nxt = [g for g in nxt if g and g > dt.datetime.now(dt.timezone.utc)]
            when = min(nxt).strftime("%H:%MZ") if nxt else "none"
            log(f"no match live (next kickoff {when}); idling {idle:g}s")
            await asyncio.sleep(idle)
            continue
        log(f"live: {', '.join(p.get('label', p['id']) for p in live)}")
        await _session(pairs, live, min_profit, eval_ms, pre_min, match_min)


# ── offline self-test (no network / no creds) ─────────────────────────────────
def _selftest():
    b = Books()
    now = time.time()
    b.pm_update("s", {"offers": [{"px": {"value": "0.60"}, "qty": "500"}],
                      "bids": [{"px": {"value": "0.58"}, "qty": "300"}]}, now)
    pm = b.pm_market("s")
    assert pm.yes_ask == 0.60 and abs(pm.no_ask - 0.42) < 1e-9, pm
    b.kx_snapshot("t", {"yes_dollars_fp": [["0.35", "40"]],
                        "no_dollars_fp": [["0.60", "80"]]}, now)
    kx = b.kx_market("t", False)
    # best yes bid .35 -> no_ask=.65 ; best no bid .60 -> yes_ask=.40
    assert abs(kx.no_ask - 0.65) < 1e-9 and abs(kx.yes_ask - 0.40) < 1e-9, kx
    b.kx_delta("t", {"side": "yes", "price_dollars": "0.36", "delta_fp": "10"}, now)
    assert max(b.kx["t"]["yes"]) == 0.36, b.kx["t"]
    # arb: buy YES on the cheaper-ask venue + NO on the other
    arb = arbmath.best_arb(pm, kx)
    assert arb is not None, arb
    # depth from books
    pd = b.pm_depth("s", "buy_yes", 0.60); assert pd == 500, pd
    kd = b.kx_depth("t", "buy_no", False); assert kd == 10, kd  # best yes bid now .36 sz10
    pair = {"id": "x", "polymarket_slug": "s", "kalshi_ticker": "t", "invert": False,
            "label": "TEST — X win"}
    res = _evaluate_pair(pair, b)
    assert res[2] is not None, res
    print("SELFTEST PASSED: PM/KX book->market, delta, depth, evaluate all correct.")


def main(argv=None):
    ap = argparse.ArgumentParser(description="WS-driven real-time cross-venue arb monitor")
    ap.add_argument("--min-profit", type=float, default=0.02, help="net $/contract to alert")
    ap.add_argument("--eval-ms", type=float, default=250.0,
                    help="milliseconds between arb evaluations (250 = 4 Hz)")
    ap.add_argument("--pre-min", type=float, default=10.0)
    ap.add_argument("--match-min", type=float, default=150.0)
    ap.add_argument("--idle", type=float, default=30.0)
    ap.add_argument("--selftest", action="store_true", help="offline replay, no network/creds")
    args = ap.parse_args(argv)
    if args.selftest:
        _selftest(); return 0
    try:
        asyncio.run(_run(args.min_profit, args.eval_ms, args.pre_min, args.match_min, args.idle))
    except KeyboardInterrupt:
        print("\nstopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
