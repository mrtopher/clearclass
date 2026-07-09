-- U11 — auth + tenant scoping (KTD10): the security surface per-importer memory
-- (U7) is built on top of. This migration lands BEFORE U6/U7 by design — RLS
-- keyed to a JWT that no table can resolve enforces nothing, so the tenant model
-- (importers + broker membership) and the JWT-keyed `classifications` isolation
-- exist first, and U7 adds only the memory *behavior* (similarity search,
-- precedent injection, persistence) on this already-secured table.
--
-- The security invariant (KTD10): the importer a broker acts for is derived from
-- the verified JWT (`auth.uid()`) via `importer_members`, NEVER from the request
-- body or the UI importer selector. RLS is the last line of defense; the route
-- (`app/api/chat`) + `lib/auth.ts` enforce the same rule at the app layer. Both
-- must agree, so a client-supplied tenant key is attacker-controlled and ignored.

CREATE EXTENSION IF NOT EXISTS vector; -- idempotent; U4 already created it.

-- ── importers: the tenant entity (an import company) ──────────────────────────
-- Provisioned out-of-band by the admin key (like the shared corpus), never by a
-- runtime request — hence no runtime INSERT/UPDATE/DELETE policy or grant.
CREATE TABLE public.importers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── importer_members: broker → importer membership ────────────────────────────
-- The ONLY source of truth for which importers a broker (auth.users) may act for.
-- A broker may belong to several importers (the "switch between only those two"
-- edge case in U11); `lib/auth.ts` validates a requested importer against exactly
-- this set. Provisioned by the admin key; runtime is read-only.
CREATE TABLE public.importer_members (
  importer_id UUID NOT NULL REFERENCES public.importers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (importer_id, user_id)
);
-- Index the membership lookup path (auth.uid() → importers) — hit by every RLS
-- policy check via is_importer_member() and by lib/auth.ts tenant resolution.
CREATE INDEX importer_members_user_idx ON public.importer_members (user_id);

-- ── classifications (KTD7): durable per-importer decision history ─────────────
-- `importer_id` is the tenant key (RLS-isolated). `user_id` attributes the
-- decision to the broker who made it; SET NULL on user deletion so the importer's
-- history — a CBP-facing consistency/defensibility argument — survives. The
-- `product_embedding` column exists for U7's per-importer similarity search; the
-- ANN index over it is deferred to U7, which owns the retrieval strategy.
CREATE TABLE public.classifications (
  id BIGSERIAL PRIMARY KEY,
  importer_id UUID NOT NULL REFERENCES public.importers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  product_description TEXT NOT NULL,
  -- text-embedding-3-small (1536-dim), in lockstep with `documents.embedding`.
  product_embedding vector(1536) NOT NULL,
  chosen_hts TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The tenant filter every memory read applies before ordering by similarity (U7).
CREATE INDEX classifications_importer_idx ON public.classifications (importer_id);

-- ── membership helper (SECURITY DEFINER — recursion guard) ────────────────────
-- Called from the `importers` and `classifications` RLS policies. It queries the
-- RLS-enabled `importer_members`; if it ran with the caller's privileges (the
-- default SECURITY INVOKER), that inner read would re-enter RLS and — for any
-- helper chain that loops back — risk the infinite-recursion OOM crash InsForge
-- warns about. SECURITY DEFINER runs it as the owner, bypassing RLS on the inner
-- read and breaking the chain. `search_path` is pinned so the definer cannot be
-- tricked into resolving `importer_members`/`auth.uid` to a hostile object.
CREATE OR REPLACE FUNCTION public.is_importer_member(target_importer UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.importer_members m
    WHERE m.importer_id = target_importer
      AND m.user_id = (SELECT auth.uid())
  );
$$;

-- Only authenticated principals evaluate this (inside their RLS policies). Revoke
-- the default PUBLIC execute so `anon` cannot probe membership directly (it would
-- return false anyway — auth.uid() is null — but the boundary should be explicit).
REVOKE EXECUTE ON FUNCTION public.is_importer_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_importer_member(UUID) TO authenticated;

-- ── RLS: importers ────────────────────────────────────────────────────────────
ALTER TABLE public.importers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read their importers"
ON public.importers
FOR SELECT TO authenticated
USING (public.is_importer_member(id));

-- Authenticated-only table: close it to anon entirely, and keep authenticated
-- read-only (importers are admin-provisioned).
REVOKE ALL ON public.importers FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.importers FROM authenticated;
GRANT SELECT ON public.importers TO authenticated;

-- ── RLS: importer_members ─────────────────────────────────────────────────────
ALTER TABLE public.importer_members ENABLE ROW LEVEL SECURITY;

-- A broker sees only their own memberships. This policy touches NO other table
-- (just auth.uid()), so it is safe as SECURITY INVOKER and cannot recurse — this
-- is the leaf that is_importer_member() reads through.
CREATE POLICY "brokers read own memberships"
ON public.importer_members
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.importer_members FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.importer_members FROM authenticated;
GRANT SELECT ON public.importer_members TO authenticated;

-- ── RLS: classifications ──────────────────────────────────────────────────────
ALTER TABLE public.classifications ENABLE ROW LEVEL SECURITY;

-- Read: any broker who is a member of the row's importer. This is what makes
-- importer A unable to read importer B's history (U7's AE3 precedent stays
-- tenant-scoped) even if the app layer had a bug.
CREATE POLICY "members read importer history"
ON public.classifications
FOR SELECT TO authenticated
USING (public.is_importer_member(importer_id));

-- Write: the broker must both belong to the importer AND stamp themselves as the
-- author (user_id = auth.uid()). WITH CHECK validates the final row; a client
-- cannot persist a decision under an importer it does not belong to, nor forge
-- another broker's authorship.
CREATE POLICY "members insert own decisions"
ON public.classifications
FOR INSERT TO authenticated
WITH CHECK (
  public.is_importer_member(importer_id)
  AND user_id = (SELECT auth.uid())
);

-- Decisions are immutable history (defensibility/audit): no runtime UPDATE/DELETE.
REVOKE ALL ON public.classifications FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.classifications FROM authenticated;
GRANT SELECT, INSERT ON public.classifications TO authenticated;
-- BIGSERIAL PK: INSERT needs USAGE on the identity sequence (the corpus table
-- never granted this because authenticated never inserts into it; here it does).
GRANT USAGE ON SEQUENCE public.classifications_id_seq TO authenticated;
