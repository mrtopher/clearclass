/**
 * The General Rules of Interpretation (GRI) and the Additional U.S. Rules of
 * Interpretation, as citable corpus chunks (U3, R1; advances KTD8/KTD3).
 *
 * The GRI are the binding, hierarchical rules a broker applies to reach a
 * classification, so the agent must be able to cite the exact rule it reasoned
 * from. This module holds the canonical rule text and a pure builder that emits
 * one chunk per rule, tagged `{type:'gri', rule}`; `scripts/ingest-gri.ts` owns
 * persistence. Pure + no I/O, mirroring `lib/chunking.ts` / `lib/rulings.ts`.
 *
 * SOURCE / FIDELITY: the text below is the standard General Rules of
 * Interpretation of the Harmonized System (WCO) as adopted verbatim in the
 * USITC Harmonized Tariff Schedule front matter, plus the Additional U.S. Rules
 * of Interpretation. It is stable, public-domain legal text reproduced here
 * rather than fetched (the authoritative source is a USITC PDF). Diff against
 * the current HTS "General Rules of Interpretation" PDF at hts.usitc.gov before
 * relying on it in a graded demo.
 */

export interface GriChunk {
  /** Rule text, prefixed with a stable citable label ("GRI 3(b): ..."). */
  content: string;
  /** Corpus type discriminator for the shared `documents` table (U4). */
  type: "gri";
  metadata: {
    /** Canonical rule identifier used for citation, e.g. "1", "3(b)", "US 1(a)". */
    rule: string;
    /** Human-readable label materialized into the citation. */
    label: string;
  };
}

/** One authored rule: its citable id/label and verbatim text. */
interface GriRule {
  rule: string;
  label: string;
  text: string;
}

/**
 * The six General Rules of Interpretation plus the four Additional U.S. Rules.
 * GRI 3 and Additional U.S. Rule 1 are kept as their lettered sub-parts because
 * a broker cites, e.g., "GRI 3(b)" specifically — one retrievable chunk per
 * sub-part matches how the rule is actually invoked.
 */
const GRI_RULES: GriRule[] = [
  {
    rule: "1",
    label: "GRI 1",
    text:
      "The table of contents, alphabetical index, and titles of sections, chapters and sub-chapters are provided for ease of reference only; for legal purposes, classification shall be determined according to the terms of the headings and any relative section or chapter notes and, provided such headings or notes do not otherwise require, according to the following provisions.",
  },
  {
    rule: "2(a)",
    label: "GRI 2(a)",
    text:
      "Any reference in a heading to an article shall be taken to include a reference to that article incomplete or unfinished, provided that, as entered, the incomplete or unfinished article has the essential character of the complete or finished article. It shall also include a reference to that article complete or finished (or falling to be classified as complete or finished by virtue of this rule), entered unassembled or disassembled.",
  },
  {
    rule: "2(b)",
    label: "GRI 2(b)",
    text:
      "Any reference in a heading to a material or substance shall be taken to include a reference to mixtures or combinations of that material or substance with other materials or substances. Any reference to goods of a given material or substance shall be taken to include a reference to goods consisting wholly or partly of such material or substance. The classification of goods consisting of more than one material or substance shall be according to the principles of rule 3.",
  },
  {
    rule: "3(a)",
    label: "GRI 3(a)",
    text:
      "When by application of rule 2(b) or for any other reason, goods are, prima facie, classifiable under two or more headings, classification shall be effected as follows: The heading which provides the most specific description shall be preferred to headings providing a more general description. However, when two or more headings each refer to part only of the materials or substances contained in mixed or composite goods or to part only of the items in a set put up for retail sale, those headings are to be regarded as equally specific in relation to those goods, even if one of them gives a more complete or precise description of the goods.",
  },
  {
    rule: "3(b)",
    label: "GRI 3(b)",
    text:
      "Mixtures, composite goods consisting of different materials or made up of different components, and goods put up in sets for retail sale, which cannot be classified by reference to 3(a), shall be classified as if they consisted of the material or component which gives them their essential character, insofar as this criterion is applicable.",
  },
  {
    rule: "3(c)",
    label: "GRI 3(c)",
    text:
      "When goods cannot be classified by reference to 3(a) or 3(b), they shall be classified under the heading which occurs last in numerical order among those which equally merit consideration.",
  },
  {
    rule: "4",
    label: "GRI 4",
    text:
      "Goods which cannot be classified in accordance with the above rules shall be classified under the heading appropriate to the goods to which they are most akin.",
  },
  {
    rule: "5(a)",
    label: "GRI 5(a)",
    text:
      "In addition to the foregoing provisions, the following rules shall apply in respect of the goods referred to therein: Camera cases, musical instrument cases, gun cases, drawing instrument cases, necklace cases and similar containers, specially shaped or fitted to contain a specific article or set of articles, suitable for long-term use and entered with the articles for which they are intended, shall be classified with such articles when of a kind normally sold therewith. This rule does not, however, apply to containers which give the whole its essential character.",
  },
  {
    rule: "5(b)",
    label: "GRI 5(b)",
    text:
      "Subject to the provisions of rule 5(a) above, packing materials and packing containers entered with the goods therein shall be classified with the goods if they are of a kind normally used for packing such goods. However, this provision is not binding when such packing materials or packing containers are clearly suitable for repetitive use.",
  },
  {
    rule: "6",
    label: "GRI 6",
    text:
      "For legal purposes, the classification of goods in the subheadings of a heading shall be determined according to the terms of those subheadings and any related subheading notes and, mutatis mutandis, to the above rules, on the understanding that only subheadings at the same level are comparable. For the purposes of this rule, the relative section, chapter and subchapter notes also apply, unless the context otherwise requires.",
  },
  {
    rule: "US 1(a)",
    label: "Additional U.S. Rule 1(a)",
    text:
      "In the absence of special language or context which otherwise requires, a tariff classification controlled by use (other than actual use) is to be determined in accordance with the use in the United States at, or immediately prior to, the date of importation, of goods of that class or kind to which the imported goods belong, and the controlling use is the principal use.",
  },
  {
    rule: "US 1(b)",
    label: "Additional U.S. Rule 1(b)",
    text:
      "A tariff classification controlled by the actual use to which the imported goods are put in the United States is satisfied only if such use is intended at the time of importation, the goods are so used, and proof thereof is furnished within 3 years after the date the goods are entered.",
  },
  {
    rule: "US 1(c)",
    label: "Additional U.S. Rule 1(c)",
    text:
      "A provision for parts of an article covers products solely or principally used as a part of such articles but a provision for parts or parts and accessories shall not prevail over a specific provision for such part or accessory.",
  },
  {
    rule: "US 1(d)",
    label: "Additional U.S. Rule 1(d)",
    text:
      "The principles of section XI regarding mixtures of two or more textile materials shall apply to the classification of goods in any provision in which a textile material is named.",
  },
];

/** Build one citable, tagged chunk per GRI / Additional U.S. rule. */
export function buildGriChunks(): GriChunk[] {
  return GRI_RULES.map((r) => ({
    content: `${r.label}: ${r.text}`,
    type: "gri" as const,
    metadata: { rule: r.rule, label: r.label },
  }));
}

/** Number of rules authored — the loud-failure floor for the ingest script. */
export const GRI_RULE_COUNT = GRI_RULES.length;
