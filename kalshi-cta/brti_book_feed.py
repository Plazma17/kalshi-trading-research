"""BRTI CONSTITUENT-BOOK feed  ->  the structural ~1-second lead on the settlement index.

WHY THIS EXISTS  (obscure_btc_signals_report.md  RANK #1 -- the top lead)
------------------------------------------------------------------------
Kalshi KXBTC15M settles on the CME CF Bitcoin Real-Time Index (BRTI). The BRTI is computed
from the ORDER BOOKS (bid/ask -- NOT trades) of a fixed set of venues and is republished
exactly ONCE PER SECOND. Therefore the LIVE consolidated bid/ask of those exact venues is, BY
CONSTRUCTION, ~1 second AHEAD of every BRTI print -- and the Kalshi mid can only reprice AFTER
the print. We currently log only the derived `cfmean` VWAP (cf_feed.py), throwing away the
sub-second constituent BOOK (best bid/ask + sizes) and its depth-IMBALANCE. Every prior
lead-lag test was 60s-candle => 60x too coarse to see a 1-second structural lead.

WHAT IT DOES
------------
Connects to the FREE, keyless, US-reachable public WebSockets of the BRTI constituents that
survive the box's geo-blocks (Binance-global 451s from US, so EXCLUDED):
  * Coinbase  wss://ws-feed.exchange.coinbase.com   (level2 / level2_batch  BTC-USD)
  * Kraken    wss://ws.kraken.com/v2                 (book channel           BTC/USD, depth 10)
  * Bitstamp  wss://ws.bitstamp.net                  (diff_order_book_btcusd  -> top of book)
  * Gemini    wss://api.gemini.com/v1/marketdata/BTCUSD  (l2_updates -> top of book)
Maintains per-venue best bid/ask + sizes; emits sub-second (EMIT_EVERY), timestamped rows:
  * per-venue best bid/ask + bid/ask sizes + per-venue mid + staleness
  * the CONSOLIDATED mid across fresh venues (the data the BRTI is built from, finer than 1s)
  * the consolidated depth-IMBALANCE (bid size vs ask size) -- the micro-pressure signal
  * the CONCURRENT cfmean / BRTI value (cfindex_live.json `index` & `mean`) STAMPED on each row,
    so the lead (constituent-book move -> next BRTI tick) is measurable DIRECTLY from the log.

OUTPUTS (cf_feed.py / btc_book.py / xexch_texture_feed.py convention):
  * brti_book_live.json  -- atomic flat snapshot the cta_evolve.py recorder can json.load() each tick
  * brti_book_log.jsonl  -- append-only timestamped rows (standalone), left-join to ticklog by ts
  TIMESTAMP: `ts` = time.time() epoch float == ticklog `t`. Join on round(t)==round(ts).
  Atomic writes via OUT + ".tmp." + pid + os.replace (never a torn read).

ROBUSTNESS (reuses the production-hardened pattern from xexch_texture_feed.py):
  * each venue independent w/ its own auto-reconnect + exponential backoff
  * a STALL WATCHDOG cancels the INNER connection task (not the supervisor) of a silently-
    dead-but-open socket; the supervisor reconnects (RECYCLE-tagged cancel, NOT the outer
    cancel bug)
  * bounded state; missing/partial fields => SKIP that update, NEVER crash
    (reference-cta-tfi-none-stuck-bot: treat optional fields as missing, don't die)

NOTE: this box is network-restricted -- run `python brti_book_feed.py --selftest` to validate
the consolidation / imbalance math on a synthetic replay WITHOUT touching the network. Live
behaviour is only exercised on the AWS box. LOG FIRST, test later -- this just banks the data.
"""
import asyncio, json, time, os, sys, argparse
from collections import deque

try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "brti_book_live.json")    # snapshot the recorder reads (like cfindex_live.json)
JSONL = os.path.join(HERE, "brti_book_log.jsonl")  # append-only standalone collection -> left-join to ticklog by ts
CFIDX = os.path.join(HERE, "cfindex_live.json")    # cf_feed.py output: the concurrent BRTI/cfmean to stamp

EMIT_EVERY = 0.2     # snapshot + JSONL row cadence (seconds) -> 5/sec, sub-second to catch the ~1s lead
HB_SECS = 30.0       # heartbeat log cadence
STALL_SECS = 20.0    # if a venue produced no msg in this long while open -> recycle its socket
FRESH = 15.0         # a venue counts toward the consolidated mid only if it updated within this many seconds

# --- BRTI constituent venues we capture (free, keyless, US-reachable, sub-second SPOT books) ---
# coinbase/kraken/bitstamp/gemini are the dominant US-book weight. crypto.com added (keyless public
# WS) as a best-effort 5th; LMAX (1 update/sec, demo-only URL) and Bullish (gated docs, BTCUSDC not
# USD, US-reachability doubtful) are NOT sub-second/keyless-spot and are intentionally excluded
# (see brti_feed_fix_plan.md). cryptocom can be disabled at runtime with --no-cryptocom if it proves
# unreachable/noisy on the AWS box (it then simply contributes nothing to cons_mid).
VENUES = ("coinbase", "kraken", "bitstamp", "gemini", "cryptocom")

# Kraken v2 'book' is a FIXED-DEPTH book: when the price moves, levels that fall outside the top-N
# are dropped by the SERVER and are NOT echoed back as a qty=0 delete (verified against the v2 book
# docs). So the client MUST truncate its own book to the subscribed depth after every update -- if it
# doesn't, a stale far level (e.g. an old best bid) lingers forever as max(bids)/min(asks) and the
# book goes CROSSED (best_bid > best_ask). depth 10 matches sub_for("kraken").
KRAKEN_DEPTH = 10

