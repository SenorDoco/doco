// GET /api/v1/brief.json: who may ask, which Docos the brief draws from, how
// the query string becomes a request, what comes back, and the query log row.
// The engine is stubbed; its own tests run it against a real database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  composeBrief: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  extractBearer: vi.fn(),
  listVisibleDocoIdsForRequest: vi.fn(),
  isProjectToken: vi.fn(),
  validateProjectToken: vi.fn(),
  queryProjectTokenDocos: vi.fn(),
  loadAgentDisplayIdentity: vi.fn(),
  recordQuery: vi.fn(),
  waitUntil: vi.fn(),
  query: vi.fn(),
}));

vi.mock("~/lib/brief/brief.server", () => ({ composeBrief: mocks.composeBrief }));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
  extractBearer: mocks.extractBearer,
}));
vi.mock("~/lib/doco-access.server", () => ({
  listVisibleDocoIdsForRequest: mocks.listVisibleDocoIdsForRequest,
}));
vi.mock("~/lib/project-tokens.server", () => ({
  isProjectToken: mocks.isProjectToken,
  validateProjectToken: mocks.validateProjectToken,
  queryProjectTokenDocos: mocks.queryProjectTokenDocos,
}));
vi.mock("~/lib/agent-identity.server", () => ({
  loadAgentDisplayIdentity: mocks.loadAgentDisplayIdentity,
}));
vi.mock("~/lib/query-log.server", () => ({ recordQuery: mocks.recordQuery }));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn({ query: mocks.query }),
}));

import { loader, parseBriefParams } from "../api.v1.brief[.]json";

const BRIEF = {
  brief_id: "brief_1",
  about: "add a route",
  touching: ["app/routes/x.tsx"],
  synthesis: null,
  items: [
    {
      id: "rule_1",
      tier: "must_obey",
      type: "rule",
      doco: "rules",
      lifecycle: "active",
      summary: "Ship small PRs.",
      text: "Ship small PRs.",
      because: "standing rule",
      url: null,
      updated_at: null,
      detail: "expanded",
    },
  ],
  gaps: [],
  held_back: 2,
  budget: 800,
  tokens_used: 60,
  steps: { total: 480 },
  warnings: [],
};

function get(query: string, headers: Record<string, string> = {}): Promise<Response> {
  return loader({
    request: new Request(`https://doco.to/api/v1/brief.json?${query}`, { headers }),
  });
}

describe("parseBriefParams", () => {
  it("reads the request from the query string", () => {
    const params = parseBriefParams(
      new URL(
        "https://doco.to/api/v1/brief.json?about=+add+a+route+&touching=a.ts,b.ts&touching=%2312&budget=500&since=2026-10-01&target=decisions&workspace=acme&rerank=0&synthesize=false&format=text",
      ),
    );
    expect(params).toEqual({
      about: "add a route",
      touching: ["a.ts", "b.ts", "#12"],
      budget: 500,
      since: "2026-10-01",
      target: "decisions",
      workspace: "acme",
      rerank: false,
      synthesize: false,
      format: "text",
    });
  });

  it("defaults the budget, the switches and the format", () => {
    const params = parseBriefParams(new URL("https://doco.to/api/v1/brief.json?budget=-3"));
    expect(params).toMatchObject({
      about: "",
      touching: [],
      budget: 4000,
      rerank: true,
      synthesize: true,
      format: "json",
    });
  });
});

describe("GET /api/v1/brief.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extractBearer.mockReturnValue(null);
    mocks.isProjectToken.mockReturnValue(false);
    mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_alice" });
    mocks.listVisibleDocoIdsForRequest.mockResolvedValue(["doco_1", "doco_2"]);
    mocks.loadAgentDisplayIdentity.mockResolvedValue({ indicator_prefix: "[🔮 Doco @alice]" });
    mocks.composeBrief.mockResolvedValue(BRIEF);
    mocks.query.mockResolvedValue({ rows: [{ workspace_id: "workspace_1" }] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("needs a signed-in principal or a project token", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValue(null);
    const res = await get("about=x");
    expect(res.status).toBe(401);
    expect(mocks.composeBrief).not.toHaveBeenCalled();
  });

  it("briefs from the Docos the request may read and logs one query of the workspace", async () => {
    const res = await get("about=add+a+route&touching=app/routes/x.tsx&budget=800&rerank=0");
    expect(res.status).toBe(200);
    const [, scope, request] = mocks.composeBrief.mock.calls[0];
    expect(scope).toEqual({ docoIds: ["doco_1", "doco_2"], origin: "https://doco.to" });
    expect(request).toMatchObject({
      about: "add a route",
      touching: ["app/routes/x.tsx"],
      budget: 800,
      rerank: false,
      synthesize: true,
    });
    const body = await res.json();
    expect(body.brief_id).toBe("brief_1");
    expect(body.text).toContain("## Must obey");
    expect(body.display.found).toBe("[🔮 Doco @alice] briefed: 1 items, 2 held back (0.5s)");
    // The workspace of the Doco the served item came from.
    expect(mocks.query.mock.calls[0][0]).toContain("WHERE handle = ANY");
    expect(mocks.query.mock.calls[0][1]).toEqual([["rules"]]);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.recordQuery).toHaveBeenCalledWith(
      expect.any(Request),
      { workspaceId: "workspace_1", docoId: null },
      "user_alice",
      {
        brief_id: "brief_1",
        served: [{ id: "rule_1", tier: "must_obey" }],
        held_back: 2,
        tokens_used: 60,
        steps: { total: 480 },
      },
    );
  });

  it("narrows to one workspace when asked", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: "doco_2" }] })
      .mockResolvedValueOnce({ rows: [{ workspace_id: "workspace_1" }] });
    await get("about=x&workspace=acme");
    expect(mocks.query.mock.calls[0][1]).toEqual([["doco_1", "doco_2"], "acme"]);
    expect(mocks.composeBrief.mock.calls[0][1].docoIds).toEqual(["doco_2"]);
  });

  it("gives a project token every Doco of its workspace, with no actor", async () => {
    mocks.extractBearer.mockReturnValue("doco_pt_x");
    mocks.isProjectToken.mockReturnValue(true);
    mocks.validateProjectToken.mockResolvedValue({ workspace_id: "workspace_9" });
    mocks.queryProjectTokenDocos.mockResolvedValue([{ id: "doco_9" }, { id: "doco_10" }]);
    const res = await get("about=x", { authorization: "Bearer doco_pt_x" });
    expect(res.status).toBe(200);
    expect(mocks.getCurrentPrincipalAsync).not.toHaveBeenCalled();
    expect(mocks.queryProjectTokenDocos.mock.calls[0][1]).toBe("workspace_9");
    expect(mocks.composeBrief.mock.calls[0][1].docoIds).toEqual(["doco_9", "doco_10"]);
    expect(mocks.recordQuery.mock.calls[0][2]).toBeNull();
    expect((await res.json()).display.found).toContain("[🔮 Doco] briefed");
  });

  it("returns the text rendering alone when format=text", async () => {
    const res = await get("about=x&format=text");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toMatch(/^Doco brief brief_1 · about: add a route\n/);
  });
});
