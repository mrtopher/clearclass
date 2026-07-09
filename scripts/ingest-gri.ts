/**
 * U3 — GRI ingestion (offline, scripted).
 *
 * Emits one citable chunk per General Rule of Interpretation (and Additional
 * U.S. Rule) from `lib/gri.ts` to a JSONL file that U4 (embedding + pgvector
 * load) consumes alongside the HTS and ruling chunks. No embeddings or DB
 * writes happen here.
 *
 * Usage:
 *   npm run ingest:gri                 # -> data/gri-chunks.jsonl
 *   npx tsx scripts/ingest-gri.ts --out=/tmp/gri.jsonl
 *
 * Loud-failure contract (mirrors ingest-hts): an unrecognized flag throws; a
 * rule count below the authored floor throws (guards against an accidental
 * truncation of the rule table); the file is written atomically (temp + rename)
 * so an interrupted run cannot leave a truncated corpus.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeJsonlAtomic } from "@/lib/corpus-io";
import { buildGriChunks, GRI_RULE_COUNT } from "@/lib/gri";

const DEFAULT_OUT = "data/gri-chunks.jsonl";

export interface GriArgs {
  out: string;
}

export function parseArgs(argv: string[]): GriArgs {
  let out = DEFAULT_OUT;
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "out" && value) {
      out = value;
    } else {
      throw new Error(
        `Unrecognized argument: ${JSON.stringify(arg)}. Supported: --out=<path>`,
      );
    }
  }
  return { out };
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2));
  const outPath = resolve(process.cwd(), out);

  const chunks = buildGriChunks();
  if (chunks.length < GRI_RULE_COUNT || chunks.length === 0) {
    throw new Error(
      `[ingest-gri] produced ${chunks.length} chunks (< ${GRI_RULE_COUNT} authored). ` +
        `The GRI rule table looks truncated — refusing to write.`,
    );
  }

  await writeJsonlAtomic(outPath, chunks);

  console.log(`[ingest-gri] Wrote ${chunks.length} GRI chunks to ${outPath}`);
  for (const c of chunks) console.log(`  ${c.metadata.label}`);
}

const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
