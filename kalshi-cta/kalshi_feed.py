"""Real-time Kalshi market-data feed via authenticated WebSocket.
Subscribes to the current KXBTC15M market's TICKER + ORDERBOOK channels and writes:
  - kalshi_live.json : live quote (yes/no bid+ask in dollars) + top-of-book SIZES (depth available to fill)
  - orderbook_log.jsonl : throttled time-series of the top book levels (to audit whether paper fills were real)
Re-subscribes when the 15-min window rolls. Auto-reconnects. Orchestrator reads kalshi_live.json instantly."""
import asyncio, json, time, os, sys, base64, urllib.request, datetime as dt
import websockets
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "kalshi_live.json")
OBLOG = os.path.join(HERE, "orderbook_log.jsonl")
WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2"
WS_PATH = "/trade-api/ws/v2"

def load_creds():
    d = {}
    for line in open(os.path.join(HERE, "..", "kalshi-poly-arb", "creds.env")):
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1); d[k.strip()] = v.strip()
    return d
_c = load_creds()
API_KEY = _c["KALSHI_API_KEY"]
KEY = serialization.load_pem_private_key(open(_c["KALSHI_PRIVATE_KEY_PATH"], "rb").read(), password=None)
def log(*a): print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)

def auth_headers():
    ts = str(int(time.time() * 1000))
    msg = (ts + "GET" + WS_PATH).encode()
    sig = KEY.sign(msg, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH), hashes.SHA256())
    return {"KALSHI-ACCESS-KEY": API_KEY, "KALSHI-ACCESS-SIGNATURE": base64.b64encode(sig).decode(), "KALSHI-ACCESS-TIMESTAMP": ts}

def current_ticker():
    try:
        url = "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=20"
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "kpa"}), timeout=10))
        now = dt.datetime.now(dt.timezone.utc)
        for m in d.get("markets", []):
            ot = dt.datetime.fromisoformat(m["open_time"].replace("Z", "+00:00"))
            ct = dt.datetime.fromisoformat(m["close_time"].replace("Z", "+00:00"))
            if ot <= now < ct: return m["ticker"]
    except Exception as e: log("ticker lookup err", str(e)[:60])
    return None

# live book: price(cents)->size, per side, for the current ticker
BOOK = {"yes": {}, "no": {}}
LIVE = {}                 # last-written snapshot (quote + sizes)
_last_oblog = [0.0]

def best(side):           # highest-priced resting bid level -> (price_cents, size)
    d = BOOK[side]
    if not d: return (None, 0)
    p = max(d); return (p, d[p])

def write_live(tk):
    yb, ybs = best("yes")     # best YES bid: sell-YES / buy-NO liquidity
    nb, nbs = best("no")      # best NO  bid: sell-NO  / buy-YES liquidity
    if yb is None or nb is None: return
    _y3 = round(sum(s for _p, s in sorted(BOOK["yes"].items(), key=lambda x: -x[0])[:3]), 2)   # top-3 YES bid depth
    _n3 = round(sum(s for _p, s in sorted(BOOK["no"].items(), key=lambda x: -x[0])[:3]), 2)    # top-3 NO bid depth
    LIVE.update({"ticker": tk,
                 "yes_bid": round(yb, 4), "yes_ask": round(1 - nb, 4),
                 "no_bid": round(nb, 4), "no_ask": round(1 - yb, 4),
                 # fill depth (contracts available at the touch) per action:
                 "buy_yes_size": round(nbs, 2), "sell_yes_size": round(ybs, 2),
                 "buy_no_size": round(ybs, 2), "sell_no_size": round(nbs, 2),
                 "ybz3": _y3, "nbz3": _n3,   # top-3-level depth sums -> multi-level imbalance / OFI for the Kalshi-price predictor
                 "ts": time.time()})
    _tmp = OUT + ".tmp." + str(os.getpid())   # ATOMIC write -> readers (predictor/orchestrator) never catch a half-written file
    with open(_tmp, "w") as f: json.dump(LIVE, f)
    os.replace(_tmp, OUT)
    if time.time() - _last_oblog[0] >= 1.0:    # throttle the depth audit-log to ~1/sec
        top = lambda s: sorted(BOOK[s].items(), key=lambda x: -x[0])[:5]
        with open(OBLOG, "a") as f:
            f.write(json.dumps({"ts": round(time.time(), 2), "ticker": tk,
                                "yes": top("yes"), "no": top("no")}) + "\n")
        _last_oblog[0] = time.time()

async def run():
    dbg = [0]
    while True:
        try:
            async with websockets.connect(WS_URL, additional_headers=auth_headers(), ping_interval=10, ping_timeout=10) as ws:
                log("connected to Kalshi WS")
                st = {"ticker": None, "id": 1}
                async def submgr():
                    while True:
                        tk = await asyncio.to_thread(current_ticker)
                        if tk and tk != st["ticker"]:
                            BOOK["yes"].clear(); BOOK["no"].clear()
                            st["id"] += 1
                            await ws.send(json.dumps({"id": st["id"], "cmd": "subscribe",
                                "params": {"channels": ["ticker", "orderbook_delta"], "market_tickers": [tk]}}))
                            st["ticker"] = tk; log("subscribed", tk)
                        await asyncio.sleep(8)
                async def receiver():
                    async for raw in ws:
                        try:
                            m = json.loads(raw); t = m.get("type"); d = m.get("msg", m)
                            tk = d.get("market_ticker") or st["ticker"]
                            if dbg[0] < 8 and t and "orderbook" in t: log("OB RAW:", json.dumps(m)[:240]); dbg[0] += 1
                            if t == "orderbook_snapshot":
                                BOOK["yes"] = {float(p): float(s) for p, s in d.get("yes_dollars_fp", [])}
                                BOOK["no"] = {float(p): float(s) for p, s in d.get("no_dollars_fp", [])}
                                write_live(tk)
                            elif t == "orderbook_delta":
                                side = d.get("side"); price = float(d.get("price_dollars")); delta = float(d.get("delta_fp"))
                                if side in ("yes", "no"):
                                    BOOK[side][price] = BOOK[side].get(price, 0) + delta
                                    if BOOK[side][price] <= 1e-9: BOOK[side].pop(price, None)
                                    write_live(tk)
                        except Exception: pass
                await asyncio.gather(submgr(), receiver())
        except Exception as e:
            log("disconnected, reconnect in 3s:", str(e)[:110])
            await asyncio.sleep(3)
asyncio.run(run())
