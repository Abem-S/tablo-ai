import sys
import os
import asyncio

sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))


def test():
    from rag.vector_store import _get_client, list_docs_in_collection
    from qdrant_client.models import Filter, FieldCondition, MatchAny, MatchValue

    client = _get_client()
    docs = list_docs_in_collection(client, "tablo_local_admin")
    if not docs:
        print("No docs")
        return

    doc_id = docs[0]["doc_id"]
    print(f"Testing with doc_id={doc_id}")

    # 1. MatchValue
    f1 = Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))])
    res1 = client.scroll(collection_name="tablo_local_admin", scroll_filter=f1, limit=5)
    print(f"MatchValue returns: {len(res1[0])}")

    # 2. MatchAny
    f2 = Filter(must=[FieldCondition(key="doc_id", match=MatchAny(any=[doc_id]))])
    res2 = client.scroll(collection_name="tablo_local_admin", scroll_filter=f2, limit=5)
    print(f"MatchAny returns: {len(res2[0])}")


test()
