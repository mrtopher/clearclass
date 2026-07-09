-- U7 — per-importer memory: the retrieval strategy over the classifications
-- history U11 already created and secured.
--
-- U11 (create-auth-tenant-tables) landed the `classifications` table, its RLS
-- ("members read importer history" / "members insert own decisions"), and the
-- `product_embedding vector(1536)` column, but DEFERRED the ANN index to U7,
-- "which owns the retrieval strategy". This migration adds exactly that plus the
-- similarity RPC — no new table, no new policy. The isolation guarantee is
-- already in place; U7 only teaches the app how to read precedent and how the DB
-- searches it efficiently.
--
-- Mirrors U5's `match_documents` (create-match-documents-rpc) deliberately: the
-- same "pgvector cosine ORDER BY can't go through PostgREST, so expose a function"
-- shape. The ONE critical difference is the security model — see the RPC below.

CREATE EXTENSION IF NOT EXISTS vector; -- idempotent; U4/U11 already created it.

-- ── ANN index (deferred here from U11) ────────────────────────────────────────
-- HNSW cosine index over the per-importer decision vectors so precedent lookup
-- is an approximate-nearest-neighbour scan, not a full per-importer table scan.
-- Paired with `vector_cosine_ops` + the `<=>` operator at query time, exactly
-- like `documents_embedding_hnsw_idx`. Per-importer history is small, but the
-- index keeps the memory read cheap as an importer accumulates decisions and is
-- the natural home for this concern (U11 left the column un-indexed on purpose).
CREATE INDEX classifications_embedding_hnsw_idx
ON public.classifications
USING hnsw (product_embedding vector_cosine_ops);

-- ── match_classifications: per-importer similarity search ─────────────────────
-- Returns this importer's prior decisions ranked by similarity to a query
-- embedding, so the agent loop can inject them as precedent (AE3).
--
-- SECURITY INVOKER (the default — NOT DEFINER) is the whole point: the function
-- runs with the CALLER's privileges, so the `classifications` RLS SELECT policy
-- ("members read importer history") still governs which rows are visible. A
-- broker can therefore only ever retrieve precedent for importers they belong to,
-- even though `target_importer` is ALSO filtered explicitly below — belt (RLS)
-- and suspenders (the WHERE), matching KTD10's "RLS is the last line of defense".
-- Making this SECURITY DEFINER would bypass RLS and leak one importer's history
-- to another — the exact cross-importer escalation U11's isolation guards against.
CREATE OR REPLACE FUNCTION public.match_classifications(
  query_embedding vector(1536),
  target_importer uuid,
  match_count integer DEFAULT 5
)
RETURNS TABLE (
  id bigint,
  product_description text,
  chosen_hts text,
  confidence double precision,
  reasoning text,
  -- 1 - cosine distance, so higher = closer (in [-1, 1]). ORDER BY sorts on the
  -- raw `<=>` distance ascending so the HNSW cosine index above is used.
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.product_description,
    c.chosen_hts,
    c.confidence,
    c.reasoning,
    1 - (c.product_embedding <=> query_embedding) AS similarity
  FROM public.classifications c
  -- Explicit tenant filter in addition to RLS: a broker who belongs to several
  -- importers gets precedent for ONLY the one they are acting for this request
  -- (the server-derived effective importer), not every importer they can read.
  --
  -- CAVEAT (post-filtering, same class as match_documents' filter_type note):
  -- HNSW is approximate — if the planner uses `classifications_embedding_hnsw_idx`
  -- it returns a bounded GLOBAL candidate pool (hnsw.ef_search, default 40) that
  -- this per-importer WHERE then filters, so a small importer's genuinely-similar
  -- decision could be crowded out of the pool and under-return (< match_count).
  -- This is a RECALL concern only — RLS + this WHERE still guarantee no
  -- cross-importer leakage. At the intended scale (tens of rows per importer) the
  -- planner should prefer the selective btree `classifications_importer_idx` +
  -- an exact sort over that tiny subset, which is both correct and fast; the HNSW
  -- index is the fallback for an importer that accumulates a large history. If
  -- per-importer recall ever degrades at scale, raise ef_search or adopt
  -- pgvector >= 0.8 iterative_scan here.
  WHERE c.importer_id = target_importer
  ORDER BY c.product_embedding <=> query_embedding
  -- Guard a non-positive match_count from producing a LIMIT 0 / error; the app
  -- layer also clamps, but defense in depth keeps a stray RPC call sane.
  LIMIT GREATEST(match_count, 1);
$$;

-- Authorization: only `authenticated` (the U6/U7 runtime, post-U11) may execute
-- this. CREATE FUNCTION grants EXECUTE to PUBLIC by default, and PUBLIC includes
-- PostgREST's `anon` role — so REVOKE that first (mirroring match_documents),
-- otherwise the GRANT is redundant and `anon` could still reach the RPC. An anon
-- call would return no rows anyway (auth.uid() is null → RLS filters everything),
-- but the function boundary should be the authorization, not a downstream policy.
REVOKE EXECUTE ON FUNCTION public.match_classifications(vector, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_classifications(vector, uuid, integer) TO authenticated;