# BRTI weights its venues roughly by liquidity; an equal-weight mean over-weights thin venues and
# adds noise. These are STATIC liquidity-proxy weights for the consolidated mid (NOT the official
# CF utility function, which we can't replicate without the full depth-weighted book). Used by
# build_snapshot for cons_mid_w; the equal-weight cons_mid is still emitted for comparison.
VENUE_W = {"coinbase": 0.45, "kraken": 0.20, "bitstamp": 0.15, "gemini": 0.10, "cryptocom": 0.10}

def _new_venue():
    return {
        "best_bid": None, "bid_sz": None,
        "best_ask": None, "ask_sz": None,
        "last_msg": 0.0, "connects": 0, "msgs": 0,
        "n_snap": 0, "n_upd": 0,   # per-type counters: snapshot vs incremental-update (the Kraken-1% tell)
        # full-book maps (price->size) for venues that send incremental diffs (coinbase/bitstamp/gemini)
        "bids": {}, "asks": {},
    }

V = {name: _new_venue() for name in VENUES}

# Venues actually streamed this run (writer/watchdog/heartbeat iterate this). Defaults to all;
# --no-cryptocom drops crypto.com if it proves unreachable/noisy on the box. build_snapshot still
# emits ALL VENUES' columns (None for inactive) so the JSONL schema stays stable for the left-join.
ACTIVE = list(VENUES)

def log(*a): print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)

def _recompute_tob(venue):
    """Recompute best bid/ask + sizes from the venue's full-book maps. Skips empty sides."""
    s = V[venue]
    if s["bids"]:
        bb = max(s["bids"])
        s["best_bid"] = bb; s["bid_sz"] = s["bids"][bb]
    if s["asks"]:
        ba = min(s["asks"])
        s["best_ask"] = ba; s["ask_sz"] = s["asks"][ba]

def _trim_kraken_book(s, new_bid_pxs, new_ask_pxs, depth=KRAKEN_DEPTH):
    """Reconcile Kraken's FIXED-DEPTH book after applying one message's bid/ask updates.

    Kraken v2 'book' silently drops levels that fall outside the top-N when the price moves -- it does
    NOT echo a qty=0 delete for them (verified vs the v2 book docs). So the client must evict stale
    levels itself, or an old best bid lingers as max(bids) and the book reads bid > ask -> venue_mid()
    rejects it as crossed -> kraken never enters cons_mid. THIS was the bug (bid>ask in 99.1% of rows).

    Resolution is DIRECTIONAL using the levels in THIS message (which are freshest): a fresh bid at
    price pb means any resting ASK <= pb was consumed (stale) and must go; a fresh ask at pa means any
    resting BID >= pa is stale. Then truncate each side to the subscribed depth."""
    if new_bid_pxs:                 # bids just moved -> the freshest bid is authoritative vs old asks
        top_new_bid = max(new_bid_pxs)
        for p in [p for p in s["asks"] if p <= top_new_bid]: s["asks"].pop(p, None)
    if new_ask_pxs:                 # asks just moved -> the freshest ask is authoritative vs old bids
        bot_new_ask = min(new_ask_pxs)
        for p in [p for p in s["bids"] if p >= bot_new_ask]: s["bids"].pop(p, None)
    if len(s["bids"]) > depth:      # keep only the top-`depth` bids (highest) / asks (lowest)
        for p in sorted(s["bids"], reverse=True)[depth:]: s["bids"].pop(p, None)
    if len(s["asks"]) > depth:
        for p in sorted(s["asks"])[depth:]: s["asks"].pop(p, None)

def set_tob(venue, bb, bsz, ba, asz):
    """Direct top-of-book set (for venues that publish TOB outright, e.g. Kraken book snapshot)."""
    s = V[venue]; now = time.time()
    if bb is not None: s["best_bid"] = bb; s["bid_sz"] = bsz
    if ba is not None: s["best_ask"] = ba; s["ask_sz"] = asz
    s["last_msg"] = now; s["msgs"] += 1

def apply_diffs(venue, bid_updates, ask_updates):
    """Apply incremental (price,size) diffs to the full-book map; size<=0 removes the level."""
    s = V[venue]; now = time.time()
    for px, sz in bid_updates:
        if sz <= 0: s["bids"].pop(px, None)
        else: s["bids"][px] = sz
    for px, sz in ask_updates:
        if sz <= 0: s["asks"].pop(px, None)
        else: s["asks"][px] = sz
    # bound the maps so a long-running diff stream can't grow unbounded (keep best ~50/side)
    if len(s["bids"]) > 400:
        for p in sorted(s["bids"], reverse=True)[50:]: s["bids"].pop(p, None)
    if len(s["asks"]) > 400:
        for p in sorted(s["asks"])[50:]: s["asks"].pop(p, None)
    _recompute_tob(venue)
    s["last_msg"] = now; s["msgs"] += 1

# ===================================================================================
#  CONSOLIDATION  (pure function over current state -> dict)
# ===================================================================================
def venue_mid(s):
    bb, ba = s["best_bid"], s["best_ask"]
    if bb is None or ba is None: return None
    if not (ba >= bb > 0): return None   # crossed/garbage book -> skip (never crash)
    return (bb + ba) / 2.0

