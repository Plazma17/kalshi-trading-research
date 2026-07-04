"""CF Benchmarks-style real-time BTC index feed.

Kalshi's KXBTC15M settles against the CF Benchmarks index (BRRNY / real-time BRTI), a
volume-weighted aggregate across REGULATED spot exchanges -- NOT Coinbase alone. Our old
single-Coinbase feed was the wrong/incomplete reference (a move on Kraken/Bitstamp moves the
index + Kalshi while Coinbase shows nothing -> our BTC signal looked contrarian/stale).

This streams every TRADE from the accessible CF constituents (Coinbase, Kraken, Bitstamp, Gemini),
keeps a rolling per-exchange volume, and writes a volume-weighted composite index to
cfindex_live.json:  {"index": <vwap>, "mean": <simple mean>, "px": {exch: price}, "n": <#exch>, "ts": <epoch>}
Atomic writes (.tmp + os.replace) so the recorder never sees a torn file. Each exchange auto-reconnects
independently; the index uses whatever exchanges are currently fresh. ~25 writes/sec.

NOTE: v1 proxy of the CF methodology (volume-weighted average of fresh per-exchange trade prices over a
60s window). Refine toward exact CF time-partitioned VWAP + the full constituent set (LMAX, Paxos) later.
"""
import asyncio, json, time, os, sys
from collections import deque
import websockets
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "cfindex_live.json")
VOL_WINDOW = 60.0   # rolling seconds for volume weighting
FRESH = 30.0        # an exchange counts only if it traded within this many seconds

STATE = {x: {"price": None, "ts": 0.0, "vol": deque()} for x in ("coinbase", "kraken", "bitstamp", "gemini")}
CBFLOW = deque()   # (ts, signed_size): +aggressor-BUY / -aggressor-SELL from Coinbase matches -> trade-flow imbalance / VPIN proxy
ALT = {}           # latest Coinbase ETH/SOL price -> multi-asset LEAD test: do liquid altcoins lead the BTC/Kalshi move?

def log(*a): print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)

def record(name, price, size):
    s = STATE[name]; now = time.time()
    s["price"] = price; s["ts"] = now
    s["vol"].append((now, size))
    cut = now - VOL_WINDOW
    while s["vol"] and s["vol"][0][0] < cut: s["vol"].popleft()

async def coinbase():
    url = "wss://ws-feed.exchange.coinbase.com"
    sub = json.dumps({"type": "subscribe", "product_ids": ["BTC-USD", "ETH-USD", "SOL-USD"], "channels": ["matches"]})   # +ETH/SOL for the multi-asset lead test
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=256) as ws:
                await ws.send(sub); log("coinbase connected")
                async for msg in ws:
                    try:
                        d = json.loads(msg)
                        if d.get("type") in ("match", "last_match") and d.get("price"):
                            _pid = d.get("product_id")
                            if _pid == "ETH-USD": ALT["eth"] = float(d["price"]); continue
                            if _pid == "SOL-USD": ALT["sol"] = float(d["price"]); continue
                            sz = float(d.get("size") or 0)
                            record("coinbase", float(d["price"]), sz)
                            tnow = time.time()
                            CBFLOW.append((tnow, sz if d.get("side") == "sell" else -sz))   # match 'side'=MAKER side; aggressor BUY when maker SOLD
                            while CBFLOW and CBFLOW[0][0] < tnow - VOL_WINDOW: CBFLOW.popleft()
                    except Exception: continue
        except Exception as e:
            log("coinbase reconnect:", str(e)[:60]); await asyncio.sleep(2)

async def kraken():
    url = "wss://ws.kraken.com/v2"
    sub = json.dumps({"method": "subscribe", "params": {"channel": "trade", "symbol": ["BTC/USD"]}})
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=256) as ws:
                await ws.send(sub); log("kraken connected")
                async for msg in ws:
                    try:
                        d = json.loads(msg)
                        if d.get("channel") == "trade" and d.get("type") in ("update", "snapshot"):
                            for t in d["data"]:
                                record("kraken", float(t["price"]), float(t["qty"]))
                    except Exception: continue
        except Exception as e:
            log("kraken reconnect:", str(e)[:60]); await asyncio.sleep(2)

async def bitstamp():
    url = "wss://ws.bitstamp.net"
    sub = json.dumps({"event": "bts:subscribe", "data": {"channel": "live_trades_btcusd"}})
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=256) as ws:
                await ws.send(sub); log("bitstamp connected")
                async for msg in ws:
                    try:
                        d = json.loads(msg)
                        if d.get("event") == "trade":
                            dd = d["data"]; record("bitstamp", float(dd["price"]), float(dd.get("amount") or 0))
                    except Exception: continue
        except Exception as e:
            log("bitstamp reconnect:", str(e)[:60]); await asyncio.sleep(2)

async def gemini():
    url = "wss://api.gemini.com/v1/marketdata/BTCUSD"
    while True:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=20, max_queue=256) as ws:
                log("gemini connected")
                async for msg in ws:
                    try:
                        d = json.loads(msg)
                        for e in d.get("events", []):
                            if e.get("type") == "trade" and e.get("price"):
                                record("gemini", float(e["price"]), float(e.get("amount") or 0))
                    except Exception: continue
        except Exception as e:
            log("gemini reconnect:", str(e)[:60]); await asyncio.sleep(2)

async def writer():
    n = 0
    while True:
        await asyncio.sleep(0.005)   # ~200 writes/sec -- raw/fast (RAM disk; caps I/O while staying ahead of the bot read rate)
        now = time.time()
        num = den = 0.0; px = {}
        for name, s in STATE.items():
            if s["price"] is None or now - s["ts"] > FRESH: continue
            vol = sum(sz for _, sz in s["vol"]) or 1e-6
            num += s["price"] * vol; den += vol
            px[name] = round(s["price"], 2)
        if den <= 0: continue
        index = num / den
        fresh_px = [s["price"] for s in STATE.values() if s["price"] is not None and now - s["ts"] <= FRESH]
        mean = sum(fresh_px) / len(fresh_px) if fresh_px else index
        bv = sum(s for t, s in CBFLOW if s > 0 and now - t <= 15)         # Coinbase aggressor BUY volume, last 15s
        sv = -sum(s for t, s in CBFLOW if s < 0 and now - t <= 15)        # aggressor SELL volume, last 15s
        tfi = round((bv - sv) / (bv + sv), 3) if (bv + sv) > 0 else 0.0   # signed trade-flow imbalance (leads jumps per research)
        tmp = OUT + ".tmp." + str(os.getpid())   # per-PID temp -> no race if two instances ever overlap
        with open(tmp, "w") as f:
            json.dump({"index": round(index, 2), "mean": round(mean, 2), "px": px, "n": len(px),
                       "tfi": tfi, "tvol": round(bv + sv, 4), "buyvol": round(bv, 4), "sellvol": round(sv, 4),
                       "eth": ALT.get("eth"), "sol": ALT.get("sol"), "ts": now}, f)
        os.replace(tmp, OUT)
        n += 1
        if n % 250 == 0: log(f"{n} writes | index ${index:.2f} | tfi {tfi:+.2f} vol {bv+sv:.2f} | {len(px)} exch")

async def main():
    await asyncio.gather(coinbase(), kraken(), bitstamp(), gemini(), writer())

asyncio.run(main())
