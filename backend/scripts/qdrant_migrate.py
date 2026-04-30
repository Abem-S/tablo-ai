"""Ensure Qdrant payload indexes exist for all collections."""
from __future__ import annotations

import os
import sys

from rag import vector_store as vs


def main() -> int:
    client = vs._get_client()
    collections = client.get_collections().collections
    if not collections:
        print("No collections found.")
        return 0

    for col in collections:
        name = col.name
        print(f"Ensuring indexes for {name}...")
        vs._ensure_payload_indexes(client, name)

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