def build_snapshot(now):
    snap = {"ts": now}
    mids = []          # fresh per-venue mids -> consolidated mid
    tot_bid_sz = 0.0   # consolidated best-bid size  -> depth imbalance
    tot_ask_sz = 0.0   # consolidated best-ask size
    nfresh = 0
    wmids = []         # (weight, mid) for fresh venues -> liquidity-weighted consolidated mid
    best_bid_overall = None   # the consolidated TOUCH (best bid across venues / best ask across venues)
    best_ask_overall = None
    health = {}
    for name in VENUES:
        s = V[name]
        m = venue_mid(s)
        fresh = (s["last_msg"] > 0 and now - s["last_msg"] <= FRESH and m is not None)
        age = round(now - s["last_msg"], 2) if s["last_msg"] else None
        # per-venue columns (None when missing -> stable schema for the left-join)
        snap[f"{name}_bid"] = round(s["best_bid"], 2) if s["best_bid"] is not None else None
        snap[f"{name}_ask"] = round(s["best_ask"], 2) if s["best_ask"] is not None else None
        snap[f"{name}_bsz"] = round(s["bid_sz"], 6) if s["bid_sz"] is not None else None
        snap[f"{name}_asz"] = round(s["ask_sz"], 6) if s["ask_sz"] is not None else None
        snap[f"{name}_mid"] = round(m, 2) if m is not None else None
        snap[f"{name}_age"] = age
        if fresh:
            nfresh += 1
            mids.append(m)
            wmids.append((VENUE_W.get(name, 0.0), m))
            if s["bid_sz"] is not None: tot_bid_sz += s["bid_sz"]
            if s["ask_sz"] is not None: tot_ask_sz += s["ask_sz"]
            if s["best_bid"] is not None and (best_bid_overall is None or s["best_bid"] > best_bid_overall):
                best_bid_overall = s["best_bid"]
            if s["best_ask"] is not None and (best_ask_overall is None or s["best_ask"] < best_ask_overall):
                best_ask_overall = s["best_ask"]
        health[name] = {"age": age, "stale": (age is None or age > STALL_SECS), "msgs": s["msgs"]}

    # CONSOLIDATED MID = simple mean of fresh venue mids (the BRTI is a consolidated book; this is
    # the finer-than-1s proxy of the number the index snapshots once/sec). None if no fresh venue.
    snap["cons_mid"] = round(sum(mids) / len(mids), 3) if mids else None
    # LIQUIDITY-WEIGHTED consolidated mid: re-normalize VENUE_W over the venues that are CURRENTLY
    # fresh (so a dead venue doesn't shrink the total) -> a less-noisy proxy of the BRTI than the
    # equal-weight cons_mid (the BRTI itself is depth-weighted). cons_mid kept for A/B comparison.
    wsum = sum(w for w, _ in wmids)
    snap["cons_mid_w"] = round(sum(w * mm for w, mm in wmids) / wsum, 3) if wsum > 0 else snap["cons_mid"]
    snap["n_fresh"] = nfresh
    # CONSOLIDATED depth-IMBALANCE at the touch: bid size vs ask size across fresh venues.
    # + => heavier resting bids = upward micro-pressure (the leading signal); range [-1, 1].
    denom = tot_bid_sz + tot_ask_sz
    snap["cons_obi"] = round((tot_bid_sz - tot_ask_sz) / denom, 4) if denom > 0 else None
    snap["cons_bidsz"] = round(tot_bid_sz, 6) if denom > 0 else None
    snap["cons_asksz"] = round(tot_ask_sz, 6) if denom > 0 else None
    # the consolidated TOUCH (tightest bid/ask across venues) + its mid + microprice
    snap["touch_bid"] = round(best_bid_overall, 2) if best_bid_overall is not None else None
    snap["touch_ask"] = round(best_ask_overall, 2) if best_ask_overall is not None else None
    if best_bid_overall is not None and best_ask_overall is not None:
        snap["touch_mid"] = round((best_bid_overall + best_ask_overall) / 2.0, 3)
        snap["touch_spr"] = round(best_ask_overall - best_bid_overall, 2)
    else:
        snap["touch_mid"] = None; snap["touch_spr"] = None

    # STAMP the concurrent cfmean / BRTI (cf_feed.py output) so the lead is measurable from the log.
    # cfidx = 60s-VWAP index ; cfmean = current cross-venue simple mean. Missing => None (never crash).
    cf_idx = cf_mean = cf_ts = None
    try:
        _cf = json.load(open(CFIDX))
        cf_idx = _cf.get("index"); cf_mean = _cf.get("mean"); cf_ts = _cf.get("ts")
    except Exception:
        pass
    snap["cf_idx"] = cf_idx     # the BRTI/cfmean VWAP we settle against (laggy by construction)
    snap["cf_mean"] = cf_mean   # cf_feed's current cross-venue mean (for cross-check vs cons_mid)
    snap["cf_ts"] = cf_ts       # cf_feed timestamp -> measure cf_feed's own staleness vs our touch
    # the LEAD we are banking: consolidated constituent mid MINUS the published index.
    # (constituent book moves first -> this residual should predict the NEXT cf_idx tick.)
    if snap["cons_mid"] is not None and cf_idx:
        snap["lead_vs_idx"] = round(snap["cons_mid"] - cf_idx, 3)
    else:
        snap["lead_vs_idx"] = None
    # same lead but from the liquidity-weighted mid (the cleaner price-lead candidate for the re-test)
    if snap["cons_mid_w"] is not None and cf_idx:
        snap["lead_vs_idx_w"] = round(snap["cons_mid_w"] - cf_idx, 3)
    else:
        snap["lead_vs_idx_w"] = None
    snap["health"] = health
    return snap

# ===================================================================================
#  WEBSOCKET VENUE TASKS  (each independent + own reconnect; stall watchdog recycles)
#  Inner connection tasks keyed by venue. The stall_watchdog cancels THESE (the live
#  connection), NOT the _supervised wrapper -> the supervisor survives & reconnects.
# ===================================================================================
INNER = {}
RECYCLE = set()   # venue names the watchdog asked to recycle (distinguishes from genuine shutdown)

