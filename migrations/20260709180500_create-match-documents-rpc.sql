-- U5 — cosine top-k retrieval RPC over the U4 `documents` corpus.
--
-- U4 stopped at the table + HNSW index and deliberately left retrieval to U5
-- (see the create-documents migration). pgvector similarity search cannot be
-- expressed through PostgREST's record endpoint — it needs an ORDER BY on the
-- `<=>` operator — so we expose it as a Postgres function callable at
-- `/api/database/rpc/match_documents`. `lib/retrieval/dense.ts` calls it via the
-- PostgREST proxy (the @insforge/sdk cannot load under a tsx offline script, so
-- the retriever stays SDK-free and both the agent tool and the eval recall
-- harness share one transport).
--
-- SECURITY INVOKER (the default) is deliberate: the function runs with the
-- caller's privileges, so the `documents` RLS read policy still governs access —
-- an authenticated broker reads the shared corpus, the offline admin key
-- (which bypasses RLS) reads it for the recall harness. It must NOT be
-- SECURITY DEFINER, which would leak the corpus to any role that can execute it.

CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding vector(1536),
  match_count integer DEFAULT 8,
  filter_type text DEFAULT NULL
)
RETURNS TABLE (
  id bigint,
  content text,
  type text,
  metadata jsonb,
  -- 1 - cosine distance, so higher = closer (in [-1, 1]). The ORDER BY still
  -- sorts on the raw `<=>` distance ascending so the HNSW cosine index is used.
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    d.id,
    d.content,
    d.type,
    d.metadata,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM public.documents d
  WHERE filter_type IS NULL OR d.type = filter_type
  ORDER BY d.embedding <=> query_embedding
  -- Guard against a non-positive match_count producing a LIMIT 0 / error; the
  -- retriever also clamps, but defense in depth keeps a stray RPC call sane.
  LIMIT GREATEST(match_count, 1);
$$;

-- The only runtime caller is an authenticated request (U6, post-U11); the
-- offline recall harness authenticates with the admin key which bypasses grants.
GRANT EXECUTE ON FUNCTION public.match_documents(vector, integer, text) TO authenticated;
