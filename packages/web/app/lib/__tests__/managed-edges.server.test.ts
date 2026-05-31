import type { PoolClient } from "@doco/db";
import type { Entity } from "@doco/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The three @doco/db edge primitives are mocked so we can assert the
// orchestration (what reconcileNodeEdges decides to create/retire and with
// which origin) without a live Postgres. The pure planner it delegates to
// (reconcileManagedEdges) is covered in @doco/index.
const mocks = vi.hoisted(() => ({
  createChangeset: vi.fn(async () => 42),
  createEdge: vi.fn(async () => ({}) as never),
  retireEdge: vi.fn(async () => ({}) as never),
}));

vi.mock("@doco/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@doco/db")>();
  return { ...actual, ...mocks };
});

import { reconcileNodeEdges } from "../managed-edges.server";

const DOCO = "doco_01KSJ000000000000000000000";
const DEC = "decision_01KSJ000000000000000000001";
const P1 = "principal_01KSJ000000000000000000002";
const P2 = "principal_01KSJ000000000000000000003";
const ACTOR = "user_01KSJ000000000000000000004";

function clientReturning(rows: unknown[]): PoolClient {
  return { query: vi.fn(async () => ({ rows })) } as unknown as PoolClient;
}

function decision(decided_by: string): Entity {
  return {
    id: DEC,
    node_type: "decision",
    decision: "x",
    question: "q",
    chosen: "c",
    decided_by,
    decided_at: "2026-05-26T00:00:00.000Z",
  } as unknown as Entity;
}

beforeEach(() => {
  mocks.createChangeset.mockClear();
  mocks.createEdge.mockClear();
  mocks.retireEdge.mockClear();
});

describe("reconcileNodeEdges", () => {
  it("is a no-op for non-node entities (policies have no managed fields)", async () => {
    const c = clientReturning([]);
    const res = await reconcileNodeEdges(c, {
      docoId: DOCO,
      entityType: "guidance_policy",
      entity: { id: "guidance_policy_01KSJ000000000000000000009" } as unknown as Entity,
      actor: ACTOR,
    });
    expect(res).toEqual({ created: 0, retired: 0 });
    expect(c.query as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(mocks.createEdge).not.toHaveBeenCalled();
  });

  it("creates a managed edge with origin='field' when none exists", async () => {
    const c = clientReturning([]);
    const res = await reconcileNodeEdges(c, {
      docoId: DOCO,
      entityType: "decision",
      entity: decision(P1),
      actor: ACTOR,
    });
    expect(res).toEqual({ created: 1, retired: 0 });
    expect(mocks.createChangeset).toHaveBeenCalledTimes(1);
    expect(mocks.createEdge).toHaveBeenCalledTimes(1);
    expect(mocks.createEdge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ edgeType: "decided_by", fromId: DEC, toId: P1, origin: "field" }),
    );
    expect(mocks.retireEdge).not.toHaveBeenCalled();
  });

  it("retires a stale field edge and creates the new target", async () => {
    const c = clientReturning([
      { id: "edge_stale", edge_type: "decided_by", to_id: P2, origin: "field" },
    ]);
    const res = await reconcileNodeEdges(c, {
      docoId: DOCO,
      entityType: "decision",
      entity: decision(P1),
      actor: ACTOR,
    });
    expect(res).toEqual({ created: 1, retired: 1 });
    expect(mocks.createEdge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ toId: P1, origin: "field" }),
    );
    expect(mocks.retireEdge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ id: "edge_stale" }),
    );
  });

  it("never retires an authored edge with the same target", async () => {
    const c = clientReturning([
      { id: "edge_authored", edge_type: "decided_by", to_id: P1, origin: "authored" },
    ]);
    const res = await reconcileNodeEdges(c, {
      docoId: DOCO,
      entityType: "decision",
      entity: decision(P1),
      actor: ACTOR,
    });
    expect(res).toEqual({ created: 0, retired: 0 });
    expect(mocks.createEdge).not.toHaveBeenCalled();
    expect(mocks.retireEdge).not.toHaveBeenCalled();
  });

  it("is idempotent: identical data skips the changeset entirely", async () => {
    const c = clientReturning([
      { id: "edge_live", edge_type: "decided_by", to_id: P1, origin: "field" },
    ]);
    const res = await reconcileNodeEdges(c, {
      docoId: DOCO,
      entityType: "decision",
      entity: decision(P1),
      actor: ACTOR,
    });
    expect(res).toEqual({ created: 0, retired: 0 });
    expect(mocks.createChangeset).not.toHaveBeenCalled();
    expect(mocks.createEdge).not.toHaveBeenCalled();
    expect(mocks.retireEdge).not.toHaveBeenCalled();
  });
});
