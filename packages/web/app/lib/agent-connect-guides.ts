// How Doco connects to the agents it supports for now: Claude Code, Codex and
// Gemini CLI (Alexander, 2026-10-07), each a terminal agent that adds an MCP
// server with one command and runs the Doco hook. Every guide adds Doco's MCP
// server (/mcp), signs in to Doco once (Doco's approval page, where the person
// picks what the agent may reach), and lets Doco's tools run without asking
// each time, since every duty calls one.
//
// The agent follows its guide itself: its instructions
// (lib/agent-instructions.ts) send it to /agents/connect, which shows these
// guides (components/connect-agent-guide.tsx), and it asks the person only
// for what it can't do, such as signing in. Other agents can still connect to
// /mcp, but Doco offers no guide for them.
// Pure.

export interface GuideStep {
  /** What to do, in a sentence or two. */
  text: string;
  /** Something to paste, shown with a Copy button. */
  code?: string;
}

export interface AgentGuide {
  /** The `?agent=` value of /agents/connect. */
  id: string;
  name: string;
  /** What the guide covers, or whom it sends elsewhere. */
  note?: string;
  steps: GuideStep[];
  /** The agent maker's own guide to adding an MCP server. */
  docs: string;
}

const SIGN_IN = "Doco opens in your browser: sign in and choose Allow.";

export function agentConnectGuides(baseUrl: string): AgentGuide[] {
  const mcp = `${baseUrl.replace(/\/+$/, "")}/mcp`;
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      note: `In a terminal, an editor, or the Claude app's Code tab. Claude Code on the web uses your claude.ai connectors instead: add Doco there as a custom connector, with the URL ${mcp}.`,
      steps: [
        {
          text: "In a terminal, add Doco for all your projects:",
          code: `claude mcp add --transport http --scope user doco ${mcp}`,
        },
        {
          text: `Start Claude Code, run /mcp, pick doco and sign in. ${SIGN_IN}`,
          code: "/mcp",
        },
        {
          text: "So Claude Code doesn't stop to ask on every call, run /permissions and add this Allow rule to your user settings:",
          code: "mcp__doco",
        },
      ],
      docs: "https://code.claude.com/docs/en/mcp",
    },
    {
      id: "codex",
      name: "Codex",
      note: "The Codex CLI, its editor extension and the ChatGPT desktop app share one setup.",
      steps: [
        {
          text: `In a terminal, add Doco and sign in. ${SIGN_IN}`,
          code: `codex mcp add doco --url ${mcp}`,
        },
        { text: "If Codex didn't open Doco, sign in with:", code: "codex mcp login doco" },
        {
          text: "The first time Codex asks before a Doco tool, choose Allow and don't ask me again.",
        },
      ],
      docs: "https://learn.chatgpt.com/docs/extend/mcp",
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      steps: [
        {
          text: "In a terminal, add Doco for all your projects, trusted so Gemini CLI doesn't stop to ask on every call:",
          code: `gemini mcp add --scope user --transport http --trust doco ${mcp}`,
        },
        { text: `Start Gemini CLI and sign in. ${SIGN_IN}`, code: "/mcp auth doco" },
      ],
      docs: "https://geminicli.com/docs/tools/mcp-server/",
    },
  ];
}
