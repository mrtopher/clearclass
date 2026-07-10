/**
 * U8 — server actions for the minimal auth surface the classifier UI needs.
 *
 * Auth mutations MUST run server-side: the SDK's browser client is read-only for
 * auth, and only a server context can write the session cookies —
 * `insforge_access_token` (JS-readable) and `insforge_refresh_token` (httpOnly,
 * server-owned). `createAuthActions()` owns that cookie write; we hand it the
 * request's cookie store (`next/headers`).
 *
 * The same env contract as `lib/auth.ts#getServerClient`: pass `baseUrl`/`anonKey`
 * explicitly so the SSR helper honors `NEXT_PUBLIC_INSFORGE_BASE_URL` rather than
 * its own `NEXT_PUBLIC_INSFORGE_URL` default. `anonKey` is REQUIRED here: the
 * `@insforge/sdk/ssr` helpers (unlike the plain `createClient`) throw
 * "Missing InsForge baseUrl or anonKey" when it is unset. It is a client-safe
 * PUBLIC key (`NEXT_PUBLIC_INSFORGE_ANON_KEY`), not the admin key — it must be set
 * in `.env.local` and the deploy env or every auth action here fails. The auth
 * calls are wrapped so a missing-key/backend failure returns an inline error
 * rather than an opaque uncaught server-action throw.
 *
 * Security note: creating an account does NOT grant importer access. Membership
 * (`importer_members`) is admin-provisioned and runtime-read-only by design
 * (KTD10), so a fresh signup authenticates but lands in the "no importer" state
 * until an admin links the broker. That is the intended posture, not a gap.
 */
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAuthActions } from "@insforge/sdk/ssr";

import type { AuthState } from "@/app/auth-state";

const authConfig = {
  baseUrl: process.env.NEXT_PUBLIC_INSFORGE_BASE_URL ?? "",
  anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY,
} as const;

/**
 * Sign in or sign up depending on the form's `mode` field, then set the session
 * cookies. On a successful sign-in (an active session now exists) we redirect to
 * `/` so the server component re-renders as authenticated and reads the fresh
 * cookies. Sign-up may or may not establish a session depending on whether the
 * project requires email verification; if it did not, we surface a notice rather
 * than redirect. Failures return an error string the form renders inline.
 */
export async function authenticate(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const mode = formData.get("mode") === "signup" ? "signup" : "signin";
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email and password are required.", notice: null };
  }

  // Resolve the outcome inside a try so a config/backend failure (e.g. a missing
  // anonKey making createAuthActions throw) becomes an inline error instead of an
  // opaque uncaught server-action rejection. `sessionEstablished` gates the
  // redirect, which is issued AFTER the try — `redirect()` throws the
  // NEXT_REDIRECT sentinel and must not be caught here.
  let outcome: AuthState;
  let sessionEstablished = false;
  try {
    const auth = createAuthActions({ cookies: await cookies(), ...authConfig });

    if (mode === "signup") {
      const { data, error } = await auth.signUp({ email, password });
      if (error) {
        outcome = { error: error.message ?? "Sign up failed.", notice: null };
      } else if (data?.user && data.requireEmailVerification !== true) {
        // A session was established (project auto-confirms) — redirect below.
        sessionEstablished = true;
        outcome = { error: null, notice: null };
      } else {
        // Email verification pending: signUp returns a user but sets NO cookies
        // (the access token is null), so there is no session yet. Do NOT redirect
        // on `data.user` alone — the broker must verify then sign in.
        outcome = {
          error: null,
          notice: "Account created. Check your email to verify, then sign in.",
        };
      }
    } else {
      const { error } = await auth.signInWithPassword({ email, password });
      if (error) {
        outcome = {
          error: error.message ?? "Sign in failed. Check your email and password.",
          notice: null,
        };
      } else {
        sessionEstablished = true;
        outcome = { error: null, notice: null };
      }
    }
  } catch (err) {
    console.error("[auth] authenticate action failed", err);
    return {
      error: "Authentication is temporarily unavailable. Please try again.",
      notice: null,
    };
  }

  if (sessionEstablished) {
    // Re-render `/` as authenticated; the fresh cookies are read server-side.
    redirect("/");
  }
  return outcome;
}

/** Clear the session cookies and return to the (now unauthenticated) home page.
 *  A failure to reach the backend still redirects — a stale token simply fails
 *  the next `getCurrentUser` and the app fails closed to login. */
export async function signOut(): Promise<void> {
  try {
    const auth = createAuthActions({ cookies: await cookies(), ...authConfig });
    await auth.signOut();
  } catch (err) {
    console.warn("[auth] signOut failed; redirecting anyway", err);
  }
  redirect("/");
}
