import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addGrantsToApiKey: vi.fn(),
  convertApiKeyToActor: vi.fn(),
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
  convertApiKeyToActor: mocks.convertApiKeyToActor,
  listApiKeysForUser: mocks.listApiKeysForUser,
  loadScopeOptions: mocks.loadScopeOptions,
  mintApiKey: mocks.mintApiKey,
  revokeApiKey: mocks.revokeApiKey,
}));

import { catalogFromOptions } from "~/lib/grant-picker";
import ApiKeysPage, {
  ExistingTokensPanel,
  ManualMcpPanel,
  action,
  actorScopeLabel,
  formatLastUsedLabel,
  meta,
} from "../tokens";

function formRequest(fields: Record<string, string>): Request {
  return new Request("https://doco.test/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("/tokens page action", () => {
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

  it("converts an existing token to actor when Modify-access picks 'All your workspaces'", async () => {
    mocks.convertApiKeyToActor.mockResolvedValue(undefined);

    const result = await action({
      request: formRequest({
        intent: "add_grants",
        client_id: "doco_client_existing",
        grants: JSON.stringify([
          { level: "actor", target_id: "", role: "writer", write_types: [] },
        ]),
      }),
    });

    expect(result).toMatchObject({
      intent: "add_grants",
      ok: true,
      client_id: "doco_client_existing",
    });
    // Convert (replace) — NOT a widening add.
    expect(mocks.convertApiKeyToActor).toHaveBeenCalledWith({
      me: expect.objectContaining({ id: "user_alice" }),
      client_id: "doco_client_existing",
      actorRole: "writer",
    });
    expect(mocks.addGrantsToApiKey).not.toHaveBeenCalled();
  });

  it("mints an actor token from an 'All your workspaces' pick, carrying the role ceiling", async () => {
    mocks.mintApiKey.mockResolvedValue({ id: "doco_client_new" });

    const result = await action({
      request: formRequest({
        intent: "mint",
        label: "claude-code",
        // The picker emits a single actor grant; its role is the ceiling.
        grants: JSON.stringify([
          { level: "actor", target_id: "", role: "reader", write_types: [] },
        ]),
      }),
    });

    expect(result).toMatchObject({ intent: "mint", ok: true });
    expect(mocks.mintApiKey).toHaveBeenCalledWith({
      me: expect.objectContaining({ id: "user_alice" }),
      label: "claude-code",
      grants: [],
      grantType: "actor",
      actorRole: "reader",
    });
  });

  it("treats an 'owner' actor pick as a null ceiling (full live role)", async () => {
    mocks.mintApiKey.mockResolvedValue({ id: "doco_client_new" });

    await action({
      request: formRequest({
        intent: "mint",
        label: "codex",
        grants: JSON.stringify([{ level: "actor", target_id: "", role: "owner", write_types: [] }]),
      }),
    });

    expect(mocks.mintApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ grantType: "actor", actorRole: null }),
    );
  });

  it("mints a scoped token from a normal grant payload (no actor path)", async () => {
    mocks.mintApiKey.mockResolvedValue({ id: "doco_client_new" });
    const grants = [{ level: "workspace", target_id: "workspace_a", role: "writer" }];

    await action({
      request: formRequest({ intent: "mint", label: "ci", grants: JSON.stringify(grants) }),
    });

    // Regular mint: grants pass through, no actor grantType/actorRole.
    expect(mocks.mintApiKey).toHaveBeenCalledWith({
      me: expect.objectContaining({ id: "user_alice" }),
      label: "ci",
      grants: [{ level: "workspace", target_id: "workspace_a", role: "writer" }],
    });
  });

  it("organizes the page into Add MCP / Generate tokens / Existing tokens tabs", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ApiKeysPage, {
          loaderData: {
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

  it("labels an actor token by its breadth + ceiling (so it never reads as scopeless)", () => {
    // The existing-tokens row shows this for grant_type === 'actor' instead of
    // the empty-grants "No active scopes" — the broadest token must read broad.
    expect(actorScopeLabel("reader")).toBe("All your workspaces · reader");
    expect(actorScopeLabel("writer")).toBe("All your workspaces · writer");
    // owner ceiling = full live role = no suffix.
    expect(actorScopeLabel(null)).toBe("All your workspaces");
  });

  it("shows ONE /mcp connector URL describing the multi-workspace reach (no picker)", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, { host: "https://doco.test" }),
    );

    // The two steps now carry the headings; the old panel title is gone.
    expect(markup).not.toContain("Connect an agent to Doco");
    expect(markup).toContain("1. Connect the MCP to your environment");
    // One endpoint at /mcp — no per-workspace picker, no workspace in the URL.
    expect(markup).toContain("https://doco.test/mcp");
    expect(markup).not.toContain("per workspace");
    expect(markup).not.toContain("Select a workspace");
    expect(markup).not.toContain("WORKSPACE_ID");
    expect(markup).not.toContain("/workspace_");
    expect(markup).not.toContain("can never touch two");
    expect(markup).not.toContain("doco_select_workspace");
    // The stale "one Doco at a time" reach prose is gone (the grant is the scope).
    expect(markup).not.toMatch(/one Doco at a time/i);
    // The per-client picker is gone — just the URL connects the MCP now.
    expect(markup).not.toContain("Pick your client for step-by-step setup.");
    expect(markup).not.toContain("claude.ai · Claude Desktop · Claude mobile · Cursor");
    expect(markup).not.toContain("ChatGPT & other clients");
    expect(markup).not.toContain("mcp-provider-");
    // Step 2: the same instructions the home page gives, from the one
    // template, not a page-specific prompt.
    expect(markup).toContain("2. Give your agent these instructions");
    expect(markup).toContain("### 1. Check the Doco connection");
    expect(markup).toContain('id="instructions"');
    expect(markup).not.toContain("Search Doco first");
    expect(markup).not.toContain("Know your default scope");
    // The standalone read/write + OAuth capabilities line was dropped.
    expect(markup).not.toContain("Read and write on one OAuth 2.1 token");
  });

  it("trims a trailing slash on the host when building the /mcp URL", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, { host: "https://doco.test/" }),
    );
    expect(markup).toContain("https://doco.test/mcp");
    expect(markup).not.toContain("https://doco.test//mcp");
  });

  it("renders the MCP URL copy row with room for a primary copy button", () => {
    const markup = renderToStaticMarkup(
      createElement(ManualMcpPanel, { host: "https://doco.test" }),
    );

    const urlBlock = markup.match(/<pre class="([^"]*)" data-testid="mcp-url">/)?.[1] ?? "";
    const copyButton =
      markup.match(/<button type="button" data-testid="mcp-url-copy" class="([^"]*)">/)?.[1] ?? "";

    expect(urlBlock).toContain("text-sm");
    expect(urlBlock).toContain("py-3");
    expect(urlBlock).toContain("pr-24");
    expect(copyButton).toContain("bg-primary");
    expect(copyButton).toContain("text-primary-foreground");
  });
});

describe("/tokens page token metadata", () => {
  it("shows last used as how long ago", () => {
    expect(
      formatLastUsedLabel("2026-06-02T18:30:00.000Z", new Date("2026-06-02T19:52:00.000Z")),
    ).toBe("Last used 1h ago");
  });

  it("keeps never-used tokens explicit", () => {
    expect(formatLastUsedLabel(null, new Date("2026-06-02T19:52:00.000Z"))).toBe("Never used");
  });
});
