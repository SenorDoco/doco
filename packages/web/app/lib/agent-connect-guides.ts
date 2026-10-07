// How a person connects Doco to the agent they use: one guide per agent, each
// a few steps with the pages to open and the things to paste. Every guide adds
// Doco's MCP server (/mcp), signs in to Doco once (the agent opens Doco's
// approval page, where the person picks what the agent may reach), and lets
// Doco's tools run without asking each time, since every duty calls one.
//
// Agents carry none of this: their instructions (lib/agent-instructions.ts)
// send the person to /agents/connect. The page, a workspace's onboarding and
// Invite agent dialog, and the Tokens page's Add MCP tab show these guides
// (components/connect-agent-guide.tsx).
// Pure.

export interface GuideStep {
  /** What to do, in a sentence or two. */
  text: string;
  /** A page to open for it; one on the web opens in a new tab. */
  link?: { label: string; href: string };
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
  docs?: string;
}

const SIGN_IN =
  "Doco opens in your browser: sign in, choose what the agent may reach, and approve.";

export function agentConnectGuides(baseUrl: string): AgentGuide[] {
  const mcp = `${baseUrl.replace(/\/+$/, "")}/mcp`;
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      note: "In a terminal, an editor, or the Claude app's Code tab. Claude Code on the web uses your claude.ai connectors: follow the Claude steps instead.",
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
      id: "claude",
      name: "Claude",
      note: "claude.ai, the Claude desktop and mobile apps, and Claude Code on the web. On a Team or Enterprise plan, an owner first adds Doco the same way under Organization settings, Connectors; then you choose Connect.",
      steps: [
        {
          text: "Open Customize, Connectors, choose + Add, then Add custom connector.",
          link: { label: "Open Connectors", href: "https://claude.ai/customize/connectors" },
        },
        { text: "Name it Doco, paste this URL, and choose Continue.", code: mcp },
        { text: `Choose Sign in now, then Add. ${SIGN_IN}` },
        {
          text: "Still in Connectors, open Doco's Tool permissions and set them to Always allow, so Claude doesn't stop to ask on every call.",
        },
        { text: "In a chat, turn Doco on from the + button, under Connectors." },
      ],
      docs: "https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp",
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      note: "ChatGPT adds MCP servers as plugins. On a Business or Enterprise workspace, an admin may have to let you add custom MCP servers.",
      steps: [
        {
          text: "Open ChatGPT's plugins, choose +, then Add custom MCP server.",
          link: { label: "Open Plugins", href: "https://chatgpt.com/plugins" },
        },
        {
          text: "Name it Doco, give this URL as its public endpoint, pick OAuth for authentication, confirm the warning, and choose Create as a plugin.",
          code: mcp,
        },
        { text: `Install the plugin and sign in when ChatGPT asks. ${SIGN_IN}` },
        {
          text: "In a chat, type @ and pick Doco. So ChatGPT doesn't stop to ask on every call, set Doco's app permission to Never ask.",
        },
      ],
      docs: "https://developers.openai.com/plugins/deploy/connect-chatgpt",
    },
    {
      id: "cursor",
      name: "Cursor",
      steps: [
        {
          text: "With Cursor open, add Doco in one click:",
          link: { label: "Add Doco to Cursor", href: cursorInstallLink(mcp) },
        },
        {
          text: "Or add Doco to ~/.cursor/mcp.json yourself:",
          code: JSON.stringify({ mcpServers: { doco: { url: mcp } } }, null, 2),
        },
        { text: `When Cursor shows doco needs a sign-in, start it. ${SIGN_IN}` },
        {
          text: "So Cursor doesn't stop to ask on every call, open Cursor Settings, Agents, Approvals & Execution, and add Doco's tools to the allowlist.",
        },
      ],
      docs: "https://cursor.com/docs/mcp",
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
    {
      id: "vscode",
      name: "VS Code",
      note: "GitHub Copilot in VS Code.",
      steps: [
        {
          text: "With VS Code open, add Doco in one click:",
          link: { label: "Add Doco to VS Code", href: vscodeInstallLink(mcp) },
        },
        {
          text: "Or run MCP: Add Server from the Command Palette, choose HTTP, and paste this URL.",
          code: mcp,
        },
        { text: `When VS Code first connects, it opens Doco. ${SIGN_IN}` },
        {
          text: "So Copilot doesn't stop to ask on every call, run Chat: Manage Tool Approval from the Command Palette and tick doco.",
        },
      ],
      docs: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
    },
    {
      id: "other",
      name: "Another agent",
      steps: [
        {
          text: "In your agent's settings, add a remote MCP server (it may be called a connector, an integration or a plugin) with this URL. It speaks streamable HTTP and signs in with OAuth, so there is no key to paste.",
          code: mcp,
        },
        { text: `Sign in when your agent asks. ${SIGN_IN}` },
        {
          text: "If your agent asks before every tool call, mark Doco's tools as always allowed or trusted.",
        },
      ],
    },
  ];
}

/** Cursor's one-click install: its deeplink carries the server's config. */
function cursorInstallLink(mcp: string): string {
  const config = btoa(JSON.stringify({ url: mcp }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=doco&config=${encodeURIComponent(config)}`;
}

/** VS Code's one-click install: its link carries the server's config. */
function vscodeInstallLink(mcp: string): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "doco", type: "http", url: mcp }))}`;
}
