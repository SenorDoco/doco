import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_BEGIN,
  INSTRUCTIONS_END,
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
  // The agent keeps this block in AGENTS.md and compares it with the home
  // page, so it must be delimited and carry nothing that varies per project.
  it("is one delimited block the agent can keep in AGENTS.md", () => {
    expect(text.startsWith(INSTRUCTIONS_BEGIN)).toBe(true);
    expect(text.trimEnd().endsWith(INSTRUCTIONS_END)).toBe(true);
  });

  it("asks the user to connect the MCP server when its tools are missing", () => {
    const check = position("### 1. Check the Doco connection");
    expect(text).toContain("https://doco.test/mcp");
    expect(text).toContain("claude mcp add --transport http doco https://doco.test/mcp");
    expect(position("ask the user to connect Doco's MCP server")).toBeGreaterThan(check);
  });

  // Alexander, 2026-09-30: the duties only work well when Doco's tools run
  // without an approval each time, so the connection check covers that too.
  it("checks Doco's tools are always allowed, and asks the user to set that up if not", () => {
    const step1 = text.slice(
      position("### 1. Check the Doco connection"),
      position("### 2. Pick the project's workspace"),
    );
    expect(step1).toContain("Doco's tools must be set to always allow");
    expect(step1).toContain("a `mcp__doco` allow rule");
    expect(step1).toContain("if they aren't, or you can't tell, ask the user to set that up");
  });

  it("then picks the project's workspace with the user, never creating one", () => {
    const connect = position("### 1. Check the Doco connection");
    const pick = position("### 2. Pick the project's workspace");
    expect(pick).toBeGreaterThan(connect);
    expect(text).toContain("`list_workspaces`");
    // No workspaces: a link to create one, and try again.
    expect(text).toContain("create one at https://doco.test/new-workspace");
    // A personal workspace exists for everyone and never stands in for a project.
    expect(text).toContain("besides the user's personal one");
    // An invited teammate joins instead of creating.
    expect(text).toContain("accept the invite a teammate sent");
    expect(text).toContain("try again once it exists");
    expect(text).toContain("Agents never create workspaces.");
    // Already connected: keep it or change it.
    expect(text).toContain("ask whether to keep it or change it");
    // Not connected: which workspace, or a link to create a new one.
    expect(text).toContain("ask the user which of the listed workspaces to use");
    expect(text).toContain("Doco workspace: https://doco.test/workspaces/<workspace-handle>");
  });

  it("has the agent create the workspace's missing Docos itself, not send the user to the site", () => {
    expect(text).toContain("`doco_create`");
    expect(text).toContain("in the workspace on the `Doco workspace:` line");
    expect(text).toContain("Never ask the user to create a Doco");
  });

  it("then checks the AGENTS.md copy against /agents and asks before updating it", () => {
    const pick = position("### 2. Pick the project's workspace");
    const current = position("### 3. Keep these instructions current");
    expect(current).toBeGreaterThan(pick);
    expect(text).toContain("Fetch https://doco.test/agents and compare");
    expect(text).toContain("ask the user whether to update it with the latest instructions");
    expect(text).toContain("ask the user to copy the latest instructions");
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
  // The duties lead, hold without a repo copy, and only setup waits for the user.
  it("leads with the duties, which hold even without a copy in the repo", () => {
    expect(position("### Every session")).toBeLessThan(
      position("### 1. Check the Doco connection"),
    );
    expect(text).toContain(
      "Four duties hold in every session, even when the project's AGENTS.md or CLAUDE.md lacks this block.",
    );
    expect(text).toContain(
      "Follow steps 1 to 3 below when the user asks to use Doco, or when a duty needs a connection or a workspace that is missing.",
    );
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

  // Claude Code keeps only the first 4096 characters of an MCP server's
  // instructions, and the hosted server sends this block whole.
  it("fits whole in the instructions an MCP client keeps", () => {
    expect(agentInstructions("https://doco.to").length).toBeLessThanOrEqual(4096);
  });

  // Claude Code loads CLAUDE.md, not AGENTS.md: a block kept only in AGENTS.md
  // never reaches it unless CLAUDE.md imports that file.
  it("checks the block is in the file the project's agents actually load", () => {
    expect(text).toContain("CLAUDE.md for Claude Code, AGENTS.md for most others");
    expect(text).toContain("`@AGENTS.md`");
  });

  // Alexander, 2026-09-30: one template for every place Doco instructs an
  // agent. It stands alone, with no second protocol document behind it.
  it("stands alone: no link to another protocol document", () => {
    expect(text).not.toMatch(/protocol/i);
  });

  // What the hosted MCP server used to add on its own now lives here, since
  // the server hands agents this same block.
  it("orients with doco_whoami and leaves sign-in to the MCP client", () => {
    expect(text).toMatch(/`doco_whoami` shows who the agent acts as/);
    expect(text).toMatch(/never drive OAuth by hand/);
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
  const [request, block] = forAcme.split(`\n\n${INSTRUCTIONS_BEGIN}`);

  // Alexander, 2026-10-01: inviting an agent from a workspace names the
  // workspace, and asks the agent to note in Agents chats that it got the
  // instructions, which finishes the workspace's onboarding step.
  it("asks the agent to start using Doco in the named workspace", () => {
    expect(request).toContain("Start using Doco in this project, in the workspace acme");
    expect(request).toContain("with acme as the project's workspace");
  });

  it("asks the agent to note in the workspace's Agents chats Doco that it got them", () => {
    expect(request).toContain(
      "`doco_capture` a Log in acme's Agents chats Doco saying you received these instructions",
    );
  });

  // The request and the workspace line sit outside the block, so the block is
  // the one on /agents, byte for byte, and stays under the MCP length cap.
  it("then hands over the /agents block and the line that connects the workspace", () => {
    expect(`${INSTRUCTIONS_BEGIN}${block}`).toBe(
      `${text}Doco workspace: https://doco.test/workspaces/acme\n`,
    );
  });

  it("keeps the request on one line and out of the first person", () => {
    expect(request.split("\n")).toHaveLength(1);
    expect(firstPersonLines(request)).toEqual([]);
  });
});