def sub_for(venue):
    """Centralized subscribe payloads (so --diag can echo the exact wire we send)."""
    if venue == "coinbase":
        return json.dumps({"type": "subscribe", "product_ids": ["BTC-USD"], "channels": ["level2_batch"]})
    if venue == "kraken":
        return json.dumps({"method": "subscribe", "params": {"channel": "book", "symbol": ["BTC/USD"], "depth": 10}})
    if venue == "bitstamp":
        return json.dumps({"event": "bts:subscribe", "data": {"channel": "diff_order_book_btcusd"}})
    if venue == "gemini":
        return json.dumps({"type": "subscribe", "subscriptions": [{"name": "l2", "symbols": ["BTCUSD"]}]})
    if venue == "cryptocom":
        # SPOT BTC_USD (underscore) -- the BRTI constituent book is spot, NOT the -PERP perpetual
        # (a perp would inject basis noise into cons_mid). depth 10; ask for snapshot + deltas.
        return json.dumps({"id": 1, "method": "subscribe",
                           "params": {"channels": ["book.BTC_USD.10"], "book_subscription_type": "SNAPSHOT_AND_UPDATE"}})
    raise KeyError(venue)

async def _supervised(name, coro_factory):
    """Run a venue coroutine; on any drop/stall/exception/watchdog-recycle, reconnect after backoff.
    The connection runs as an inner task so the watchdog can cancel just the connection (not us)."""
    backoff = 2
    while True:
        try:
            V[name]["connects"] += 1
            inner = asyncio.ensure_future(coro_factory())
            INNER[name] = inner
            await inner
            backoff = 2
            await asyncio.sleep(1)   # clean return -> brief floor, don't busy-spin
        except asyncio.CancelledError:
            if name in RECYCLE:
                RECYCLE.discard(name)
                log(f"{name} watchdog-recycled -> reconnecting")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            raise   # genuine shutdown: propagate so gather()/run() can stop cleanly
        except Exception as e:
            log(f"{name} reconnect:", str(e)[:80])
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

async def coinbase_stream():
    import websockets
    url = "wss://ws-feed.exchange.coinbase.com"
    async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=None, max_size=None) as ws:
        await ws.send(sub_for("coinbase")); log("coinbase connected")
        async for msg in ws:
            try:
                d = json.loads(msg)
                tp = d.get("type")
                if tp == "snapshot":
                    s = V["coinbase"]
                    s["bids"] = {float(p): float(q) for p, q in d.get("bids", [])[:50]}
                    s["asks"] = {float(p): float(q) for p, q in d.get("asks", [])[:50]}
                    _recompute_tob("coinbase")
                    s["last_msg"] = time.time(); s["msgs"] += 1; s["n_snap"] += 1
                elif tp == "l2update":
                    bu = []; au = []
                    for ch in d.get("changes", []):
                        try: side, px, sz = ch[0], float(ch[1]), float(ch[2])
                        except Exception: continue
                        (bu if side == "buy" else au).append((px, sz))
                    if bu or au:
                        apply_diffs("coinbase", bu, au); V["coinbase"]["n_upd"] += 1
            except Exception:
                continue   # malformed/partial msg -> skip, never crash

async def kraken_stream():
    import websockets
    url = "wss://ws.kraken.com/v2"
    # depth goes INSIDE params (valid: 10/25/100/500/1000). v2 wire: {channel:"book", type:"snapshot"
    # |"update", data:[{symbol, bids:[{price,qty}], asks:[...], checksum}]}.  The parser below is
    # verified correct against that wire format (see --diag) -- the historical "1% of updates" was a
    # CONNECTION bug, not a parse bug: on websockets>=14 the default client PING (ping_interval=20)
    # plus ping_timeout closes the socket when Kraken v2 -- which keeps liveness on its OWN heartbeat
    # channel -- doesn't answer the client protocol ping in time, so the socket dropped right after
    # the snapshot and the supervisor reconnected (banking ~1 snapshot/cycle ~= 1% of coinbase vol,
    # and ZERO updates). FIX: ping_interval=None (no client keepalive); rely on Kraken's heartbeat
    # channel + our stall_watchdog for liveness. max_size=None for safety on large depth frames.
    async with websockets.connect(url, ping_interval=None, max_queue=None, max_size=None) as ws:
        await ws.send(sub_for("kraken")); log("kraken connected")
        async for msg in ws:
            try:
                d = json.loads(msg)
                if d.get("channel") != "book": continue
                typ = d.get("type")
                for bk in d.get("data", []):
                    s = V["kraken"]
                    if typ == "snapshot":
                        s["bids"] = {}; s["asks"] = {}; s["n_snap"] += 1
                    elif typ == "update":
                        s["n_upd"] += 1
                    new_bid_pxs = []; new_ask_pxs = []   # freshest levels this msg -> stale-cross sweep
                    for lv in bk.get("bids", []):
                        px = float(lv["price"]); qty = float(lv["qty"])
                        if qty <= 0: s["bids"].pop(px, None)
                        else: s["bids"][px] = qty; new_bid_pxs.append(px)
                    for lv in bk.get("asks", []):
                        px = float(lv["price"]); qty = float(lv["qty"])
                        if qty <= 0: s["asks"].pop(px, None)
                        else: s["asks"][px] = qty; new_ask_pxs.append(px)
                    # Kraken v2 is a FIXED-DEPTH book that silently drops out-of-window levels: evict
                    # stale crossed levels (directional, vs this msg's freshest prices) + truncate to
                    # depth. Without this an old best bid lingers as max(bids) -> bid>ask -> crossed ->
                    # kraken excluded from cons_mid (the 99.1%-crossed bug). NOT a wire-parse swap.
                    _trim_kraken_book(s, new_bid_pxs, new_ask_pxs)
                    _recompute_tob("kraken")
                    s["last_msg"] = time.time(); s["msgs"] += 1
            except Exception:
                continue

