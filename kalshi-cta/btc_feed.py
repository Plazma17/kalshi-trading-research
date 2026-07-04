"""Real-time BTC price feed via Coinbase WebSocket (replaces 2.5s REST polling).
Streams every ticker update and writes the latest price to btc_live.json (price + epoch ts),
throttled to ~25 writes/sec. Auto-reconnects. The orchestrator reads btc_live.json instantly,
so the model sees BTC moves within milliseconds instead of up to ~2.5s late."""
import asyncio, json, time, os, sys
import websockets
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "btc_live.json")
URL = "wss://ws-feed.exchange.coinbase.com"
SUB = json.dumps({"type": "subscribe", "product_ids": ["BTC-USD"], "channels": ["ticker"]})

def log(*a): print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)

async def run():
    n = 0
    while True:
        try:
            async with websockets.connect(URL, ping_interval=20, ping_timeout=20, max_queue=64) as ws:
                await ws.send(SUB)
                log("connected to Coinbase WS ticker (BTC-USD)")
                last = 0.0
                async for msg in ws:
                    d = json.loads(msg)
                    if d.get("type") == "ticker" and d.get("price"):
                        now = time.time()
                        if now - last >= 0.005:  # ~200 writes/sec -- raw/fast (was 0.04)
                            tmp = OUT + ".tmp"
                            with open(tmp, "w") as f:
                                json.dump({"price": float(d["price"]), "ts": now}, f)
                            os.replace(tmp, OUT)  # atomic -> no torn reads by the orchestrator
                            last = now; n += 1
                            if n % 250 == 0: log(f"{n} updates, last ${d['price']}")
        except Exception as e:
            log("disconnected, reconnecting in 2s:", str(e)[:80])
            await asyncio.sleep(2)

asyncio.run(run())
