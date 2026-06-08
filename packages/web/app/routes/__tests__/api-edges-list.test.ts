import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
}));

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
  requireDocoTypeWriteForRequest: vi.fn(),
}));

vi.mock("~/lib/authoring-source.server", () => ({
  authoringContextForRequest: vi.fn(),
}));

vi.mock("~/lib/edge-capture.server", () => ({
  captureEdge: vi.fn(),
}));

import { loader } from "../$docoHandle.api.edges[.]json";

/**
 * Capture the SQL + args the loader hands to the DB client so we can assert
 * how the query params shape the query. Returns a single fake edge row.
 */
function captureQuery() {
  const captured: { sql: string; args: unknown[] } = { sql: "", args: [] };
  mocks.withClient.mockImplementation(async (fn: (c: unknown) => unknown) =>
    fn({
      query: (sql: string, args: unknown[]) => {
        captured.sql = sql;
        captured.args = args;
        return { rows: [{ id: "edge_1" }] };
      },
    }),
  );
  return captured;
}

describe("GET /<doco>/api/edges.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      meta: { ownerId: "workspace_torre", docoId: "doco_bpms" },
    });
  });

  it("filters by from_id when the query param is supplied", async () => {
    const captured = captureQuery();

    await loader({
      request: new Request("https://doco.test/torre-bpm/api/edges.json?from_id=state_visits_torre"),
      params: { docoHandle: "torre-bpm" },
    } as never);

    expect(captured.sql).toMatch(/from_id = \$\d/);
    expect(captured.args).toContain("state_visits_torre");
  });

  it("filters by to_id when the query param is supplied", async () => {
    const captured = captureQuery();

    await loader({
      request: new Request("https://doco.test/torre-bpm/api/edges.json?to_id=state_visits_torre"),
      params: { docoHandle: "torre-bpm" },
    } as never);

    expect(captured.sql).toMatch(/to_id = \$\d/);
    expect(captured.args).toContain("state_visits_torre");
  });

  it("filters by both endpoints when from_id and to_id are supplied together", async () => {
    const captured = captureQuery();

    await loader({
      request: new Request("https://doco.test/torre-bpm/api/edges.json?from_id=a&to_id=b"),
      params: { docoHandle: "torre-bpm" },
    } as never);

    expect(captured.sql).toMatch(/from_id = \$\d/);
    expect(captured.sql).toMatch(/to_id = \$\d/);
    expect(captured.args).toContain("a");
    expect(captured.args).toContain("b");
  });

  it("returns the standard list envelope so the agent tool can trim it", async () => {
    // Edge listings reach Señor Doco through doco_api, whose result truncator
    // only knows how to gracefully trim `body.items`. A bespoke `{ edges }`
    // shape gets byte-sliced into invalid JSON when large, so the agent can't
    // read an edge id back out. Match every other list endpoint: { ok, type,
    // doco_id, count, items }.
    captureQuery();

    const res = await loader({
      request: new Request("https://doco.test/torre-bpm/api/edges.json"),
      params: { docoHandle: "torre-bpm" },
    } as never);
    const body = await (res as Response).json();

    expect(body).toMatchObject({
      ok: true,
      type: "edges",
      doco_id: "doco_bpms",
      count: 1,
      items: [{ id: "edge_1" }],
    });
    expect(body).not.toHaveProperty("edges");
  });

  it("excludes retired edges by default", async () => {
    const captured = captureQuery();

    await loader({
      request: new Request("https://doco.test/torre-bpm/api/edges.json"),
      params: { docoHandle: "torre-bpm" },
    } as never);

    expect(captured.sql).toMatch(/lifecycle <> 'retired'/);
  });

  it("includes retired edges when include_retired=true", async () => {
    const captured = captureQuery();

    await loader({
      request: new Request("https://doco.test/torre-bpm/api/edges.json?include_retired=true"),
      params: { docoHandle: "torre-bpm" },
    } as never);

    expect(captured.sql).not.toMatch(/lifecycle <> 'retired'/);
  });
});
