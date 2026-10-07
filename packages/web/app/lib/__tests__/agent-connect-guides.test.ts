// Alexander, 2026-10-06: the person says which agent they use and gets
// step-by-step instructions for connecting Doco to it, with links that open in
// new windows. Agents carry none of it; their instructions send the person to
// /agents/connect.
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
  it("covers the agents people use, and any other", () => {
    expect(guides.map((g) => g.name)).toEqual([
      "Claude Code",
      "Claude",
      "ChatGPT",
      "Cursor",
      "Codex",
      "Gemini CLI",
      "VS Code",
      "Another agent",
    ]);
  });

  it("connects every agent to the one MCP endpoint, and signs in to Doco", () => {
    for (const g of guides) {
      const all = JSON.stringify(g);
      expect(all, g.name).toContain("https://doco.test/mcp");
      expect(all, g.name).not.toContain("https://doco.test//mcp");
      expect(all, g.name).toContain("choose what the agent may reach, and approve");
    }
  });

  it("gives each agent its own commands", () => {
    expect(text("claude-code")).toContain(
      "claude mcp add --transport http --scope user doco https://doco.test/mcp",
    );
    expect(text("codex")).toContain("codex mcp add doco --url https://doco.test/mcp");
    expect(text("codex")).toContain("codex mcp login doco");
    expect(text("gemini-cli")).toContain("/mcp auth doco");
    expect(JSON.parse(guide("cursor").steps[1].code ?? "")).toEqual({
      mcpServers: { doco: { url: "https://doco.test/mcp" } },
    });
  });

  // Alexander, 2026-09-30: every duty calls a Doco tool, so the tools must run
  // without an approval each time; each guide says how, where the agent can.
  it("lets Doco's tools run without asking, where the agent allows it", () => {
    expect(text("claude-code")).toContain("mcp__doco");
    expect(text("claude")).toContain("Always allow");
    expect(text("cursor")).toContain("allowlist");
    expect(text("gemini-cli")).toContain("--trust doco");
    expect(text("chatgpt")).toContain("Never ask");
    expect(text("codex")).toContain("Allow and don't ask me again");
    expect(text("vscode")).toContain("Chat: Manage Tool Approval");
    expect(text("other")).toContain("always allowed or trusted");
  });

  it("opens Cursor and VS Code with Doco ready to add", () => {
    const cursor = guide("cursor").steps[0].link?.href ?? "";
    expect(cursor).toMatch(
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=doco&config=/,
    );
    const config = decodeURIComponent(cursor.split("config=")[1]);
    expect(JSON.parse(atob(config))).toEqual({ url: "https://doco.test/mcp" });
    const vscode = guide("vscode").steps[0].link?.href ?? "";
    expect(JSON.parse(decodeURIComponent(vscode.replace("vscode:mcp/install?", "")))).toEqual({
      name: "doco",
      type: "http",
      url: "https://doco.test/mcp",
    });
  });
});

describe("ConnectAgentGuide", () => {
  const render = (initial: string | null) =>
    renderToStaticMarkup(createElement(ConnectAgentGuide, { guides, initial }));

  it("asks which agent the person uses, and shows no steps until they pick", () => {
    const html = render(null);
    expect(html).toContain("Which agent do you use?");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain('aria-pressed="true"');
  });

  it("walks the picked agent's steps, opening web pages in a new tab", () => {
    const html = render("claude");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("<ol");
    expect(html).toContain('href="https://claude.ai/customize/connectors" target="_blank"');
    // Each thing to paste comes with a Copy button.
    expect(html).toContain("https://doco.test/mcp</pre>");
    expect(html).toContain(">Copy</button>");
  });

  it("opens an app's own install link in place, not in an empty tab", () => {
    const html = render("cursor");
    expect(html).toMatch(/<a href="cursor:\/\/[^"]+" class="font-semibold">Add Doco to Cursor</);
  });
});

describe("/agents/connect", () => {
  it("is the page the agent instructions send people to", () => {
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
