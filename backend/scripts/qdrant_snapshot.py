"""Create Qdrant collection snapshots (server-side)."""

from __future__ import annotations

import json
import os
import sys
import urllib.request


def _request(method: str, url: str):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    base = os.getenv("QDRANT_URL", "http://localhost:6333").rstrip("/")
    collections = (
        _request("GET", f"{base}/collections").get("result", {}).get("collections", [])
    )
    if not collections:
        print("No Qdrant collections found.")
        return 0

    for col in collections:
        name = col.get("name")
        if not name:
            continue
        data = _request("POST", f"{base}/collections/{name}/snapshots")
        snap = data.get("result", {}).get("name", "")
        print(f"Snapshot created for {name}: {snap}")

    print("Snapshots are stored under /qdrant/snapshots in the Qdrant container.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
