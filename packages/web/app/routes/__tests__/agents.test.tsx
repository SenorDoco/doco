import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  AGENT_INSTRUCTIONS_PATH,
  AGENT_INSTRUCTIONS_TEXT_PATH,
  agentInstructions,
} from "~/lib/agent-instructions";
import routes from "../../routes";
import AgentsPage, { loader } from "../agents";
import { loader as instructionsText } from "../agents.instructions[.]md";

// Alexander, 2026-10-01: the home page no longer shows the agent
// instructions. They moved, unchanged, to /agents, where every pointer for
// agents now leads.
describe("/agents", () => {
  it("is a route of its own", () => {
    expect(AGENT_INSTRUCTIONS_PATH).toBe("/agents");
    expect(routes.find((r) => r.path === "agents")?.file).toBe("routes/agents.tsx");
  });

  it("hands over the agent instructions verbatim, with a Copy button", () => {
    const loaderData = loader({ request: new Request("https://doco.test/agents") });
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(AgentsPage, { loaderData })),
    );
    expect(html).toContain("To use Doco with your agent(s), give them these instructions:");
    expect(html).toContain(">Copy</button>");
    const escaped = renderToStaticMarkup(
      createElement("pre", null, agentInstructions("https://doco.test")),
    );
    expect(html).toContain(escaped.slice("<pre>".length, -"</pre>".length));
  });

  // Alexander, 2026-10-07: Doco supports Claude Code, Codex and Gemini CLI,
  // which connect themselves, and the hook brings the instructions, so the
  // project keeps only its workspace.
  it("names the agents Doco supports, and keeps the project to its workspace", () => {
    const loaderData = loader({ request: new Request("https://doco.test/agents") });
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(AgentsPage, { loaderData })),
    );
    expect(html).toContain("Doco works with Claude Code, Codex and Gemini CLI for now.");
    expect(html).toContain('href="/agents/connect"');
    expect(html).toContain("<code>.doco/workspace</code>");
    expect(html).not.toContain("Doco workspace:");
    expect(html).not.toContain("ChatGPT");
  });
});

// The Doco hook loads the instructions from here at the start of every
// session, without a token.
describe("/agents/instructions.md", () => {
  it("serves the instructions as plain text, to anyone", async () => {
    expect(AGENT_INSTRUCTIONS_TEXT_PATH).toBe("/agents/instructions.md");
    expect(routes.find((r) => r.path === "agents/instructions.md")?.file).toBe(
      "routes/agents.instructions[.]md.tsx",
    );
    const res = instructionsText({
      request: new Request("https://doco.test/agents/instructions.md"),
    });
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe(agentInstructions("https://doco.test"));
  });
});
