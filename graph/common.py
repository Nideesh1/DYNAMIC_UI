"""Shared setup: env, Graphiti/Falkor clients, Gemini embeddings with backoff + disk cache."""

from __future__ import annotations

import asyncio
import hashlib
import os
import pickle
import random
from pathlib import Path

os.environ.setdefault('GRAPHITI_TELEMETRY_ENABLED', 'false')

from dotenv import load_dotenv  # noqa: E402

GRAPH_DIR = Path(__file__).resolve().parent
ROOT = GRAPH_DIR.parent
CACHE = GRAPH_DIR / 'cache'
CACHE.mkdir(exist_ok=True)
load_dotenv(ROOT / '.env')

GROUP_ID = 'cb6'
DATABASE = 'cb6'
# Embedding backend. 'local' (default) = fastembed BAAI/bge-small-en-v1.5 (384-d, no quota).
# 'gemini' = gemini-embedding-001 @1024-d; the free-tier key is capped at 100 texts/min + ~1000/day,
# too small for ~6.5k node/edge texts, so local is the default. Queries MUST use the same backend.
EMBED_BACKEND = os.getenv('CB6_EMBED_BACKEND', 'local')
LOCAL_EMBED_MODEL = 'BAAI/bge-small-en-v1.5'
EMBED_MODEL = 'gemini-embedding-001'
EMBED_DIM = 1024 if EMBED_BACKEND == 'gemini' else 384
LLM_MODEL = 'gemini-3.5-flash-lite'  # never use 3.x flash here: free-tier quota reserved for the live app
SMALL_LLM_MODEL = 'gemini-3.5-flash-lite'  # gemini-2.5-flash-lite is 404 for this key
FALKOR_HOST = os.getenv('FALKOR_HOST', 'localhost')
FALKOR_PORT = int(os.getenv('FALKOR_PORT', '6379'))

RESOLUTIONS = ROOT / 'blockparty/data/resolutions_MCB6.jsonl'
TRANSCRIPTS = ROOT / 'blockparty/data/transcripts_MCB6.jsonl'
EVENTS = ROOT / 'cb6/data/rest/community_event.json'


def api_key() -> str:
    k = os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY')
    if not k:
        raise RuntimeError('GEMINI_API_KEY missing from ../.env')
    return k


def get_driver():
    from graphiti_core.driver.falkordb_driver import FalkorDriver

    return FalkorDriver(host=FALKOR_HOST, port=FALKOR_PORT, database=DATABASE)


def get_graphiti(driver=None):
    """Full Graphiti instance (for hybrid search). Not needed for plain Cypher."""
    from graphiti_core import Graphiti
    from graphiti_core.cross_encoder.gemini_reranker_client import GeminiRerankerClient
    from graphiti_core.embedder.gemini import GeminiEmbedder, GeminiEmbedderConfig
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.gemini_client import GeminiClient

    key = api_key()
    return Graphiti(
        graph_driver=driver or get_driver(),
        llm_client=GeminiClient(
            LLMConfig(api_key=key, model=LLM_MODEL, small_model=SMALL_LLM_MODEL)
        ),
        embedder=LocalEmbedderClient() if EMBED_BACKEND == 'local' else GeminiEmbedder(
            GeminiEmbedderConfig(api_key=key, embedding_model=EMBED_MODEL, embedding_dim=EMBED_DIM),
            batch_size=100,
        ),
        cross_encoder=GeminiRerankerClient(LLMConfig(api_key=key, model=SMALL_LLM_MODEL)),
    )


# ------------------------------------------------------------- embeddings
_EMB_PATH = CACHE / f'embeddings_{EMBED_BACKEND}.pkl'
_FASTEMBED = None


def _fastembed():
    global _FASTEMBED
    if _FASTEMBED is None:
        from fastembed import TextEmbedding

        _FASTEMBED = TextEmbedding(LOCAL_EMBED_MODEL, cache_dir=str(CACHE / 'fastembed'))
    return _FASTEMBED


