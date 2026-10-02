// The instructions a person gives their agent to use Doco. The /agents page
// shows them with a Copy button; the agent keeps them in the project's
// AGENTS.md (or CLAUDE.md, or its client's project instructions), between the
// two markers, next to the Doco hook that briefs it before every reply.
//
// The begin marker carries a version computed from the block's text, so it
// changes whenever the wording does. Every session the agent compares its
// project copy's version with the copy the connector sent and replaces an
// older one itself.
//
// This is the one agent-instructions template in Doco. The /agents page, each
// workspace's onboarding and Invite agent page, the onboarding reminder email,
// the Tokens page, the hosted MCP server's instructions and the agent
// bootstrap all hand over this block; everything else that talks to agents
// points at /agents.
//
// The duties lead and hold without a repo copy, because an agent may meet
// this block only through the connector. Claude Code keeps just the first
// 4096 characters of an MCP server's instructions, so the block stays under.
//
// Each paragraph and list item is one line: the page's box wraps the text to
// its own width.

import { TAGLINE } from "~/lib/tagline";

export const INSTRUCTIONS_END = "<!-- doco:end -->";

/** The line the Doco hook (app/hook/doco-hook.mjs holds the same text) adds before every user message. */
export const DOCO_REMINDER =
  "Doco: doco_brief before you act, capture each decision as it forms, and log this chat in Agents chats.";

/** The page that shows the block, where every pointer for agents leads. */
export const AGENT_INSTRUCTIONS_PATH = "/agents";

/** The site-wide meta tag an agent reading any page's head sees first. */
export const AI_INSTRUCTIONS_META = `This site is Doco: ${TAGLINE}. If you were told 'let's start using Doco' or similar, follow the agent instructions at ${AGENT_INSTRUCTIONS_PATH}.`;

export function agentInstructions(baseUrl: string): string {
  return `<!-- doco:begin v${agentInstructionsVersion(baseUrl)} -->\n${block(baseUrl)}`;
}

/** The version on the block's begin marker. */
export function agentInstructionsVersion(baseUrl: string): string {
  return version(block(baseUrl));
}

/**
 * The line doco_brief's description carries: every MCP client shows tool
 * descriptions to the agent, even one that drops the server's instructions,
 * so an install that never saw the block's current version still meets it.
 */
export function agentInstructionsPointer(baseUrl: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `The current Doco agent instructions are version v${agentInstructionsVersion(host)}. If the project's copy of them is missing, has no version or has another, fetch ${host}${AGENT_INSTRUCTIONS_PATH} and follow its step 3.`;
}

function block(baseUrl: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `## Doco

This project keeps its shared memory in Doco (${host}): the intents, decisions, rules and history behind the work. Follow steps 1 to 3 below when the user asks to use Doco, or when a duty needs a connection or a workspace that is missing.

### Every session

Four duties hold in every session, even when the project's AGENTS.md or CLAUDE.md lacks this block. Each Doco's policies refine how to do them, never whether.

1. **Load context first.** Before the first substantive reply and each new task, call \`doco_brief\` with what you are about to do and what you touch (paths, URLs, ids, PRs); obey its first tier and cite its ids.
2. **Record the conversation.** Before the session ends, \`doco_capture\` a Log of the chat in the workspace's Agents chats Doco: who took part, what was asked, what was worked on, what came of it and what was left open, with the ids of the nodes it produced.
3. **Document every decision.** When a choice is made, \`doco_capture\` it as a Decision as it forms (the question, the choice, the alternatives and why they lost) in the Doco for its kind of decision: Product decisions for what to build and why, Design decisions for UX, interaction and visual choices, Architectural decisions for system structure, technology and data.
4. **Update the process.** When a decision is about a business process, add it to the workspace's Processes Doco as well: change the steps, gateways or rules of the process it affects to match, citing the decision's id.

A doco is the project's record; write what was decided, by whom and why, in the third person or the imperative.

Before every reply, recall: \`${DOCO_REMINDER}\`

Do step 3 when the project's copy of this block is missing, has no version, or its \`doco:begin\` version differs from the one Doco's connector sent (else ${host}${AGENT_INSTRUCTIONS_PATH}), or when a client with hooks lacks the Doco hook.

### 1. Check the Doco connection

Look for Doco's MCP tools (\`doco_whoami\`, \`list_workspaces\`). If they are missing, ask the user to connect Doco's MCP server:

- Claude Code: run \`claude mcp add --transport http doco ${host}/mcp\`, then \`/mcp\` to sign in
- Any other client (claude.ai, ChatGPT, Cursor): add ${host}/mcp as a custom connector or remote MCP server

Doco's tools must be set to always allow. Check that (in Claude Code, a \`mcp__doco\` allow rule); if they aren't, or you can't tell, ask the user to set that up.

Signing in is the MCP client's job: never drive OAuth by hand. \`doco_whoami\` shows who the agent acts as, what it can reach, and the workspace constitutions its captures must honor.

### 2. Pick the project's workspace

One project = one workspace. Call \`list_workspaces\`.

- No workspaces besides the user's personal one: tell the user to create one at ${host}/new-workspace, or to accept the invite a teammate sent, and to try again once it exists. Agents never create workspaces.
- A workspace is already connected (the \`Doco workspace:\` line right after this block): ask whether to keep it or change it.
- None connected yet, or changing it: ask the user which of the listed workspaces to use, or share ${host}/new-workspace to create one.

Record the choice as one line right after this block:

    Doco workspace: ${host}/workspaces/<workspace-handle>

When the work needs a Doco the workspace lacks, create it with \`doco_create\` in the workspace on the \`Doco workspace:\` line. Never ask the user to create a Doco on the website.

### 3. Keep this block in the project

Save this block in the file the project's agents load (CLAUDE.md for Claude Code, AGENTS.md for most others; a CLAUDE.md line \`@AGENTS.md\` loads AGENTS.md too), replacing any older copy between the markers, then tell the user. Then install the Doco hook as ${host}${AGENT_INSTRUCTIONS_PATH}#hook shows: it briefs the agent before each prompt and file edit, with the reminder above first.
${INSTRUCTIONS_END}
`;
}

/** FNV-1a: eight hex digits that change whenever the text does. */
function version(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * What a person sends their agent to start using Doco in one workspace: a
 * request naming the workspace and asking the agent to note in its Agents
 * chats Doco that it got the instructions (which finishes the workspace's
 * onboarding step), then the same block, then the line that connects the
 * project to the workspace. The request and the line sit outside the block,
 * so the block an MCP client keeps stays the same everywhere and under its
 * length cap. A workspace's onboarding, its Invite agent page and the reminder
 * email all hand over this text.
 */
export function agentInstructionsForWorkspace(baseUrl: string, workspaceHandle: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `Start using Doco in this project, in the workspace ${workspaceHandle}: follow the instructions below, with ${workspaceHandle} as the project's workspace. Once Doco's tools work, \`doco_capture\` a Log in ${workspaceHandle}'s Agents chats Doco saying you received these instructions.

${agentInstructions(host)}Doco workspace: ${host}/workspaces/${workspaceHandle}
`;
}
