import { describe, expect, it, vi } from "vitest";

// Mirror the capture.server test harness: mock the DB + side-effect modules
// so importing capture.server doesn't reach Postgres. The validation paths
// under test return before any persist call, and the lifecycle helper is pure.
vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    pull_request: { table: "nodes", body: true, typeNamedColumn: "prose" },
  },
  getDocoById: vi.fn(),
  getEntity: vi.fn(),
  upsertEntity: vi.fn(),
  withClient: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
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

import { capturePullRequest, pullRequestLifecycleFromState } from "../capture.server";

const DOCO_ID = "doco_01TEST00000000000000000001";
const LOCATOR = "https://github.com/acme/store/pull/482";

describe("pullRequestLifecycleFromState", () => {
  it("maps open → drafting", () => {
    expect(pullRequestLifecycleFromState("open")).toEqual({ lifecycle: "drafting" });
  });
  it("maps merged → asserted + succeeded", () => {
    expect(pullRequestLifecycleFromState("merged")).toEqual({
      lifecycle: "asserted",
      outcome: "succeeded",
    });
  });
  it("maps closed → retired", () => {
    expect(pullRequestLifecycleFromState("closed")).toEqual({ lifecycle: "retired" });
  });
  it("defaults undefined → drafting", () => {
    expect(pullRequestLifecycleFromState(undefined)).toEqual({ lifecycle: "drafting" });
  });
});

describe("capturePullRequest validation", () => {
  const call = (draft: Record<string, unknown>) =>
    capturePullRequest("/tmp/doco", DOCO_ID, "owner", "doco", draft as never);

  it("requires pull_request prose", async () => {
    const r = await call({ title: "T", locator: LOCATOR });
    expect(r).toMatchObject({ error: expect.stringContaining("pull_request is required") });
  });
  it("requires title", async () => {
    const r = await call({ pull_request: "p", locator: LOCATOR });
    expect(r).toMatchObject({ error: expect.stringContaining("title is required") });
  });
  it("requires locator", async () => {
    const r = await call({ pull_request: "p", title: "T" });
    expect(r).toMatchObject({ error: expect.stringContaining("locator is required") });
  });
  it("rejects an invalid state", async () => {
    const r = await call({ pull_request: "p", title: "T", locator: LOCATOR, state: "weird" });
    expect(r).toMatchObject({ error: expect.stringContaining("state must be one of") });
  });
});
