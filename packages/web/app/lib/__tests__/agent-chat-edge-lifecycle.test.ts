// The sidebar agent's system prompt must teach EDGE lifecycle as a
// first-class operation — not just node lifecycle.
//
// Regression guard for the failure where "for these queued nodes, put their
// edges in the queued stage too" got executed as "activate the 26 nodes":
// the prompt only scaffolded node lifecycle (and led with "activate"), gave
// edge lifecycle a single parenthetical, and never surfaced the
// active-edge⟹active-endpoints invariant that makes re-staging an edge a
// motivated move. With nothing teaching the edge path, the model snapped to
// the well-trodden node-activation one — the opposite of the request.
//
// buildSystemBlocks is a pure function of (principal, bootstrap); the
// server-only deps are stubbed so importing agent-chat.server doesn't drag
// the DB / Anthropic client in at module load.

import { describe, expect, it, vi } from "vitest";
import type { CurrentPrincipal } from "../session.server";

vi.mock("@doco/db", () => ({
  getDocoById: vi.fn(),
  getDocoByIdOrHandle: vi.fn(),
  getWorkspaceById: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  withClient: vi.fn(),
}));
vi.mock("../assistant-runtime.server", () => ({
  SENOR_DOCO_DEFAULT_MAX_TOKENS: 8192,
  getSenorDocoModel: () => "claude-test",
  missingSenorDocoAnthropicMessage: () => null,
  streamSenorDocoMessage: vi.fn(),
}));
vi.mock("../doco-api-tool.server", () => ({
  DOCO_API_TOOL: {
    name: "doco_api",
    description: "Call a Doco API route",
    input_schema: { type: "object", properties: {} },
  },
  runDocoApiToolRequest: vi.fn(),
}));
vi.mock("../internal-fetch.server", () => ({ internalFetch: vi.fn() }));
vi.mock("../dotenv.server", () => ({ ensureEnvLoaded: vi.fn() }));
vi.mock("../telemetry.server", () => ({ upsertAgentTurn: vi.fn() }));
vi.mock("../host.server", () => ({ listAllDocos: vi.fn(async () => []) }));
vi.mock("../doco-access.server", () => ({
  canAccessDoco: vi.fn(),
  oauthTokenGrantsDoco: vi.fn(),
}));
vi.mock("../agent-bootstrap.server", () => ({
  loadWorkspaceConstitutionsForPrincipal: vi.fn(),
}));
vi.mock("../senor-doco-prompt.server", () => ({
  buildSenorDocoCorePrompt: () => "CORE PROMPT",
}));

import { buildSystemBlocks } from "../agent-chat.server";

const principal: CurrentPrincipal = {
  id: "user_edgelifecycle00000000000",
  username: "harness",
  type: "person",
  isHuman: true,
};

function sidebarPrompt(): string {
  return buildSystemBlocks(principal, {
    docoLines: [],
    workspaceLines: [],
    policySnippets: [],
    constitutionSections: [],
    needsWorkspaceChoice: false,
  })
    .map((b) => b.text)
    .join("\n");
}

describe("sidebar prompt — edges are a first-class lifecycle target", () => {
  it("documents PATCH of an edge's lifecycle as its own endpoint, not a parenthetical", () => {
    expect(sidebarPrompt()).toContain("PATCH /<handle>/api/edges/<id>.json");
  });

  it("surfaces the active-edge⟹active-endpoints invariant that motivates re-staging", () => {
    // Without this rule the request reads as backwards, so the model
    // 'corrects' it into the familiar forward action (activate).
    expect(sidebarPrompt()).toContain("An ACTIVE edge can only connect ACTIVE nodes");
  });

  it("names the exact anti-pattern: don't activate the nodes to reconcile a queued node's edges", () => {
    expect(sidebarPrompt()).toContain("never reconcile the mismatch by activating the nodes");
  });
});
