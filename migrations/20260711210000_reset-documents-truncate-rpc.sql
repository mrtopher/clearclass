-- Post-U12 fix — corpus reset must TRUNCATE, not DELETE (HNSW bloat).
--
-- The embed-load script's full-load "truncate first" step originally issued a
-- PostgREST DELETE (`/api/database/records/documents?id=gte.0`). That is wrong
-- for a pgvector table: an HNSW index does NOT reclaim graph nodes on DELETE —
-- deleted vectors leave tombstones and each reload grafts a fresh graph on top.
-- Repeated delete-and-reload cycles bloated `documents_embedding_hnsw_idx` to
-- ~248 MB for ~7.8k rows (vs. ~7.8 KB/row healthy), and maintaining that bloated
-- in-memory graph during inserts OOM-killed the database (SIGKILL, repeated
-- crash-recovery) — a full outage. TRUNCATE resets the heap AND the index files
-- in one shot, so the bloat cannot accumulate.
--
-- PostgREST cannot express TRUNCATE (it is a utility statement, not DML), so we
-- expose it as a function callable at `/api/database/rpc/reset_documents`,
-- mirroring how `match_documents` exposes pgvector search. `scripts/embed-load.ts`
-- calls it via the same PostgREST proxy the retriever uses.
--
-- SECURITY DEFINER (unlike match_documents' INVOKER): TRUNCATE requires table
-- ownership, which the runtime roles do not have — the function must run as its
-- owner (the migration role that owns `documents`). Because a corpus wipe is
-- destructive, EXECUTE is REVOKEd from PUBLIC so neither `anon` nor
-- `authenticated` (a broker) can ever call it; only the offline admin key —
-- which bypasses grants — reaches it, exactly as intended for an out-of-band
-- corpus reload. `SET search_path` is the standard SECURITY DEFINER hardening
-- against search-path hijacking.

CREATE OR REPLACE FUNCTION public.reset_documents()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  TRUNCATE public.documents;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_documents() FROM PUBLIC;
