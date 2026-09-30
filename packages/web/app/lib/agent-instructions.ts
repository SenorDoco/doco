// The instructions a person gives their agent to use Doco. The home page
// shows them with a Copy button; the agent keeps them in the project's
// AGENTS.md (or CLAUDE.md, or its client's project instructions), between the
// two markers, and compares that copy with the home page to stay current.
//
// This is the one agent-instructions template in Doco. The home page, each
// workspace's Connect your agent page, the Tokens page, the hosted MCP
// server's instructions and the agent bootstrap all hand over this block;
// everything else that talks to agents points here.
//
// The duties lead and hold without a repo copy, because an agent may meet
// this block only through the connector. Claude Code keeps just the first
// 4096 characters of an MCP server's instructions, so the block stays under.

export const INSTRUCTIONS_BEGIN = "<!-- doco:begin -->";
export const INSTRUCTIONS_END = "<!-- doco:end -->";

export function agentInstructions(baseUrl: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `${INSTRUCTIONS_BEGIN}
## Doco

This project keeps its shared memory in Doco (${host}): the intents,
decisions, rules and history behind the work, shared by the team and its
agents. Follow steps 1 to 3 below when the user asks to use Doco, or when a
duty needs a connection or a workspace that is missing.

### Every session

Four duties hold in every session, even when the project's AGENTS.md or
CLAUDE.md lacks this block. Each Doco's policies refine how to do them,
never whether.

1. **Load context first.** Before the first substantive reply,
   \`doco_search\` the workspace's Docos for the intents, decisions, rules
   and logs that bear on the work. Search again before each substantive
   question.
2. **Record the conversation.** Before the session ends, \`doco_capture\`
   a Log of the chat in the workspace's Agents chats Doco: who took part,
   what was asked, what was worked on, what came of it and what was left
   open, with the ids of the nodes it produced.
3. **Document every decision.** When a choice is made, \`doco_capture\` it
   as a Decision as it forms (the question, the choice, the alternatives
   and why they lost) in the Doco for its kind of decision: Product
   decisions for what to build and why, Design decisions for UX,
   interaction and visual choices, Architectural decisions for system
   structure, technology and data.
4. **Update the process.** When a decision is about a business process,
   add it to the workspace's Processes Doco as well: change the steps,
   gateways or rules of the process it affects to match, citing the
   decision's id.

A doco is the project's record; write what was decided, by whom and why,
in the third person or the imperative.

### 1. Check the Doco connection

Look for Doco's MCP tools (\`doco_whoami\`, \`list_workspaces\`). If they
are missing, ask the user to connect Doco's MCP server and try again once
it is connected:

- claude.ai, Claude Desktop, ChatGPT, Cursor: add a custom connector with
  the URL ${host}/mcp
- Claude Code: run \`claude mcp add --transport http doco ${host}/mcp\`,
  then \`/mcp\` to sign in
- Any other MCP client: add ${host}/mcp as a remote (Streamable HTTP) server

Signing in is the MCP client's job: never drive OAuth by hand or have the
user paste a callback URL. Once connected,
\`doco_whoami\` shows who the agent acts as, what it can reach, and the
workspace constitutions its captures must honor.

### 2. Pick the project's workspace

One project = one workspace. Call \`list_workspaces\`.

- No workspaces besides the user's personal one (named after the user,
  never a project's): tell the user to create one at
  ${host}/new-workspace, or to accept the invite a teammate sent, and to
  try again once it exists. Agents never create workspaces.
- A workspace is already connected (the \`Doco workspace:\` line right
  after this block): ask whether to keep it or change it.
- None connected yet, or changing it: ask the user which of the listed workspaces
  to use, or share ${host}/new-workspace to create one.

A new workspace is reachable at once through an "all workspaces"
connection; otherwise the user reconnects and picks it. Record the choice
as one line right after this block:

    Doco workspace: ${host}/workspaces/<workspace-handle>

When the work needs a Doco the workspace lacks, create it with
\`doco_create\` in the workspace on the \`Doco workspace:\` line, picking
the template that fits. Never ask the user to create a Doco on the website.

### 3. Keep these instructions current

Fetch ${host} and compare the instructions it shows with this block, from
the \`doco:begin\` marker to the \`doco:end\` marker. If they differ, or
the file the project's agents load lacks this block (CLAUDE.md for Claude
Code, AGENTS.md for most others; a CLAUDE.md line \`@AGENTS.md\` loads
AGENTS.md too), ask the user whether to update it with the latest instructions
from ${host}. If it can't be fetched, ask the user to copy the latest
instructions from the home page and paste them.
${INSTRUCTIONS_END}
`;
}

/**
 * The same block, followed by the line that connects the project to one
 * workspace. Offered right after a workspace is created, and from each
 * workspace's Invite agent button.
 */
export function agentInstructionsForWorkspace(baseUrl: string, workspaceHandle: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `${agentInstructions(host)}Doco workspace: ${host}/workspaces/${workspaceHandle}\n`;
}
