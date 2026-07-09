-- U4 — corpus store: embeddings + pgvector, HNSW, and the tsvector column U9 hybrid search needs.
--
-- `documents` is SHARED reference data (HTS lines, GRI rules, CBP rulings), not
-- per-user rows. Every authenticated broker retrieves from the SAME corpus, so
-- there is deliberately no `owner_id` and no per-user RLS here — the read policy
-- lets any authenticated principal SELECT, and nothing else. Per-importer
-- isolation lives on `classifications` (U7), keyed to the JWT importer; do not
-- conflate the two. Writes happen only from the offline admin load
-- (`scripts/embed-load.ts` via the project API key, which bypasses RLS), never
-- from a runtime authenticated request — hence no INSERT/UPDATE/DELETE policy.
--
-- Retrieval itself (the cosine `match` RPC) is U5's concern; U4 stops at the
-- table, indexes, and grants so U5 can build the retriever on a populated store.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.documents (
  id BIGSERIAL PRIMARY KEY,
  -- Materialized, self-describing chunk text (U2 ancestor path / GRI rule /
  -- ruling summary) — this is what gets embedded and what U5 returns for citation.
  content TEXT NOT NULL,
  -- text-embedding-3-small output dimension is 1536. A vector column's dimension
  -- cannot be altered in place. NOTE on the plan's DB-cap mitigation: at the
  -- ~407 MB the full corpus already occupies (of a 500 MB free tier), you CANNOT
  -- hold a second embedding generation alongside this one, so "re-embed into a new
  -- column" is not reachable without first dropping this column (a hard cutover) or
  -- moving to a paid tier. To reclaim headroom, prefer re-loading at a smaller
  -- `dimensions` (e.g. 1024/512) from a fresh, truncated table.
  embedding vector(1536) NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT 'openai/text-embedding-3-small',
  -- Corpus discriminator: 'hts' | 'gri' | 'ruling'. Indexed for metadata filters.
  type TEXT NOT NULL,
  -- Heterogeneous per-type citation metadata (hts_code, ruling_number, rule, …).
  -- Small and read whole alongside the chunk, so JSONB is the right shape here.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Precomputed lexical vector for U9 hybrid (BM25/ts_rank) retrieval. STORED so
  -- the GIN index and ts_rank read it directly instead of recomputing per query.
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- Shared corpus: any authenticated broker may read every row. There is no write
-- policy — the corpus is loaded out-of-band by the admin key, so authenticated
-- runtime requests can read but never mutate it.
CREATE POLICY "authenticated can read corpus"
ON public.documents
FOR SELECT TO authenticated
USING (true);

-- Runtime roles get broad DML by default so RLS can decide access; narrow that to
-- SELECT-only here since the only legitimate authenticated operation is reading.
REVOKE INSERT, UPDATE, DELETE ON public.documents FROM authenticated;
GRANT SELECT ON public.documents TO authenticated;

-- HNSW cosine index for approximate nearest-neighbour search (U5). Safe to build
-- on the empty table; pair `vector_cosine_ops` with the `<=>` operator at query time.
CREATE INDEX documents_embedding_hnsw_idx
ON public.documents
USING hnsw (embedding vector_cosine_ops);

-- Lexical index for U9 hybrid search.
CREATE INDEX documents_content_tsv_gin_idx
ON public.documents
USING gin (content_tsv);

-- Metadata filter used by retrieval/eval to scope by corpus source.
CREATE INDEX documents_type_idx ON public.documents (type);
