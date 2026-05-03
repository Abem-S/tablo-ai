import asyncio
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "backend"))
from rag.retrieval import RetrievalPipeline
from rag.knowledge_graph import KnowledgeGraph
from rag.vector_store import _get_client


async def test():
    client = _get_client()
    kg = KnowledgeGraph()
    kg.load()
    r = RetrievalPipeline(kg, "tablo_local_admin", "local_admin")

    doc_id = "98f1dc94-0fab-419e-90ca-ab6954328d23"
    for query in ["primary keys", "database design"]:
        res = await r.retrieve(query, "t1", allowed_doc_ids=[doc_id])
        print(f"Query: {query} -> chunks: {len(res.context.sources)}")


asyncio.run(test())
