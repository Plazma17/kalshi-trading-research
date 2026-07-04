"""Dual-leg arb executor — SAFETY FIRST.

Captures a detected cross-venue gap by buying YES on Polymarket US (long) and NO on Kalshi.
Designed to be paranoid: it does NOTHING with real money unless ARB_LIVE=1 is explicitly set;
otherwise every order is a PREVIEW (Polymarket) / dry-run (Kalshi). Hard caps bound the size.

v1 SCOPE (deliberate safety limits — expand only after a funded tiny-order test):
  * ONLY the direction "YES on Polymarket (BUY_LONG) + NO on Kalshi". We never SHORT on
    Polymarket — its short-side price semantics are unverified and not worth risking real money
    on a guess. (The scanner also flags the reverse direction; v1 simply skips those.)
  * Both legs are marketable LIMIT orders at the gap price (won't fill worse than the arb).
  * LEG-RISK protocol: fire Polymarket FOK first. Only if it fully fills do we fire Kalshi. If
    the Kalshi leg then fails, immediately CLOSE the Polymarket position (capping the loss to one
    leg's slippage). If Polymarket doesn't fill, we never touch Kalshi -> zero exposure.

STILL NEEDS A FUNDED TINY-ORDER TEST before trusting live: (a) Polymarket fill semantics under
FOK, (b) Kalshi IOC/marketable fill + the no-price math, (c) the unwind path. Until then run dry.
"""
from __future__ import annotations

import os
import sys
import time

import creds
creds.load()

LIVE = os.environ.get("ARB_LIVE") == "1"
# Allocation: the bot may use at most this much PER VENUE (user-set $10/side).
PER_VENUE = float(os.environ.get("ARB_PER_VENUE", "10"))
# HARD, CODE-LEVEL per-venue dollar ceiling. The effective cap is the MIN of the env value and
# this constant, so no config/env can push a single trade above $10/venue (Noah's authorization).
HARD_PER_VENUE_CAP = 10.0
EFF_PER_VENUE = min(PER_VENUE, HARD_PER_VENUE_CAP)
MAX_CONTRACTS = int(os.environ.get("ARB_MAX_CONTRACTS", "40"))
MIN_NET_EDGE = float(os.environ.get("ARB_MIN_EDGE", "0.04"))     # min net $/contract to fire (after BOTH fees)
# ── HARD-KILL thresholds (session safety) ─────────────────────────────────────
# LEG-RISK: a fill on one leg where the other leg fails to complete within the fill window leaves
# a NAKED position. After MAX_LEG_RISK_EVENTS such events in a session -> HARD STOP (no more orders).
MAX_LEG_RISK_EVENTS = int(os.environ.get("ARB_MAX_LEG_RISK", "2"))
# SESSION LOSS: stop the moment realized PnL (leg-risk unwind slippage etc.) drops to/below this.
SESSION_LOSS_KILL = float(os.environ.get("ARB_SESSION_LOSS_KILL", "-8"))
KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"
HERE = os.path.dirname(os.path.abspath(__file__))
KILL_LOG = os.path.join(HERE, "arb_kill.log")

# PM-US FEE = $0. Verified 2026-07-03 against a live authenticated order PREVIEW on the US API
# (commissionsBasisPoints=0, commissionNotionalTotalCollected=$0.0000 for BUY_LONG). The prior
# 0.05 coefficient in the study was a conservative Kalshi-shaped guess; the real venue charges
# nothing, so the arb math below adds ONLY the Kalshi fee. This WIDENS the true edge.
POLY_US_FEE = 0.0


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


