import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addGrantsToApiKey: vi.fn(),
  getCurrentPrincipal: vi.fn(),
  listApiKeysForUser: vi.fn(),
  loadScopeOptions: vi.fn(),
  mintApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/api-keys.server", () => ({
  addGrantsToApiKey: mocks.addGrantsToApiKey,
  listApiKeysForUser: mocks.listApiKeysForUser,
  loadScopeOptions: mocks.loadScopeOptions,
  mintApiKey: mocks.mintApiKey,
  revokeApiKey: mocks.revokeApiKey,
}));

vi.mock("~/components/agent-invite-prompt", () => ({
  AgentInvitePrompt: () => createElement("div", { "data-testid": "agent-invite-prompt" }),
}));

vi.mock("~/components/site-header", () => ({
  SiteHeader: () => null,
}));

import ApiKeysPage, { ManualMcpPanel, action, formatLastUsedLabel, meta } from "../api-keys";

function formRequest(fields: Record<string, string>): Request {
  return new Request("https://doco.test/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("/api-keys page action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
    mocks.addGrantsToApiKey.mockResolvedValue([]);
  });

  it("adds more grants to an existing token", async () => {
    const grants = [
      {
        level: "doco",
        target_id: "doco_bpms",
        role: "reader",
        write_types: ["decision"],
      },
    ];

    const result = await action({
      request: formRequest({
        intent: "add_grants",
        client_id: "doco_client_existing",
        grants: JSON.stringify(grants),
      }),
    });

    expect(result).toEqual({
      intent: "add_grants",
      ok: true,
      client_id: "doco_client_existing",
    });
    expect(mocks.addGrantsToApiKey).toHaveBeenCalledWith({
      me: expect.objectContaining({ id: "user_alice" }),
      client_id: "doco_client_existing",
      grants,
    });
  });

  it("labels the tokens and MCP page with the requested title", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ApiKeysPage, {
          loaderData: {
            me: { id: "user_alice", username: "alice", type: "person", isHuman: true },
            keys: [],
            scopeOptions: [],
            host: "https://doco.test",
            justMinted: null,
          },
        }),
      ),
    );

    expect(meta()[0]?.title).toBe("Tokens/MCP · Doco");
    expect(markup).toContain("Tokens/MCP");
    expect(markup).toContain("Add MCP manually");
    expect(markup).not.toContain(">Access tokens</h1>");
  });

  it("teaches the per-workspace MCP URL with the id placeholder when there are no workspaces", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, { host: "https://doco.test" }),
    );

    expect(markup).toContain("Connect a client to Doco");
    expect(markup).toContain("per workspace");
    expect(markup).toContain("https://doco.test/WORKSPACE_ID/mcp");
    expect(markup).toContain(
      "claude mcp add doco -- npx -y mcp-remote https://doco.test/WORKSPACE_ID/mcp",
    );
    // No app-wide /mcp endpoint is advertised anymore.
    expect(markup).not.toContain("https://doco.test/mcp");
    expect(markup).toContain("ChatGPT &amp; other MCP clients");
    expect(markup).toContain("doco_request_access");
  });

  it("lists a concrete per-workspace MCP URL when the user has a workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, {
        host: "https://doco.test",
        workspaces: [{ id: "workspace_01ABC", handle: "acme" }],
      }),
    );

    expect(markup).toContain("https://doco.test/workspace_01ABC/mcp");
    expect(markup).toContain(
      "claude mcp add doco -- npx -y mcp-remote https://doco.test/workspace_01ABC/mcp",
    );
  });
});

describe("/api-keys page token metadata", () => {
  it("shows last used as how long ago", () => {
    expect(
      formatLastUsedLabel("2026-06-02T18:30:00.000Z", new Date("2026-06-02T19:52:00.000Z")),
    ).toBe("Last used 1h ago");
  });

  it("keeps never-used tokens explicit", () => {
    expect(formatLastUsedLabel(null, new Date("2026-06-02T19:52:00.000Z"))).toBe("Never used");
  });
});
