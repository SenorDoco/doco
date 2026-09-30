// A Notion-mirror Doco's search.json — the endpoint Señor Doco and MCP agents
// query — returns matching Notion pages alongside node hits.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  semantic: { queryEmbedding: Float32Array.from([1, 0, 0]), modelId: "test:model" },
  hybridSearch: vi.fn(),
  searchNotionMirror: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: async () => ({
    handle: "acme-notion",
    me: null,
    meta: { docoId: "doco_notion", goal: "" },
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
vi.mock("~/lib/codebase-read.server", () => ({ searchCodebase: async () => [] }));
vi.mock("~/lib/notion-mirror-read.server", () => ({
  searchNotionMirror: mocks.searchNotionMirror,
}));

import { loader } from "../$docoHandle.search[.]json";

const notionHit = {
  type: "notion_page",
  page_id: "11111111-0000-4000-8000-000000000002",
  title: "Onboarding",
  path: "Handbook",
  url: "https://www.notion.so/11111111000040008000000000000002",
  last_edited_time: "2026-09-27T10:00:00.000Z",
  snippet: "Day one: Laptop Badge See Handbook.",
};

async function search(query: string) {
  const res = await loader({
    request: new Request(`https://doco.test/acme-notion/search.json?${query}`),
    params: { docoId: "acme-notion" },
  });
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hybridSearch.mockResolvedValue({ hits: [], candidateIds: [], usedVector: false });
  mocks.searchNotionMirror.mockResolvedValue([notionHit]);
});

describe("search.json on a Notion-mirror Doco", () => {
  it("returns matching Notion pages even when no node matches", async () => {
    const body = await search("q=laptop");

    expect(body.notion_pages).toEqual([notionHit]);
    expect(body.count).toBe(1);
    expect(body.warning ?? "").not.toMatch(/No entities match/);
    expect(mocks.searchNotionMirror).toHaveBeenCalledWith(
      {},
      "doco_notion",
      "laptop",
      20,
      mocks.semantic,
    );
  });

  it("leaves Notion out when the caller filters by node type or lifecycle", async () => {
    const byType = await search("q=laptop&node_type=decision");
    const byLifecycle = await search("q=laptop&lifecycle=active");

    expect(byType.notion_pages).toEqual([]);
    expect(byLifecycle.notion_pages).toEqual([]);
    expect(mocks.searchNotionMirror).not.toHaveBeenCalled();
  });

  it("returns no Notion pages for an empty query", async () => {
    const body = await search("q=");
    expect(body.notion_pages).toEqual([]);
  });
});