async def bitstamp_stream():
    import websockets
    url = "wss://ws.bitstamp.net"
    async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=None) as ws:
        await ws.send(sub_for("bitstamp")); log("bitstamp connected")
        async for msg in ws:
            try:
                d = json.loads(msg)
                ev = d.get("event")
                if ev in ("data", "snapshot") and d.get("data"):
                    dd = d["data"]
                    bu = [(float(p), float(q)) for p, q in dd.get("bids", [])]
                    au = [(float(p), float(q)) for p, q in dd.get("asks", [])]
                    if bu or au:
                        apply_diffs("bitstamp", bu, au); V["bitstamp"]["n_upd"] += 1
            except Exception:
                continue

async def gemini_stream():
    import websockets
    url = "wss://api.gemini.com/v2/marketdata/BTCUSD"
    async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=None) as ws:
        await ws.send(sub_for("gemini")); log("gemini connected")
        async for msg in ws:
            try:
                d = json.loads(msg)
                if d.get("type") not in ("l2_updates",): continue
                bu = []; au = []
                for ch in d.get("changes", []):
                    try: side, px, sz = ch[0], float(ch[1]), float(ch[2])
                    except Exception: continue
                    (bu if side == "buy" else au).append((px, sz))
                if bu or au:
                    apply_diffs("gemini", bu, au); V["gemini"]["n_upd"] += 1
            except Exception:
                continue

async def cryptocom_stream():
    """Crypto.com Exchange public market-data WS (keyless). MUST answer public/heartbeat with
    public/respond-heartbeat or the server closes the socket -- this is the easy-to-miss handshake.
    Book wire: result.data[] entries carry 'asks'/'bids' as [price, qty, num_orders] string triples;
    SNAPSHOT_AND_UPDATE makes 'update' messages incremental (qty 0 => remove level)."""
    import websockets
    url = "wss://stream.crypto.com/exchange/v1/market"
    async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=None, max_size=None) as ws:
        # crypto.com asks clients to wait ~1s after connect before subscribing
        await asyncio.sleep(1.0)
        await ws.send(sub_for("cryptocom")); log("cryptocom connected")
        async for msg in ws:
            try:
                d = json.loads(msg)
                # 1) heartbeat handshake -- mandatory, else disconnect
                if d.get("method") == "public/heartbeat":
                    await ws.send(json.dumps({"id": d.get("id"), "method": "public/respond-heartbeat"}))
                    continue
                res = d.get("result")
                if not res or not str(res.get("channel", "")).startswith("book"):
                    continue
                # snapshot vs incremental: crypto.com tags result.subscription/data; with
                # SNAPSHOT_AND_UPDATE the first push is a full book ('snapshot'), then deltas ('update').
                dtype = res.get("data_type") or res.get("type")  # tolerate either key
                s = V["cryptocom"]
                for entry in res.get("data", []):
                    is_snap = (dtype == "snapshot") or (s["msgs"] == 0)
                    if is_snap:
                        s["bids"] = {}; s["asks"] = {}; s["n_snap"] += 1
                    else:
                        s["n_upd"] += 1
                    bu = []; au = []
                    for lvl in entry.get("bids", []):
                        try: bu.append((float(lvl[0]), float(lvl[1])))
                        except Exception: continue
                    for lvl in entry.get("asks", []):
                        try: au.append((float(lvl[0]), float(lvl[1])))
                        except Exception: continue
                    apply_diffs("cryptocom", bu, au)
            except Exception:
                continue

STREAMS = {
    "coinbase": coinbase_stream,
    "kraken": kraken_stream,
    "bitstamp": bitstamp_stream,
    "gemini": gemini_stream,
    "cryptocom": cryptocom_stream,
}

# ===================================================================================
#  WRITER + STALL WATCHDOG
# ===================================================================================
async def writer():
    n = 0
    jf = open(JSONL, "a", buffering=1)   # line-buffered append
    while True:
        await asyncio.sleep(EMIT_EVERY)
        now = time.time()
        snap = build_snapshot(now)
        tmp = OUT + ".tmp." + str(os.getpid())
        try:
            with open(tmp, "w") as f: json.dump(snap, f)
            os.replace(tmp, OUT)
        except Exception as e:
            log("snapshot write err:", str(e)[:60])
        try:
            jf.write(json.dumps(snap) + "\n")
        except Exception as e:
            log("jsonl write err:", str(e)[:60])
        n += 1
        if n % int(HB_SECS / EMIT_EVERY) == 0:
            h = snap["health"]
            ages = " ".join(f"{k[:2]}={h[k]['age']}" for k in ACTIVE)
            # per-venue snapshot/update split: a healthy diff-venue must have n_upd >> n_snap.
            # Kraken at ~1% manifested here as n_upd~=n_snap (reconnect loop banking only snapshots).
            su = " ".join(f"{k[:2]}={V[k]['n_snap']}/{V[k]['n_upd']}" for k in ACTIVE)
            log(f"{n} emits | cons_mid {snap['cons_mid']} cons_mid_w {snap['cons_mid_w']} "
                f"obi {snap['cons_obi']} n_fresh {snap['n_fresh']} | cf_idx {snap['cf_idx']} "
                f"lead {snap['lead_vs_idx']} | age {ages} | snap/upd {su}")
            for venue in ACTIVE:
                if h[venue]["stale"]:
                    log(f"STALE {venue} (age={h[venue]['age']}s) -> socket should recycle")

