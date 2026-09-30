// A codebase Doco's search.json — the endpoint Señor Doco and MCP agents
// query — returns matching code files alongside node hits.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  semantic: { queryEmbedding: Float32Array.from([1, 0, 0]), modelId: "test:model" },
  hybridSearch: vi.fn(),
  searchCodebase: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: async () => ({
    handle: "acme-codebase",
    me: null,
    meta: { docoId: "doco_code", goal: "" },
  }),
}));
vi.mock("~/lib/agent-identity.server", () => ({ loadAgentDisplayIdentity: async () => null }));
vi.mock("~/lib/embedding-provider.server", () => ({
  embedQuery: async () => ({ semantic: mocks.semantic, warning: null }),
}));
vi.mock("~/lib/search-filters.server", () => ({
  computeFilterFacets: async () => ({ lifecycle: [], nodeType: [] }),
  parseSearchFilters: () => ({ lifecycle: null, nodeType: null, limit: 100 }),
}));
vi.mock("~/lib/search.server", () => ({ hybridSearch: mocks.hybridSearch }));
vi.mock("~/lib/slack-mirror-read.server", () => ({ searchSlackMirror: async () => [] }));
vi.mock("~/lib/notion-mirror-read.server", () => ({ searchNotionMirror: async () => [] }));
vi.mock("~/lib/codebase-read.server", () => ({ searchCodebase: mocks.searchCodebase }));

import { loader } from "../$docoHandle.search[.]json";

const codeHit = {
  type: "code_file",
  repo: "acme/app",
  path: "src/billing/invoice.ts",
  url: "https://github.com/acme/app/blob/HEAD/src/billing/invoice.ts",
  snippet: "export function totalInvoice(lines) {",
  line: 3,
};

async function search(query: string) {
  const res = await loader({
    request: new Request(`https://doco.test/acme-codebase/search.json?${query}`),
    params: { docoId: "acme-codebase" },
  });
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hybridSearch.mockResolvedValue({ hits: [], candidateIds: [], usedVector: false });
  mocks.searchCodebase.mockResolvedValue([codeHit]);
});

describe("search.json on a codebase Doco", () => {
  it("returns matching code files even when no node matches", async () => {
    const body = await search("q=totalInvoice");

    expect(body.code_files).toEqual([codeHit]);
    expect(body.count).toBe(1);
    expect(body.warning ?? "").not.toMatch(/No entities match/);
    expect(mocks.searchCodebase).toHaveBeenCalledWith({}, "doco_code", "totalInvoice", 20);
  });

  it("leaves code out when the caller filters by node type or lifecycle", async () => {
    const byType = await search("q=totalInvoice&node_type=decision");
    const byLifecycle = await search("q=totalInvoice&lifecycle=active");

    expect(byType.code_files).toEqual([]);
    expect(byLifecycle.code_files).toEqual([]);
    expect(mocks.searchCodebase).not.toHaveBeenCalled();
  });

  it("returns no code files for an empty query", async () => {
    const body = await search("q=");
    expect(body.code_files).toEqual([]);
  });
});
