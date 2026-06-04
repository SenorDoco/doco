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
      request: new Request(
        "https://doco.test/torre-bpm/api/edges.json?from_id=state_visits_torre",
      ),
      params: { docoHandle: "torre-bpm" },
    } as never);

    expect(captured.sql).toMatch(/from_id = \$\d/);
    expect(captured.args).toContain("state_visits_torre");
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
      request: new Request(
        "https://doco.test/torre-bpm/api/edges.json?include_retired=true",
      ),
      params: { docoHandle: "torre-bpm" },
    } as never);

    expect(captured.sql).not.toMatch(/lifecycle <> 'retired'/);
  });
});
