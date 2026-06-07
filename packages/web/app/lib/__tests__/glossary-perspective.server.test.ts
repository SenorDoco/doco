import { describe, expect, it, vi } from "vitest";
import { loadGlossaryPerspectiveData } from "../glossary-perspective.server";

// A glossary's terms are References: the prose is the word being defined (the
// headword), the `definition` attribute is the meaning, the `locator` carries a
// cited source, and `alternatives` hold synonyms / deprecated variants. The
// loader reads only References now — terms are one shape, not five.
function makeClient(rows: unknown[]) {
  return {
    async query<T>(_sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
      return { rows: rows as T[] };
    },
  };
}

function row(over: Record<string, unknown>) {
  return {
    id: "x",
    entity_type: "reference",
    label: null,
    prose: null,
    lifecycle: "active",
    data: {},
    locator: null,
    ...over,
  };
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

    expect(data.stats.entries).toBe(1);
    const entry = data.groups[0].entries[0];
    expect(entry.headword).toBe("Torre");
    expect(entry.entityType).toBe("reference");
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

  it("renders a cited-source Reference's source line from its locator and tags it `src.`", async () => {
    // A `derived_from` target: no `definition`, but a source line to show.
    const client = makeClient([
      row({
        id: "reference_src",
        label: "RFC 7231",
        prose: "RFC 7231",
        locator: "https://www.rfc-editor.org/rfc/rfc7231",
      }),
    ]);

    const { groups } = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    const entry = groups[0].entries[0];
    expect(entry.headword).toBe("RFC 7231");
    expect(entry.source).toBe("https://www.rfc-editor.org/rfc/rfc7231");
    expect(entry.senses).toEqual([]);
    expect(entry.tag).toBe("src.");
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
    const querySpy = vi.fn();
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        expect(sql).toMatch(/node_type = 'reference'/);
        expect(sql).not.toMatch(/'decision'/);
        return { rows: [] };
      },
    };
    await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    expect(querySpy).toHaveBeenCalledOnce();
  });

  it("returns empty groups when the Doco has no terms", async () => {
    const data = await loadGlossaryPerspectiveData(makeClient([]), "doco_01", "acme/glossary");
    expect(data.groups).toEqual([]);
    expect(data.stats.entries).toBe(0);
  });

  it("passes a SQL limit when a page budget is supplied", async () => {
    const querySpy = vi.fn();
    const client: Parameters<typeof loadGlossaryPerspectiveData>[0] = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        expect(sql).toMatch(/ORDER BY updated_at DESC/);
        expect(sql).toMatch(/LIMIT \$2/);
        expect(params).toEqual(["doco_01", 40]);
        return { rows: [] };
      },
    };

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary", {
      limit: 40,
    });

    expect(data.stats.entries).toBe(0);
    expect(data.totalCount).toBe(0);
    expect(querySpy).toHaveBeenCalledOnce();
  });

  it("reports the true total via a scalar COUNT subquery so the header can show truncation", async () => {
    const querySpy = vi.fn();
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        expect(sql).toMatch(/\(SELECT COUNT\(\*\)/);
        return {
          rows: [
            row({
              id: "reference_01",
              label: "Doco",
              prose: "Doco",
              data: { definition: "institutional memory." },
              // pg returns the windowed bigint as a string.
              total_count: "1800",
            }),
          ] as T[],
        };
      },
    };

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary", {
      limit: 1,
    });

    expect(data.totalCount).toBe(1800);
    expect(data.stats.entries).toBe(1);
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
