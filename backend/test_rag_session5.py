import sys
import os

sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))
from rag.vector_store import _get_client


def test():
    client = _get_client()
    points, _ = client.scroll(
        collection_name="tablo_local_admin",
        limit=10000,
        with_payload=True,
    )
    for p in points:
        if (
            p.payload
            and p.payload.get("doc_id") == "98f1dc94-0fab-419e-90ca-ab6954328d23"
        ):
            print(f"FOUND POINT!")
            print(f"Payload doc_id type: {type(p.payload.get('doc_id'))}")
            print(f"Payload doc_id value: {p.payload.get('doc_id')!r}")
            break
    else:
        print("Point not found manually either.")


test()
