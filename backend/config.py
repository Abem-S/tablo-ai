"""Configuration helpers with secret manager support."""
from __future__ import annotations

import logging
import os
from functools import lru_cache

logger = logging.getLogger("tablo.config")


@lru_cache(maxsize=1)
def _load_vault_secrets() -> dict[str, str]:
    """Load secrets from Vault (KV v2). Returns empty dict if not configured."""
    vault_addr = os.getenv("VAULT_ADDR")
    vault_token = os.getenv("VAULT_TOKEN")
    vault_path = os.getenv("TABLO_VAULT_PATH", "secret/tablo")
    if not vault_addr or not vault_token:
        return {}

    try:
        import hvac
    except ImportError:
        logger.warning("Vault configured but hvac not installed; skipping Vault secrets")
        return {}

    try:
        client = hvac.Client(url=vault_addr, token=vault_token)
        if not client.is_authenticated():
            logger.warning("Vault token authentication failed")
            return {}
        result = client.secrets.kv.v2.read_secret_version(path=vault_path)
        return result.get("data", {}).get("data", {}) or {}
    except Exception as e:
        logger.warning("Failed to read Vault secrets: %s", e)
        return {}


def _read_secret_file(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip()
        return value or None
    except Exception as e:
        logger.warning("Failed to read secret file %s: %s", path, e)
        return None


def get_env(name: str, default: str | None = None, required: bool = False) -> str | None:
    """Read config from env, *_FILE, or Vault (in that order)."""
    file_path = os.getenv(f"{name}_FILE")
    if file_path:
        value = _read_secret_file(file_path)
        if value is not None:
            return value

    value = os.getenv(name, default)
    if value is not None:
        return value

    vault_secrets = _load_vault_secrets()
    if name in vault_secrets:
        return vault_secrets.get(name)

    if required:
        raise RuntimeError(f"Missing required config: {name}")
    return default
