/**
 * U8 — the auth-form state shape shared between the `"use server"` action
 * (`app/actions.ts`) and the client form (`components/LoginForm.tsx`).
 *
 * This lives OUTSIDE `app/actions.ts` on purpose: a `"use server"` module is an
 * RPC boundary and may export only async functions, so a plain value like
 * `initialAuthState` cannot live there. Keeping the type + constant here lets
 * both sides import them without violating that constraint.
 */

/** The state `useActionState` threads through the login form. */
export interface AuthState {
  error: string | null;
  /** A non-blocking notice (e.g. "verify your email") shown after signup when no
   *  session was established. */
  notice: string | null;
}

export const initialAuthState: AuthState = { error: null, notice: null };
