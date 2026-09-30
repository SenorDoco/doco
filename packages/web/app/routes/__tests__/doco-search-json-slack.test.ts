// A Slack-mirror Doco's search.json — the endpoint Señor Doco and MCP agents
// query — returns matching Slack messages alongside node hits.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  semantic: { queryEmbedding: Float32Array.from([1, 0, 0]), modelId: "test:model" },
  hybridSearch: vi.fn(),
  searchSlackMirror: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: (fn: (c: unknown) => unknown) => fn({}) }));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: async () => ({
    handle: "acme-slack",
    me: null,
    meta: { docoId: "doco_slack", goal: "" },
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
vi.mock("~/lib/notion-mirror-read.server", () => ({ searchNotionMirror: async () => [] }));
vi.mock("~/lib/codebase-read.server", () => ({ searchCodebase: async () => [] }));
vi.mock("~/lib/search.server", () => ({ hybridSearch: mocks.hybridSearch }));
vi.mock("~/lib/slack-mirror-read.server", () => ({ searchSlackMirror: mocks.searchSlackMirror }));

import { loader } from "../$docoHandle.search[.]json";

const slackHit = {
  type: "slack_message",
  channel: "eng",
  channel_id: "C_ENG",
  ts: "1700000200.000100",
  thread_ts: "1700000100.000100",
  author: "Ben",
  posted_at: "2023-11-14T22:16:40.000Z",
  text: "switching the pooler to transaction mode",
  permalink: "https://acme.slack.com/archives/C_ENG/p1700000200000100",
};

async function search(query: string) {
  const res = await loader({
    request: new Request(`https://doco.test/acme-slack/search.json?${query}`),
    params: { docoId: "acme-slack" },
  });
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hybridSearch.mockResolvedValue({ hits: [], candidateIds: [], usedVector: false });
  mocks.searchSlackMirror.mockResolvedValue([slackHit]);
});

describe("search.json on a Slack-mirror Doco", () => {
  it("returns matching Slack messages even when no node matches", async () => {
    const body = await search("q=pooler");

    expect(body.slack_messages).toEqual([slackHit]);
    expect(body.count).toBe(1);
    expect(body.warning ?? "").not.toMatch(/No entities match/);
    expect(mocks.searchSlackMirror).toHaveBeenCalledWith(
      {},
      "doco_slack",
      "pooler",
      20,
      mocks.semantic,
    );
  });

  it("leaves Slack out when the caller filters by node type or lifecycle", async () => {
    const byType = await search("q=pooler&node_type=decision");
    const byLifecycle = await search("q=pooler&lifecycle=active");

    expect(byType.slack_messages).toEqual([]);
    expect(byLifecycle.slack_messages).toEqual([]);
    expect(mocks.searchSlackMirror).not.toHaveBeenCalled();
  });

  it("returns no Slack messages for an empty query", async () => {
    const body = await search("q=");
    expect(body.slack_messages).toEqual([]);
  });
});