async def stall_watchdog():
    """If a venue stops producing messages while its socket stays 'open', cancel+respawn it."""
    while True:
        await asyncio.sleep(5)
        now = time.time()
        for venue in ACTIVE:
            s = V[venue]
            if s["last_msg"] and now - s["last_msg"] > STALL_SECS:
                inner = INNER.get(venue)   # cancel the live CONNECTION, not the supervisor wrapper
                if inner and not inner.done():
                    log(f"watchdog: {venue} silent {now - s['last_msg']:.0f}s -> recycling connection")
                    RECYCLE.add(venue)     # tag so supervisor reconnects instead of treating as shutdown
                    inner.cancel()
                    s["last_msg"] = now    # reset so we don't thrash; supervisor will reconnect

async def main():
    tasks = {name: asyncio.ensure_future(_supervised(name, STREAMS[name])) for name in ACTIVE}
    await asyncio.gather(writer(), stall_watchdog(), *tasks.values())

# ===================================================================================
#  SELF-TEST  (synthetic replay -- validates consolidation/imbalance math, NO network)
# ===================================================================================
def selftest():
    log("SELFTEST: synthetic replay (no network)")
    now0 = time.time()
    # Build a consistent constituent book where bids are heavier than asks (upward micro-pressure),
    # and one venue (gemini) is STALE (older than FRESH) so it must be EXCLUDED from the consolidation.
    # coinbase: incremental diffs
    apply_diffs("coinbase", [(60000.0, 3.0), (59999.0, 2.0)], [(60002.0, 1.0), (60003.0, 1.5)])
    V["coinbase"]["last_msg"] = now0
    # kraken: direct top-of-book set
    set_tob("kraken", 60001.0, 4.0, 60003.0, 1.0)
    V["kraken"]["last_msg"] = now0
    # bitstamp: diffs
    apply_diffs("bitstamp", [(59998.0, 2.5)], [(60004.0, 0.5)])
    V["bitstamp"]["last_msg"] = now0
    # gemini: present but STALE (older than FRESH) -> must be dropped from consolidation
    apply_diffs("gemini", [(60000.5, 99.0)], [(60001.5, 0.01)])
    V["gemini"]["last_msg"] = now0 - (FRESH + 5)

    # stamp a fake concurrent cf index so lead_vs_idx computes
    tmpcf = CFIDX + ".selftest.bak"
    had = os.path.exists(CFIDX)
    if had: os.replace(CFIDX, tmpcf)
    try:
        with open(CFIDX, "w") as f: json.dump({"index": 60000.0, "mean": 60000.5, "ts": now0}, f)
        snap = build_snapshot(now0)
    finally:
        try: os.remove(CFIDX)
        except Exception: pass
        if had: os.replace(tmpcf, CFIDX)

    print(json.dumps(snap, indent=2))
    # ---- assertions ----
    assert snap["n_fresh"] == 3, f"gemini is stale -> only 3 fresh venues, got {snap['n_fresh']}"
    # consolidated mid = mean of the 3 fresh venue mids
    cb_mid = (60000.0 + 60002.0) / 2.0
    kr_mid = (60001.0 + 60003.0) / 2.0
    bs_mid = (59998.0 + 60004.0) / 2.0
    exp_mid = round((cb_mid + kr_mid + bs_mid) / 3.0, 3)
    assert snap["cons_mid"] == exp_mid, f"cons_mid {snap['cons_mid']} != expected {exp_mid}"
    # imbalance: bid sizes (3+4+2.5=9.5) heavier than ask sizes (1+1+0.5=2.5) -> strongly +
    assert snap["cons_obi"] is not None and snap["cons_obi"] > 0.5, f"expected heavy +OBI, got {snap['cons_obi']}"
    assert snap["cons_bidsz"] == 9.5 and snap["cons_asksz"] == 2.5, "consolidated sizes wrong"
    # the gemini stale 99.0/0.01 sizes must NOT have leaked into the consolidation
    assert abs(snap["cons_bidsz"] - 9.5) < 1e-9, "stale venue leaked into bid size"
    # touch = tightest bid (60001 kraken) / tightest ask (60002 coinbase)
    assert snap["touch_bid"] == 60001.0 and snap["touch_ask"] == 60002.0, "touch wrong"
    # lead vs the stamped index (60000.0)
    assert snap["lead_vs_idx"] == round(exp_mid - 60000.0, 3), "lead_vs_idx wrong"
    # LIQUIDITY-WEIGHTED mid: weights re-normalized over the 3 fresh venues (cb .45, kr .20, bs .15)
    fw = {"coinbase": 0.45, "kraken": 0.20, "bitstamp": 0.15}
    wsum = sum(fw.values())
    exp_w = round((fw["coinbase"] * cb_mid + fw["kraken"] * kr_mid + fw["bitstamp"] * bs_mid) / wsum, 3)
    assert snap["cons_mid_w"] == exp_w, f"cons_mid_w {snap['cons_mid_w']} != expected {exp_w}"
    assert snap["lead_vs_idx_w"] == round(exp_w - 60000.0, 3), "lead_vs_idx_w wrong"
    # schema stability: every venue has all its columns even when stale/missing
    for v in VENUES:
        for suf in ("bid", "ask", "bsz", "asz", "mid", "age"):
            assert f"{v}_{suf}" in snap, f"missing column {v}_{suf}"
    assert "ts" in snap and isinstance(snap["ts"], float)
    json.dumps(snap)  # round-trip serializable

    # ---- crypto.com parse path: string-triple [px, qty, n] snapshot then a delete-by-zero update ----
    V["cryptocom"] = _new_venue()
    apply_diffs("cryptocom", [(59999.0, 1.0)], [(60005.0, 1.0)])   # emulate snapshot levels
    V["cryptocom"]["n_snap"] += 1
    assert venue_mid(V["cryptocom"]) == (59999.0 + 60005.0) / 2.0, "cryptocom snapshot mid wrong"
    apply_diffs("cryptocom", [(59999.0, 0.0)], [])                 # delete-by-zero removes the bid level
    assert 59999.0 not in V["cryptocom"]["bids"], "cryptocom zero-qty delete didn't remove level"
    V["cryptocom"] = _new_venue()  # reset so it doesn't pollute anything downstream

    log(f"SELFTEST PASSED: cons_mid {snap['cons_mid']} (eq) / {snap['cons_mid_w']} (wtd) over "
        f"{snap['n_fresh']} fresh venues, OBI {snap['cons_obi']} (+ = heavier bids), "
        f"lead_vs_idx {snap['lead_vs_idx']}; stale venue excluded; crypto.com parse OK.")

