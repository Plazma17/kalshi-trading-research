"""Polymarket market-data source — two backends.

We trade on **Polymarket US** (the CFTC-regulated, USD-settled DCM), so that is the REAL
target. Reading market data needs NO key: it lives on the PUBLIC gateway host
`gateway.polymarket.us/v1/markets` (confirmed against the official `polymarket-us` SDK, whose
markets resource calls it unauthenticated). The Ed25519 KYC key is only required to TRADE
(orders/portfolio on api.polymarket.us) — that's the deferred live phase.

Two backends:

  * "us"     — gateway.polymarket.us /v1/markets, public. The REAL US market set + US prices
               + per-market fee coefficient. Default. No creds needed for the scanner.
  * "global" — gamma-api.polymarket.com, public. The global (non-US) superset; kept as a
               cross-check / dev fixture. Prices are mid/last. Never trade off it.

Pick via fetch_markets(backend=...) or the POLY_BACKEND env var (default "us").
All prices are normalized to DOLLARS in [0,1].

The Ed25519 request-signing helpers (for the future trading phase) live in poly_auth.py.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from model import Market, parse_iso

GAMMA_BASE = "https://gamma-api.polymarket.com"
US_GATEWAY = "https://gateway.polymarket.us"


def _http_get(url: str, headers: dict | None = None):
    req = urllib.request.Request(
        url, headers={"User-Agent": "kalshi-poly-arb/0.1", "Accept": "application/json",
                      **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _jl(v):
    """Gamma returns some list fields as JSON strings, e.g. '["Yes","No"]'."""
    if isinstance(v, list):
        return v
    if isinstance(v, str) and v.strip().startswith("["):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return None
    return None


def _quote(q):
    """Parse a {'value': '0.59', 'currency': 'USD'} money object to a float in dollars.
    0 / missing => None (no quote on that side)."""
    if not isinstance(q, dict):
        return None
    try:
        f = float(q.get("value"))
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


# ── global (gamma) — public dev fixture ───────────────────────────────────────

def _gamma_to_market(m: dict) -> Market | None:
    outcomes = _jl(m.get("outcomes"))
    prices = _jl(m.get("outcomePrices"))
    if not outcomes or len(outcomes) != 2:
        return None
    low = [str(o).lower() for o in outcomes]
    if set(low) != {"yes", "no"}:
        return None  # only plain binary Yes/No markets
    pmap = {}
    if prices and len(prices) == 2:
        try:
            pmap = {low[i]: float(prices[i]) for i in range(2)}
        except (TypeError, ValueError):
            pmap = {}
    yes, no = pmap.get("yes"), pmap.get("no")
    return Market(
        venue="polymarket",
        market_id=str(m.get("id") or m.get("slug") or ""),
        question=m.get("question") or "",
        # gamma gives mid/last, not an executable ask — use as INDICATIVE only.
        yes_ask=yes, no_ask=no, yes_bid=yes, no_bid=no,
        close_time=parse_iso(m.get("endDate")),
        volume=float(m.get("volumeNum") or 0),
        url=f"https://polymarket.com/event/{m.get('slug', '')}",
        raw={k: m.get(k) for k in
             ("id", "slug", "conditionId", "clobTokenIds", "question", "endDate")},
    )


def _fetch_global(max_markets: int) -> list[Market]:
    out: list[Market] = []
    offset, page = 0, 100  # gamma caps `limit` at 100/page; paginate via offset
    # gamma 422s past a deep offset (~2000) on the volume-sorted feed — that tail is
    # low-volume noise we don't want anyway. Cap the offset and stop cleanly on a 422.
    while len(out) < max_markets and offset <= 2000:
        params = {"closed": "false", "active": "true", "limit": page, "offset": offset,
                  "order": "volumeNum", "ascending": "false"}
        try:
            data = _http_get(GAMMA_BASE + "/markets?" + urllib.parse.urlencode(params))
        except urllib.error.HTTPError as e:
            if e.code == 422:
                break  # past the paginable range
            raise
        if not isinstance(data, list) or not data:
            break
        for m in data:
            mk = _gamma_to_market(m)
            if mk and mk.market_id and mk.question:
                out.append(mk)
        offset += page
        if len(data) < page:
            break
    return out[:max_markets]


# ── Polymarket US (production) — public gateway, no auth for reads ─────────────

def _us_question(m: dict) -> str:
    """US sports markets carry a generic `question` ("World Series Champion") with the team
    only in the slug; fold the slug's trailing token in so the matcher can tell them apart.
    Non-sports markets have a complete question and pass through unchanged."""
    q = (m.get("question") or "").strip()
    slug = m.get("slug") or ""
    tail = slug.rsplit("-", 1)[-1] if "-" in slug else ""
    if tail and tail.isalpha() and tail.lower() not in q.lower() and len(tail) <= 5:
        return f"{q} ({tail})"
    return q


def _us_to_market(m: dict) -> Market | None:
    outcomes = _jl(m.get("outcomes"))
    prices = _jl(m.get("outcomePrices"))
    if not outcomes or len(outcomes) != 2:
        return None
    low = [str(o).lower() for o in outcomes]
    if set(low) != {"yes", "no"}:
        return None  # only plain binary Yes/No markets (outcome order varies — map by label)
    try:
        fee = float(m["feeCoefficient"]) if m.get("feeCoefficient") is not None else None
    except (TypeError, ValueError):
        fee = None

    # Executable prices: the gateway carries the YES instrument's top-of-book as
    # bestAskQuote/bestBidQuote (== the /bbo endpoint's bestAsk/bestBid). Prefer those —
    # the bulk `outcomePrices` are stale (we've seen them sum to ≠1). In a unified binary
    # CLOB, buying NO == selling YES, so no_ask = 1 - yes_bid and no_bid = 1 - yes_ask.
    yes_ask = _quote(m.get("bestAskQuote"))
    yes_bid = _quote(m.get("bestBidQuote"))
    if yes_ask is None and yes_bid is None and prices and len(prices) == 2:
        try:  # fall back to indicative mid only if there's no book
            pmap = {low[i]: float(prices[i]) for i in range(2)}
            yes_ask = yes_bid = pmap.get("yes")
        except (TypeError, ValueError):
            pass
    no_ask = (1.0 - yes_bid) if yes_bid is not None else None
    no_bid = (1.0 - yes_ask) if yes_ask is not None else None

    return Market(
        venue="polymarket",
        market_id=m.get("slug") or "",
        question=_us_question(m),
        yes_ask=yes_ask, no_ask=no_ask, yes_bid=yes_bid, no_bid=no_bid,
        close_time=parse_iso(m.get("endDate")),
        volume=0.0,
        fee_coeff=fee,
        url=f"https://polymarket.us/markets/{m.get('slug', '')}",
        raw={k: m.get(k) for k in
             ("slug", "question", "title", "titleShort", "endDate", "closed",
              "feeCoefficient", "orderPriceMinTickSize", "category", "gameStartTime")},
    )


def _fetch_us(max_markets: int) -> list[Market]:
    """Public US gateway. No key needed (trading keys are reserved for poly_auth.py)."""
    out: list[Market] = []
    offset, page = 0, 100
    while len(out) < max_markets:
        params = {"closed": "false", "active": "true", "limit": page, "offset": offset}
        try:
            data = _http_get(US_GATEWAY + "/v1/markets?" + urllib.parse.urlencode(params))
        except urllib.error.HTTPError as e:
            if e.code == 422:
                break
            raise
        items = data.get("markets") if isinstance(data, dict) else None
        if not items:
            break
        for m in items:
            mk = _us_to_market(m)
            if mk and mk.market_id and mk.question:
                out.append(mk)
        offset += page
        if len(items) < page:
            break
    return out[:max_markets]


def fetch_bbo(slug: str) -> tuple[float | None, float | None]:
    """Targeted YES top-of-book for one US market (for the monitor): (yes_ask, yes_bid) in
    dollars from the /bbo endpoint. Public, no auth."""
    d = _http_get(f"{US_GATEWAY}/v1/markets/{slug}/bbo").get("marketData", {})
    return _quote(d.get("bestAsk")), _quote(d.get("bestBid"))


def fetch_book(slug: str) -> dict:
    """Full order book for one US market: {'bids': [(px,qty)...], 'offers': [(px,qty)...]}.
    Used to check whether a displayed gap price is backed by REAL size or is a phantom/stale quote."""
    d = _http_get(f"{US_GATEWAY}/v1/markets/{slug}/book").get("marketData", {})
    def lvls(key):
        out = []
        for x in (d.get(key) or []):
            px = _quote(x.get("px"))
            try:
                qty = float(x.get("qty", 0) or 0)
            except (TypeError, ValueError):
                qty = 0.0
            if px is not None:
                out.append((px, qty))
        return out
    return {"bids": lvls("bids"), "offers": lvls("offers")}


def fetch_markets(max_markets: int = 4000, backend: str | None = None) -> list[Market]:
    backend = backend or os.environ.get("POLY_BACKEND", "us")
    if backend == "us":
        return _fetch_us(max_markets)
    if backend == "global":
        return _fetch_global(max_markets)
    raise ValueError(f"unknown poly backend {backend!r} (expected 'us' or 'global')")


if __name__ == "__main__":
    ms = fetch_markets(max_markets=200)
    print(f"fetched {len(ms)} polymarket markets (backend={os.environ.get('POLY_BACKEND','global')})")
    for m in ms[:5]:
        print(f"  {m.market_id:14} yes={m.yes_ask} no={m.no_ask}  {m.question[:70]}")
