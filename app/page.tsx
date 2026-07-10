/**
 * U8 — the classifier home page (R4, R5, R9). A Server Component so it resolves
 * the session server-side (the same verified-JWT path the API gate uses) before
 * rendering, and never ships auth logic to the client.
 *
 * Three states, driven by `resolveTenant` (which returns the server-derived
 * importer + memberships, or a discriminated failure):
 *   1. unauthenticated (401) → the sign-in form
 *   2. authenticated with ≥1 importer (ok) → the classifier chat
 *   3. authenticated but no importer membership (403 no-membership) → an
 *      explainer, because membership is admin-provisioned (KTD10) and a fresh
 *      signup legitimately has none yet
 *
 * The importer selector and the `importerId` the chat sends are conveniences;
 * the effective tenant is always re-derived from the token on every `/api/chat`
 * call, so nothing here is a security boundary.
 */
import { getPrincipal, resolveTenant, type ResolveTenantResult } from "@/lib/auth";
import { signOut } from "@/app/actions";
import { ClassifierChat } from "@/components/ClassifierChat";
import { LoginForm } from "@/components/LoginForm";

// This page reads the session cookie (via resolveTenant → cookies()), so it must
// render per-request. Declared explicitly — mirroring `app/api/chat/route.ts` —
// rather than relying on Next's implicit dynamic detection: `resolveSession`'s
// blanket catch would otherwise swallow the `DYNAMIC_SERVER_USAGE` bailout signal
// `cookies()` raises during static prerender, and a slip in detection would cache
// the signed-out login view for every user.
export const dynamic = "force-dynamic";

/**
 * Resolve the session, failing CLOSED to "unauthenticated" if the auth backend
 * is unreachable or misconfigured. `resolveTenant` already fails closed when
 * token *verification* throws, but constructing the SSR client can itself throw
 * (e.g. missing config); rather than white-screening the whole app with a 500,
 * we treat any such failure as "not signed in" and render the login form —
 * consistent with the fail-closed posture in `lib/auth.ts` and the best-effort
 * session refresh in `middleware.ts`.
 */
async function resolveSession(): Promise<ResolveTenantResult> {
  try {
    return await resolveTenant();
  } catch (err) {
    console.error("[page] auth resolution failed; rendering signed-out view", err);
    return { ok: false, status: 401, reason: "unresolved" };
  }
}

export default async function Home() {
  const resolution = await resolveSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">ClearClass</h1>
          <p className="max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
            Defensible HTS classification for customs brokers — top-3 candidates
            with GRI reasoning, citations, and confidence.
          </p>
        </div>
        {resolution.ok || resolution.status === 403 ? <SignOutButton /> : null}
      </header>

      {resolution.ok ? (
        <ClassifierChat
          memberships={resolution.context.memberships}
          defaultImporterId={resolution.context.importerId}
        />
      ) : resolution.status === 401 ? (
        <LoginForm />
      ) : (
        <NoImporter />
      )}
    </main>
  );
}

function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900"
      >
        Sign out
      </button>
    </form>
  );
}

/** Authenticated, but the broker belongs to no importer yet — membership is
 *  admin-provisioned (KTD10), so self-signup alone cannot classify. */
async function NoImporter() {
  const principal = await getPrincipal();
  return (
    <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950/30">
      <h2 className="text-lg font-semibold text-amber-900 dark:text-amber-200">
        No importer linked to your account
      </h2>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-300/80">
        {principal?.email ? `You're signed in as ${principal.email}. ` : ""}
        Your account isn&apos;t linked to any importer yet. An administrator must
        grant you membership before you can classify — this keeps each importer&apos;s
        classification history isolated.
      </p>
    </section>
  );
}
