"""Viewer tokens: HMAC-signed, self-describing (scope and/or run + expiry). See docs/SPEC.md "Scopes & auth".

Format (no padding anywhere, base64url = RFC 4648 section 5 without "="):

    token   = payload "." sig
    payload = base64url(UTF-8 JSON {"scope": str|null, "run": str|null, "exp": int unix seconds})
    sig     = base64url(HMAC-SHA256(key=secret UTF-8, msg=payload ASCII))

The signature covers the encoded payload string exactly as sent, so any JSON serializer works for minting.
A token with scope null and run null is an admin token (sees every run).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


class TokenError(ValueError):
    """Invalid, tampered or expired token."""


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sig(secret: str, payload: str) -> str:
    return _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())


def make_token(secret: str, scope: str | None = None, run: str | None = None, ttl_s: int = 3600) -> str:
    """Mint a viewer token for `agentglow serve --secret`. scope/run None = not restricted (both None = admin)."""
    if not secret:
        raise ValueError("secret is required")
    body = {"scope": scope, "run": run, "exp": int(time.time()) + int(ttl_s)}
    payload = _b64(json.dumps(body, separators=(",", ":")).encode())
    return f"{payload}.{_sig(secret, payload)}"


def verify_token(secret: str, token: str, now: float | None = None) -> dict:
    """-> {"scope", "run", "exp"}; raises TokenError."""
    try:
        payload, sig = token.strip().split(".")
    except (AttributeError, ValueError):
        raise TokenError("malformed token")
    if not hmac.compare_digest(sig, _sig(secret, payload)):
        raise TokenError("bad signature")
    try:
        body = json.loads(_unb64(payload))
        exp = int(body["exp"])
    except Exception:
        raise TokenError("malformed payload")
    if exp < (time.time() if now is None else now):
        raise TokenError("expired")
    scope, run = body.get("scope"), body.get("run")
    return {"scope": str(scope) if scope else None, "run": str(run) if run else None, "exp": exp}
