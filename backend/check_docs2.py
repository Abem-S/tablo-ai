import sys
import os

sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))


def test():
    from rag.vector_store import _get_client, list_docs_in_collection

    client = _get_client()
    docs = list_docs_in_collection(client, "tablo_local_admin")
    doc_ids = [d["doc_id"] for d in docs]
    print(f"All Doc IDs in Qdrant: {doc_ids}")


test()
