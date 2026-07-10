/**
 * U8 — minimal email/password auth so the deployed app is usable end-to-end
 * (R11 + the Definition of Done's phone/laptop smoke). Sign-in and sign-up share
 * one form; a `mode` hidden field tells the server action which to run.
 *
 * The mutation itself runs server-side (`app/actions.ts#authenticate`) because
 * only a server context can set the session cookies. This component is just the
 * form: `useActionState` threads the action's `{error, notice}` result back for
 * inline display, and `useFormStatus` disables the button while pending.
 *
 * Note: creating an account authenticates but does not grant importer access —
 * membership is admin-provisioned (KTD10). A fresh signup therefore lands in the
 * "no importer linked" state until an admin links the broker; the page renders
 * that state distinctly.
 */
"use client";

import { useActionState } from "react";

import { authenticate } from "@/app/actions";
import { initialAuthState } from "@/app/auth-state";

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(
    authenticate,
    initialAuthState,
  );

  return (
    <div className="rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
      <h2 className="text-lg font-semibold">Sign in to classify</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Customs brokers only. Your session determines which importer you act for.
      </p>

      <form action={formAction} className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="email" className="text-sm text-neutral-600 dark:text-neutral-400">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="rounded-xl border border-neutral-300 bg-white p-2.5 text-sm outline-none focus:border-neutral-400 focus:ring-2 focus:ring-neutral-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-neutral-800"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="password" className="text-sm text-neutral-600 dark:text-neutral-400">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            className="rounded-xl border border-neutral-300 bg-white p-2.5 text-sm outline-none focus:border-neutral-400 focus:ring-2 focus:ring-neutral-200 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-neutral-800"
          />
        </div>

        {state.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {state.error}
          </p>
        ) : null}
        {state.notice ? (
          <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
            {state.notice}
          </p>
        ) : null}

        {/* Two submit buttons, distinguished by the `mode` they set via
            formAction's implicit form data. Both submit the same fields. */}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            name="mode"
            value="signin"
            disabled={isPending}
            className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {isPending ? "Working…" : "Sign in"}
          </button>
          <button
            type="submit"
            name="mode"
            value="signup"
            disabled={isPending}
            className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Create account
          </button>
        </div>
      </form>
    </div>
  );
}