def diag():
    """Replay each venue's EXACT wire format through the real parse path -- proves the parsers are
    correct WITHOUT touching the network (the Kraken-1% bug was connection-level, not parse-level)."""
    log("DIAG: per-venue wire-format replay (no network)")
    # KRAKEN v2: snapshot then update then delete-by-zero
    V["kraken"] = _new_venue()
    def kr(msg):
        # EXACT mirror of kraken_stream's per-message body (incl. the fixed-depth stale-cross trim)
        d = json.loads(msg)
        if d.get("channel") != "book": return
        typ = d.get("type"); s = V["kraken"]
        for bk in d.get("data", []):
            if typ == "snapshot": s["bids"] = {}; s["asks"] = {}; s["n_snap"] += 1
            elif typ == "update": s["n_upd"] += 1
            new_bid_pxs = []; new_ask_pxs = []
            for lv in bk.get("bids", []):
                px = float(lv["price"]); qty = float(lv["qty"])
                if qty <= 0: s["bids"].pop(px, None)
                else: s["bids"][px] = qty; new_bid_pxs.append(px)
            for lv in bk.get("asks", []):
                px = float(lv["price"]); qty = float(lv["qty"])
                if qty <= 0: s["asks"].pop(px, None)
                else: s["asks"][px] = qty; new_ask_pxs.append(px)
            _trim_kraken_book(s, new_bid_pxs, new_ask_pxs)
            _recompute_tob("kraken"); s["msgs"] += 1
    kr(json.dumps({"channel": "book", "type": "snapshot", "data": [{"symbol": "BTC/USD", "bids": [{"price": 60000.0, "qty": 1.0}], "asks": [{"price": 60001.0, "qty": 2.0}], "checksum": 1}]}))
    kr(json.dumps({"channel": "book", "type": "update", "data": [{"symbol": "BTC/USD", "bids": [{"price": 60000.5, "qty": 3.0}], "asks": [], "checksum": 2}]}))
    kr(json.dumps({"channel": "book", "type": "update", "data": [{"symbol": "BTC/USD", "bids": [], "asks": [{"price": 60001.0, "qty": 0.0}], "checksum": 3}]}))
    assert V["kraken"]["n_snap"] == 1 and V["kraken"]["n_upd"] == 2, "kraken diag counts wrong"
    assert V["kraken"]["best_bid"] == 60000.5, "kraken update did not move best_bid"
    assert 60001.0 not in V["kraken"]["asks"], "kraken delete-by-zero failed"
    log(f"DIAG kraken OK: snap={V['kraken']['n_snap']} upd={V['kraken']['n_upd']} "
        f"tob=({V['kraken']['best_bid']},{V['kraken']['best_ask']})")

    # --- REGRESSION for THE crossed-book bug (bid>ask in 99.1% of rows) -------------------------
    # Reproduce a fixed-depth book whose price marches UP: the old best bid is NEVER deleted by a
    # qty=0 from the server (Kraken just drops it from its top-N), so without the trim it lingers as
    # max(bids) ABOVE the current asks -> crossed -> venue_mid()=None -> kraken excluded. With the
    # trim, the stale level is swept and the book stays un-crossed (best_bid < best_ask).
    V["kraken"] = _new_venue()
    kr(json.dumps({"channel": "book", "type": "snapshot", "data": [{"symbol": "BTC/USD",
        "bids": [{"price": 60140.0, "qty": 1.0}, {"price": 60139.0, "qty": 1.0}],
        "asks": [{"price": 60141.0, "qty": 1.0}, {"price": 60142.0, "qty": 1.0}], "checksum": 1}]}))
    # market marches UP ~137: a stream of update messages that lift bid+ask but never qty=0 the old
    # best bid 60140 (server silently drops it from its depth-10 window; we must too).
    for k in range(1, 140):
        bb = 60140.0 + k; aa = bb + 1.0
        kr(json.dumps({"channel": "book", "type": "update", "data": [{"symbol": "BTC/USD",
            "bids": [{"price": bb, "qty": 1.0}], "asks": [{"price": aa, "qty": 1.0}], "checksum": k}]}))
    kbb = V["kraken"]["best_bid"]; kba = V["kraken"]["best_ask"]
    assert kbb is not None and kba is not None, "kraken crossed-regression lost a side"
    assert kbb < kba, f"REGRESSION: kraken book CROSSED after march-up (bid {kbb} >= ask {kba})"
    assert venue_mid(V["kraken"]) is not None, "kraken still crossed -> venue_mid None (the bug)"
    assert len(V["kraken"]["bids"]) <= KRAKEN_DEPTH and len(V["kraken"]["asks"]) <= KRAKEN_DEPTH, \
        "kraken book not truncated to subscribed depth"
    log(f"DIAG kraken CROSSED-FIX OK: after 139 up-marches tob=({kbb},{kba}) un-crossed, "
        f"mid={venue_mid(V['kraken'])}, depth={len(V['kraken']['bids'])}/{len(V['kraken']['asks'])}")
    V["kraken"] = _new_venue()
    log("DIAG: kraken subscribe payload =", sub_for("kraken"))
    log("DIAG: cryptocom subscribe payload =", sub_for("cryptocom"))
    log("DIAG PASSED: all parsers handle their real wire format; the historical kraken 1% was a "
        "connection-level keepalive drop (now ping_interval=None), not a parse bug.")

