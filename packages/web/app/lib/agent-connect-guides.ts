// How a person connects Doco to the agents it supports for now: Claude Code,
// Codex and Gemini CLI (Alexander, 2026-10-07), each with two ways in
// (Alexander, 2026-10-09: "explain how to do it from the desktop apps and
// not just the CLI"): a command in a terminal, or the agent's desktop app
// or settings file. Every way adds Doco's MCP server (/mcp), signs in to
// Doco once (Doco's approval page, where the person picks what the agent
// may reach), and lets Doco's tools run without asking each time, since
// every duty calls one.
//
// The person connects Doco before inviting the agent: a workspace's setup
// shows these guides as its third step, and /agents/connect shows them to
// anyone (components/connect-agent-guide.tsx). An agent whose Doco tools are
// missing asks the person to come here, and never adds the server itself
// (lib/agent-instructions.ts). Other agents can still connect to /mcp, but
// Doco offers no guide for them. Pure.

import { MCP_PATH } from "~/lib/agent-instructions";

export interface GuideStep {
  /** What to do, in a sentence or two. */
  text: string;
  /** Something to paste, shown with a Copy button. */
  code?: string;
}

/** One way to connect an agent: in a terminal, or in its desktop app. */
export interface GuideWay {
  name: string;
  steps: GuideStep[];
}

export interface AgentGuide {
  /** The `?agent=` value of /agents/connect. */
  id: string;
  name: string;
  /** What the guide covers, or whom it sends elsewhere. */
  note?: string;
  ways: GuideWay[];
  /** The agent maker's own guide to adding an MCP server. */
  docs: string;
}

const SIGN_IN = "Doco opens in your browser: sign in and choose Allow.";

export function agentConnectGuides(baseUrl: string): AgentGuide[] {
  const mcp = `${baseUrl.replace(/\/+$/, "")}${MCP_PATH}`;
  const claudeSignIn = {
    text: `Run /mcp, pick doco and sign in. ${SIGN_IN}`,
    code: "/mcp",
  };
  const claudeAllow = {
    text: "So Claude Code runs Doco's tools without asking you or, in auto mode, checking each call first, run /permissions and add this Allow rule to your user settings:",
    code: "mcp__doco",
  };
  const codexAllow = {
    text: "The first time Codex asks before a Doco tool, choose Allow and don't ask me again.",
  };
  const geminiSignIn = { text: `Start Gemini CLI and sign in. ${SIGN_IN}`, code: "/mcp auth doco" };
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      note: `In a terminal, an editor, or the Claude app's Code tab. Claude Code on the web uses your claude.ai connectors instead: add Doco there as a custom connector, with the URL ${mcp}.`,
      ways: [
        {
          name: "In a terminal",
          steps: [
            {
              text: "Add Doco for all your projects:",
              code: `claude mcp add --transport http --scope user doco ${mcp}`,
            },
            { ...claudeSignIn, text: `Start Claude Code in your project. ${claudeSignIn.text}` },
            claudeAllow,
          ],
        },
        {
          name: "In the Claude desktop app",
          steps: [
            {
              text: "Open Settings, then Developer, then Edit Config, and add Doco under mcpServers in claude_desktop_config.json (the whole file, if it's empty):",
              code: `{\n  "mcpServers": {\n    "doco": { "type": "http", "url": "${mcp}" }\n  }\n}`,
            },
            {
              ...claudeSignIn,
              text: `Open the Code tab and start a session in your project. ${claudeSignIn.text}`,
            },
            claudeAllow,
          ],
        },
      ],
      docs: "https://code.claude.com/docs/en/mcp",
    },
    {
      id: "codex",
      name: "Codex",
      note: "The Codex CLI, its editor extension and the ChatGPT desktop app share one setup, in ~/.codex/config.toml.",
      ways: [
        {
          name: "In a terminal",
          steps: [
            {
              text: `Add Doco and sign in. ${SIGN_IN}`,
              code: `codex mcp add doco --url ${mcp}`,
            },
            { text: "If Codex didn't open Doco, sign in with:", code: "codex mcp login doco" },
            codexAllow,
          ],
        },
        {
          name: "In the ChatGPT desktop app or an editor",
          steps: [
            {
              text: "Add Doco to ~/.codex/config.toml:",
              code: `[mcp_servers.doco]\nurl = "${mcp}"`,
            },
            {
              text: `Start Codex in your project and sign in to Doco when it asks; in a terminal, this does the same. ${SIGN_IN}`,
              code: "codex mcp login doco",
            },
            codexAllow,
          ],
        },
      ],
      docs: "https://learn.chatgpt.com/docs/extend/mcp",
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      ways: [
        {
          name: "In a terminal",
          steps: [
            {
              text: "Add Doco for all your projects, trusted so Gemini CLI doesn't stop to ask on every call:",
              code: `gemini mcp add --scope user --transport http --trust doco ${mcp}`,
            },
            geminiSignIn,
          ],
        },
        {
          name: "In its settings file",
          steps: [
            {
              text: "Add Doco to ~/.gemini/settings.json, trusted so Gemini CLI doesn't stop to ask on every call (the whole file, if it's empty):",
              code: `{\n  "mcpServers": {\n    "doco": { "httpUrl": "${mcp}", "trust": true }\n  }\n}`,
            },
            geminiSignIn,
          ],
        },
      ],
      docs: "https://geminicli.com/docs/tools/mcp-server/",
    },
  ];
}
