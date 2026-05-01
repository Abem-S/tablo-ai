"""Restore a Qdrant collection snapshot."""

from __future__ import annotations

import json
import os
import sys
import urllib.request


def _request(method: str, url: str):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: python scripts/qdrant_restore.py <collection> <snapshot_name>")
        return 2

    collection = sys.argv[1]
    snapshot = sys.argv[2]
    base = os.getenv("QDRANT_URL", "http://localhost:6333").rstrip("/")

    data = _request(
        "POST", f"{base}/collections/{collection}/snapshots/{snapshot}/recover"
    )
    ok = data.get("status", "") == "ok"
    print("Restore result:", data)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
