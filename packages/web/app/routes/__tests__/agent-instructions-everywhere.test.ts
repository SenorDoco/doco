// Alexander, 2026-09-30: one agent-instructions template all over Doco. The
// home page block (lib/agent-instructions.ts) is the only one; every other
// place that talks to agents hands it over or points at it.
import { describe, expect, it } from "vitest";
import routes from "../../routes";
import { loader as probe } from "../agent-probes[.]ts";
import { loader as inviteAgentTxt } from "../invite.$code.agent[.]txt";
import { loader as oauthRecipe } from "../protocol.agent-oauth-recipe";

describe("the one agent-instructions template", () => {
  it("replaces the old protocol page: its address sends agents to the home page", async () => {
    const route = routes.find((r) => r.path === "protocol/canonical-instructions");
    expect(route?.file).toBe("routes/agent-probes[.]ts.tsx");
    const response = await probe();
    expect(response.headers.get("Location")).toBe("/");
  });

  it("is what the OAuth recipe has agents keep in AGENTS.md", async () => {
    const body = await oauthRecipe({
      request: new Request("https://doco.test/protocol/agent-oauth-recipe"),
    }).text();
    expect(body).toMatch(
      /AGENTS\.md` with the instructions from the Doco home page \(https:\/\/doco\.test\/\)/,
    );
    expect(body).not.toMatch(/canonical[ _-]instructions/i);
    expect(body).toContain("`agent_instructions`");
  });

  it("is where an agent handed an invite URL goes to use Doco", async () => {
    const body = await inviteAgentTxt({
      request: new Request("https://doco.test/invite/abc/agent.txt"),
      params: { code: "abc" },
    }).text();
    expect(body).toContain("To use Doco, follow the instructions on the Doco home page:");
    expect(body).toContain("https://doco.test/\n");
  });
});
