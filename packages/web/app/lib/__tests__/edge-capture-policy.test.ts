// captureEdge wiring for edge-scoped authoring policies: it must pack BOTH
// endpoints into the judge candidate, block (422) when the edge policy fails,
// and evaluate a `drafting` sketch edge with the probabilistic judges deferred
// (the deterministic `requires_edge_type` allowlist still fires). The DB + edge
// runner are mocked so this is a focused unit test of the wiring in
// edge-capture.server.

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
    data: type === "action" ? { prose: "Posts a job", verb: "posts" } : { prose: "Posts a job" },
    name: null,
    lifecycle: "active",
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
    // Edge `role` is gone — the edge carries no role prop.
    props: {},
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
    // The edge scoping handed to the runner is edge_type + endpoint node types
    // only — `role` is gone.
    expect(arg.edge).toEqual({
      edge_type: "supports",
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

  it("still evaluates a drafting sketch edge, but with the probabilistic judges deferred", async () => {
    // The deterministic `requires_edge_type` allowlist is a structural gate, so
    // a drafting edge IS evaluated (a disallowed edge type is barred even in a
    // sketch). Only the probabilistic quality judges are deferred — the runner
    // is called with includeProbabilistic=false.
    runEdge.fn.mockResolvedValue({ violations: [], blocking: null, warnings: [] });
    const res = await captureEdge(makeInput({ lifecycle: "drafting" }));
    expect("ok" in res && res.ok).toBe(true);
    expect(runEdge.fn).toHaveBeenCalledTimes(1);
    expect(runEdge.fn.mock.calls[0][0].includeProbabilistic).toBe(false);
    expect(dbStub.createEdge).toHaveBeenCalledTimes(1);
  });

  it("blocks a drafting edge whose type the allowlist bars (structural gate fires in draft)", async () => {
    runEdge.fn.mockResolvedValue({
      violations: [],
      blocking: { reason: "edge_type `has_parent` not in allowlist", on_violation: "block" },
      warnings: [],
    });
    const res = await captureEdge(makeInput({ lifecycle: "drafting", edgeType: "has_parent" }));
    expect("error" in res && res.status).toBe(422);
    expect(dbStub.createEdge).not.toHaveBeenCalled();
  });
});
