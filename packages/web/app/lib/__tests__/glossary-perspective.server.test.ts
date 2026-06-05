import { describe, expect, it, vi } from "vitest";
import { loadGlossaryPerspectiveData } from "../glossary-perspective.server";

// The loader issues a single UNION-ALL query across the content tables,
// so the mock returns rows already in the unioned NodeRow shape.
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
    entity_type: "decision",
    label: null,
    prose: null,
    lifecycle: "active",
    data: {},
    ref_type: null,
    locator: null,
    citation: null,
    ...over,
  };
}

describe("loadGlossaryPerspectiveData", () => {
  it("renders Reference nodes as entries (regression: glossary was blank with only References)", async () => {
    const client = makeClient([
      row({
        id: "reference_01",
        entity_type: "reference",
        label: "Torre",
        prose: "The company building this product.",
        ref_type: "term",
        citation: "Torre.ai handbook",
      }),
    ]);

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");

    expect(data.stats.entries).toBe(1);
    const entry = data.groups[0].entries[0];
    expect(entry.headword).toBe("Torre");
    expect(entry.entityType).toBe("reference");
    expect(entry.href).toBe("/acme/glossary/reference/reference_01");
    expect(entry.senses).toEqual(["The company building this product."]);
    expect(entry.source).toBe("Torre.ai handbook");
    expect(entry.tag).toBe("term"); // ref_type used as the register label
  });

  it("maps Decisions to chosen=headword, question lead-in, and alternatives", async () => {
    const client = makeClient([
      row({
        id: "decision_01",
        entity_type: "decision",
        label: "Node",
        prose: "A single typed node in a Doco.",
        data: {
          chosen: "Node",
          question: "What is one unit of captured knowledge?",
          alternatives: [{ name: "node", rejected_because: "too generic" }],
        },
      }),
    ]);

    const { groups } = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    const entry = groups[0].entries[0];
    expect(entry.headword).toBe("Node");
    expect(entry.question).toBe("What is one unit of captured knowledge?");
    expect(entry.tag).toBe("n.");
    expect(entry.alternatives).toEqual([{ name: "node", note: "too generic", deprecated: true }]);
  });

  it("uses the stored node name as the glossary headword before decision metadata fallback", async () => {
    const client = makeClient([
      row({
        id: "decision_01",
        entity_type: "decision",
        label: "Changeset",
        prose: "Changeset\n\nA batch graph-authoring request.",
        data: {
          chosen: "A batch graph-authoring request.",
          question: "What is a changeset in Doco?",
        },
      }),
    ]);

    const { groups } = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");
    const entry = groups[0].entries[0];
    expect(entry.headword).toBe("Changeset");
    expect(entry.senses).toEqual(["A batch graph-authoring request."]);
  });

  it("alphabetizes mixed types into letter groups and tags non-term types honestly", async () => {
    const client = makeClient([
      row({
        id: "intent_01",
        entity_type: "intent",
        label: "Scope of this glossary",
        prose: "Scope of this glossary covers Torre product terms.",
      }),
      row({
        id: "decision_01",
        entity_type: "decision",
        label: "Doco",
        prose: "Doco — institutional memory.",
        data: { chosen: "Doco" },
      }),
      row({
        id: "rule_01",
        entity_type: "rule",
        label: "Always capitalize Doco",
        prose: "Always capitalize Doco in UI copy.",
      }),
    ]);

    const { groups, letters } = await loadGlossaryPerspectiveData(
      client,
      "doco_01",
      "acme/glossary",
    );
    expect(letters).toEqual(["A", "D", "S"]);
    const byType = Object.fromEntries(
      groups.flatMap((g) => g.entries).map((e) => [e.entityType, e.tag]),
    );
    expect(byType.rule).toBe("usage");
    expect(byType.intent).toBe("scope");
    expect(byType.decision).toBe("n.");
  });

  it("returns empty groups when the Doco has no content nodes", async () => {
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
              id: "decision_01",
              entity_type: "decision",
              label: "Doco",
              prose: "Doco — institutional memory.",
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
    // Regression (sibling of BPMN PR #819): the glossary loader hardcoded
    // `<> 'retired'`, so retired terms never reached the client. The
    // lifecycle filter (Drafting/Asserted/Retired) lives client-side
    // (`visibleLifecycles`) and is the only thing that should hide a
    // lifecycle — pre-filtering retired on the server makes toggling
    // "Retired" on a no-op, leaving a fully-retired glossary blank.
    const querySpy = vi.fn();
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        return {
          rows: [
            row({
              id: "decision_retired",
              entity_type: "decision",
              label: "Sunset term",
              prose: "A term we no longer use.",
              lifecycle: "retired",
            }),
          ] as T[],
        };
      },
    };

    const data = await loadGlossaryPerspectiveData(client, "doco_01", "acme/glossary");

    const [sql] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/<> 'retired'/);
    // The retired row survives to an entry — the client filter, not the
    // server, owns hiding it.
    expect(data.groups.flatMap((g) => g.entries).map((e) => e.id)).toContain("decision_retired");
  });
});
