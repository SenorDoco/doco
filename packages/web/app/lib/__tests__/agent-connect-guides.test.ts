// Alexander, 2026-10-07: Doco supports only Claude Code, Codex and Gemini CLI
// for now. Alexander, 2026-10-09: the person connects Doco to their agent
// before inviting it, from a terminal or from the agent's desktop app, so each
// guide shows both ways; the agent no longer adds Doco to itself.
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
const way = (id: string, name: string) => {
  const found = guide(id).ways.find((w) => w.name === name);
  if (!found) throw new Error(`no way ${name} for ${id}`);
  return JSON.stringify(found);
};

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

  it("connects every agent to the one MCP endpoint each way, and signs in to Doco", () => {
    for (const g of guides) {
      expect(g.ways.length, g.name).toBeGreaterThanOrEqual(2);
      for (const w of g.ways) {
        const all = JSON.stringify(w);
        expect(all, `${g.name}: ${w.name}`).toContain("https://doco.test/mcp");
        expect(all, `${g.name}: ${w.name}`).not.toContain("https://doco.test//mcp");
        // One-click Allow (decision_01M4EQPJ6AKETJ1508W254DXVB).
        expect(all, `${g.name}: ${w.name}`).toContain(
          "Doco opens in your browser: sign in and choose Allow.",
        );
      }
    }
  });

  it("gives each agent its own commands in a terminal", () => {
    expect(way("claude-code", "In a terminal")).toContain(
      "claude mcp add --transport http --scope user doco https://doco.test/mcp",
    );
    expect(way("codex", "In a terminal")).toContain(
      "codex mcp add doco --url https://doco.test/mcp",
    );
    expect(way("codex", "In a terminal")).toContain("codex mcp login doco");
    expect(way("gemini-cli", "In a terminal")).toContain("/mcp auth doco");
  });

  // Alexander, 2026-10-09: "explain how to do it from the desktop apps and
  // not just the CLI". The Claude desktop app's Code tab reads the servers in
  // claude_desktop_config.json; the ChatGPT desktop app shares Codex's
  // ~/.codex/config.toml; Gemini CLI has no desktop app, so its settings file.
  it("explains each agent's desktop app, or its settings file", () => {
    const claude = way("claude-code", "In the Claude desktop app");
    expect(claude).toContain("Settings");
    expect(claude).toContain("claude_desktop_config.json");
    expect(claude).toContain(
      '\\"doco\\": { \\"type\\": \\"http\\", \\"url\\": \\"https://doco.test/mcp\\" }',
    );
    expect(claude).toContain("Code tab");
    const codex = way("codex", "In the ChatGPT desktop app or an editor");
    expect(codex).toContain("~/.codex/config.toml");
    expect(codex).toContain('[mcp_servers.doco]\\nurl = \\"https://doco.test/mcp\\"');
    const gemini = way("gemini-cli", "In its settings file");
    expect(gemini).toContain("~/.gemini/settings.json");
    expect(gemini).toContain('\\"httpUrl\\": \\"https://doco.test/mcp\\", \\"trust\\": true');
  });

  // Alexander, 2026-09-30: every duty calls a Doco tool, so the tools must run
  // without an approval each time; each way says how, where the agent can.
  it("lets Doco's tools run without asking, where the agent allows it", () => {
    for (const w of guide("claude-code").ways) expect(JSON.stringify(w)).toContain("mcp__doco");
    for (const w of guide("gemini-cli").ways) expect(JSON.stringify(w)).toContain("trust");
    for (const w of guide("codex").ways) {
      expect(JSON.stringify(w)).toContain("Allow and don't ask me again");
    }
  });
});

describe("ConnectAgentGuide", () => {
  const render = (initial: string | null) =>
    renderToStaticMarkup(createElement(ConnectAgentGuide, { guides, initial }));

  // Alexander, 2026-10-09: the steps appeared only once an agent was picked,
  // with a click, and a page read as text had three names and nothing else.
  // So every agent's ways and steps are in the page as served, each under
  // its name; picking one narrows the page to it.
  it("asks which agent, and shows every agent's ways until one is picked", () => {
    const html = render(null);
    expect(html).toContain("Which agent do you use?");
    expect(html).not.toContain('aria-pressed="true"');
    for (const g of guides) {
      expect(html, g.name).toContain(`<h2 class="text-sm font-semibold">${g.name}</h2>`);
      for (const w of g.ways) {
        expect(html, `${g.name}: ${w.name}`).toContain(`>${w.name}</h3>`);
        for (const step of w.steps) {
          if (step.code) {
            expect(html, `${g.name}: ${w.name}`).toContain(
              renderToStaticMarkup(createElement("pre", null, step.code)).slice(5, -6),
            );
          }
        }
      }
    }
  });

  it("walks only the picked agent's ways, its own guide opening in a new tab", () => {
    const html = render("codex");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("<ol");
    // Each thing to paste comes with a Copy button.
    expect(html).toContain("codex mcp add doco --url https://doco.test/mcp</pre>");
    expect(html).toContain("[mcp_servers.doco]");
    expect(html).toContain(">Copy</button>");
    expect(html).toContain('href="https://learn.chatgpt.com/docs/extend/mcp" target="_blank"');
    expect(html).not.toContain("claude mcp add");
    expect(html).not.toContain("gemini mcp add");
    expect(html).not.toContain("claude_desktop_config.json");
  });
});

describe("/agents/connect", () => {
  it("is the page the agent instructions send the person to", () => {
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
    expect(html).not.toContain("claude mcp add");
    expect(html).toContain('href="/agents"');
  });

  // With no ?agent=, the page as served names the MCP server in its first
  // paragraph and shows every agent's ways below, terminal and desktop app.
  it("names the MCP server and every agent's ways as served, with no pick", () => {
    const loaderData = loader({ request: new Request("https://doco.test/agents/connect") });
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ConnectAgentPage, { loaderData })),
    );
    expect(html).toContain("Doco&#x27;s MCP server at https://doco.test/mcp");
    expect(html).toContain("in a terminal or in its desktop app");
    expect(html).toContain(
      "claude mcp add --transport http --scope user doco https://doco.test/mcp",
    );
    expect(html).toContain("claude_desktop_config.json");
    expect(html).toContain("codex mcp add doco --url https://doco.test/mcp");
    expect(html).toContain(
      "gemini mcp add --scope user --transport http --trust doco https://doco.test/mcp",
    );
    expect(html).not.toContain("adds it to itself");
  });
});
