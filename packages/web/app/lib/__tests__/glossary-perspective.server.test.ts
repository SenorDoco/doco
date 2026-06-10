import { describe, expect, it, vi } from "vitest";
import { loadGlossaryPerspectiveData } from "../glossary-perspective.server";

// A glossary's terms are References: the prose is the word being defined (the
// headword), the `definition` attribute is the meaning, the `locator` carries a
// cited source, and `alternatives` hold synonyms / deprecated variants. The
// loader reads only References now — terms are one shape, not five.
function makeClient(rows: unknown[]) {
  return {
    async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
      // The per-lifecycle totals query (GROUP BY) isn't the subject of these
      // term-shape tests — return no totals so they stay focused on entries.
      if (/GROUP BY/i.test(sql)) return { rows: [] as T[] };
      return { rows: rows as T[] };
    },
  };
}

function row(over: Record<string, unknown>) {
  return {
    id: "x",
    node_type: "reference",
    label: null,
    prose: null,
    lifecycle: "active",
    data: {},
    locator: null,
    ...over,
  };
}

// The loaded entries, flattened across letter groups — the loader no longer
// returns a separate `stats` block; the footer derives its counts client-side.
function entriesOf(data: { groups: { entries: unknown[] }[] }): unknown[] {
  return data.groups.flatMap((g) => g.entries);
}

