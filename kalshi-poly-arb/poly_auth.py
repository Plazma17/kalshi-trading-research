"""Polymarket US Ed25519 request signing — for the TRADING phase (orders/portfolio).

Reading market data needs NO auth (it's on the public gateway, see poly_source.py). These
helpers are only needed once we place orders against the authenticated host
`https://api.polymarket.us`.

Scheme reverse-engineered from and matching the official `polymarket-us` SDK (auth.py):
  - message  = f"{timestamp_ms}{METHOD}{path}"   # path is the BARE path, NO query string
  - key      = Ed25519 seed = base64decode(secret_key)[:32]  (the 64-byte secret is seed||pub)
  - signature= base64( ed25519_sign(message) )
  - headers  = X-PM-Access-Key, X-PM-Timestamp (ms), X-PM-Signature
The query string is sent to the server but is NOT part of the signed message. Authenticated
requests go to api.polymarket.us; public reads go to gateway.polymarket.us.

Creds come from the gitignored creds.env (POLYMARKET_KEY_ID / POLYMARKET_SECRET_KEY) via
creds.load(); NEVER hard-code or log them.
"""

from __future__ import annotations

import base64
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

API_BASE = "https://api.polymarket.us"


def _signing_key(secret_key_b64: str) -> Ed25519PrivateKey:
    seed = base64.b64decode(secret_key_b64)
    return Ed25519PrivateKey.from_private_bytes(seed[:32])  # 64-byte secret = seed||pubkey


def auth_headers(key_id: str, secret_key_b64: str, method: str, path: str) -> dict[str, str]:
    """Build the X-PM-* headers for an authenticated request. `path` must be the bare path
    (e.g. '/v1/orders') WITHOUT the query string."""
    ts = str(int(time.time() * 1000))
    sig = _signing_key(secret_key_b64).sign(f"{ts}{method.upper()}{path}".encode())
    return {
        "X-PM-Access-Key": key_id,
        "X-PM-Timestamp": ts,
        "X-PM-Signature": base64.b64encode(sig).decode("ascii"),
    }
