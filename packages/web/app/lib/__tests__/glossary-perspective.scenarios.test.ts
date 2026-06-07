import { describe, expect, it } from "vitest";
import { loadGlossaryPerspectiveData } from "../glossary-perspective.server";

// Ten real-world glossaries rendered through the loader. Suite A above
// (glossary-perspective.server.test.ts) pins the per-field reshaping; this
// corpus stresses the *presentation* end to end — A–Z grouping, case-insensitive
// dictionary order, multi-word and non-alphabetic headwords, multi-sense
// definitions, synonyms/deprecations, inline source citations, and the
// loaded-slice stats — so a rendering defect on realistic data is caught.

type QueryClient = Parameters<typeof loadGlossaryPerspectiveData>[0];

function makeClient(rows: unknown[]): QueryClient {
  return {
    async query<T>(_sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
      return { rows: rows as T[] };
    },
  };
}

interface TermRow {
  word: string;
  definition?: string;
  alternatives?: unknown;
  locator?: string;
  lifecycle?: string;
}

/** Build the unioned NodeRow the loader's SQL projects for a Reference term. */
function termRow(t: TermRow, i: number) {
  return {
    id: `reference_${i}`,
    entity_type: "reference",
    label: t.word, // SQL: split_part(prose, '\n', 1)
    prose: t.word,
    lifecycle: t.lifecycle ?? "active",
    data: {
      ...(t.definition !== undefined ? { definition: t.definition } : {}),
      ...(t.alternatives !== undefined ? { alternatives: t.alternatives } : {}),
    },
    locator: t.locator ?? null,
  };
}

async function render(terms: TermRow[]) {
  // The loader reads the true total from a scalar COUNT(*) subquery projected
  // onto every row; mirror that in the mock so totalCount is realistic.
  const rows = terms.map((t, i) => ({ ...termRow(t, i), total_count: terms.length }));
  return loadGlossaryPerspectiveData(makeClient(rows), "doco_01", "acme/lexicon");
}

// Each scenario is a realistic glossary; the assertions probe whatever that
// glossary exercises (grouping, senses, aliases, source, lifecycle).
describe("glossary perspective — ten real-world glossaries render correctly", () => {
  it("fintech: alphabetizes and counts defined entries", async () => {
    const data = await render([
      { word: "chargeback", definition: "A forced reversal of a card payment by the issuer." },
      {
        word: "settlement",
        definition: "Transfer of captured funds to the merchant, net of fees.",
      },
      { word: "ACH", definition: "Automated Clearing House — a US bank-to-bank transfer network." },
    ]);
    expect(data.letters).toEqual(["A", "C", "S"]);
    expect(data.groups.flatMap((g) => g.entries).map((e) => e.headword)).toEqual([
      "ACH",
      "chargeback",
      "settlement",
    ]);
    expect(data.stats.defined).toBe(3);
    expect(data.totalCount).toBe(3);
  });

  it("clinical: an inline source citation surfaces as the entry's source line", async () => {
    const data = await render([
      {
        word: "discharge summary",
        definition: "A document recording a patient's diagnosis, treatment, and follow-up plan.",
        locator: "https://www.hl7.org/fhir/composition.html",
      },
      {
        word: "triage",
        definition: "Ranking patients by urgency of need when resources are limited.",
      },
    ]);
    const discharge = data.groups
      .flatMap((g) => g.entries)
      .find((e) => e.headword === "discharge summary");
    expect(discharge?.source).toBe("https://www.hl7.org/fhir/composition.html");
    // A multi-word headword is grouped by its first letter and tagged a phrase.
    expect(discharge?.letter).toBe("D");
    expect(discharge?.tag).toBe("phr.");
  });

  it("legal: synonyms render, including a deprecated variant flagged from its note", async () => {
    const data = await render([
      {
        word: "indemnification",
        definition: "A duty by one party to compensate another for specified losses.",
        alternatives: ["hold harmless", { name: "save harmless", rejected_because: "archaic" }],
      },
    ]);
    const entry = data.groups[0].entries[0];
    expect(entry.alternatives).toEqual([
      { name: "hold harmless", note: null, deprecated: false },
      { name: "save harmless", note: "archaic", deprecated: true },
    ]);
    expect(data.stats.withAliases).toBe(1);
  });

  it("api: a multi-paragraph definition splits into numbered senses", async () => {
    const data = await render([
      {
        word: "REST",
        definition:
          "An architectural style for networked applications using stateless HTTP.\n\nResources are addressed by URLs and manipulated with verbs.",
      },
    ]);
    expect(data.groups[0].entries[0].senses).toEqual([
      "An architectural style for networked applications using stateless HTTP.",
      "Resources are addressed by URLs and manipulated with verbs.",
    ]);
  });

  it("ml: case-insensitive dictionary order groups mixed-case headwords together", async () => {
    const data = await render([
      { word: "epoch", definition: "One full pass over the training dataset." },
      { word: "Embedding", definition: "A dense vector representation of a discrete input." },
      {
        word: "early stopping",
        definition: "Halting training when validation loss stops improving.",
      },
    ]);
    // All three are 'E', ordered case-insensitively: early stopping, Embedding, epoch.
    expect(data.letters).toEqual(["E"]);
    expect(data.groups[0].entries.map((e) => e.headword)).toEqual([
      "early stopping",
      "Embedding",
      "epoch",
    ]);
  });

  it("security: an acronym headword keeps its casing and groups by first letter", async () => {
    const data = await render([
      {
        word: "PoLP",
        definition: "Principle of least privilege — grant only the access required.",
      },
      {
        word: "phishing",
        definition: "A social-engineering attack impersonating a trusted party.",
      },
    ]);
    expect(data.letters).toEqual(["P"]);
    const heads = data.groups[0].entries.map((e) => e.headword);
    expect(heads).toContain("PoLP");
    expect(heads).toContain("phishing");
  });

  it("devops: a drafting stub with no definition is loaded but not counted as defined", async () => {
    const data = await render([
      { word: "SLO", definition: "A target reliability level for a service over a window." },
      { word: "toil", lifecycle: "drafting" }, // captured headword, definition pending
    ]);
    expect(data.stats.entries).toBe(2);
    expect(data.stats.defined).toBe(1);
    expect(data.stats.drafting).toBe(1);
    const toil = data.groups.flatMap((g) => g.entries).find((e) => e.headword === "toil");
    expect(toil?.senses).toEqual([]);
  });

  it("people-ops: a retired (deprecated) term still loads so the client can reveal it", async () => {
    const data = await render([
      { word: "attrition", definition: "The rate at which employees leave over a period." },
      { word: "manpower", definition: "Former term for staffing; avoid.", lifecycle: "retired" },
    ]);
    const ids = data.groups.flatMap((g) => g.entries).map((e) => e.lifecycle);
    expect(ids).toContain("retired");
    expect(data.stats.entries).toBe(2);
  });

  it("data-governance: a non-alphabetic headword sorts into the '#' group, last", async () => {
    const data = await render([
      { word: "PII", definition: "Personally identifiable information." },
      { word: "3NF", definition: "Third normal form — a relational schema normalization level." },
    ]);
    expect(data.letters).toEqual(["P", "#"]); // '#' always sorts last
    const hash = data.groups.find((g) => g.letter === "#");
    expect(hash?.entries.map((e) => e.headword)).toEqual(["3NF"]);
  });

  it("e-commerce: an empty glossary renders no groups", async () => {
    const data = await render([]);
    expect(data.groups).toEqual([]);
    expect(data.letters).toEqual([]);
    expect(data.stats.entries).toBe(0);
  });
});
