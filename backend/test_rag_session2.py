import asyncio
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))
from rag.retrieval import RetrievalPipeline
from rag.knowledge_graph import KnowledgeGraph
from rag.vector_store import _get_client, list_docs_in_collection


async def test():
    client = _get_client()
    kg = KnowledgeGraph()
    kg.load()
    r = RetrievalPipeline(kg, "tablo_local_admin", "local_admin")

    docs = list_docs_in_collection(client, r._collection)
    if not docs:
        print("No docs found")
        return

    for query in ["database design", "OSI model", "difference between verbs"]:
        res = await r.retrieve(query, "t1", allowed_doc_ids=[docs[0]["doc_id"]])
        print(f"Query: {query} -> chunks: {len(res.context.sources)}")


asyncio.run(test())
