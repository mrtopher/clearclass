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
 * its own `NEXT_PUBLIC_INSFORGE_URL` default. `anonKey` is optional here (KTD11 —
 * ClearClass sets none).
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

  const auth = createAuthActions({ cookies: await cookies(), ...authConfig });

  if (mode === "signup") {
    const { data, error } = await auth.signUp({ email, password });
    if (error) {
      return { error: error.message ?? "Sign up failed.", notice: null };
    }
    // signUp sets cookies only when the project auto-confirms. If a session was
    // established, `getCurrentUser` will resolve on the next render — redirect.
    // Otherwise the broker must verify + sign in.
    if (data?.user) {
      redirect("/");
    }
    return {
      error: null,
      notice: "Account created. Check your email to verify, then sign in.",
    };
  }

  const { error } = await auth.signInWithPassword({ email, password });
  if (error) {
    return {
      error: error.message ?? "Sign in failed. Check your email and password.",
      notice: null,
    };
  }
  redirect("/");
}

/** Clear the session cookies and return to the (now unauthenticated) home page. */
export async function signOut(): Promise<void> {
  const auth = createAuthActions({ cookies: await cookies(), ...authConfig });
  await auth.signOut();
  redirect("/");
}
