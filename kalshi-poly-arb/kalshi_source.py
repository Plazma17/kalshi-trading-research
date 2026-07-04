"""Kalshi public market-data source.

Kalshi's `/markets` endpoint is publicly readable WITHOUT a signature — auth only gates
portfolio/orders. So the scanner needs no Kalshi creds (those come later, for execution,
reusing lip-maker/kalshi/client.py's RSA-PSS signing).

Prices arrive as integer cents; we convert to DOLLARS in [0,1] at this boundary so the rest
of the bot is unit-clean. A 0-cent ask/bid means "no quote on that side" and becomes None,
NOT 0.0 — treating an absent ask as a free fill would invent phantom arbs.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

from model import Market, parse_iso

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"


def _get(path: str, params: dict) -> dict:
    url = KALSHI_BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"User-Agent": "kalshi-poly-arb/0.1", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _dollars(v) -> float | None:
    """Read a Kalshi *_dollars price field (float dollars). 0 / None / '' => None — an
    absent quote, NOT a free fill. (The V2 API moved prices to `*_dollars`; the old
    integer-cents `yes_ask`/`no_ask` keys are gone — the same shape-shift lip-maker hit.)"""
    if v in (None, "", 0, 0.0):
        return None
    try:
        f = float(v)
        return f if f > 0 else None
    except (TypeError, ValueError):
        return None


def _to_market(m: dict) -> Market | None:
    # Skip multi-game / multivariate collection rows: their `title` is a comma-joined list of
    # outcomes ("yes Belgium,yes Spain,...") — not a clean binary question, useless to match.
    if m.get("mve_collection_ticker") or m.get("mve_selected_legs"):
        return None
    title = (m.get("title") or "").strip()
    if title.count(",") >= 3:  # belt-and-suspenders for the list-style collection titles
        return None
    sub = (m.get("yes_sub_title") or "").strip()
    # The strike/sub-title carries the discriminating detail (e.g. ">= $100k") the event
    # title omits — fold it in unless already present.
    question = f"{title} {sub}".strip() if sub and sub.lower() not in title.lower() else title
    return Market(
        venue="kalshi",
        market_id=m.get("ticker") or "",
        question=question,
        yes_ask=_dollars(m.get("yes_ask_dollars")),
        no_ask=_dollars(m.get("no_ask_dollars")),
        yes_bid=_dollars(m.get("yes_bid_dollars")),
        no_bid=_dollars(m.get("no_bid_dollars")),
        close_time=parse_iso(m.get("close_time")),
        volume=float(m.get("volume_fp") or 0),
        url=f"https://kalshi.com/markets/{m.get('event_ticker', '')}",
        raw={k: m.get(k) for k in
             ("ticker", "event_ticker", "title", "yes_sub_title", "close_time",
              "yes_ask_dollars", "no_ask_dollars", "status", "volume_fp")},
    )


def fetch_markets(max_markets: int = 3000, status: str = "open") -> list[Market]:
    """Page through open Kalshi markets. Only returns currently-quoted binary markets."""
    out: list[Market] = []
    cursor = None
    while len(out) < max_markets:
        params = {"limit": 1000, "status": status}
        if cursor:
            params["cursor"] = cursor
        data = _get("/markets", params)
        markets = data.get("markets") or []
        for m in markets:
            mk = _to_market(m)
            if mk and mk.market_id and mk.question:
                out.append(mk)
        cursor = data.get("cursor")
        if not cursor or not markets:
            break
    return out[:max_markets]


def fetch_market(ticker: str) -> Market | None:
    """Fetch one market by ticker (for the monitor's targeted polling)."""
    url = f"{KALSHI_BASE}/markets/{ticker}"
    req = urllib.request.Request(
        url, headers={"User-Agent": "kalshi-poly-arb/0.1", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        m = json.load(r).get("market")
    return _to_market(m) if m else None


if __name__ == "__main__":
    ms = fetch_markets(max_markets=200)
    quoted = [m for m in ms if m.quoted]
    print(f"fetched {len(ms)} kalshi markets, {len(quoted)} quoted")
    for m in quoted[:5]:
        print(f"  {m.market_id:30} yes_ask={m.yes_ask} no_ask={m.no_ask}  {m.question[:70]}")
