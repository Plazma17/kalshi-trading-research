"""Cross-venue market matcher.

Finds candidate pairs of Kalshi and Polymarket markets that describe the SAME binary event.
This is the riskiest part: a wrong match makes a directional bet look like an arb. So the
matcher is ADVISORY — it returns a similarity score in [0,1] and the evidence behind it; a
human confirms resolution equivalence before any trade. Bias toward precision (few, confident
matches) over recall.

Performance: comparing every K market to every PM market is O(N·M) (millions of pairs). We
block first — build an inverted index from a rare-ish significant token to the K markets
containing it, then only score PM markets against K markets that share a significant token.
"""

from __future__ import annotations

import re
from collections import defaultdict
from difflib import SequenceMatcher

from model import Market

_STOP = set(
    "will the a an of to in on at for be is are by and or you your this that with as it from "
    "who what when which whether than then has have had was were market price above below "
    "before after during between yes no".split())


def _tokens(s: str) -> list[str]:
    s = s.lower()
    s = re.sub(r"[^a-z0-9$%.\- ]", " ", s)
    return [t for t in s.split() if t and t not in _STOP and len(t) > 1]


def _numbers(s: str) -> set[str]:
    # normalize $1,000 / 1000 / $1k-ish numeric tokens for overlap scoring
    return set(re.findall(r"\$?\d[\d,]*\.?\d*%?", s.lower()))


def _significant(toks: list[str]) -> set[str]:
    """Tokens worth blocking on: any token with a digit, or a word >= 4 chars."""
    return {t for t in toks if any(c.isdigit() for c in t) or len(t) >= 4}


def similarity(a: Market, b: Market) -> tuple[float, dict]:
    """Return (score, evidence). Combines token-set Jaccard, sequence ratio, shared-number
    overlap, and a date-compatibility multiplier (same event should resolve near the same
    time)."""
    ta, tb = _tokens(a.question), _tokens(b.question)
    sa, sb = set(ta), set(tb)
    if not sa or not sb:
        return 0.0, {}
    jac = len(sa & sb) / len(sa | sb)
    seq = SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio()
    na, nb = _numbers(a.question), _numbers(b.question)
    num_overlap = len(na & nb) / len(na | nb) if (na or nb) else 0.0

    score = 0.45 * jac + 0.35 * seq + 0.20 * num_overlap

    date_note = "no dates"
    if a.close_time and b.close_time:
        dd = abs((a.close_time - b.close_time).days)
        if dd > 21:
            score *= 0.4          # very different resolution dates -> probably not the same
        elif dd > 5:
            score *= 0.8
        date_note = f"{dd}d apart"

    evidence = {
        "shared_tokens": sorted(sa & sb)[:12],
        "shared_numbers": sorted(na & nb),
        "jaccard": round(jac, 3), "seq": round(seq, 3),
        "num_overlap": round(num_overlap, 3), "date": date_note,
    }
    return min(1.0, score), evidence


def match(kalshi: list[Market], poly: list[Market], threshold: float = 0.55
          ) -> list[tuple[float, Market, Market, dict]]:
    """Return [(score, poly_market, kalshi_market, evidence)] above threshold, best first.
    Each poly market keeps only its single best Kalshi candidate."""
    # inverted index: significant token -> kalshi markets containing it
    index: dict[str, list[Market]] = defaultdict(list)
    for k in kalshi:
        for tok in _significant(_tokens(k.question)):
            index[tok].append(k)

    results = []
    for p in poly:
        # gather candidate K markets sharing >=1 significant token (dedup by id)
        cand: dict[str, Market] = {}
        for tok in _significant(_tokens(p.question)):
            for k in index.get(tok, ()):
                cand[k.market_id] = k
        best_s, best_k, best_ev = 0.0, None, {}
        for k in cand.values():
            s, ev = similarity(p, k)
            if s > best_s:
                best_s, best_k, best_ev = s, k, ev
        if best_k and best_s >= threshold:
            results.append((best_s, p, best_k, best_ev))
    results.sort(key=lambda r: -r[0])
    return results
