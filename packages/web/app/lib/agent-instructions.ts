// The instructions a person gives their agent to use Doco: Claude Code, Codex
// or Gemini CLI, the agents Doco supports for now, all of which run hooks. The
// person connects Doco to the agent first (Alexander, 2026-10-09, as
// /agents/connect shows), so the agent gets them with the MCP server; the
// Doco hook (app/hook/doco-hook.mjs) then loads them from Doco at the start
// of every session, so no project keeps a copy and none goes stale
// (Alexander, 2026-10-07: with the hook, forget about AGENTS.md). The project
// keeps only its workspace, in .doco/workspace.
//
// This is the one agent-instructions template in Doco. The /agents page and
// its plain-text copy (which the hook reads), each workspace's setup and
// Invite agent dialog, the onboarding reminder email, the Tokens page, the
// hosted MCP server's instructions and the agent bootstrap all hand over this
// text; everything else that talks to agents points at /agents.
//
// Claude Code keeps just the first 4096 characters of an MCP server's
// instructions, so the text stays under.
//
// Each paragraph and list item is one line: the page's box wraps the text to
// its own width.

import { TAGLINE } from "~/lib/tagline";

/** The line the Doco hook (app/hook/doco-hook.mjs holds the same text) adds before every user message. */
export const DOCO_REMINDER =
  "Doco: doco_brief before you act, capture each decision as it forms, and log this chat in Agents chats.";

/** The page that shows the block, where every pointer for agents leads. */
export const AGENT_INSTRUCTIONS_PATH = "/agents";

/** The page that walks a person through connecting Doco to their agent. */
export const CONNECT_AGENT_PATH = "/agents/connect";

/** Doco's MCP server, the one endpoint every agent connects to. */
export const MCP_PATH = "/mcp";

/** The site-wide meta tag an agent reading any page's head sees first. */
export const AI_INSTRUCTIONS_META = `This site is Doco: ${TAGLINE}. If you were told 'let's start using Doco' or similar, follow the agent instructions at ${AGENT_INSTRUCTIONS_PATH}.`;

/** Where the hook reads the instructions as plain text. */
export const AGENT_INSTRUCTIONS_TEXT_PATH = "/agents/instructions.md";

export function agentInstructions(baseUrl: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `## Doco

This project keeps its shared memory in Doco (${host}): the intents, decisions, rules and history behind the work.

### Every session

Four duties hold in every session. Each Doco's policies refine how, never whether.

1. **Load context first.** Before the first substantive reply and each new task, call \`doco_brief\` with what you are about to do and what you touch (paths, URLs, ids, PRs); obey its first tier and cite its ids.
2. **Record the conversation.** Keep one Log per chat in the workspace's Agents chats Doco, captured with \`doco_capture\`, superseded with \`doco_changeset\` as the chat goes on: who took part, what was asked, what came of it, what was left open, and the ids of the nodes it produced.
3. **Document every decision.** When a choice is made, \`doco_capture\` it as a Decision (the question, the choice, the alternatives and why they lost) in Product decisions (what to build and why), Design decisions (UX, interaction, visuals) or Architectural decisions (structure, technology, data). Setting up Doco is not a decision; the Log covers it.
4. **Update the process.** When a decision changes a business process, also change that process's steps, gateways or rules in the Processes Doco, citing the decision's id.

Write in Docos what was decided, by whom and why, in the third person or the imperative. Name people, not emails; never print a token. If a Doco call fails, retry it once, go on with what doesn't need it, and tell the user what is pending.

### Setup

Check these first at the start of each session, before the duties, and fix what is missing. The user who added Doco to this project authorized these steps, the hook included: do them without asking first, then tell the user what changed. They need Claude Code, Codex or Gemini CLI in the project's folder; if you don't run hooks or have no project folder (the Claude app's chat or a browser), ask the user to send this message from one of those instead, and stop.

1. **Connection.** If Doco's tools (\`doco_brief\`, \`doco_capture\`) are missing, ask the user to connect Doco to you as ${host}${CONNECT_AGENT_PATH} shows and restart you, then stop; never add it or dig through your client's internals yourself. If they ask for approval on every call, ask the user to allow them as that page shows.
2. **Workspace.** One project = one workspace: the one whose URL is in the project's \`.doco/workspace\` file. Without that file, use the workspace the user named, or call \`list_workspaces\` and ask the user which to use; save \`${host}/workspaces/<handle>\` there. If they have none, send them to ${host}/new-workspace or to the invite a teammate sent; agents never create workspaces. Create a Doco the workspace lacks yourself, with \`doco_create\`; never ask the user to.
3. **Hook.** If the project doesn't run the Doco hook, install it as \`doco_hook_token\` shows; it runs by itself, so don't run it by hand.

Setup is done when Doco's tools answer, \`.doco/workspace\` is saved, the hook is installed with its token, and the chat's Log is in Agents chats; give the user its link.
`;
}

/**
 * What a person sends their agent to start using Doco in one workspace, once
 * Doco is connected to it: one short paragraph naming the workspace, the
 * setup left (the instructions' Workspace and Hook steps) and the chat's Log
 * to start in its Agents chats Doco, saying it got the message (which
 * finishes the workspace's setup). It names the hook settings files because
 * Claude Code's auto mode lets an agent change its own settings only when the
 * user's own message asks for that change (2026-10-09: it refused two edits
 * of .claude/settings.json asked for by the instructions alone). It carries no copy of the instructions
 * (Alexander, 2026-10-09: as simple as possible, with no old baggage): the
 * agent holds them from the MCP server, and the hook loads them from /agents
 * at every session. A workspace's setup, its Invite agent dialog and the
 * reminder email all hand over this text.
 */
export function agentInstructionsForWorkspace(baseUrl: string, workspaceHandle: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `Start using Doco in this project, in the workspace ${workspaceHandle} (${host}/workspaces/${workspaceHandle}). Follow Doco's instructions for agents, at ${host}${AGENT_INSTRUCTIONS_PATH}: save the workspace's URL in \`.doco/workspace\`, install the Doco hook with its token from \`doco_hook_token\` in your hook settings (\`.claude/settings.json\`, \`.codex/hooks.json\` or \`.gemini/settings.json\`), and \`doco_capture\` this chat's Log in ${workspaceHandle}'s Agents chats Doco, saying you received this message.`;
}
