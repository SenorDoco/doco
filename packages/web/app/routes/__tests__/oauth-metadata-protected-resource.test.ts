import { describe, expect, it } from "vitest";
import { loader as workspaceLoader } from "../oauth-metadata-protected-resource.$workspaceId";
import { loader } from "../oauth-metadata-protected-resource";

describe("/.well-known/oauth-protected-resource (RFC 9728, origin root)", () => {
  function load(urlStr: string): Promise<Record<string, unknown>> {
    const response = loader({ request: new Request(urlStr) }) as Response;
    return response.json();
  }

  it("names the origin as the resource (no app-wide /mcp) + advertises the AS", async () => {
    const body = await load("https://doco.to/.well-known/oauth-protected-resource");
    expect(body.resource).toBe("https://doco.to");
    expect(body.authorization_servers).toEqual(["https://doco.to"]);
    expect(body.scopes_supported).toContain("doco");
    expect(body.bearer_methods_supported).toContain("header");
  });

  it("derives the issuer from the request host (so previews/localhost work)", async () => {
    const body = await load("http://localhost:5173/.well-known/oauth-protected-resource");
    expect(body.resource).toBe("http://localhost:5173");
    expect(body.authorization_servers).toEqual(["http://localhost:5173"]);
  });
});

describe("/.well-known/oauth-protected-resource/<workspace-id>/mcp (per-workspace)", () => {
  function load(urlStr: string, workspaceId: string): Promise<Record<string, unknown>> {
    const response = workspaceLoader({
      request: new Request(urlStr),
      params: { workspaceId },
    }) as Response;
    return response.json();
  }

  it("names this workspace's MCP endpoint as the resource", async () => {
    const body = await load(
      "https://doco.to/.well-known/oauth-protected-resource/workspace_acme/mcp",
      "workspace_acme",
    );
    expect(body.resource).toBe("https://doco.to/workspace_acme/mcp");
    expect(body.authorization_servers).toEqual(["https://doco.to"]);
    expect(body.scopes_supported).toContain("doco");
  });
});