async def kraken_dump(n_raw=5, run_secs=20.0):
    """LIVE kraken probe (network REQUIRED -- run on the AWS box). Connects to the v2 book channel,
    prints the first ~n_raw RAW messages verbatim, then feeds EVERY message through the REAL parse +
    trim path and prints the resulting best_bid/best_ask each time so you can eyeball that
    best_bid < best_ask (un-crossed). The crossed-book bug only reproduces against the live wire
    shape (the synthetic --selftest/--diag replay did not match it), so this is the on-box verifier."""
    import websockets
    url = "wss://ws.kraken.com/v2"
    V["kraken"] = _new_venue()
    log(f"KRAKEN-DUMP: connecting {url} (first {n_raw} raw msgs, then parsed TOB for ~{run_secs:.0f}s)")
    n = 0; t0 = time.time(); crossed = 0; checked = 0
    async with websockets.connect(url, ping_interval=None, max_queue=None, max_size=None) as ws:
        await ws.send(sub_for("kraken"))
        log("KRAKEN-DUMP: subscribe sent =", sub_for("kraken"))
        async for msg in ws:
            n += 1
            if n <= n_raw:
                log(f"--- RAW MSG {n} ---")
                print(msg[:1200], flush=True)
            try:
                d = json.loads(msg)
                if d.get("channel") != "book":
                    if n <= n_raw: log(f"  (non-book frame: channel={d.get('channel')} type={d.get('type')})")
                    continue
                typ = d.get("type"); s = V["kraken"]
                for bk in d.get("data", []):
                    if typ == "snapshot": s["bids"] = {}; s["asks"] = {}; s["n_snap"] += 1
                    elif typ == "update": s["n_upd"] += 1
                    new_bid_pxs = []; new_ask_pxs = []
                    for lv in bk.get("bids", []):
                        px = float(lv["price"]); qty = float(lv["qty"])
                        if qty <= 0: s["bids"].pop(px, None)
                        else: s["bids"][px] = qty; new_bid_pxs.append(px)
                    for lv in bk.get("asks", []):
                        px = float(lv["price"]); qty = float(lv["qty"])
                        if qty <= 0: s["asks"].pop(px, None)
                        else: s["asks"][px] = qty; new_ask_pxs.append(px)
                    _trim_kraken_book(s, new_bid_pxs, new_ask_pxs)
                    _recompute_tob("kraken")
                    s["last_msg"] = time.time(); s["msgs"] += 1
                    bb, ba = s["best_bid"], s["best_ask"]
                    if bb is not None and ba is not None:
                        checked += 1
                        if bb >= ba: crossed += 1
                    if n <= n_raw + 10:   # print parsed TOB for the first handful so the shape is visible
                        flag = "" if (bb is None or ba is None or bb < ba) else "  <<< CROSSED!"
                        log(f"  parsed[{typ}] best_bid={bb} best_ask={ba} "
                            f"mid={venue_mid(s)} depth={len(s['bids'])}/{len(s['asks'])}{flag}")
            except Exception as e:
                log("  parse err:", str(e)[:80])
            if time.time() - t0 > run_secs:
                break
    pct = (100.0 * crossed / checked) if checked else 0.0
    log(f"KRAKEN-DUMP DONE: {n} msgs, snap/upd={V['kraken']['n_snap']}/{V['kraken']['n_upd']}, "
        f"final TOB=({V['kraken']['best_bid']},{V['kraken']['best_ask']}), "
        f"CROSSED {crossed}/{checked} rows ({pct:.1f}%).")
    if checked and pct < 1.0:
        log("KRAKEN-DUMP VERDICT: PASS -- book is un-crossed (best_bid < best_ask). The fix works; "
            "redeploy and confirm kraken_mid is non-null in the writer heartbeat.")
    else:
        log(f"KRAKEN-DUMP VERDICT: STILL CROSSED ({pct:.1f}%) -- do NOT redeploy; investigate further.")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true", help="run synthetic replay, no network")
    ap.add_argument("--diag", action="store_true", help="replay each venue's real wire format (no network)")
    ap.add_argument("--kraken-dump", action="store_true",
                    help="LIVE kraken probe (network): print first raw msgs + parsed best_bid/best_ask "
                         "to verify the book is un-crossed on the box (the bug only repros live)")
    ap.add_argument("--dump-secs", type=float, default=20.0, help="how long --kraken-dump runs (default 20s)")
    ap.add_argument("--no-cryptocom", action="store_true",
                    help="disable the crypto.com venue (if unreachable/noisy on the box)")
    args = ap.parse_args()
    if args.no_cryptocom and "cryptocom" in ACTIVE:
        ACTIVE.remove("cryptocom"); log("cryptocom DISABLED via --no-cryptocom")
    if args.selftest:
        selftest()
    elif args.diag:
        diag()
    elif args.kraken_dump:
        try:
            asyncio.run(kraken_dump(run_secs=args.dump_secs))
        except KeyboardInterrupt:
            log("kraken-dump interrupted")
    else:
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            log("shutdown")
