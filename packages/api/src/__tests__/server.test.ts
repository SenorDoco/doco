import { resolve } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { reindex } from "@evalo/index";
import { makeApp } from "../server.js";

const REPO_ROOT = resolve(__dirname, "../../../..");

beforeAll(async () => {
  await reindex(REPO_ROOT);
});

describe("Hono REST API", () => {
  const app = makeApp({ evaloRoot: REPO_ROOT, defaultPrincipalId: "principal_01KR441EA199MZCP7RDMADFZW9" });

  it("GET /api/v1/health returns ok", async () => {
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET /api/v1/evalo returns root + counts", async () => {
    const res = await app.request("/api/v1/evalo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evalo: { slug: string }; counts: Record<string, number> };
    expect(body.evalo.slug).toBe("torrenegra/evalo");
    expect(body.counts.decision).toBeGreaterThanOrEqual(45);
  });

  it("GET /api/v1/evalo/decision/{id} returns one decision", async () => {
    const res = await app.request("/api/v1/evalo/decision/decision_01KR441EAMKYKCEBSEYHGJ8M3Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { node_type: string; slug: string };
    expect(body.node_type).toBe("decision");
    expect(body.slug).toBe("optimization-priority-order");
  });

  it("GET /api/v1/evalo/decision returns a list", async () => {
    const res = await app.request("/api/v1/evalo/decision?limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBe(5);
  });

  it("POST /api/v1/query runs SQL", async () => {
    const res = await app.request("/api/v1/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT COUNT(*) as n FROM rule" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { n: number }[] };
    expect(body.rows[0]?.n).toBe(5);
  });

  it("POST /api/v1/check on agent delete_evalo returns 422 (BLOCKED)", async () => {
    const action = {
      id: "action_01TESTAPI",
      node_type: "action" as const,
      verb: "delete_evalo",
      actor_id: "principal_01KR441EA259F7EE420Z4VWFPJ", // claude (agent)
      target: "evalo_01KR441EA0ZDMF0N5DY38GSVS3",
    };
    const res = await app.request("/api/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { blocked: boolean; results: Array<{ result: string }> };
    expect(body.blocked).toBe(true);
    expect(body.results.some((r) => r.result === "fail")).toBe(true);
  });

  it("POST /api/v1/check on human delete_evalo returns 200", async () => {
    const action = {
      id: "action_01TESTAPIHUMAN",
      node_type: "action" as const,
      verb: "delete_evalo",
      actor_id: "principal_01KR441EA199MZCP7RDMADFZW9", // torrenegra (human)
      target: "evalo_01KR441EA0ZDMF0N5DY38GSVS3",
    };
    const res = await app.request("/api/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocked: boolean };
    expect(body.blocked).toBe(false);
  });

  it("GET /api/v1/lint returns clean report", async () => {
    const res = await app.request("/api/v1/lint");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors: number };
    expect(body.errors).toBe(0);
  });
});
