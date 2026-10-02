// /workspaces/:handle/brief — "What applies to…?": the workspace's search box
// became the brief (decision_01M3YYQ1JRBS04Z99KEP869F26, phase 2), so people
// see the same answer their agents get. The engine is stubbed; the
// private-Docos real-DB test drives the page against a real database.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import routes from "../../routes";

const mocks = vi.hoisted(() => ({
  composeBrief: vi.fn(),
  getCurrentPrincipal: vi.fn(),
  loadWorkspaceForRead: vi.fn(),
  recordQuery: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("~/lib/brief/brief.server", () => ({ composeBrief: mocks.composeBrief }));
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("~/lib/workspace-helpers.server", () => ({
  loadWorkspaceForRead: mocks.loadWorkspaceForRead,
}));
vi.mock("~/lib/query-log.server", () => ({ recordQuery: mocks.recordQuery }));
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("@doco/db", () => ({ withClient: (fn: (c: unknown) => unknown) => fn({}) }));

import WorkspaceBrief, { loader } from "../workspaces.$workspaceHandle.brief";

const WORKSPACE = { id: "workspace_1", handle: "acme", name: "Acme", constitution: "" };
const BRIEF = {
  brief_id: "brief_1",
  about: "add a route",
  touching: ["app/routes/x.tsx"],
  synthesis: "Ship small PRs [rule_1].",
  items: [
    {
      id: "rule_1",
      tier: "must_obey",
      type: "rule",
      doco: "rules",
      lifecycle: "active",
      summary: "Ship small PRs.",
      text: "Ship small PRs.\nOne change per pull request.",
      because: "standing rule",
      url: "https://doco.test/rules/rule/rule_1",
      updated_at: "2026-10-01T00:00:00.000Z",
      detail: "expanded",
    },
    {
      id: "idea_2",
      tier: "in_motion",
      type: "idea",
      doco: "ideas",
      lifecycle: "drafting",
      summary: "Route briefs through the hook.",
      text: "Route briefs through the hook.",
      because: "matches your ask; still drafting",
      url: "https://doco.test/ideas/idea/idea_2",
      updated_at: "2026-10-02T00:00:00.000Z",
      detail: "compact",
    },
  ],
  gaps: ["No decision names app/routes/x.tsx."],
  held_back: 3,
  budget: 4000,
  tokens_used: 120,
  steps: { total: 480 },
  warnings: [],
};

function load(query: string) {
  return loader({
    request: new Request(`https://doco.test/workspaces/acme/brief${query}`),
    params: { workspaceHandle: "acme" },
  });
}

describe("/workspaces/:handle/brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice" });
    mocks.loadWorkspaceForRead.mockResolvedValue({
      workspace: WORKSPACE,
      myRole: "owner",
      docos: [{ id: "doco_1" }, { id: "doco_2" }],
    });
    mocks.composeBrief.mockResolvedValue(BRIEF);
  });

  it("took the place of the workspace search route", () => {
    expect(routes.find((r) => r.path === "workspaces/:workspaceHandle/brief")?.file).toBe(
      "routes/workspaces.$workspaceHandle.brief.tsx",
    );
    expect(routes.find((r) => r.path === "workspaces/:workspaceHandle/search")).toBeUndefined();
  });

  it("shows the form alone until something is asked", async () => {
    const data = await load("");
    expect(data.brief).toBeNull();
    expect(mocks.composeBrief).not.toHaveBeenCalled();
    expect(mocks.recordQuery).not.toHaveBeenCalled();
  });

  it("briefs across the Docos the caller can read and logs one query of the workspace", async () => {
    const data = await load("?about=add+a+route&touching=app/routes/x.tsx&rerank=0");
    expect(data.brief?.brief_id).toBe("brief_1");
    expect(mocks.loadWorkspaceForRead).toHaveBeenCalledWith("acme", "user_alice");
    const [, scope, request] = mocks.composeBrief.mock.calls[0];
    expect(scope).toEqual({ docoIds: ["doco_1", "doco_2"], origin: "https://doco.test" });
    expect(request).toMatchObject({
      about: "add a route",
      touching: ["app/routes/x.tsx"],
      rerank: false,
      synthesize: true,
    });
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.recordQuery).toHaveBeenCalledWith(
      expect.any(Request),
      { workspaceId: "workspace_1", docoId: null },
      "user_alice",
      {
        brief_id: "brief_1",
        served: [
          { id: "rule_1", tier: "must_obey" },
          { id: "idea_2", tier: "in_motion" },
        ],
        held_back: 3,
        tokens_used: 120,
        steps: { total: 480 },
      },
    );
  });

  it("renders the brief by tier, with the synthesis, each item's reason, and the gaps", async () => {
    const loaderData = await load("?about=add+a+route&touching=app/routes/x.tsx");
    const Stub = createRoutesStub([
      { path: "/", Component: () => createElement(WorkspaceBrief, { loaderData }) },
    ]);
    const html = renderToStaticMarkup(createElement(Stub));
    expect(html).toContain("What applies to…?");
    expect(html).toContain('value="add a route"');
    expect(html).toContain('value="app/routes/x.tsx"');
    expect(html).toContain("Ship small PRs [rule_1].");
    expect(html.indexOf("Must obey")).toBeLessThan(html.indexOf("In motion"));
    expect(html).toContain('href="https://doco.test/rules/rule/rule_1"');
    expect(html).toContain("because standing rule");
    expect(html).toContain("One change per pull request.");
    expect(html).toContain("No decision names app/routes/x.tsx.");
    expect(html).toContain("3 held back");
    expect(html).not.toContain("Already decided");
  });
});
