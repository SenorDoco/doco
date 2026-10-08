// Alexander, 2026-10-07: Doco supports only Claude Code, Codex and Gemini CLI
// for now. Each adds Doco with one command, so the agent follows its guide on
// /agents/connect itself, and the person only signs in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ConnectAgentGuide } from "~/components/connect-agent-guide";
import routes from "../../routes";
import ConnectAgentPage, { loader } from "../../routes/agents.connect";
import { agentConnectGuides } from "../agent-connect-guides";
import { CONNECT_AGENT_PATH, agentInstructions } from "../agent-instructions";

const guides = agentConnectGuides("https://doco.test/");
const guide = (id: string) => {
  const found = guides.find((g) => g.id === id);
  if (!found) throw new Error(`no guide ${id}`);
  return found;
};
const text = (id: string) => JSON.stringify(guide(id));

describe("agentConnectGuides", () => {
  it("covers only the agents Doco supports", () => {
    expect(guides.map((g) => g.name)).toEqual(["Claude Code", "Codex", "Gemini CLI"]);
  });

  // Claude Code on the web runs the project's hooks but takes its MCP servers
  // from claude.ai's connectors.
  it("sends Claude Code on the web to claude.ai's connectors", () => {
    expect(guide("claude-code").note).toContain(
      "Claude Code on the web uses your claude.ai connectors instead: add Doco there as a custom connector, with the URL https://doco.test/mcp.",
    );
  });

  it("connects every agent to the one MCP endpoint, and signs in to Doco", () => {
    for (const g of guides) {
      const all = JSON.stringify(g);
      expect(all, g.name).toContain("https://doco.test/mcp");
      expect(all, g.name).not.toContain("https://doco.test//mcp");
      // One-click Allow (decision_01M4EQPJ6AKETJ1508W254DXVB).
      expect(all, g.name).toContain("Doco opens in your browser: sign in and choose Allow.");
    }
  });

  it("gives each agent its own commands", () => {
    expect(text("claude-code")).toContain(
      "claude mcp add --transport http --scope user doco https://doco.test/mcp",
    );
    expect(text("codex")).toContain("codex mcp add doco --url https://doco.test/mcp");
    expect(text("codex")).toContain("codex mcp login doco");
    expect(text("gemini-cli")).toContain("/mcp auth doco");
  });

  // Alexander, 2026-09-30: every duty calls a Doco tool, so the tools must run
  // without an approval each time; each guide says how, where the agent can.
  it("lets Doco's tools run without asking, where the agent allows it", () => {
    expect(text("claude-code")).toContain("mcp__doco");
    expect(text("gemini-cli")).toContain("--trust doco");
    expect(text("codex")).toContain("Allow and don't ask me again");
  });
});

describe("ConnectAgentGuide", () => {
  const render = (initial: string | null) =>
    renderToStaticMarkup(createElement(ConnectAgentGuide, { guides, initial }));

  it("asks which agent, and shows no steps until one is picked", () => {
    const html = render(null);
    expect(html).toContain("Which agent do you use?");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("walks the picked agent's steps, its own guide opening in a new tab", () => {
    const html = render("codex");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("<ol");
    // Each thing to paste comes with a Copy button.
    expect(html).toContain("codex mcp add doco --url https://doco.test/mcp</pre>");
    expect(html).toContain(">Copy</button>");
    expect(html).toContain('href="https://learn.chatgpt.com/docs/extend/mcp" target="_blank"');
  });
});

describe("/agents/connect", () => {
  it("is the page the agent instructions send the agent to", () => {
    expect(CONNECT_AGENT_PATH).toBe("/agents/connect");
    expect(routes.find((r) => r.path === "agents/connect")?.file).toBe("routes/agents.connect.tsx");
    expect(agentInstructions("https://doco.test")).toContain("https://doco.test/agents/connect");
  });

  it("needs no sign-in, and opens the agent named in ?agent=", () => {
    const loaderData = loader({
      request: new Request("https://doco.test/agents/connect?agent=codex"),
    });
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ConnectAgentPage, { loaderData })),
    );
    expect(html).toContain("Connect Doco to your agent");
    expect(html).toContain("codex mcp add doco --url https://doco.test/mcp");
    expect(html).toContain('href="/agents"');
  });
});
