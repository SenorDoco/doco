// Alexander, 2026-09-30: one agent-instructions template all over Doco. The
// block in lib/agent-instructions.ts is the only one; every other place that
// talks to agents hands it over or points at the page that shows it, /agents
// (the home page until 2026-10-01).
import { describe, expect, it } from "vitest";
import { AI_INSTRUCTIONS_META } from "~/lib/agent-instructions";
import routes from "../../routes";
import { loader as probe } from "../agent-probes[.]ts";
import { loader as inviteAgentTxt } from "../invite.$code.agent[.]txt";
import { loader as oauthRecipe } from "../protocol.agent-oauth-recipe";
import { loader as robots } from "../robots[.]txt";

describe("the one agent-instructions template", () => {
  it("replaces the old protocol page: its address sends agents to /agents", async () => {
    const route = routes.find((r) => r.path === "protocol/canonical-instructions");
    expect(route?.file).toBe("routes/agent-probes[.]ts.tsx");
    const response = await probe();
    expect(response.headers.get("Location")).toBe("/agents");
  });

  it("is where robots.txt and the agent meta tag send agents", async () => {
    expect(await (await robots()).text()).toContain("the instructions to use Doco are at /agents.");
    expect(AI_INSTRUCTIONS_META).toContain("follow the agent instructions at /agents.");
  });

  // Alexander, 2026-10-07: with the hook, forget about AGENTS.md. The recipe
  // has agents follow the instructions, which install the hook that loads
  // them, and keep no copy.
  it("is what the OAuth recipe has agents follow, keeping no copy in AGENTS.md", async () => {
    const body = await oauthRecipe({
      request: new Request("https://doco.test/protocol/agent-oauth-recipe"),
    }).text();
    expect(body).toContain("follow the instructions at https://doco.test/agents, which");
    expect(body).toContain("so the project keeps no copy");
    expect(body).not.toContain("AGENTS.md");
    expect(body).not.toMatch(/canonical[ _-]instructions/i);
    expect(body).toContain("`agent_instructions`");
  });

  it("is where an agent handed an invite URL goes to use Doco", async () => {
    const body = await inviteAgentTxt({
      request: new Request("https://doco.test/invite/abc/agent.txt"),
      params: { code: "abc" },
    }).text();
    expect(body).toContain("To use Doco, follow the instructions at:");
    expect(body).toContain("https://doco.test/agents\n");
  });
});