def local_embed(texts: list[str]) -> list[list[float]]:
    return [v.tolist() for v in _fastembed().embed(texts, batch_size=64)]


def _make_local_client():
    from graphiti_core.embedder.client import EmbedderClient

    class _Local(EmbedderClient):
        async def create(self, input_data):
            text = input_data if isinstance(input_data, str) else list(input_data)[0]
            return (await asyncio.to_thread(local_embed, [text]))[0]

        async def create_batch(self, input_data_list):
            return await asyncio.to_thread(local_embed, list(input_data_list))

    return _Local()


def LocalEmbedderClient():  # noqa: N802 - factory that looks like a class to callers
    return _make_local_client()


class Embedder:
    """Batch embedder with 429 backoff and a persistent text->vector cache."""

    def __init__(self):
        self.client = None
        if EMBED_BACKEND == 'gemini':
            from google import genai

            self.client = genai.Client(api_key=api_key())
        self.cache: dict[str, list[float]] = {}
        if _EMB_PATH.exists():
            self.cache = pickle.loads(_EMB_PATH.read_bytes())
        self.api_calls = 0

    @staticmethod
    def _h(text: str) -> str:
        return hashlib.sha1(text.encode()).hexdigest()

    def save(self):
        tmp = _EMB_PATH.with_suffix('.tmp')
        tmp.write_bytes(pickle.dumps(self.cache))
        tmp.replace(_EMB_PATH)

    async def _call(self, batch: list[str]) -> list[list[float]]:
        if EMBED_BACKEND == 'local':
            self.api_calls += 1
            return await asyncio.to_thread(local_embed, batch)
        from google.genai import types

        for attempt in range(8):
            try:
                self.api_calls += 1
                r = await self.client.aio.models.embed_content(
                    model=EMBED_MODEL,
                    contents=batch,
                    config=types.EmbedContentConfig(output_dimensionality=EMBED_DIM),
                )
                return [e.values for e in r.embeddings]
            except Exception as e:  # 429 / 5xx
                msg = str(e)
                if attempt == 7 or not any(c in msg for c in ('429', '500', '503', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE')):
                    raise
                await asyncio.sleep(min(60, 2**attempt + random.random()))
        raise RuntimeError('unreachable')

    async def embed(self, texts: list[str], batch_size: int = 100, concurrency: int = 4) -> list[list[float]]:
        missing = list({self._h(t): t for t in texts if self._h(t) not in self.cache}.values())

        async def run(batch):
            async with sem:
                vecs = await self._call(batch)
                for t, v in zip(batch, vecs, strict=True):
                    self.cache[self._h(t)] = list(v)

        if EMBED_BACKEND == 'local':
            concurrency, batch_size = 1, 512
        sem = asyncio.Semaphore(concurrency)
        await asyncio.gather(*(run(missing[i : i + batch_size]) for i in range(0, len(missing), batch_size)))
        if missing:
            self.save()
        return [self.cache[self._h(t)] for t in texts]


async def write_bulk(driver, nodes, edges, embedder: Embedder, chunk: int = 300):
    """Embed names/facts (cached) then write via graphiti's add_nodes_and_edges_bulk in chunks."""
    from graphiti_core.utils.bulk_utils import add_nodes_and_edges_bulk

    if nodes:
        vecs = await embedder.embed([n.name for n in nodes])
        for n, v in zip(nodes, vecs, strict=True):
            n.name_embedding = v
    if edges:
        vecs = await embedder.embed([e.fact for e in edges])
        for e, v in zip(edges, vecs, strict=True):
            e.fact_embedding = v
    for i in range(0, len(nodes), chunk):
        await add_nodes_and_edges_bulk(driver, [], [], nodes[i : i + chunk], [], None)
    for i in range(0, len(edges), chunk):
        await add_nodes_and_edges_bulk(driver, [], [], [], edges[i : i + chunk], None)
