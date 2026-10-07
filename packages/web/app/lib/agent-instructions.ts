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

/** The page that walks a person through connecting Doco to their agent. */
export const CONNECT_AGENT_PATH = "/agents/connect";

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

This project keeps its shared memory in Doco (${host}): the intents, decisions, rules and history behind the work.

### Every session

Four duties hold in every session, even when the project's AGENTS.md or CLAUDE.md lacks this block. Each Doco's policies refine how, never whether.

1. **Load context first.** Before the first substantive reply and each new task, call \`doco_brief\` with what you are about to do and what you touch (paths, URLs, ids, PRs); obey its first tier and cite its ids.
2. **Record the conversation.** Before the session ends, \`doco_capture\` a Log of the chat in the workspace's Agents chats Doco: who took part, what was asked, what came of it, what was left open, and the ids of the nodes it produced.
3. **Document every decision.** When a choice is made, \`doco_capture\` it as a Decision (the question, the choice, the alternatives and why they lost) in Product decisions (what to build and why), Design decisions (UX, interaction, visuals) or Architectural decisions (structure, technology, data).
4. **Update the process.** When a decision changes a business process, also change that process's steps, gateways or rules in the Processes Doco, citing the decision's id.

Write in Docos what was decided, by whom and why, in the third person or the imperative.

Before every reply, recall: \`${DOCO_REMINDER}\`

### Setup

Check these at the start of each session and fix what is missing.

1. **Connection.** If Doco's tools (\`doco_brief\`, \`doco_capture\`) are missing, or ask for approval on every call, ask the user to connect Doco by following ${host}${CONNECT_AGENT_PATH}. Never set it up or sign in for them.
2. **Workspace.** One project = one workspace: the one on the \`Doco workspace:\` line right after this block. Without that line, call \`list_workspaces\`, ask the user which to use, and add \`Doco workspace: ${host}/workspaces/<handle>\`. If they have none besides their personal one, send them to ${host}/new-workspace or to the invite a teammate sent; agents never create workspaces. Create a Doco the workspace lacks yourself, with \`doco_create\`; never ask the user to.
3. **This block.** Keep it in the file the project's agents load (CLAUDE.md for Claude Code, AGENTS.md for most others; \`@AGENTS.md\` in CLAUDE.md loads it). When the project's copy is missing, has no version, or its \`doco:begin\` version differs from the one Doco's connector sent (else ${host}${AGENT_INSTRUCTIONS_PATH}), replace it between the markers and tell the user. Where the client has hooks, install the Doco hook as ${host}${AGENT_INSTRUCTIONS_PATH}#hook shows.
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
