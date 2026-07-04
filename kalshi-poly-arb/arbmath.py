"""Arb math + fee model for a matched cross-venue pair.

Lock a guaranteed $1 payout by buying YES on one venue and NO on the other:
    cost   = ask(YES on venue A) + ask(NO on venue B) + fees
    payoff = $1.00  (exactly one outcome resolves true, given the SAME event)
    profit = 1.00 - cost
We evaluate both directions and return the better. All prices in DOLLARS [0,1].
"""

from __future__ import annotations

import math

from model import Market


def kalshi_fee(price: float | None) -> float:
    """Kalshi general per-contract trading fee in dollars: ceil(0.07 · P · (1-P)) to the
    cent. Peaks ~1.75c at P=0.50, ~0 at the extremes. (Maker rebates/promos ignored — this
    is the conservative taker fee.)"""
    if price is None:
        return 0.0
    return math.ceil(0.07 * price * (1.0 - price) * 100) / 100.0


POLY_US_FEE_COEFF_DEFAULT = 0.05  # observed feeCoefficient on the US gateway


def poly_us_fee(price: float | None, coeff: float | None = None) -> float:
    """Polymarket US per-contract trading fee, modeled on the standard prediction-market
    curve `coeff · P · (1-P)` (max at P=0.5, ~0 at the extremes) using the market's
    `feeCoefficient` (~0.05). NOTE: this is the curve SHAPE Kalshi uses; confirm the exact US
    formula against the published schedule before trusting a thin edge."""
    if price is None:
        return 0.0
    c = coeff if coeff is not None else POLY_US_FEE_COEFF_DEFAULT
    return math.ceil(c * price * (1.0 - price) * 100) / 100.0


def _fee(m: Market, price: float | None) -> float:
    if m.venue == "kalshi":
        return kalshi_fee(price)
    return poly_us_fee(price, m.fee_coeff)


def best_arb(a: Market, b: Market) -> dict | None:
    """Best risk-free direction for the pair, or None if neither side is two-leg quotable.
    Returns a dict with the legs, modeled fees, cost, and net profit per contract (dollars)."""
    best = None
    for buy_yes, buy_no in ((a, b), (b, a)):
        ya, nb = buy_yes.yes_ask, buy_no.no_ask
        if ya is None or nb is None:
            continue
        fee = _fee(buy_yes, ya) + _fee(buy_no, nb)
        cost = ya + nb
        profit = 1.0 - cost - fee
        leg = {
            "buy_yes_on": buy_yes.venue, "yes_ask": round(ya, 4),
            "buy_no_on": buy_no.venue, "no_ask": round(nb, 4),
            "gross_cost": round(cost, 4), "fees": round(fee, 4),
            "net_profit": round(profit, 4),
            "net_profit_pct": round(profit / cost * 100, 2) if cost > 0 else 0.0,
        }
        if best is None or leg["net_profit"] > best["net_profit"]:
            best = leg
    return best