# ── Polymarket US leg (BUY_LONG / YES only) ───────────────────────────────────
class PolyExec:
    venue = "polymarket"

    def __init__(self):
        from polymarket_us import PolymarketUS
        self.c = PolymarketUS(key_id=os.environ["POLYMARKET_KEY_ID"],
                              secret_key=os.environ["POLYMARKET_SECRET_KEY"])

    def usd_available(self) -> float:
        try:
            bals = self.c.account.balances().get("balances", []) or []
            tot = 0.0
            for b in bals:
                if (b.get("currency") or "USD") == "USD":
                    tot += float(b.get("buyingPower", b.get("currentBalance", 0)) or 0)
            return tot
        except Exception as e:  # noqa: BLE001
            log("poly balance err", e); return 0.0

    def best_ask(self, slug):
        ya, _ = __import__("poly_source").fetch_bbo(slug)
        return ya

    def _params(self, slug, price, qty):
        # IOC (not FOK): take whatever the thin book offers up to qty, rather than all-or-nothing.
        # capture() then matches the Kalshi leg to the actual PM fill and unwinds any excess.
        return {"marketSlug": slug, "intent": "ORDER_INTENT_BUY_LONG", "type": "ORDER_TYPE_LIMIT",
                "price": {"value": f"{price:.3f}", "currency": "USD"}, "quantity": int(qty),
                "tif": "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
                "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC"}

    def position_qty(self, slug) -> int:
        try:
            pos = (self.c.portfolio.positions().get("positions", {}) or {}).get(slug)
            return int(float(pos.get("netPosition", 0))) if pos else 0
        except Exception as e:  # noqa: BLE001
            log("poly pos err", e); return 0

    def buy_yes(self, slug, price, qty):
        """Buy YES (FOK). Fills are ASYNC — the create response's executions are empty even on a
        fill — so we CONFIRM via the position delta. Returns {'filled': n}."""
        p = self._params(slug, price, qty)
        if not LIVE:
            return {"dry": True, "filled": 0, "preview": self.c.orders.preview({"request": p})}
        before = self.position_qty(slug)
        self.c.orders.create(p)
        for _ in range(6):                       # poll up to ~3s for the async fill
            time.sleep(0.5)
            got = self.position_qty(slug) - before
            if got >= qty:
                return {"filled": qty}
        return {"filled": max(0, self.position_qty(slug) - before)}

    def sell(self, slug, qty):
        """Close/unwind a long via an explicit marketable SELL_LONG IOC. (close_position sends a
        price-0 order that does NOT fill — confirmed in live testing.)"""
        if not LIVE or qty <= 0:
            return {"dry": True, "sell_px": None}
        import poly_source
        _, bid = poly_source.fetch_bbo(slug)
        px = max(0.01, round((bid or 0.05) - 0.03, 2))   # cross the bid to guarantee the IOC fill
        params = {"marketSlug": slug, "intent": "ORDER_INTENT_SELL_LONG", "type": "ORDER_TYPE_LIMIT",
                  "price": {"value": f"{px:.2f}", "currency": "USD"}, "quantity": int(qty),
                  "tif": "TIME_IN_FORCE_IMMEDIATE_OR_CANCEL",
                  "manualOrderIndicator": "MANUAL_ORDER_INDICATOR_AUTOMATIC"}
        try:
            resp = self.c.orders.create(params)
            return {"resp": resp, "sell_px": px}
        except Exception as e:  # noqa: BLE001 — unwind must never raise into capture()
            log("poly unwind err", e)
            return {"error": str(e)[:120], "sell_px": None}


# ── Kalshi leg (buy NO — a native buy of the NO contract) ─────────────────────
class KalshiExec:
    venue = "kalshi"

    def __init__(self):
        sys.path.insert(0, r"C:\users\Noah\claude-workspace\lip-maker")
        key = os.environ.get("KALSHI_API_KEY")
        pem = os.environ.get("KALSHI_PRIVATE_KEY_PATH")
        self.ready = bool(key and pem and os.path.exists(pem))
        self.c = None
        if self.ready:
            from kalshi.client import KalshiClient
            self.c = KalshiClient(key, pem, KALSHI_BASE, order_tif="immediate_or_cancel")

    def usd_available(self) -> float:
        if not self.ready:
            return 0.0
        try:
            return float(self.c.get_balance().get("balance", 0)) / 100.0
        except Exception as e:  # noqa: BLE001
            log("kalshi balance err", e); return 0.0

    def buy_no(self, ticker, price_cents, qty):
        if not self.ready:
            return {"error": "kalshi creds missing (set KALSHI_API_KEY + KALSHI_PRIVATE_KEY_PATH)"}
        if not LIVE:
            return {"dry": True, "filled": 0, "would": {"ticker": ticker, "side": "no",
                                                        "price_cents": price_cents, "qty": qty}}
        r = self.c.place_order(ticker=ticker, side="no", action="buy", count=int(qty),
                               no_price_cents=int(price_cents), post_only=False)
        r["filled"] = int(float(r.get("fill_count", 0) or 0))  # Kalshi confirms fills synchronously
        return r


