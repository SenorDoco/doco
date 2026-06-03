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

vi.mock("~/components/site-header", () => ({
  SiteHeader: () => null,
}));

import { catalogFromOptions } from "~/lib/grant-picker";
import ApiKeysPage, {
  ExistingTokensPanel,
  ManualMcpPanel,
  ProviderInstructions,
  action,
  formatLastUsedLabel,
  mcpUrlForWorkspace,
  meta,
} from "../api-keys";

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

  it("organizes the page into Add MCP / Generate tokens / Existing tokens tabs", () => {
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
    // The three tabs that replace the old mode switcher.
    expect(markup).toContain("Add MCP");
    expect(markup).toContain("Generate tokens");
    expect(markup).toContain("Existing tokens");
    // The "Invite AI agent" onboarding option is gone for good.
    expect(markup).not.toContain("Invite AI agent");
  });

  it("drops the redundant 'All access tokens' heading from the existing-tokens tab", () => {
    const markup = renderToStaticMarkup(
      createElement(ExistingTokensPanel, { keys: [], catalog: catalogFromOptions([], []) }),
    );

    // The tab label is self-explanatory, so the in-panel title is removed…
    expect(markup).not.toContain("All access tokens");
    // …but the empty state still reads.
    expect(markup).toContain("No active tokens yet.");
  });

  it("builds the per-workspace MCP URL, trimming a trailing slash on the host", () => {
    expect(mcpUrlForWorkspace("https://doco.test", "workspace_01ABC")).toBe(
      "https://doco.test/workspace_01ABC/mcp",
    );
    expect(mcpUrlForWorkspace("https://doco.test/", "workspace_01ABC")).toBe(
      "https://doco.test/workspace_01ABC/mcp",
    );
  });

  it("asks which workspace first and reveals nothing concrete until one is picked", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, {
        host: "https://doco.test",
        workspaces: [
          { id: "workspace_01A", handle: "acme" },
          { id: "workspace_01B", handle: "beta" },
        ],
      }),
    );

    expect(markup).toContain("Connect a client to Doco");
    expect(markup).toContain("per workspace");
    // The selector offers every workspace by handle…
    expect(markup).toContain("acme");
    expect(markup).toContain("beta");
    // …but with two to choose from, nothing is picked yet, so neither the
    // URL nor the client setup is shown until the user selects one.
    expect(markup).not.toContain("https://doco.test/workspace_01A/mcp");
    expect(markup).not.toContain("https://doco.test/workspace_01B/mcp");
  });

  it("auto-selects and shows the URL when the user has exactly one workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, {
        host: "https://doco.test",
        workspaces: [{ id: "workspace_01ABC", handle: "acme" }],
      }),
    );

    // One workspace: no need to ask — its URL is shown right away.
    expect(markup).toContain("https://doco.test/workspace_01ABC/mcp");
    // Client setup steps stay behind the provider options until one is clicked.
    expect(markup).not.toContain("claude mcp add doco -- npx -y mcp-remote");
    // No app-wide /mcp endpoint is advertised anymore.
    expect(markup).not.toContain("https://doco.test/mcp");
    // The clickable provider options are present, and so is the capabilities note.
    expect(markup).toContain("Claude Desktop");
    expect(markup).toContain("ChatGPT");
    expect(markup).toContain("doco_request_access");
  });

  it("falls back to the WORKSPACE_ID placeholder when the user has no workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, { host: "https://doco.test" }),
    );

    expect(markup).toContain("https://doco.test/WORKSPACE_ID/mcp");
    expect(markup).not.toContain("https://doco.test/mcp");
  });

  it("renders client-specific setup only for the chosen provider", () => {
    const url = "https://doco.test/workspace_01ABC/mcp";

    // Claude Code keeps the mcp-remote bridge command…
    const code = renderToStaticMarkup(
      createElement(ProviderInstructions, { providerId: "claude-code", url }),
    );
    expect(code).toContain(`claude mcp add doco -- npx -y mcp-remote ${url}`);
    // …but the hand-edited claude_desktop_config.json block is gone: modern
    // Claude Desktop uses the same custom-connector flow as Claude.ai, not a
    // local config file.
    expect(code).not.toContain("claude_desktop_config.json");

    // Claude Desktop now rides the connector path — paste the URL, no config
    // file, no bridge.
    const connector = renderToStaticMarkup(
      createElement(ProviderInstructions, { providerId: "claude-cursor", url }),
    );
    expect(connector).toContain("Add custom connector");
    expect(connector).toContain(url);
    expect(connector).not.toContain("claude_desktop_config.json");
    expect(connector).not.toContain("mcp-remote");

    const chatgpt = renderToStaticMarkup(
      createElement(ProviderInstructions, { providerId: "chatgpt", url }),
    );
    expect(chatgpt).toContain(url);
    // The ChatGPT path doesn't carry the Claude Desktop config.
    expect(chatgpt).not.toContain("claude_desktop_config.json");
  });

  it("groups Claude Desktop with the connector clients and gives Claude Code its own tab", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, {
        host: "https://doco.test",
        workspaces: [{ id: "workspace_01ABC", handle: "acme" }],
      }),
    );

    // Claude Desktop now shares the custom-connector button with Claude.ai…
    expect(markup).toContain("claude.ai · Claude Desktop · Claude mobile · Cursor");
    // …and Claude Code keeps its own (mcp-remote bridge) tab.
    expect(markup).toContain("Claude Code");
    // The old combined "Claude Desktop · Claude Code" tab is gone.
    expect(markup).not.toContain("Claude Desktop · Claude Code");
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
