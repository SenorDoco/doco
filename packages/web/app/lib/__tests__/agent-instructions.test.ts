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
  it("has the agent connect itself to Doco as /agents/connect shows, leaving the sign-in to the user", () => {
    const step = text.slice(position("1. **Connection.**"), position("2. **Workspace.**"));
    expect(step).toContain(
      "are missing, or ask for approval on every call, add Doco to yourself as https://doco.test/agents/connect shows for your agent",
    );
    expect(step).toContain(
      "then ask the user for the steps there only they can take, such as signing in to Doco and restarting you",
    );
    expect(text).not.toContain("Never set it up or sign in for them.");
    // The commands live on the page, one per agent, not in the block.
    expect(text).not.toContain("claude mcp add");
    expect(text).not.toContain("https://doco.test/mcp");
  });

  it("then uses the project's workspace, asking the user only when there is none", () => {
    const step2 = text.slice(position("2. **Workspace.**"), position("3. **Hook.**"));
    expect(step2).toContain("One project = one workspace");
    expect(step2).toContain("the one whose URL is in the project's `.doco/workspace` file");
    expect(step2).toContain("call `list_workspaces` and ask the user which to use");
    expect(step2).toContain("save `https://doco.test/workspaces/<handle>` there");
    // A personal workspace exists for everyone and never stands in for a project.
    expect(step2).toContain("none besides their personal one");
    // No workspace: a link to create one, or the invite a teammate sent.
    expect(step2).toContain("send them to https://doco.test/new-workspace");
    expect(step2).toContain("the invite a teammate sent");
    expect(step2).toContain("agents never create workspaces");
  });

  it("has the agent create the workspace's missing Docos itself, not send the user to the site", () => {
    expect(text).toContain("Create a Doco the workspace lacks yourself, with `doco_create`");
    expect(text).toContain("never ask the user to.");
  });

  // Projects set up before the hook carried the instructions keep a Doco
  // block and its `Doco workspace:` line in AGENTS.md or CLAUDE.md. The agent
  // moves the workspace into .doco/workspace and removes the block, which
  // would otherwise sit beside what the hook brings.
  it("moves a project's older Doco block out of AGENTS.md and CLAUDE.md", () => {
    expect(text).toContain("Check these at the start of each session and fix what is missing.");
    const step2 = text.slice(position("2. **Workspace.**"), position("3. **Hook.**"));
    expect(step2).toContain(
      "Without that file, take the URL from a `Doco workspace:` line in AGENTS.md or CLAUDE.md",
    );
    const step3 = text.slice(position("3. **Hook.**"));
    expect(step3).toContain(
      "remove any older Doco block (from `<!-- doco:begin` to `<!-- doco:end -->`) and its `Doco workspace:` line from AGENTS.md and CLAUDE.md",
    );
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
      "If the project doesn't run the Doco hook, install it as https://doco.test/agents#hook shows, with its token from `doco_hook_token`.",
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
  // 2026-10-06: shorter and simpler, once setup moved to the website.
  it("fits whole in the instructions an MCP client keeps, with room to spare", () => {
    expect(agentInstructions("https://doco.to").length).toBeLessThanOrEqual(3000);
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

  it("asks the agent to note in the workspace's Agents chats Doco that it got them", () => {
    expect(request).toContain(
      "`doco_capture` a Log in acme's Agents chats Doco saying you received these instructions",
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
