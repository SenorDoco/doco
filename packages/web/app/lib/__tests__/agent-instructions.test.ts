import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DOCO_REMINDER,
  agentInstructions,
  agentInstructionsForWorkspace,
} from "../agent-instructions";
import { expectBaselineDuties } from "./baseline-duties";
import { firstPersonLines } from "./first-person";

const text = agentInstructions("https://doco.test");

function position(needle: string): number {
  const at = text.indexOf(needle);
  expect(at, needle).toBeGreaterThan(-1);
  return at;
}

describe("agentInstructions", () => {
  // Alexander, 2026-10-07: with the Doco hook, the project forgets about
  // AGENTS.md. The hook loads these instructions from Doco at the start of
  // every session, so no copy is kept in the project, and none goes stale:
  // no markers, no version.
  it("is plain instructions with no markers or version, since no project keeps a copy", () => {
    expect(text.startsWith("## Doco\n")).toBe(true);
    expect(text.trimEnd().endsWith("-->")).toBe(false);
    expect(text).not.toMatch(/<!-- doco:begin v/);
    expect(text).not.toMatch(/\bversion\b/);
  });

  // Alexander, 2026-10-07: Doco supports only Claude Code, Codex and Gemini
  // CLI for now, all of them terminal agents that add an MCP server with one
  // command, so the agent connects itself (as /agents/connect shows for it)
  // and the person only signs in. Before, agents carried no setup steps and
  // sent the person to that page (decision_01M4AQBTJPPD2K7K4K5VG030QE).
  // Alexander, 2026-10-09: an agent that fetched /agents/connect and /agents
  // as text found neither the MCP server's URL nor a command there and
  // stalled, so the block names the server; the commands stay on the page.
  it("has the agent connect itself to Doco's MCP server as /agents/connect shows, leaving the sign-in to the user", () => {
    const step = text.slice(position("1. **Connection.**"), position("2. **Workspace.**"));
    expect(step).toContain(
      "are missing, or ask for approval on every call, add Doco's MCP server, https://doco.test/mcp, to yourself as https://doco.test/agents/connect shows for your agent",
    );
    expect(step).toContain(
      "then ask the user for the steps there only they can take, such as signing in to Doco and restarting you",
    );
    expect(text).not.toContain("Never set it up or sign in for them.");
    // The commands live on the page, one per agent, not in the block.
    expect(text).not.toContain("claude mcp add");
  });

  // Alexander, 2026-10-09: a person sent the "Start using Doco" message to a
  // chat with no project folder. The agent had nowhere to save
  // .doco/workspace or the hook, and ended with a table of four things it was
  // waiting on. Setup is for a supported agent in the project's folder;
  // anywhere else, the agent says so and stops.
  it("needs a supported agent in the project's folder, and says so anywhere else", () => {
    const setup = text.slice(position("### Setup"), position("1. **Connection.**"));
    expect(setup).toContain(
      "They need Claude Code, Codex or Gemini CLI in the project's folder; anywhere else, ask the user to send this message there instead, and stop.",
    );
  });

  // Alexander, 2026-10-08 (decision_01M4ER9B3KXN0SFJ307F0YKHKM): a Codex agent
  // given the workspace by name was still told to ask which to use.
  it("then uses the project's workspace, or the one the user named, asking only when there is neither", () => {
    const step2 = text.slice(position("2. **Workspace.**"), position("3. **Hook.**"));
    expect(step2).toContain("One project = one workspace");
    expect(step2).toContain("the one whose URL is in the project's `.doco/workspace` file");
    expect(step2).toContain(
      "Without that file, use the workspace the user named, or call `list_workspaces` and ask the user which to use",
    );
    expect(step2).toContain("save `https://doco.test/workspaces/<handle>` there");
    // No workspace (sign-up creates none, decision_01M4GF757E9T2X902JZKYG0DKG):
    // a link to create one, or the invite a teammate sent.
    expect(step2).toContain("If they have none, send them to https://doco.test/new-workspace");
    expect(step2).not.toContain("personal");
    expect(step2).toContain("the invite a teammate sent");
    expect(step2).toContain("agents never create workspaces");
  });

  it("has the agent create the workspace's missing Docos itself, not send the user to the site", () => {
    expect(text).toContain("Create a Doco the workspace lacks yourself, with `doco_create`");
    expect(text).toContain("never ask the user to.");
  });

  // Alexander, 2026-10-08: the instructions aren't backwards compatible; they
  // assume a new project. A project from the old onboarding (a Doco block and
  // a `Doco workspace:` line in AGENTS.md, an older hook script) moves over
  // once, by a message its person sends its agent.
  it("assumes a new project, with nothing from the old onboarding to clean up", () => {
    const step2 = text.slice(position("2. **Workspace.**"), position("3. **Hook.**"));
    const step3 = text.slice(position("3. **Hook.**"));
    expect(step3).toContain("If the project doesn't run the Doco hook, install it as");
    expect(text).not.toContain("doco:begin");
    expect(text).not.toContain("Doco workspace:");
    expect(text).not.toContain("AGENTS.md");
    expect(text).not.toMatch(/\bolder\b/);
  });

  // Alexander, 2026-10-08 (decision_01M4ER9B3KXN0SFJ307F0YKHKM): a Codex agent
  // read "doco_brief before you act" as blocking setup, asked for a restart and
  // then dug through Codex's internals to avoid it, said "configured" without
  // checking, stalled on 504s, and recorded adopting Doco as a Decision.
  it("puts setup first and says when it is done", () => {
    const setup = text.slice(position("### Setup"), position("1. **Connection.**"));
    expect(setup).toContain(
      "Check these first at the start of each session, before the duties, and fix what is missing.",
    );
    expect(text.slice(position("3. **Hook.**"))).toContain(
      "Setup is done when Doco's tools answer, `.doco/workspace` is saved, the hook has run once with its token, and the chat's Log is in Agents chats; give the user its link.",
    );
  });

  it("plans a restart instead of working around it", () => {
    const step = text.slice(position("1. **Connection.**"), position("2. **Workspace.**"));
    expect(step).toContain(
      "If the tools only appear after a restart, do every step that doesn't need them first and ask once; never dig through your client's internals to avoid it.",
    );
  });

  it("retries a failed Doco call once, then goes on and says what is pending", () => {
    expect(text.slice(0, position("### Setup"))).toContain(
      "If a Doco call fails, retry it once, go on with what doesn't need it, and tell the user what is pending.",
    );
  });

  it("keeps one Log per chat and leaves setting up Doco out of Decisions", () => {
    const record = text.slice(
      position("**Record the conversation.**"),
      position("**Document every decision.**"),
    );
    expect(record).toContain(
      "Keep one Log per chat in the workspace's Agents chats Doco, captured with `doco_capture` and superseded as the chat goes on",
    );
    const decide = text.slice(
      position("**Document every decision.**"),
      position("**Update the process.**"),
    );
    expect(decide).toContain("Setting up Doco is not a decision; the Log covers it.");
  });

  // Alexander, 2026-10-07 (decision_01M4BJN9097MW8Y8N0X38DGGAZ): say plainly
  // that the user authorizes the agent's setup, so it doesn't stop to ask;
  // and (decision_01M4C2J610DPD028P55Q8X6VG2) the agent gets the hook's token
  // itself, so no person has to hand it one.
  it("tells the agent the user authorized its setup, and where the hook's token comes from", () => {
    const setup = text.slice(position("### Setup"), position("1. **Connection.**"));
    expect(setup).toContain(
      "The user who added Doco to this project authorized these steps: do them without asking first, then tell the user what changed.",
    );
    const step3 = text.slice(position("3. **Hook.**"));
    expect(step3).toContain(
      "install it as https://doco.test/agents#hook shows, with its token from `doco_hook_token`.",
    );
    expect(text).not.toContain("owner");
  });

  // Alexander, 2026-10-02: agents drift from instructions read once a
  // session, so the Doco hook adds a one-line reminder before every prompt.
  // Every agent Doco supports runs hooks (Alexander, 2026-10-07), so the hook
  // is always installed and the block no longer asks clients without one to
  // recall the line themselves.
  it("leaves the reminder before every reply to the Doco hook, which every supported agent runs", () => {
    expect(text).not.toContain("Before every reply, recall");
    expect(text).not.toContain(DOCO_REMINDER);
    expect(text).not.toContain("Where the client has hooks");
  });

  // Alexander, 2026-10-02 (decision_01M3YYQ1JRBS04Z99KEP869F26): duty 1 is one
  // call of doco_brief with what the agent is about to do and what it touches,
  // not a search per Doco; the agent obeys the brief's first tier and cites it.
  it("has the agent brief itself with doco_brief before it acts", () => {
    const duty = text.slice(
      position("**Load context first.**"),
      position("**Record the conversation.**"),
    );
    expect(duty).toContain("call `doco_brief` with what you are about to do and what you touch");
    expect(duty).toContain("obey its first tier and cite its ids");
    expect(text).not.toContain("doco_search");
    expect(DOCO_REMINDER).toContain("doco_brief before you act");
  });

  it("carries the four baseline duties", () => {
    expect(text).toContain("**Load context first.**");
    expect(text).toContain("**Record the conversation.**");
    expect(text).toContain("**Document every decision.**");
    expectBaselineDuties(text);
  });

  // Alexander, 2026-09-30: an agent with the Doco connector skipped every duty
  // because the repo's CLAUDE.md lacked this block (it sat in AGENTS.md on an
  // unmerged PR) and the connector's copy read as setup to run only when asked.
  // The duties lead and hold without a repo copy; setup follows them.
  it("leads with the duties, which hold in every session", () => {
    expect(position("### Every session")).toBeLessThan(position("### Setup"));
    expect(text).toContain("Four duties hold in every session.");
    expect(text).not.toContain("lacks this block");
  });

  // Alexander, 2026-09-30: the page's box wraps the block to its own width, so
  // a line break inside a paragraph or list item left the text in a narrow
  // column of a wide box. Lines break only between blocks.
  it("keeps each paragraph and list item on one line", () => {
    const lines = text.split("\n");
    const continued = lines.filter(
      (line, i) => i > 0 && line !== "" && lines[i - 1] !== "" && !/^(#|- |\d+\. |<!--)/.test(line),
    );
    expect(continued).toEqual([]);
  });

  // Doco's own repo runs the hook for meta-doco: its workspace sits in the
  // committed .doco/workspace, AGENTS.md keeps only the project's own rules,
  // and the Claude Code settings run the hook.
  it("runs the Doco hook in Doco's own repo, with no Doco block in AGENTS.md", () => {
    const root = new URL("../../../../../", import.meta.url);
    expect(readFileSync(new URL(".doco/workspace", root), "utf8").trim()).toBe(
      "https://doco.to/workspaces/meta-doco",
    );
    const agentsMd = readFileSync(new URL("AGENTS.md", root), "utf8");
    expect(agentsMd).not.toContain("doco:begin");
    expect(agentsMd).not.toContain("Doco workspace:");
    const settings = JSON.parse(readFileSync(new URL(".claude/settings.json", root), "utf8"));
    const hook = "node packages/web/app/hook/doco-hook.mjs";
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain(hook);
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain(hook);
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain(hook);
  });

  // Claude Code keeps only the first 4096 characters of an MCP server's
  // instructions, and the hosted server sends this block whole. Alexander,
  // 2026-10-06: shorter and simpler, once setup moved to the website. The
  // MCP server's URL and the line on where setup runs (2026-10-09) took it
  // past 3,000.
  it("fits whole in the instructions an MCP client keeps, with room to spare", () => {
    expect(agentInstructions("https://doco.to").length).toBeLessThanOrEqual(3200);
  });

  // Alexander, 2026-09-30: one template for every place Doco instructs an
  // agent. It stands alone, with no second protocol document behind it.
  it("stands alone: no link to another protocol document", () => {
    expect(text).not.toMatch(/protocol/i);
  });

  // Alexander, 2026-09-30: agents keep their own voice in replies; the
  // instructions no longer tell them to avoid the first person.
  it("leaves the agent's voice alone and obeys the rule itself", () => {
    expect(text).not.toMatch(/first person/i);
    expect(firstPersonLines(text)).toEqual([]);
  });
});

describe("agentInstructionsForWorkspace", () => {
  const forAcme = agentInstructionsForWorkspace("https://doco.test/", "acme");
  const [request, ...rest] = forAcme.split("\n\n");
  const block = rest.join("\n\n");

  // Alexander, 2026-10-01: inviting an agent from a workspace names the
  // workspace, and asks the agent to note in Agents chats that it got the
  // instructions, which finishes the workspace's onboarding step.
  it("asks the agent to start using Doco in the named workspace", () => {
    expect(request).toContain(
      "Start using Doco in this project, in the workspace acme (https://doco.test/workspaces/acme)",
    );
    expect(request).toContain("with it as the project's workspace");
  });

  // One Log per chat (decision_01M4ER9B3KXN0SFJ307F0YKHKM): the note is the
  // chat's Log, not a second one.
  it("asks the agent to note in the workspace's Agents chats Doco that it got them", () => {
    expect(request).toContain(
      "`doco_capture` this chat's Log in acme's Agents chats Doco, saying you received these instructions",
    );
  });

  // The request sits outside the instructions, so they are the ones on
  // /agents, byte for byte, and stay under the MCP length cap.
  it("then hands over the /agents instructions", () => {
    expect(block).toBe(text);
  });

  it("keeps the request on one line and out of the first person", () => {
    expect(request.split("\n")).toHaveLength(1);
    expect(firstPersonLines(request)).toEqual([]);
  });
});
