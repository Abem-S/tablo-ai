import asyncio
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))
from rag.vector_store import _get_client, get_points_by_doc_id


def test():
    client = _get_client()
    doc_id = "98f1dc94-0fab-419e-90ca-ab6954328d23"
    points = get_points_by_doc_id(client, "tablo_local_admin", doc_id)
    print(f"Total points: {len(points)}")
    if points:
        print(f"Sample text 1: {points[0]['payload'].get('text')[:100]}")
        print(f"Sample text 2: {points[1]['payload'].get('text')[:100]}")
        print(f"Sample text 3: {points[2]['payload'].get('text')[:100]}")


test()
