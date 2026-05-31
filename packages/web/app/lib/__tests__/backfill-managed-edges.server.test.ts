import { beforeEach, describe, expect, it, vi } from "vitest";

// backfillManagedEdges opens one transaction, scans the managed-owner node
// types, and runs the capture-path reconciliation per node. The @doco/db edge
// primitives are mocked; the tx client answers the node scan (FROM nodes) with
// the configured rows and each per-node edge lookup (FROM edges) as empty.
const mocks = vi.hoisted(() => ({
  createChangeset: vi.fn(async () => 1),
  createEdge: vi.fn(async () => ({}) as never),
  retireEdge: vi.fn(async () => ({}) as never),
  nodeRows: [] as unknown[],
}));

vi.mock("@doco/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@doco/db")>();
  return {
    ...actual,
    createChangeset: mocks.createChangeset,
    createEdge: mocks.createEdge,
    retireEdge: mocks.retireEdge,
    withTransaction: async (fn: (c: unknown) => unknown) =>
      fn({
        query: async (sql: string) =>
          /from nodes/i.test(sql) ? { rows: mocks.nodeRows } : { rows: [] },
      }),
  };
});

import { backfillManagedEdges } from "../managed-edges.server";

const DOCO = "doco_01KSJ000000000000000000000";
const PRINCIPAL = "principal_01KSJ000000000000000000002";

beforeEach(() => {
  mocks.createEdge.mockClear();
  mocks.nodeRows = [];
});

describe("backfillManagedEdges", () => {
  it("authors a managed edge for every scanned node and sums the totals", async () => {
    mocks.nodeRows = [
      {
        id: "decision_01KSJ000000000000000000001",
        node_type: "decision",
        data: { decided_by: PRINCIPAL },
      },
      {
        id: "action_01KSJ000000000000000000003",
        node_type: "action",
        data: { actor_id: PRINCIPAL },
      },
    ];
    const res = await backfillManagedEdges(DOCO);
    expect(res).toEqual({ scanned: 2, created: 2, retired: 0 });
    expect(mocks.createEdge).toHaveBeenCalledTimes(2);
    expect(mocks.createEdge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ edgeType: "decided_by", origin: "field" }),
    );
  });

  it("is a no-op on a Doco with no managed-owner nodes", async () => {
    mocks.nodeRows = [];
    const res = await backfillManagedEdges(DOCO);
    expect(res).toEqual({ scanned: 0, created: 0, retired: 0 });
    expect(mocks.createEdge).not.toHaveBeenCalled();
  });
});
