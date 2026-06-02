import { describe, expect, it } from "vitest";
import { loader } from "../protocol.agent-oauth-recipe";

describe("/protocol/agent-oauth-recipe", () => {
  it("points hosted MCP setup to the Tokens/MCP manual tab instead of /connect", async () => {
    const response = loader({
      request: new Request("https://doco.test/protocol/agent-oauth-recipe"),
    });
    const body = await response.text();

    expect(body).toContain("Tokens/MCP");
    expect(body).toContain("Add MCP manually");
    expect(body).toContain("https://doco.test/api-keys");
    expect(body).not.toContain("https://doco.test/connect");
  });
});
