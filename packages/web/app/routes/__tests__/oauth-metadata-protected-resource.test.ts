import { describe, expect, it } from "vitest";
import { loader } from "../oauth-metadata-protected-resource";

describe("/.well-known/oauth-protected-resource (RFC 9728)", () => {
  function load(urlStr: string): Promise<Record<string, unknown>> {
    const response = loader({ request: new Request(urlStr) }) as Response;
    return response.json();
  }

  it("advertises the /mcp resource and its authorization server, origin-relative", async () => {
    const body = await load("https://doco.to/.well-known/oauth-protected-resource");
    expect(body.resource).toBe("https://doco.to/mcp");
    expect(body.authorization_servers).toEqual(["https://doco.to"]);
    expect(body.scopes_supported).toContain("doco");
    expect(body.bearer_methods_supported).toContain("header");
  });

  it("derives the issuer from the request host (so previews/localhost work)", async () => {
    const body = await load("http://localhost:5173/.well-known/oauth-protected-resource");
    expect(body.resource).toBe("http://localhost:5173/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost:5173"]);
  });
});
