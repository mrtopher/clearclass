/**
 * Hierarchy-preserving HTS chunking — the highest lever on classification
 * accuracy (KTD3, U2).
 *
 * The USITC export is a flat list of rows whose tree structure lives entirely
 * in the `indent` field. A row is a *leaf* (an actual classifiable HTS line)
 * when no following row is nested deeper; everything above it — the 4-digit
 * heading, the 6/8-digit rate lines, and `superior:"true"` grouping rows with
 * an empty `htsno` — is context. We emit exactly one chunk per leaf, with the
 * full ancestor path materialized into the chunk text so a retrieved chunk is
 * self-describing and citable without walking back to the schedule.
 *
 * Duty rates are inherited: a 10-digit statistical leaf usually has an empty
 * `general`, while the real rate sits on its 8-digit rate-line ancestor. We
 * walk up the ancestor stack to resolve `general_duty` rather than reading the
 * leaf blindly.
 *
 * This module is intentionally pure (no network, no fs) so the accuracy-
 * critical logic is fully unit-testable with fixtures; `scripts/ingest-hts.ts`
 * owns fetching and persistence.
 */

/** One row of the USITC `exportList` JSON (fields we rely on). */
export interface HtsRow {
  /** HTS number, e.g. "6109.10.00.12". Empty on `superior` grouping rows. */
  htsno: string;
  /** Tree depth as a numeric string, e.g. "0", "1", "2". */
  indent: string;
  /** "true" on grouping rows that only supply descriptive context. */
  superior: string | null;
  /** Units of quantity, e.g. ["doz.", "kg"]. May be null/empty. */
  units: string[] | null;
  /** General (column 1) duty rate. Often empty on statistical leaves. */
  general: string;
  description: string;
  special?: string;
  other?: string;
}

export interface HtsChunk {
  /** Materialized text for embedding: full ancestor path, root -> leaf. */
  content: string;
  /** Corpus type discriminator for the shared `documents` table (U4). */
  type: "hts";
  metadata: {
    /** 2-digit chapter, e.g. "61". */
    chapter: string;
    /** 4-digit heading, e.g. "6109". */
    heading: string;
    /** 6-digit subheading in dotted form, e.g. "6109.10". */
    subheading: string;
    /** The leaf's canonical HTS code, verbatim from the schedule. */
    hts_code: string;
    /** Units of quantity for the leaf. */
    units: string[];
    /** General duty rate, inherited from the nearest ancestor if the leaf's own is empty. */
    general_duty: string;
  };
}

/** Separator between ancestor descriptions in the chunk text. */
const PATH_SEP = " > ";

function parseIndent(row: HtsRow, index: number): number {
  const n = Number.parseInt(row.indent, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(
      `Malformed HTS row at index ${index}: non-numeric indent ${JSON.stringify(
        row.indent,
      )} (description: ${JSON.stringify(row.description)})`,
    );
  }
  return n;
}

/**
 * Resolve the general duty rate for a leaf: prefer the leaf's own rate, else
 * the nearest ancestor (deepest first) that carries one.
 */
function resolveGeneralDuty(leaf: HtsRow, ancestors: HtsRow[]): string {
  if (leaf.general.trim()) return leaf.general.trim();
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const rate = ancestors[i].general.trim();
    if (rate) return rate;
  }
  return "";
}

/** Derive chapter/heading/subheading from the digits of an HTS code. */
function deriveHierarchyCodes(htsno: string): {
  chapter: string;
  heading: string;
  subheading: string;
} {
  const digits = htsno.replace(/\D/g, "");
  return {
    chapter: digits.slice(0, 2),
    heading: digits.slice(0, 4),
    subheading:
      digits.length >= 6 ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}` : digits.slice(0, 4),
  };
}

function buildChunk(leaf: HtsRow, ancestors: HtsRow[]): HtsChunk {
  const path = [...ancestors, leaf]
    .map((r) => r.description.trim())
    .filter(Boolean)
    .join(PATH_SEP);

  const { chapter, heading, subheading } = deriveHierarchyCodes(leaf.htsno);

  return {
    content: path,
    type: "hts",
    metadata: {
      chapter,
      heading,
      subheading,
      hts_code: leaf.htsno,
      units: leaf.units ?? [],
      general_duty: resolveGeneralDuty(leaf, ancestors),
    },
  };
}

/**
 * Convert a flat run of USITC HTS rows into hierarchy-preserving leaf chunks.
 *
 * A chunk is emitted only for a row that (a) has an HTS code and (b) is a leaf
 * (no deeper-nested successor). Code-less rows — `superior:"true"` groupers
 * ("Horses:") and chapter-internal section labels ("I. CHEMICAL ELEMENTS") —
 * never emit; they only ever supply ancestor context. This means a page of
 * pure labels legitimately yields zero chunks, so the "fail loudly on a
 * truncated/garbled export" guarantee lives at the fetch layer (non-array
 * response) and the aggregate count floor in `scripts/ingest-hts.ts`, not here.
 *
 * The one malformation the chunker itself rejects is a non-numeric `indent`,
 * which would corrupt the whole tree walk (see `parseIndent`).
 */
export function chunkHtsRows(rows: HtsRow[]): HtsChunk[] {
  if (!Array.isArray(rows)) {
    throw new TypeError("chunkHtsRows expected an array of HTS rows");
  }

  const chunks: HtsChunk[] = [];
  // Stack of strict ancestors of the current row (all with smaller indent).
  const stack: Array<{ row: HtsRow; indent: number }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const indent = parseIndent(row, i);

    // Pop until the stack holds only strict ancestors (indent < current).
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    // A leaf is a code-bearing row with no deeper-nested successor.
    const next = rows[i + 1];
    const isLeafPosition = !next || parseIndent(next, i + 1) <= indent;

    if (isLeafPosition && row.htsno.trim()) {
      chunks.push(buildChunk(row, stack.map((e) => e.row)));
    }

    stack.push({ row, indent });
  }

  return chunks;
}