describe("loadGlossaryPerspectiveData", () => {
  it("renders a Reference term entry: the prose is the word, the `definition` attribute is the meaning", async () => {
    const client = makeClient([
      row({
        id: "reference_01",
        label: "Torre", // first line of prose = the word being defined
        prose: "Torre",
        data: { definition: "The company building this product." },
      }),
    ]);

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");

    expect(entriesOf(data)).toHaveLength(1);
    const entry = data.groups[0].entries[0];
    expect(entry.headword).toBe("Torre");
    expect(entry.nodeType).toBe("reference");
    expect(entry.href).toBe("/acme/glossary/reference/reference_01");
    // The definition comes from the attribute, never the prose/headword.
    expect(entry.senses).toEqual(["The company building this product."]);
    // A defined term reads as a dictionary headword — a faux part of speech,
    // not a flat type label.
    expect(entry.tag).toBe("n.");
  });

  it("splits a multi-paragraph definition into numbered senses", async () => {
    const client = makeClient([
      row({
        id: "reference_alignment",
        label: "alignment",
        prose: "alignment",
        data: {
          definition: "Coherence between intent, decision, and action.\n\nDoco's central concept.",
        },
      }),
    ]);

    const { groups } = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    expect(groups[0].entries[0].senses).toEqual([
      "Coherence between intent, decision, and action.",
      "Doco's central concept.",
    ]);
  });

  it("renders a term's cited source from its `locator` alongside the definition", async () => {
    // Provenance is a property of the entry: the term carries its definition
    // AND a `locator` citing where the definition is drawn from.
    const client = makeClient([
      row({
        id: "reference_idempotent",
        label: "idempotent",
        prose: "idempotent",
        data: {
          definition: "An operation that has the same effect whether applied once or many times.",
        },
        locator: "https://www.rfc-editor.org/rfc/rfc7231",
      }),
    ]);

    const { groups } = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    const entry = groups[0].entries[0];
    expect(entry.headword).toBe("idempotent");
    expect(entry.source).toBe("https://www.rfc-editor.org/rfc/rfc7231");
    expect(entry.senses).toEqual([
      "An operation that has the same effect whether applied once or many times.",
    ]);
    expect(entry.tag).toBe("n.");
  });

  it("reads synonyms and deprecated variants from the `alternatives` attribute", async () => {
    const client = makeClient([
      row({
        id: "reference_rule",
        label: "rule",
        prose: "rule",
        data: {
          definition: "A statement of correctness.",
          alternatives: [
            { name: "constraint" },
            { name: "guardrail", rejected_because: "informal" },
          ],
        },
      }),
    ]);

    const { groups } = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    expect(groups[0].entries[0].alternatives).toEqual([
      { name: "constraint", note: null, deprecated: false },
      { name: "guardrail", note: "informal", deprecated: true },
    ]);
  });

  it("alphabetizes terms into letter groups, case-insensitively", async () => {
    const client = makeClient([
      row({ id: "r3", label: "alignment", prose: "alignment", data: { definition: "x" } }),
      row({ id: "r1", label: "Doco", prose: "Doco", data: { definition: "y" } }),
      row({ id: "r2", label: "agent", prose: "agent", data: { definition: "z" } }),
    ]);

    const { groups, letters } = await loadGlossaryPerspectiveData(
      client,
      "doco_01",
      "acme/glossary",
    );
    expect(letters).toEqual(["A", "D"]);
    expect(groups[0].entries.map((e) => e.headword)).toEqual(["agent", "alignment"]);
  });

  it("queries only References, not the legacy five-type union", async () => {
    const calls: string[] = [];
    const client = {
      async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
        calls.push(sql);
        return { rows: [] };
      },
    };
    await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    const termQuery = calls.find((sql) => /node_type = 'reference'/.test(sql));
    expect(termQuery).toBeDefined();
    expect(termQuery).not.toMatch(/'decision'/);
  });

  it("returns empty groups when the Doco has no terms", async () => {
    const data = await loadGlossaryPerspectiveData(makeClient([]), "doco_01", "acme/glossary");
    expect(data.groups).toEqual([]);
    expect(entriesOf(data)).toHaveLength(0);
  });

  it("passes a SQL limit to the term query when a page budget is supplied", async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const client: Parameters<typeof loadGlossaryPerspectiveData>[0] = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary", {
      limit: 40,
    });

    // The slice query carries the LIMIT; the per-lifecycle totals query
    // (GROUP BY, no limit) counts the full domain.
    const termQuery = calls.find((q) => /ORDER BY updated_at DESC/.test(q.sql));
    expect(termQuery?.sql).toMatch(/LIMIT \$2/);
    expect(termQuery?.params).toEqual(["doco_01", 40]);
    expect(entriesOf(data)).toHaveLength(0);
    expect(data.totalByLifecycle).toEqual({ drafting: 0, queued: 0, active: 0, retired: 0 });
  });

  it("reports the true per-lifecycle total via a grouped COUNT so the header can show truncation", async () => {
    const client = {
      async query<T>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
        // The grouped totals query is counted before the LIMIT, so a mostly
        // retired lexicon still reports its real size once "Retired" is shown.
        if (/GROUP BY/.test(sql)) {
          return {
            rows: [
              { lifecycle: "active", n: "1798" },
              { lifecycle: "retired", n: "2" },
            ] as T[],
          };
        }
        return {
          rows: [
            row({
              id: "reference_01",
              label: "Doco",
              prose: "Doco",
              data: { definition: "institutional memory." },
            }),
          ] as T[],
        };
      },
    };

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary", {
      limit: 1,
    });

    expect(data.totalByLifecycle).toEqual({ drafting: 0, queued: 0, active: 1798, retired: 2 });
    expect(entriesOf(data)).toHaveLength(1);
  });

  it("loads every lifecycle so the client filter can reveal retired entries", async () => {
    // Regression (sibling of BPMN PR #819): hiding a lifecycle is the client's
    // job (`visibleLifecycles`). Pre-filtering retired on the server makes
    // toggling "Retired" on a no-op, leaving a fully-retired glossary blank.
    const querySpy = vi.fn();
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        return {
          rows: [
            row({
              id: "reference_retired",
              label: "Sunset term",
              prose: "Sunset term",
              data: { definition: "A term we no longer use." },
              lifecycle: "retired",
            }),
          ] as T[],
        };
      },
    };

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");

    const [sql] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/<> 'retired'/);
    expect(data.groups.flatMap((g) => g.entries).map((e) => e.id)).toContain("reference_retired");
  });
});
