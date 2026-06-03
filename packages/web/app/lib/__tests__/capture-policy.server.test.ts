import { upsertEntity } from "@doco/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureGuidancePolicy } from "../capture.server";

// Capture goes through enforce → persist → reindex → render. Mock the
// DB and side-effecting collaborators the same way capture-update does,
// so these tests exercise the real author-resolution logic in
// buildGuidancePolicyPayload without a Postgres.
vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    guidance_policy: { table: "guidance_policies", body: true },
    node_authoring_policy: { table: "node_authoring_policies", body: true },
  },
  getDocoById: vi.fn(async () => ({ id: "doco_x", handle: "torre-bpm" })),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(async () => undefined),
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
  const call = vi.mocked(upsertEntity).mock.calls.at(0);
  if (!call) throw new Error("upsertEntity was not called");
  return (call[0] as { data: Record<string, unknown> }).data;
}

describe("captureGuidancePolicy author resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures a guidance policy when no principal author can be resolved", async () => {
    // The new-policy form never collects an author; the route fills it
    // from the signed-in user. resolvePrincipalIdForUser returns null
    // whenever the Doco has no principal that maps to the user — e.g. a
    // BPMN-imported Doco whose principals are renamed roles ("Talent
    // seeker", "Torre"), not a "user"/"human" persona. The route then
    // passes authored_by_principal_id: undefined. Authorship is an
    // optional graph edge, so the policy must still capture — without it
    // the owner is blocked with a cryptic "authored_by_principal_id is
    // required" error (the reported bug).
    const result = await captureGuidancePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        policy: "Keep BPMN lane names in business language.",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ ok: true, id: expect.stringMatching(/^guidance_policy_/) });
    expect(upsertEntity).toHaveBeenCalledTimes(1);
    expect(persistedData()).not.toHaveProperty("authored_by");
  });

  it("records the principal author when the route resolves one", async () => {
    const result = await captureGuidancePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        policy: "Keep BPMN lane names in business language.",
        authored_by_principal_id: "principal_alice",
        created_by_user_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ ok: true });
    expect(persistedData()).toMatchObject({ authored_by: "principal_alice" });
  });

  it("still rejects a user id supplied as the author", async () => {
    const result = await captureGuidancePolicy(
      "/tmp/doco",
      DOCO_ID,
      "torre",
      "torre-bpm",
      {
        policy: "Keep BPMN lane names in business language.",
        authored_by_principal_id: "user_alice",
      },
      "https://doco.test",
    );

    expect(result).toMatchObject({ error: expect.stringContaining("must be a Principal NODE id") });
    expect(upsertEntity).not.toHaveBeenCalled();
  });
});
