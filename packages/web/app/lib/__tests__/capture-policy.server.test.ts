import { upsertPolicy } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturePolicy } from "../capture.server";

// Capture goes through enforce → persist → reindex → render. Mock the
// DB and side-effecting collaborators the same way capture-update does,
// so these tests exercise the real author-resolution logic in
// buildPolicyPayload without a Postgres.
vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    policy: { table: "policies", body: true },
  },
  getDocoById: vi.fn(async () => ({ id: "doco_x", handle: "torre-bpm" })),
  getEntity: vi.fn(),
  upsertPolicy: vi.fn(async () => undefined),
  upsertNode: vi.fn(async () => undefined),
  nodeRowFromFields: vi.fn(),
  recordEntityVersion: vi.fn(async () => undefined),
  withClient: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
  withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

vi.mock("../audit-log.server", () => ({ appendAuditEvent: vi.fn() }));

vi.mock("../authoring-runner.server", () => ({
  runAuthoringPolicies: vi.fn(async () => ({
    evaluated: 0,
    passed: 0,
    blocking: null,
    violations: [],
    warnings: [],
  })),
}));

vi.mock("../redeem.server", () => ({
  reindex: vi.fn(async () => undefined),
  reindexEmbeddingsOnly: vi.fn(async () => undefined),
}));

const DOCO_ID = "doco_01TEST00000000000000000001";

function persistedData(): Record<string, unknown> {
  const call = vi.mocked(upsertPolicy).mock.calls.at(0);
  if (!call) throw new Error("upsertPolicy was not called");
  return (call[0] as { data: Record<string, unknown> }).data;
}

describe("capturePolicy author resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures a policy when no principal author can be resolved", async () => {
    // The new-policy form never collects an author; the route fills it
    // from the signed-in user. resolvePrincipalIdForUser returns null
    // whenever the Doco has no principal that maps to the user — e.g. a
    // BPMN-imported Doco whose principals are renamed roles ("Talent
    // seeker", "Torre"), not a "user"/"human" persona. The route then
    // passes authored_by_principal_id: undefined. Authorship is an
    // optional graph edge, so the policy must still capture — without it
    // the owner is blocked with a cryptic "authored_by_principal_id is
    // required" error (the reported bug).
    const result = await capturePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        kind: "suggestion",
        agent_instruction: "Keep BPMN lane names in business language.",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ ok: true, id: expect.stringMatching(/^policy_/) });
    expect(upsertPolicy).toHaveBeenCalledTimes(1);
    expect(persistedData()).not.toHaveProperty("authored_by");
  });

  it("links the capture footer to the policy's page, not the 404ing /policy/ node route", async () => {
    const result = await capturePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        kind: "suggestion",
        agent_instruction: "Keep BPMN lane names in business language.",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ ok: true });
    const { id, footer_lines } = result as { id: string; footer_lines: string[] };
    const footer = footer_lines.join("\n");
    // Policies are not nodes: the footer must point at the real Policy page
    // (`/<handle>/policies/<id>`), never the generic `/<type>/<id>` node route
    // (`/<handle>/policy/<id>`), which 404s for the `policy` type.
    expect(footer).toContain(`https://doco.test/torre-bpm/policies/${id}`);
    expect(footer).not.toContain(`/torre-bpm/policy/${id}`);
  });

  it("records the principal author when the route resolves one", async () => {
    const result = await capturePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        kind: "suggestion",
        agent_instruction: "Keep BPMN lane names in business language.",
        authored_by_principal_id: "principal_alice",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ ok: true });
    expect(persistedData()).toMatchObject({ authored_by: "principal_alice" });
  });

  it("captures an EDGE-scoped probabilistic policy carrying the edge scoping", async () => {
    const result = await capturePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        kind: "probabilistic",
        agent_instruction:
          "A sub-process Intent is the base form of the Action it serves (`Posts a job` → `Post a job`).",
        edge_type: "supports",
        from_node_type: "action",
        to_node_type: "intent",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ ok: true });
    expect(persistedData()).toMatchObject({
      kind: "probabilistic",
      predicate: {
        agent_instruction: expect.stringContaining("base form"),
        edge_type: "supports",
        from_node_type: "action",
        to_node_type: "intent",
      },
      on_violation: "block",
    });
    // Edge `role` is gone — the seeded predicate carries no role tag.
    expect((persistedData().predicate as Record<string, unknown>).edge_role).toBeUndefined();
    // Edge-scoped predicates carry no node-type filter.
    expect((persistedData().predicate as Record<string, unknown>).when_node_type).toBeUndefined();
  });

  it("rejects an edge-scoped policy with an unknown edge_type", async () => {
    const result = await capturePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        kind: "probabilistic",
        agent_instruction: "compare the endpoints",
        edge_type: "not_a_real_edge",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );
    expect(result).toMatchObject({ error: expect.stringContaining("not a first-class edge type") });
    expect(upsertPolicy).not.toHaveBeenCalled();
  });

  it("still rejects a user id supplied as the author", async () => {
    const result = await capturePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        kind: "suggestion",
        agent_instruction: "Keep BPMN lane names in business language.",
        authored_by_principal_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ error: expect.stringContaining("must be a Principal NODE id") });
    expect(upsertPolicy).not.toHaveBeenCalled();
  });
});
