-- U9 — lexical (BM25/ts_rank) top-k retrieval RPC over the U4 `documents` corpus.
--
-- The advanced retriever (`lib/retrieval/hybrid.ts`) fuses a DENSE arm (the U5
-- `match_documents` cosine RPC) with a LEXICAL arm — this function — via
-- Reciprocal Rank Fusion, then reranks (`lib/retrieval/rerank.ts`). U4 already
-- provisioned everything the lexical arm needs on the table: the STORED
-- `content_tsv tsvector` generated column and its `documents_content_tsv_gin_idx`
-- GIN index (both created "for U9 hybrid"). This migration only adds the RPC.
--
-- Why an RPC (identical reasoning to `match_documents`): a full-text search that
-- ORDERs BY `ts_rank(...)` cannot be expressed through PostgREST's record
-- endpoint, so we expose it as a function callable at
-- `/api/database/rpc/match_documents_lexical`. `lib/retrieval/hybrid.ts` calls it
-- via the PostgREST proxy with `fetch` (the @insforge/sdk cannot load under a tsx
-- offline script, so the whole retrieval stack stays SDK-free and one transport
-- serves both the agent tool and the eval harness).
--
-- SECURITY INVOKER (the default) is deliberate, exactly as in `match_documents`:
-- the function runs with the caller's privileges, so the `documents` RLS read
-- policy still governs access — an authenticated broker reads the shared corpus,
-- the offline admin key (bypasses RLS) reads it for the eval harness. It must NOT
-- be SECURITY DEFINER, which would leak the corpus to any role that can execute it.

CREATE OR REPLACE FUNCTION public.match_documents_lexical(
  query_text text,
  match_count integer DEFAULT 20,
  filter_type text DEFAULT NULL
)
RETURNS TABLE (
  id bigint,
  content text,
  type text,
  metadata jsonb,
  -- ts_rank score of the row against the query. Named `similarity` so the row
  -- shape is IDENTICAL to `match_documents` and the SDK-free transport can reuse
  -- `toRetrievedChunk` unchanged — RRF fuses on RANK POSITION, not on the raw
  -- score, so the two arms' scores never need to be on the same scale.
  similarity double precision
)
LANGUAGE sql
STABLE
AS $$
  -- `websearch_to_tsquery` (not plainto_/to_tsquery) never throws on arbitrary
  -- product-description input — it treats the text as a web-style search string,
  -- so a broker's free-form query can't produce a tsquery syntax error. A query of
  -- pure stopwords yields an empty tsquery that `@@` matches nothing, correctly
  -- returning zero lexical hits (the dense arm still carries that query).
  SELECT
    d.id,
    d.content,
    d.type,
    d.metadata,
    ts_rank(d.content_tsv, websearch_to_tsquery('english', query_text)) AS similarity
  FROM public.documents d
  WHERE
    -- Only rows that actually match the lexical query (uses the GIN index); an
    -- unmatched row has rank 0 and would only dilute the fused candidate set.
    d.content_tsv @@ websearch_to_tsquery('english', query_text)
    AND (filter_type IS NULL OR d.type = filter_type)
  ORDER BY similarity DESC
  -- Guard against a non-positive match_count producing a LIMIT 0 / error; the
  -- retriever also clamps, but defense in depth keeps a stray RPC call sane.
  LIMIT GREATEST(match_count, 1);
$$;

-- Authorization model mirrors `match_documents` exactly: the ONLY roles that may
-- execute this are `authenticated` (U6 runtime) and the admin key (eval harness,
-- bypasses grants). Postgres grants EXECUTE to PUBLIC by default on CREATE
-- FUNCTION, and PUBLIC includes PostgREST's `anon` role — so REVOKE that default
-- first, otherwise `anon` could still reach the RPC.
REVOKE EXECUTE ON FUNCTION public.match_documents_lexical(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_documents_lexical(text, integer, text) TO authenticated;
