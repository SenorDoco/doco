// The instructions a person gives their agent to use Doco. The home page
// shows them with a Copy button; the agent keeps them in the project's
// AGENTS.md (or CLAUDE.md, or its client's project instructions), between the
// two markers, and compares that copy with the home page to stay current.
//
// This is Doco's single agent entry point: the connection check, picking the
// project's workspace, the baseline duties and the voice rule all live here.

export const INSTRUCTIONS_BEGIN = "<!-- doco:begin -->";
export const INSTRUCTIONS_END = "<!-- doco:end -->";

export function agentInstructions(baseUrl: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `${INSTRUCTIONS_BEGIN}
## Doco

This project keeps its shared memory in Doco (${host}): the intents,
decisions, rules and history behind the work, shared by the team and its
agents. When the user asks to use Doco, follow steps 1 to 3. The duties
under "Every session" hold in every session.

### 1. Check the Doco connection

Look for Doco's MCP tools (\`doco_whoami\`, \`list_workspaces\`). If they
are missing, ask the user to connect Doco's MCP server and try again once
it is connected:

- claude.ai, Claude Desktop, ChatGPT, Cursor: add a custom connector with
  the URL ${host}/mcp
- Claude Code: run \`claude mcp add --transport http doco ${host}/mcp\`,
  then \`/mcp\` to sign in
- Any other MCP client: add ${host}/mcp as a remote (Streamable HTTP) server

While connecting, the user picks what the agent can reach: all of their
workspaces, specific workspaces, or specific Docos.

### 2. Pick the project's workspace

One project = one workspace. Call \`list_workspaces\`.

- No workspaces besides the user's personal one (named after the user,
  never a project's): tell the user to create one at
  ${host}/new-workspace, or to accept the invite a teammate sent, and to
  try again once it exists. Agents never create workspaces.
- A workspace is already connected to this project (the
  \`Doco workspace:\` line right after this block): tell the user this
  project is connected to that workspace and ask whether to keep it or
  change it. To change it, ask which of the listed workspaces to use, or
  share ${host}/new-workspace to create a new one.
- No workspace connected yet: ask the user which of the listed workspaces
  to use for this project, or share ${host}/new-workspace to create a new
  one.

A new workspace is reachable at once through an "all workspaces"
connection; otherwise the user reconnects and picks it. Record the choice
as one line right after this block:

    Doco workspace: ${host}/workspaces/<workspace-handle>

When the work needs a Doco the workspace lacks (decisions, bugs, ideas,
...), create it with \`doco_create\` in the workspace on the
\`Doco workspace:\` line, picking the template that fits. Never
ask the user to create a Doco on the website.

### 3. Keep these instructions current

Fetch ${host} and compare the instructions it shows with this block, from
the \`doco:begin\` marker to the \`doco:end\` marker. If they match, go on.
If they differ, or the project's AGENTS.md (or CLAUDE.md, or similar) lacks
this block, ask the user whether to update it with the latest instructions
from ${host}. If ${host} can't be fetched, ask the user to copy the latest
instructions from the ${host} home page and paste them.

### Every session

Three duties hold in every session. Each Doco's policies refine how to do
them, never whether.

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

If the workspace has no Doco of the kind a duty needs, create it from its
template with \`doco_create\`.

A doco is the project's record; write what was decided, by whom and why,
in the third person or the imperative.

Full protocol: ${host}/protocol/canonical-instructions
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
