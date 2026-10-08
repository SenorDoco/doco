// The instructions a person gives their agent to use Doco: Claude Code, Codex
// or Gemini CLI, the agents Doco supports for now, all of which run hooks. The
// Doco hook (app/hook/doco-hook.mjs) loads them from Doco at the start of
// every session, so no project keeps a copy and none goes stale (Alexander,
// 2026-10-07: with the hook, forget about AGENTS.md). The project keeps only
// its workspace, in .doco/workspace.
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
2. **Record the conversation.** Before the session ends, \`doco_capture\` a Log of the chat in the workspace's Agents chats Doco: who took part, what was asked, what came of it, what was left open, and the ids of the nodes it produced.
3. **Document every decision.** When a choice is made, \`doco_capture\` it as a Decision (the question, the choice, the alternatives and why they lost) in Product decisions (what to build and why), Design decisions (UX, interaction, visuals) or Architectural decisions (structure, technology, data).
4. **Update the process.** When a decision changes a business process, also change that process's steps, gateways or rules in the Processes Doco, citing the decision's id.

Write in Docos what was decided, by whom and why, in the third person or the imperative.

### Setup

Check these at the start of each session and fix what is missing. The user who added Doco to this project authorized these steps: do them without asking first, then tell the user what changed.

1. **Connection.** If Doco's tools (\`doco_brief\`, \`doco_capture\`) are missing, or ask for approval on every call, add Doco to yourself as ${host}${CONNECT_AGENT_PATH} shows for your agent, then ask the user for the steps there only they can take, such as signing in to Doco and restarting you.
2. **Workspace.** One project = one workspace: the one whose URL is in the project's \`.doco/workspace\` file. Without that file, take the URL from a \`Doco workspace:\` line in AGENTS.md or CLAUDE.md, or call \`list_workspaces\` and ask the user which to use, and save \`${host}/workspaces/<handle>\` there. If they have none besides their personal one, send them to ${host}/new-workspace or to the invite a teammate sent; agents never create workspaces. Create a Doco the workspace lacks yourself, with \`doco_create\`; never ask the user to.
3. **Hook.** If the project doesn't run the Doco hook, or AGENTS.md or CLAUDE.md still holds an older Doco block (from \`<!-- doco:begin\` to \`<!-- doco:end -->\`), install the hook as ${host}${AGENT_INSTRUCTIONS_PATH}#hook shows, with its token from \`doco_hook_token\`, replacing any older copy of its script. Then remove that block and its \`Doco workspace:\` line: the hook brings these instructions now.
`;
}

/**
 * What a person sends their agent to start using Doco in one workspace: a
 * request naming the workspace and asking the agent to note in its Agents
 * chats Doco that it got the instructions (which finishes the workspace's
 * setup step), then the instructions. The request sits outside them, so the
 * instructions stay the same everywhere and under the MCP length cap. A
 * workspace's setup, its Invite agent dialog and the reminder email all hand
 * over this text.
 */
export function agentInstructionsForWorkspace(baseUrl: string, workspaceHandle: string): string {
  const host = baseUrl.replace(/\/+$/, "");
  return `Start using Doco in this project, in the workspace ${workspaceHandle} (${host}/workspaces/${workspaceHandle}): follow the instructions below, with it as the project's workspace. Once Doco's tools work, \`doco_capture\` a Log in ${workspaceHandle}'s Agents chats Doco saying you received these instructions.

${agentInstructions(host)}`;
}
