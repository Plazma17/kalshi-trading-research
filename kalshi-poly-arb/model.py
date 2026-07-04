"""The common, venue-agnostic Market record.

CRITICAL UNIT RULE: every price on this record is in DOLLARS in [0,1] (a probability),
NOT cents. Kalshi's API speaks integer cents; poly speaks dollar strings. Each source
module converts to dollars at the boundary so the matcher / arb math never has to think
about units. A None price means "not currently quoted" (empty book / closed side) — it is
NOT zero, and must never be treated as a free fill.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Market:
    venue: str                       # "kalshi" | "polymarket"
    market_id: str                   # venue-native id (kalshi ticker / poly market id)
    question: str                    # human-readable yes/no question

    # Cost in DOLLARS (0..1) to BUY each side. None = not quoted.
    yes_ask: Optional[float]
    no_ask: Optional[float]
    yes_bid: Optional[float] = None  # what you'd receive selling YES
    no_bid: Optional[float] = None

    close_time: Optional[dt.datetime] = None  # UTC resolution/close
    volume: float = 0.0
    fee_coeff: Optional[float] = None  # venue fee coefficient (Polymarket US feeCoefficient)
    url: str = ""
    raw: dict = field(default_factory=dict)   # source-native fields for drill-down

    @property
    def quoted(self) -> bool:
        """Has at least one executable ask — worth considering for an arb leg."""
        return self.yes_ask is not None or self.no_ask is not None


def parse_iso(s: Optional[str]) -> Optional[dt.datetime]:
    """Parse an ISO-8601 timestamp (with trailing Z) to an aware UTC datetime."""
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
