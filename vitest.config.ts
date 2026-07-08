import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest is the unit/integration runner named in the plan's Verification
 * Contract (`npm test`). Tests live in `__tests__/` dirs (e.g.
 * `scripts/__tests__/chunking.test.ts`) and use the `@/` alias to import the
 * code under test, so a test's location need not sit beside its target.
 *
 * The chunker and ingestion code is plain server-side TypeScript, so the
 * default `node` environment is correct — no jsdom needed.
 */
export default defineConfig({
  // Mirror the tsconfig `@/*` path alias so imports resolve the same way in
  // tests as in the Next.js app and ingestion scripts.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    exclude: ["node_modules", ".next"],
  },
});
