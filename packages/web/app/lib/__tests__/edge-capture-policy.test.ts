// captureEdge wiring for edge-scoped authoring policies: it must pack BOTH
// endpoints into the judge candidate, block (422) when the edge policy fails,
// and exempt a `drafting` sketch edge. The DB + edge runner are mocked so this
// is a focused unit test of the wiring in edge-capture.server.

import { generateUlid, makeEntityId } from "@doco/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runEdge = vi.hoisted(() => ({ fn: vi.fn() }));
const dbStub = vi.hoisted(() => ({ createEdge: vi.fn() }));

vi.mock("../authoring-runner.server", () => ({ runEdgeAuthoringPolicies: runEdge.fn }));

vi.mock("@doco/db", () => ({
  // Endpoint resolution: return a node record keyed off the id prefix.
  getEntity: vi.fn(async (type: string, id: string) => ({
    id,
    doco_id: DOCO_ID,
    entity_type: type,
    data: type === "action" ? { verb: "posts" } : {},
    name: null,
    lifecycle: "active",
    type_named_value: type === "action" ? "Posts a job" : "Posts a job",
  })),
  createChangeset: vi.fn(async () => "tx_test"),
  createEdge: dbStub.createEdge,
  retireEdge: vi.fn(),
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
}));

import { captureEdge } from "../edge-capture.server";

const DOCO_ID = makeEntityId("doco", generateUlid());
const ACTION_ID = makeEntityId("action", generateUlid());
const INTENT_ID = makeEntityId("intent", generateUlid());

function makeInput(over: Record<string, unknown> = {}) {
  return {
    docoId: DOCO_ID,
    actorId: makeEntityId("user", generateUlid()),
    edgeType: "supports",
    fromId: ACTION_ID,
    toId: INTENT_ID,
    props: { role: "serves" },
    ...over,
  };
}

beforeEach(() => {
  runEdge.fn.mockReset();
  dbStub.createEdge.mockReset();
  dbStub.createEdge.mockResolvedValue({
    id: makeEntityId("edge", generateUlid()),
    lifecycle: "active",
  });
});

describe("captureEdge — edge-scoped policy wiring", () => {
  it("hands the edge runner the scoping AND both endpoint payloads", async () => {
    runEdge.fn.mockResolvedValue({ violations: [], blocking: null, warnings: [] });
    const res = await captureEdge(makeInput());
    expect("ok" in res && res.ok).toBe(true);
    expect(runEdge.fn).toHaveBeenCalledTimes(1);
    const arg = runEdge.fn.mock.calls[0][0];
    expect(arg.edge).toEqual({
      edge_type: "supports",
      role: "serves",
      from_node_type: "action",
      to_node_type: "intent",
    });
    // The judge candidate carries both endpoints keyed by node type.
    expect(arg.judgeCandidate.action).toMatchObject({ text: "Posts a job", verb: "posts" });
    expect(arg.judgeCandidate.intent).toMatchObject({ text: "Posts a job" });
  });

  it("returns 422 (and does not create the edge) when the policy blocks", async () => {
    runEdge.fn.mockResolvedValue({
      violations: [],
      blocking: { reason: "intent name is not the base form of the action", on_violation: "block" },
      warnings: [],
    });
    const res = await captureEdge(makeInput());
    expect("error" in res && res.status).toBe(422);
    expect("error" in res && res.error).toMatch(/base form of the action/i);
    expect(dbStub.createEdge).not.toHaveBeenCalled();
  });

  it("creates the edge when the policy passes", async () => {
    runEdge.fn.mockResolvedValue({ violations: [], blocking: null, warnings: [] });
    const res = await captureEdge(makeInput());
    expect("ok" in res && res.ok).toBe(true);
    expect(dbStub.createEdge).toHaveBeenCalledTimes(1);
  });

  it("exempts a drafting sketch edge — no policy evaluation", async () => {
    const res = await captureEdge(makeInput({ lifecycle: "drafting" }));
    expect("ok" in res && res.ok).toBe(true);
    expect(runEdge.fn).not.toHaveBeenCalled();
    expect(dbStub.createEdge).toHaveBeenCalledTimes(1);
  });
});
