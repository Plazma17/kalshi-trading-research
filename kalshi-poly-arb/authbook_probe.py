"""Authenticated Kalshi /orderbook read for specific tickers.

The public /events snapshot carries depth fields (yes_bid_size_fp etc.) that PERSIST even
when the live /orderbook is EMPTY to anonymous callers (the phantom-fill trap flagged in
every prior cycle). This probe uses the REST RSA-PSS signature to read the REAL resting
book for a handful of listing-moment candidate tickers, so depth is CONFIRMED not cached.

Prints, per ticker: the top yes/no ask levels + sizes actually resting.
"""
from __future__ import annotations
import os, sys, time, json, base64, urllib.request, urllib.parse
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import creds as _creds
_creds.load()

BASE = "https://api.elections.kalshi.com/trade-api/v2"

# QA FIX (2026-07-02): creds/key were loaded at MODULE level (os.environ[...] raised KeyError
# at import when creds.env was absent), which made this module un-importable by the scanner.
# Lazy-init so scan.py/monitor.py can `import authbook_probe` unconditionally and degrade
# gracefully when auth is unavailable.
API_KEY = None
_PRIV = None

def _init():
    global API_KEY, _PRIV
    if _PRIV is not None:
        return
    API_KEY = os.environ["KALSHI_API_KEY"]
    key_path = os.environ["KALSHI_PRIVATE_KEY_PATH"]
    _PRIV = serialization.load_pem_private_key(open(key_path, "rb").read(), password=None)

def sign(msg: str) -> str:
    _init()
    sig = _PRIV.sign(msg.encode("utf-8"),
                    padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
                    hashes.SHA256())
    return base64.b64encode(sig).decode()

def auth_get(path: str, params: dict | None = None):
    _init()
    ts = str(int(time.time() * 1000))
    method = "GET"
    # Kalshi prehash = timestamp + METHOD + path (path WITHOUT query string, WITH /trade-api/v2 prefix)
    full_path = "/trade-api/v2" + path
    prehash = ts + method + full_path
    headers = {
        "KALSHI-ACCESS-KEY": API_KEY,
        "KALSHI-ACCESS-SIGNATURE": sign(prehash),
        "KALSHI-ACCESS-TIMESTAMP": ts,
        "Accept": "application/json",
        "User-Agent": "authbook-probe/0.1",
    }
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def real_depth(ticker: str) -> dict:
    """Authenticated REAL resting depth for one ticker — the phantom-arb gate primitive.

    Returns {"ok": bool, "buy_yes": (ask$, size)|None, "buy_no": (ask$, size)|None, "error"}.
    buy_yes = what a YES taker faces (crosses the best resting NO bid: ask = 1-no_bid, size =
    that bid's size); buy_no mirrors via the best resting YES bid. ok=False means the
    authenticated read itself failed (no creds / network) — depth UNKNOWN, not zero."""
    try:
        d = auth_get(f"/markets/{ticker}/orderbook", {"depth": 5})
    except Exception as e:  # noqa: BLE001 — caller decides how to degrade
        return {"ok": False, "buy_yes": None, "buy_no": None,
                "error": f"{type(e).__name__}: {str(e)[:80]}"}
    ob = d.get("orderbook_fp") or d.get("orderbook") or {}
    yes = ob.get("yes_dollars") or ob.get("yes") or []   # resting YES bids [price$, size]
    no = ob.get("no_dollars") or ob.get("no") or []      # resting NO bids  [price$, size]
    def best(levels):
        if not levels:
            return None
        p, s = max(levels, key=lambda x: float(x[0]))
        return (float(p), float(s))
    bno, byes = best(no), best(yes)
    return {"ok": True,
            "buy_yes": (round(1 - bno[0], 4), bno[1]) if bno else None,
            "buy_no": (round(1 - byes[0], 4), byes[1]) if byes else None,
            "error": None}

def show_book(ticker: str):
    try:
        d = auth_get(f"/markets/{ticker}/orderbook", {"depth": 5})
    except Exception as e:
        print(f"  {ticker}: ERROR {e}")
        return
    ob = d.get("orderbook_fp") or d.get("orderbook") or {}
    yes = ob.get("yes_dollars") or ob.get("yes") or []   # resting YES bids [price$, size]
    no  = ob.get("no_dollars")  or ob.get("no")  or []   # resting NO bids  [price$, size]
    # 'yes' = resting bids to BUY YES; 'no' = resting bids to BUY NO.
    # To BUY YES as a taker you cross the best NO bid: yes_ask = 1 - best_no_bid, fillable size
    #   = that NO-bid's size. So YES-buy depth is driven by the 'no' array's top (highest price).
    # To BUY NO  as a taker you cross the best YES bid: no_ask = 1 - best_yes_bid.
    def best(levels):  # highest-price resting bid = tightest
        if not levels: return None
        p, s = max(levels, key=lambda x: float(x[0]))
        return (float(p), float(s))
    bno = best(no)   # -> implies yes_ask = 1-p, buy-YES size = s
    byes = best(yes) # -> implies no_ask  = 1-p, buy-NO  size = s
    ya = (round(1-bno[0],2), bno[1]) if bno else None
    na = (round(1-byes[0],2), byes[1]) if byes else None
    print(f"  {ticker}: BUY-YES ask={ya[0] if ya else None}$ size={ya[1] if ya else 0:.0f} | "
          f"BUY-NO ask={na[0] if na else None}$ size={na[1] if na else 0:.0f} "
          f"(raw yes_levels={len(yes)} no_levels={len(no)})")

def main():
    tickers = sys.argv[1:]
    if not tickers:
        # default: the fresh-cell candidates surfaced by listing_moment_scan
        tickers = [
            "KXMLBGAME-26JUL031910CWSCLE",   # fresh N=2, YES gross +5c
            "KXATPMATCH-26JUL01DEJFON",      # fresh N=2, snapshot NO-depth 379
            "KXCAELECTION-2612",             # fresh N=2, snapshot NO-depth 2294
            "KXLTGOVVT-26",                  # fresh N=2, NO gross +1c
        ]
    _init()
    print(f"authenticated /orderbook read for {len(tickers)} tickers (KEY {API_KEY[:6]}...):")
    for t in tickers:
        show_book(t)
        time.sleep(0.15)

if __name__ == "__main__":
    main()
