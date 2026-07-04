"""JOR vs ALG (Algeria=DZA) — Kalshi ORDERBOOK DEPTH logger (READ-ONLY, no orders).

Records, per outcome, the price AND the resting size behind it on both sides, so we can answer the
NZL-v-EGY question: when a 'buy all NO < $2' arb flashes, is there REAL depth to fill it, or is the
quote a phantom (thin book)? To BUY NO you lift the best YES bid, so NO-fill-depth = size at the top
yes bid. The buy-all-NO arb can only be filled in min(depth) sets across the 3 legs (thinnest leg = cap).

Writes jordza_depth.csv (~2s/full-snapshot). No trading. Run: python jordza_depth_logger.py
"""
import urllib.request, json, time, csv, os, datetime as dt, math

TICKERS = {"JOR": "KXWCGAME-26JUN22JORDZA-JOR", "DZA": "KXWCGAME-26JUN22JORDZA-DZA", "TIE": "KXWCGAME-26JUN22JORDZA-TIE"}
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "jordza_depth.csv")
MINUTES = float(os.environ.get("JD_MINUTES", "150"))
TICK = float(os.environ.get("JD_TICK", "2.0"))
def kfee(p): return math.ceil(0.07 * p * (1 - p) * 100) / 100 if (p and 0 < p < 1) else 0
def log(*a): print(f"[{dt.datetime.now().strftime('%H:%M:%S')}]", *a, flush=True)
def get(url): return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=15))

def leg(tk):
    """Return dict with no_ask + the depth (contracts) available to BUY NO, and same for YES."""
    d = get(f"https://api.elections.kalshi.com/trade-api/v2/markets/{tk}/orderbook")["orderbook_fp"]
    yb = [(float(p), float(s)) for p, s in (d.get("yes_dollars") or [])]   # resting YES bids
    nb = [(float(p), float(s)) for p, s in (d.get("no_dollars") or [])]    # resting NO bids
    by = max(yb, default=(0.0, 0.0))   # best YES bid -> lifting it BUYS NO
    bn = max(nb, default=(0.0, 0.0))   # best NO bid  -> lifting it BUYS YES
    return {"no_ask": round(1 - by[0], 2) if by[0] else None, "no_depth": round(by[1], 1),
            "yes_ask": round(1 - bn[0], 2) if bn[0] else None, "yes_depth": round(bn[1], 1)}

new = not os.path.exists(OUT)
fh = open(OUT, "a", newline="", encoding="utf-8")
w = csv.writer(fh)
if new:
    w.writerow(["ts", "outcome", "no_ask", "no_fill_depth", "yes_ask", "yes_fill_depth"])
log(f"JOR/ALG depth logger | {len(TICKERS)} legs | {TICK}s/snap | -> {os.path.basename(OUT)}")

snaps = int(MINUTES * 60 / TICK)
for s in range(snaps):
    try:
        legs = {}
        for code, tk in TICKERS.items():
            L = leg(tk); legs[code] = L
            ts = dt.datetime.now(dt.timezone.utc).isoformat()
            w.writerow([ts, code, L["no_ask"], L["no_depth"], L["yes_ask"], L["yes_depth"]])
        fh.flush()
        # buy-all-NO arb: collect exactly $2 (two losing-side NOs pay $1 each), cost = sum(no_ask)+fees
        nas = [legs[c]["no_ask"] for c in TICKERS]
        if all(a is not None for a in nas):
            cost = sum(nas) + sum(kfee(a) for a in nas)
            fill = min(legs[c]["no_depth"] for c in TICKERS)   # thinnest leg caps the fillable sets
            edge = 2.0 - cost
            tag = f"*** ARB edge +${edge:.2f}/set, fillable {fill:.0f} sets ***" if edge > 0 else ""
            if s % 15 == 0 or edge > 0:
                log(f"buy-all-NO cost ${cost:.3f} (collect $2) edge ${edge:+.3f} | min-depth {fill:.0f} | "
                    + " ".join(f"{c}:NOask{legs[c]['no_ask']}x{legs[c]['no_depth']:.0f}" for c in TICKERS) + " " + tag)
    except Exception as e:
        log("err", str(e)[:70])
    time.sleep(TICK)
fh.close()
log("=== JOR/ALG depth logger ended ===")