def kalshi_fee(price):
    import math
    return math.ceil(0.07 * price * (1 - price) * 100) / 100.0


class ArbExecutor:
    def __init__(self):
        self.poly = PolyExec()
        self.kx = KalshiExec()
        # ── session HARD-KILL state ──────────────────────────────────────────
        self.leg_risk_events = 0        # count of naked-leg realizations this session
        self.realized_pnl = 0.0         # realized $ (leg-risk unwind slippage + settled results)
        self.halted = False
        self.halt_reason = None

    def _killnote(self, tag: str, msg: str) -> None:
        """Loud + durable kill/alert record (also readable by the monitor/watchdog)."""
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {tag}: {msg}"
        log(f"!!! {tag} !!! {msg}")
        try:
            with open(KILL_LOG, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:  # noqa: BLE001
            pass

    def _halt(self, tag: str, msg: str) -> None:
        self.halted = True
        self.halt_reason = f"{tag}: {msg}"
        self._killnote(tag, msg + "  -> HARD STOP (no further orders this session)")

    def _tripped(self):
        """Return an abort-reason string if the session is halted / a threshold is already
        breached; else None. Checked at the TOP of every capture()."""
        if self.halted:
            return self.halt_reason
        if self.leg_risk_events >= MAX_LEG_RISK_EVENTS:
            self._halt("LEG_RISK_KILL", f"{self.leg_risk_events} naked-leg events >= "
                       f"{MAX_LEG_RISK_EVENTS}")
            return self.halt_reason
        if self.realized_pnl <= SESSION_LOSS_KILL:
            self._halt("SESSION_LOSS_KILL", f"realized ${self.realized_pnl:.2f} <= "
                       f"${SESSION_LOSS_KILL:.2f}")
            return self.halt_reason
        return None

    def _record_leg_risk(self, *, loss: float, detail: str) -> None:
        """Register ONE naked-leg realization: bump the counter, book the realized loss, and
        trip the hard-kill if either the 2-strike count or the session $-loss floor is reached."""
        self.leg_risk_events += 1
        self.realized_pnl -= abs(loss)
        self._killnote("LEG_RISK", f"event #{self.leg_risk_events} ({detail}); "
                       f"realized ${self.realized_pnl:.2f}")
        if self.leg_risk_events >= MAX_LEG_RISK_EVENTS:
            self._halt("LEG_RISK_KILL", f"{self.leg_risk_events} naked-leg events >= "
                       f"{MAX_LEG_RISK_EVENTS}")
        if self.realized_pnl <= SESSION_LOSS_KILL:
            self._halt("SESSION_LOSS_KILL", f"realized ${self.realized_pnl:.2f} <= "
                       f"${SESSION_LOSS_KILL:.2f}")

    def capture(self, *, poly_slug, kalshi_ticker, poly_yes_ask, kalshi_no_ask, qty):
        """Attempt ONE arb: buy YES on Polymarket + NO on Kalshi, holding both to settlement.
        Leg-risk protocol: PM first (FOK, confirmed via position); then Kalshi for the qty PM
        actually filled; if Kalshi underfills, unwind the unmatched PM via marketable sell."""
        mode = "LIVE" if LIVE else "DRY/preview"
        # ── HARD-KILL gate: if the session is halted (2-strike leg-risk or session $-loss), refuse
        # every further order. Checked FIRST, before any pricing/sizing/book work.
        tripped = self._tripped()
        if tripped:
            return self._abort(f"SESSION HALTED — {tripped}")
        # AGGRESSIVE marketable limits: cross by up to HALF the edge (capped 6c/leg) so we actually
        # fill on a fleeting/stale quote, while still locking >= MIN_NET_EDGE. A +1c limit missed a
        # live 19% gap (quote moved before our order landed); this pays up to catch it.
        raw_net = 1.0 - (poly_yes_ask + kalshi_no_ask + kalshi_fee(kalshi_no_ask))
        slip = max(0.01, min((raw_net - MIN_NET_EDGE) / 2, 0.06))
        pm_px = min(0.99, round(poly_yes_ask + slip, 2))
        kx_px_c = min(99, round((kalshi_no_ask + slip) * 100))
        fee = kalshi_fee(kx_px_c / 100)
        cost = pm_px + kx_px_c / 100 + fee           # realized cost incl. slippage crossing + fee
        net = 1.0 - cost
        # size to the $/side allocation — EFF_PER_VENUE = min(env, $10 HARD code cap), so a single
        # trade can never deploy more than $10/venue no matter the config.
        qty = min(qty, MAX_CONTRACTS,
                  int(EFF_PER_VENUE / max(pm_px, 0.01)),
                  int(EFF_PER_VENUE / max(kx_px_c / 100, 0.01)))
        log(f"--- capture [{mode}] PM[{poly_slug}] yes@{poly_yes_ask:.2f} + KX no@{kalshi_no_ask:.2f}")
        log(f"    exec yes@{pm_px:.2f}+no@{kx_px_c}c+fee${fee:.2f} -> net {net:+.3f}/ct  qty {qty}")

        if net < MIN_NET_EDGE:
            return self._abort(f"net {net:.3f} < min edge {MIN_NET_EDGE}")
        if qty < 1:
            return self._abort("qty < 1 after caps")
        pbal, kbal = self.poly.usd_available(), self.kx.usd_available()
        if LIVE and (pbal < qty * pm_px or kbal < qty * (kx_px_c / 100)):
            return self._abort(f"insufficient balance (poly ${pbal:.2f}, kalshi ${kbal:.2f})")

        # PRE-FIRE /book GATE (the documented fill-error fix). The gap is detected off a feed that goes
        # STALE during fast moves (goals) -> phantom asks that 0-fill. Re-fetch the PM order book RIGHT
        # NOW and only proceed if a REAL offer still crosses our marketable limit AND has depth >= qty.
        # Runs in dry mode too, so a DRY run on a live gap shows the gate's verdict with zero money.
        try:
            import poly_source
            fresh = poly_source.fetch_book(poly_slug)
        except Exception as e:
            return self._abort(f"PM /book re-fetch failed: {str(e)[:50]}")
        offers = (fresh or {}).get("offers") or []
        if not offers:
            return self._abort("PM /book empty at fire-time (phantom gap)")
        real_ask, real_sz = offers[0]
        if real_ask > pm_px:
            return self._abort(f"PM ask moved {real_ask:.2f} > limit {pm_px:.2f} — gap closed (phantom)")
        if real_sz < qty:
            return self._abort(f"PM real depth {int(real_sz)} < qty {qty} at the ask — thin/phantom")
        log(f"    pre-fire OK: PM real ask {real_ask:.2f} x{int(real_sz)} crosses limit, depth>=qty")

        # PRE-FIRE KALSHI GATE (mirror of the PM re-check — added after the 2026-07-03 AUS-EGY live
        # fire, where a stoppage-time goal jumped the Kalshi NO ask 0.69->0.84 PAST our 0.75 limit,
        # 0-filling leg2 and forcing a naked-PM unwind for a real loss). The detected kalshi_no_ask
        # goes STALE in the same fast move that creates the gap, so re-fetch the Kalshi market RIGHT
        # NOW and only proceed if the FRESH NO ask still crosses our marketable limit kx_px_c. Runs in
        # dry mode too, so a DRY run on a live gap shows the gate's verdict with zero money.
        try:
            import kalshi_source
            km_fresh = kalshi_source.fetch_market(kalshi_ticker)
        except Exception as e:
            return self._abort(f"KX market re-fetch failed: {str(e)[:50]}")
        if km_fresh is None or km_fresh.no_ask is None:
            return self._abort("KX market empty/None at fire-time (phantom gap)")
        kx_real_c = round(km_fresh.no_ask * 100)
        if kx_real_c > kx_px_c:
            return self._abort(f"KX no_ask moved {kx_real_c}c > limit {kx_px_c}c — gap closed (stale KX)")
        log(f"    pre-fire OK: KX real no_ask {kx_real_c}c <= limit {kx_px_c}c crosses")

        if not LIVE:
            r1 = self.poly.buy_yes(poly_slug, pm_px, qty)
            log("    [dry] poly preview ok:", bool(r1.get("preview")))
            log("    [dry] kalshi would:", self.kx.buy_no(kalshi_ticker, kx_px_c, qty).get("would"))
            return {"mode": "dry", "net": net, "qty": qty}

        # leg 1: Polymarket YES (FOK) — confirm fill via position
        log(f"    leg1: PM buy YES x{qty} @ {pm_px:.2f}…")
        r1 = self.poly.buy_yes(poly_slug, pm_px, qty)
        got = r1.get("filled", 0)
        log(f"      PM filled {got}/{qty}")
        if got == 0:
            return self._abort("PM leg unfilled — zero exposure")
        # leg 2: Kalshi NO — match PM's filled qty
        log(f"    leg2: Kalshi buy NO x{got} @ {kx_px_c}c…")
        r2 = self.kx.buy_no(kalshi_ticker, kx_px_c, got)
        kf = r2.get("filled", 0)
        log(f"      Kalshi filled {kf}/{got}")
        if kf < got:
            uwq = got - kf
            log(f"    !! leg mismatch — unwinding {uwq} PM (marketable sell) to cap risk")
            uw = self.poly.sell(poly_slug, uwq)
            # LEG-RISK REALIZED: we held a naked PM leg. Book the loss and count the strike.
            #   * unwind filled  -> realized loss ≈ uwq · (buy_px − sell_px)  (slippage)
            #   * unwind FAILED  -> position still naked -> conservatively book the full premium
            #     uwq · pm_px at risk AND flag the naked exposure loudly.
            sell_px = (uw or {}).get("sell_px")
            unwind_failed = (uw or {}).get("error") is not None or sell_px is None
            if unwind_failed:
                loss = uwq * pm_px
                self._killnote("NAKED_EXPOSURE",
                               f"UNWIND FAILED on {uwq} PM {poly_slug} — MANUAL FLATTEN NEEDED")
            else:
                loss = max(0.0, uwq * (pm_px - sell_px))
            self._record_leg_risk(loss=loss,
                                  detail=f"Kalshi underfill {kf}/{got}, unwound {uwq}, "
                                         f"~${loss:.2f} loss")
            res = "LOCKED_PARTIAL" if kf > 0 else "UNWOUND_NO_EXPOSURE"
            return {"mode": "live", "result": res, "locked": kf, "unwound": uwq, "unwind": uw,
                    "leg_risk_events": self.leg_risk_events, "realized_pnl": self.realized_pnl,
                    "halted": self.halted, "halt_reason": self.halt_reason}
        log(f"    ✓ ARB LOCKED — {got} contracts both legs, net {net:+.3f}/ct")
        return {"mode": "live", "result": "LOCKED", "locked": got, "qty": got, "net": net,
                "pm_px": pm_px, "kx_px": kx_px_c / 100}

    def _abort(self, why, **extra):
        log(f"    ABORT: {why}")
        return {"mode": "abort", "why": why, **extra}


if __name__ == "__main__":
    # dry self-test: preview a tiny arb on a current World Cup pair from the watchlist
    import json
    ex = ArbExecutor()
    log(f"balances — poly ${ex.poly.usd_available():.2f} | kalshi ${ex.kx.usd_available():.2f} (ready={ex.kx.ready})")
    try:
        wl = json.load(open(os.path.join(os.path.dirname(__file__), "watchlist.json")))["pairs"]
        p = next((x for x in wl if not x.get("verify_resolution")), wl[0])
        slug = p["polymarket_slug"]
        ya = ex.poly.best_ask(slug) or 0.5
        log(f"self-test pair: {p['label']}")
        ex.capture(poly_slug=slug, kalshi_ticker=p["kalshi_ticker"],
                   poly_yes_ask=ya, kalshi_no_ask=max(0.01, 1 - ya - 0.06), qty=2)
    except Exception as e:  # noqa: BLE001
        log("self-test err", type(e).__name__, e)
