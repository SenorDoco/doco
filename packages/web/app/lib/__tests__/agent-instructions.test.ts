import { describe, expect, it } from "vitest";
import { INSTRUCTIONS_BEGIN, INSTRUCTIONS_END, agentInstructions } from "../agent-instructions";
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

  it("then picks the project's workspace with the user, never creating one", () => {
    const connect = position("### 1. Check the Doco connection");
    const pick = position("### 2. Pick the project's workspace");
    expect(pick).toBeGreaterThan(connect);
    expect(text).toContain("`list_workspaces`");
    // No workspaces: a link to create one, and try again.
    expect(text).toMatch(/create one at\s+https:\/\/doco\.test\/new-workspace/);
    // A personal workspace exists for everyone and never stands in for a project.
    expect(text).toMatch(/besides the user's personal one/);
    // An invited teammate joins instead of creating.
    expect(text).toMatch(/accept the invite a teammate sent/);
    expect(text).toContain("try again once it exists");
    expect(text).toContain("Agents never create workspaces.");
    // Already connected: keep it or change it.
    expect(text).toMatch(/ask whether to keep it or\s+change it/);
    // Not connected: which workspace, or a link to create a new one.
    expect(text).toMatch(/ask the user which of the listed workspaces\s+to use/);
    expect(text).toContain("Doco workspace: https://doco.test/workspaces/<workspace-handle>");
  });

  it("then checks the AGENTS.md copy against the home page and asks before updating it", () => {
    const pick = position("### 2. Pick the project's workspace");
    const current = position("### 3. Keep these instructions current");
    expect(current).toBeGreaterThan(pick);
    expect(text).toContain("Fetch https://doco.test and compare");
    expect(text).toMatch(/ask the user whether to update it with the latest instructions/);
    expect(text).toMatch(/ask the user to copy the latest\s+instructions/);
  });

  it("carries the three baseline duties and the full protocol link", () => {
    expect(text).toContain("**Load context first.**");
    expect(text).toContain("**Document every decision.**");
    expect(text).toContain("**Record the conversation.**");
    expect(text).toContain("https://doco.test/protocol/canonical-instructions");
  });

  // Alexander, 2026-09-30: agents keep their own voice in replies; the
  // instructions no longer tell them to avoid the first person.
  it("leaves the agent's voice alone and obeys the rule itself", () => {
    expect(text).not.toMatch(/first person/i);
    expect(firstPersonLines(text)).toEqual([]);
  });
});
