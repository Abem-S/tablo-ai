"""Single-player authentication for Tablo OSS.

Design: one admin password in .env, one hardcoded user_id = "local_admin".
No OAuth, no JWTs, no user accounts — this is a self-hosted single-user app.

How it works:
- TABLO_ADMIN_PASSWORD must be set in backend/.env
- POST /auth/login verifies the password and returns a signed session token
- All protected endpoints require the token via Authorization: Bearer <token>
- The token encodes user_id = "local_admin" so every action is isolated
  to the tablo_local_admin Qdrant collection

Why this approach:
- Immediately fixes the Qdrant user isolation bug (user_id is no longer None)
- Secures the self-hosted app from open internet access
- Zero complexity — no database, no OAuth, no refresh tokens
- Trivially replaceable with real auth in a SaaS fork
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from functools import lru_cache

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import get_env

logger = logging.getLogger("tablo.auth")

# The single user ID for the local admin — all data is scoped to this
LOCAL_ADMIN_USER_ID = "local_admin"

# Token validity: 30 days (self-hosted, no refresh needed)
TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

_bearer = HTTPBearer(auto_error=False)


@lru_cache(maxsize=1)
def _get_secret_key() -> str:
    """Derive a stable signing key from the admin password + a fixed salt."""
    password = get_env("TABLO_ADMIN_PASSWORD") or ""
    if not password:
        logger.warning(
            "TABLO_ADMIN_PASSWORD is not set — auth is disabled. "
            "Set it in backend/.env to secure your instance."
        )
    # Use PBKDF2 to derive a signing key from the password
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        b"tablo-oss-salt-v1",
        iterations=100_000,
    )
    return key.hex()


def _sign(payload: str) -> str:
    """HMAC-SHA256 sign a payload string."""
    key = bytes.fromhex(_get_secret_key())
    return hmac.new(key, payload.encode("utf-8"), hashlib.sha256).hexdigest()


def create_session_token(user_id: str = LOCAL_ADMIN_USER_ID) -> str:
    """Create a signed session token encoding user_id and expiry.

    Format: {user_id}:{expires_at}:{signature}
    """
    expires_at = int(time.time()) + TOKEN_TTL_SECONDS
    payload = f"{user_id}:{expires_at}"
    sig = _sign(payload)
    return f"{payload}:{sig}"


def verify_session_token(token: str) -> str | None:
    """Verify a session token and return the user_id, or None if invalid."""
    try:
        parts = token.split(":")
        if len(parts) != 3:
            return None
        user_id, expires_at_str, sig = parts
        expires_at = int(expires_at_str)
        if time.time() > expires_at:
            logger.debug("Session token expired")
            return None
        payload = f"{user_id}:{expires_at_str}"
        expected_sig = _sign(payload)
        if not hmac.compare_digest(sig, expected_sig):
            logger.warning("Session token signature mismatch")
            return None
        return user_id
    except Exception as e:
        logger.debug("Token verification failed: %s", e)
        return None


def verify_admin_password(password: str) -> bool:
    """Check if the provided password matches TABLO_ADMIN_PASSWORD."""
    expected = get_env("TABLO_ADMIN_PASSWORD") or ""
    if not expected:
        # No password set — allow all access (dev mode)
        logger.warning("TABLO_ADMIN_PASSWORD not set — allowing unauthenticated access")
        return True
    return hmac.compare_digest(password, expected)


def is_auth_enabled() -> bool:
    """Return True if TABLO_ADMIN_PASSWORD is configured."""
    return bool(get_env("TABLO_ADMIN_PASSWORD"))


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """FastAPI dependency: extract and verify the session token.

    Returns the user_id (always "local_admin" for OSS).
    Raises 401 if auth is enabled and the token is missing/invalid.
    """
    if not is_auth_enabled():
        # Auth disabled — return default user_id
        return LOCAL_ADMIN_USER_ID

    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please log in at /auth/login.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = verify_session_token(credentials.credentials)
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session token. Please log in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return user_id


# Optional dependency — returns user_id if authenticated, else None
# Used for endpoints that work both authenticated and unauthenticated
async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    if not is_auth_enabled():
        return LOCAL_ADMIN_USER_ID
    if credentials is None:
        return None
    return verify_session_token(credentials.credentials)
