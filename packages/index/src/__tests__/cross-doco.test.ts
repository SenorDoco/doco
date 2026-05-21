import { describe, expect, it } from "vitest";
import { applyCrossDocoAccess, canEmitCrossDocoEdge } from "../cross-doco.js";
import type { DocoAccess } from "../cross-doco.js";
import type { Edge } from "../edges.js";

const PRIVATE_ACME_A: DocoAccess = {
  id: "doco_acme_a",
  org_id: "organization_acme",
  visibility: "private",
};
const PRIVATE_ACME_B: DocoAccess = {
  id: "doco_acme_b",
  org_id: "organization_acme",
  visibility: "private",
};
const PRIVATE_OTHER: DocoAccess = {
  id: "doco_other_private",
  org_id: "organization_other",
  visibility: "private",
};
const PUBLIC_OTHER: DocoAccess = {
  id: "doco_other_public",
  org_id: "organization_other",
  visibility: "public",
};
const PRIVATE_ORPHAN: DocoAccess = {
  id: "doco_orphan",
  org_id: null,
  visibility: "private",
};

describe("canEmitCrossDocoEdge", () => {
  it("allows intra-Doco (self)", () => {
    expect(canEmitCrossDocoEdge(PRIVATE_ACME_A, PRIVATE_ACME_A)).toBe(true);
  });

  it("allows same-org targets even when both are private", () => {
    expect(canEmitCrossDocoEdge(PRIVATE_ACME_A, PRIVATE_ACME_B)).toBe(true);
  });

  it("allows any target whose visibility is public", () => {
    expect(canEmitCrossDocoEdge(PRIVATE_ACME_A, PUBLIC_OTHER)).toBe(true);
  });

  it("denies a different-org private target", () => {
    expect(canEmitCrossDocoEdge(PRIVATE_ACME_A, PRIVATE_OTHER)).toBe(false);
  });

  it("does not treat null org_id as 'same org' even on both sides", () => {
    // Without an explicit org, "same org" is undefined — fall back to
    // the public-visibility rule.
    expect(canEmitCrossDocoEdge(PRIVATE_ORPHAN, PRIVATE_ORPHAN)).toBe(true);
    expect(
      canEmitCrossDocoEdge(PRIVATE_ORPHAN, { ...PRIVATE_ORPHAN, id: "doco_other_orphan" }),
    ).toBe(false);
  });
});

function edge(toId: string, opts: Partial<Edge> = {}): Edge {
  return {
    from_id: "intent_01H000000000000000000000FROM",
    from_node_type: "intent",
    to_id: toId,
    to_node_type: toId.split("_")[0] ?? "decision",
    edge_type: opts.edge_type ?? "enacts",
    ...(opts.attribution ? { attribution: opts.attribution } : {}),
  };
}

describe("applyCrossDocoAccess", () => {
  const fromDoco = PRIVATE_ACME_A;
  const localIds = new Set([
    "intent_01H000000000000000000000FROM",
    "decision_01H000000000000000000000LOC",
  ]);

  it("tags intra-Doco edges with to_doco_id = source", () => {
    const result = applyCrossDocoAccess(
      fromDoco,
      localIds,
      [edge("decision_01H000000000000000000000LOC")],
      new Map(),
      new Map(),
    );
    expect(result).toEqual([
      {
        from_id: "intent_01H000000000000000000000FROM",
        from_node_type: "intent",
        to_id: "decision_01H000000000000000000000LOC",
        to_node_type: "decision",
        edge_type: "enacts",
        to_doco_id: "doco_acme_a",
      },
    ]);
  });

  it("emits a cross-Doco edge when target's Doco is in the same org", () => {
    const targetId = "decision_01H000000000000000000000ORG";
    const targetEntityDocos = new Map([[targetId, "doco_acme_b"]]);
    const docoAccess = new Map([
      ["doco_acme_a", fromDoco],
      ["doco_acme_b", PRIVATE_ACME_B],
    ]);
    const result = applyCrossDocoAccess(
      fromDoco,
      localIds,
      [edge(targetId)],
      targetEntityDocos,
      docoAccess,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.to_doco_id).toBe("doco_acme_b");
  });

  it("emits a cross-Doco edge when target's Doco is public", () => {
    const targetId = "rule_01H00000000000000000000PUB";
    const targetEntityDocos = new Map([[targetId, PUBLIC_OTHER.id]]);
    const docoAccess = new Map([
      [fromDoco.id, fromDoco],
      [PUBLIC_OTHER.id, PUBLIC_OTHER],
    ]);
    const result = applyCrossDocoAccess(
      fromDoco,
      localIds,
      [edge(targetId)],
      targetEntityDocos,
      docoAccess,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.to_doco_id).toBe(PUBLIC_OTHER.id);
  });

  it("drops cross-Doco edges to a different-org private Doco", () => {
    const targetId = "rule_01H00000000000000000000DEN";
    const targetEntityDocos = new Map([[targetId, PRIVATE_OTHER.id]]);
    const docoAccess = new Map([
      [fromDoco.id, fromDoco],
      [PRIVATE_OTHER.id, PRIVATE_OTHER],
    ]);
    const result = applyCrossDocoAccess(
      fromDoco,
      localIds,
      [edge(targetId)],
      targetEntityDocos,
      docoAccess,
    );
    expect(result).toEqual([]);
  });

  it("drops edges whose target isn't found in any Doco (orphan refs)", () => {
    const targetId = "decision_01H00000000000000000ORPH";
    const result = applyCrossDocoAccess(
      fromDoco,
      localIds,
      [edge(targetId)],
      new Map(),
      new Map([[fromDoco.id, fromDoco]]),
    );
    expect(result).toEqual([]);
  });

  it("preserves edge_props and attribution on resolved edges", () => {
    const targetId = "rule_01H00000000000000000000PRP";
    const e: Edge = {
      ...edge(targetId),
      edge_props: { reason: "as: policy" },
      attribution: "doco-auto",
    };
    const targetEntityDocos = new Map([[targetId, PUBLIC_OTHER.id]]);
    const docoAccess = new Map([
      [fromDoco.id, fromDoco],
      [PUBLIC_OTHER.id, PUBLIC_OTHER],
    ]);
    const [resolved] = applyCrossDocoAccess(fromDoco, localIds, [e], targetEntityDocos, docoAccess);
    expect(resolved?.edge_props).toEqual({ reason: "as: policy" });
    expect(resolved?.attribution).toBe("doco-auto");
    expect(resolved?.to_doco_id).toBe(PUBLIC_OTHER.id);
  });

  it("treats a target whose Doco is the source Doco itself as intra-Doco", () => {
    const targetId = "log_01H00000000000000000000SELF";
    // Target lives in the source Doco but wasn't part of `localIds`
    // (e.g., a node type the loader doesn't track in `entities`).
    const targetEntityDocos = new Map([[targetId, fromDoco.id]]);
    const docoAccess = new Map([[fromDoco.id, fromDoco]]);
    const [resolved] = applyCrossDocoAccess(
      fromDoco,
      localIds,
      [edge(targetId)],
      targetEntityDocos,
      docoAccess,
    );
    expect(resolved?.to_doco_id).toBe(fromDoco.id);
  });
});
