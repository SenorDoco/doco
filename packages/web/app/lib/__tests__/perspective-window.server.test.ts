import { describe, expect, it } from "vitest";
import { PERSPECTIVE_WINDOW_SPECS, selectPerspectiveWindow } from "../perspective-window.server";

type Row = Record<string, unknown>;

function makeClient({
  focus,
  counts = [],
  neighbors = [],
  ranked = [],
}: {
  focus?: Row | null;
  counts?: Row[];
  neighbors?: Row[];
  ranked?: Row[];
}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      if (/GROUP BY node_type/i.test(sql)) return { rows: counts as T[] };
      if (/LIMIT 1/i.test(sql)) return { rows: (focus ? [focus] : []) as T[] };
      if (/edge_neighbors/i.test(sql)) return { rows: neighbors as T[] };
      return { rows: ranked as T[] };
    },
  };
  return { client, calls };
}

describe("selectPerspectiveWindow", () => {
  it("keeps an explicit focus first before neighbor and ranked fill", async () => {
    const { client } = makeClient({
      counts: [
        { node_type: "decision", n: "3" },
        { node_type: "intent", n: "1" },
      ],
      neighbors: [
        {
          id: "intent_neighbor",
          node_type: "intent",
          lifecycle: "active",
          created_at: "2026-05-02T00:00:00.000Z",
          degree: "3",
        },
      ],
      ranked: [
        {
          id: "decision_fresh",
          node_type: "decision",
          lifecycle: "active",
          created_at: "2026-05-03T00:00:00.000Z",
          degree: "10",
        },
        {
          id: "decision_focus",
          node_type: "decision",
          lifecycle: "drafting",
          created_at: "2026-05-01T00:00:00.000Z",
          degree: "0",
        },
        {
          id: "decision_extra",
          node_type: "decision",
          lifecycle: "active",
          created_at: "2026-05-01T00:00:00.000Z",
          degree: "1",
        },
      ],
    });

    const window = await selectPerspectiveWindow(client, {
      docoId: "doco_1",
      explicitFocusNodeId: "decision_focus",
      limit: 3,
      spec: PERSPECTIVE_WINDOW_SPECS.graph,
    });

    expect(window.focusNodeId).toBe("decision_focus");
    expect(window.nodeIds).toEqual(["decision_focus", "intent_neighbor", "decision_fresh"]);
    expect(window.reasonByNodeId).toMatchObject({
      decision_focus: "explicit_focus",
      intent_neighbor: "neighbor",
      decision_fresh: "ranked_fill",
    });
    expect(window.hasMore).toBe(true);
    expect(window.totalEligibleByType).toEqual({ decision: 3, intent: 1 });
    expect(window.omittedCountsByType).toEqual({ decision: 1 });
  });

  it("computes a default focus before windowing when no focus is explicit", async () => {
    const { client } = makeClient({
      focus: {
        id: "decision_central",
        node_type: "decision",
        lifecycle: "active",
        created_at: "2026-05-01T00:00:00.000Z",
        degree: "12",
      },
      counts: [{ node_type: "decision", n: "2" }],
      ranked: [
        {
          id: "decision_central",
          node_type: "decision",
          lifecycle: "active",
          created_at: "2026-05-01T00:00:00.000Z",
          degree: "12",
        },
        {
          id: "decision_newer",
          node_type: "decision",
          lifecycle: "active",
          created_at: "2026-05-03T00:00:00.000Z",
          degree: "1",
        },
      ],
    });

    const window = await selectPerspectiveWindow(client, {
      docoId: "doco_1",
      explicitFocusNodeId: null,
      limit: 2,
      spec: PERSPECTIVE_WINDOW_SPECS.graph,
    });

    expect(window.focusNodeId).toBe("decision_central");
    expect(window.nodeIds).toEqual(["decision_central", "decision_newer"]);
    expect(window.reasonByNodeId.decision_central).toBe("default_focus");
  });

  it("keeps retired nodes in the window for client-lifecycle-filtered perspectives", async () => {
    // The window gates the loaders via `id = ANY(window)`. If the spec
    // excludes retired here, removing `<> 'retired'` from the loader is
    // defeated — retired never reaches the client and toggling "Retired"
    // on is a no-op (the BPMN PR #819 bug, re-introduced for every
    // perspective once #821 routed them all through this window). These
    // perspectives all render the lifecycle filter, so retired must stay
    // in the window and let the client decide — like the graph spec.
    for (const key of ["bpmn", "org-tree", "sla", "glossary"] as const) {
      const { client, calls } = makeClient({ counts: [], ranked: [] });
      await selectPerspectiveWindow(client, {
        docoId: "doco_1",
        explicitFocusNodeId: null,
        limit: 5,
        spec: PERSPECTIVE_WINDOW_SPECS[key],
      });
      for (const { sql } of calls) {
        expect(sql, `${key} window must not pre-exclude retired nodes`).not.toMatch(
          /COALESCE\(n\.lifecycle, 'active'\) <> 'retired'/,
        );
      }
    }
  });
});
