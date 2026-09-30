import { describe, expect, it } from "vitest";
import { AGENT_REFERENCE, CANONICAL_INSTRUCTIONS } from "../instructions.server";
import { expectBaselineDuties } from "./baseline-duties";
import { firstPersonLines } from "./first-person";

describe("CANONICAL_INSTRUCTIONS", () => {
  // Agents never create Workspaces. People do, and agents are granted access
  // at one of three levels: all of a user's Workspaces, one, or a subset of
  // its docos. The canonical instructions must say so, and list workspace
  // creation among the human-only actions.
  it("says people create Workspaces and names the three access levels", () => {
    expect(CANONICAL_INSTRUCTIONS).toMatch(/People create Workspaces/);
    expect(CANONICAL_INSTRUCTIONS).toMatch(/you never do/);
    expect(CANONICAL_INSTRUCTIONS).toContain("**all of the user's Workspaces**");
    expect(CANONICAL_INSTRUCTIONS).toContain("**specific Workspaces**");
    expect(CANONICAL_INSTRUCTIONS).toContain("**specific docos**");
    expect(CANONICAL_INSTRUCTIONS).not.toContain("**one Workspace**");
    expect(AGENT_REFERENCE).toContain(
      "- Create / delete a workspace, and grant agents access to it.",
    );
  });

  // Agents create a Workspace's docos themselves (doco_create over MCP, or the
  // docos API). Only deleting a doco stays with people.
  it("has agents create docos inside a Workspace, and keeps only deleting one human-only", () => {
    expect(CANONICAL_INSTRUCTIONS).toContain("`doco_create`");
    expect(AGENT_REFERENCE).not.toContain("- Create / delete a doco.");
    expect(AGENT_REFERENCE).toContain("- Delete a doco.");
  });

  // Alexander, 2026-09-26: conversations are worth recording, and decisions
  // must be documented. That is baseline protocol, not something each doco
  // opts into — so the old "the universal protocol does not mandate captures"
  // stance is gone, and the three baseline duties are named up front.
  it("makes loading context, recording conversations and documenting decisions baseline", () => {
    expect(CANONICAL_INSTRUCTIONS).not.toMatch(/does not mandate captures/i);
    expect(CANONICAL_INSTRUCTIONS).toContain("## Baseline duties");
    expect(CANONICAL_INSTRUCTIONS).toContain("**Load context first.**");
    expect(CANONICAL_INSTRUCTIONS).toContain("**Record the conversation.**");
    expect(CANONICAL_INSTRUCTIONS).toContain("**Document every decision.**");
    expectBaselineDuties(CANONICAL_INSTRUCTIONS);
    // Every chat gets its Log: the old "a session that changed nothing needs
    // no Log" exemption is gone.
    expect(CANONICAL_INSTRUCTIONS).not.toMatch(/needs no Log/);
    // Policies refine HOW, they never switch the duties off.
    expect(CANONICAL_INSTRUCTIONS).toMatch(/policies refine how/i);
    expect(CANONICAL_INSTRUCTIONS).toMatch(/never switch (them|these duties) off/i);
  });

  it("teaches agents to link a policy by its stable URL when citing it", () => {
    // The stable per-policy URL pattern the Policy page is served at.
    expect(CANONICAL_INSTRUCTIONS).toContain("https://doco.to/<handle>/policies/<policy_id>");
    // And the directive to actually link it whenever a policy is referenced.
    // (Match contiguous phrases — the surrounding prose hard-wraps mid-sentence.)
    expect(CANONICAL_INSTRUCTIONS).toMatch(/cite, or quote a policy/i);
    expect(CANONICAL_INSTRUCTIONS).toMatch(/link to it at that URL/i);
  });

  it("writes the document-unit noun lowercase; brand 'Doco' and the [🔮 Doco] label keep their capital", () => {
    // House style: the countable noun — a doco / the doco / docos — is
    // lowercase except sentence/heading-initial. The product name and the
    // indicator label stay capitalized. Plural "Docos" is ALWAYS the
    // document-unit, so it must never appear capitalized.
    expect(CANONICAL_INSTRUCTIONS).not.toMatch(/\bDocos\b/);
    expect(CANONICAL_INSTRUCTIONS).toContain("search the doco");
    expect(CANONICAL_INSTRUCTIONS).toContain("this doco's policies");
    expect(CANONICAL_INSTRUCTIONS).toContain("Every doco has a set of");
    expect(CANONICAL_INSTRUCTIONS).toContain("If the doco is **public**");
    expect(CANONICAL_INSTRUCTIONS).toContain("Each doco sets its own");
    expect(CANONICAL_INSTRUCTIONS).toContain("query the project's doco");
    // Brand + label survive.
    expect(CANONICAL_INSTRUCTIONS).toContain("uses **Doco**");
    expect(CANONICAL_INSTRUCTIONS).toContain("[🔮 Doco]");
  });

  it("AGENT_REFERENCE uses the document-unit noun lowercase too", () => {
    expect(AGENT_REFERENCE).not.toMatch(/\bDocos\b/);
    expect(AGENT_REFERENCE).toContain("Delete a doco");
  });

  it("frames Doco as the whole-lifecycle graph, not just the 'why'", () => {
    // Doco captures what HAPPENED (logs) and external artifacts (references:
    // PRs, issues), not only rationale. (Prose hard-wraps, so match loosely.)
    expect(CANONICAL_INSTRUCTIONS).toContain("**logs**");
    expect(CANONICAL_INSTRUCTIONS).toContain("**references**");
    expect(CANONICAL_INSTRUCTIONS).toMatch(/pull\s+requests/i);
    // The old 'why-only' Git analogy is gone.
    expect(CANONICAL_INSTRUCTIONS).not.toContain("captures the *why* as it forms");
  });

  it("scopes the agent to its whole grant — never caps it at one doco/workspace", () => {
    expect(CANONICAL_INSTRUCTIONS).toContain("MCP connector lives at");
    expect(CANONICAL_INSTRUCTIONS).not.toContain("/me/mcp");
    expect(CANONICAL_INSTRUCTIONS).toContain("list_workspaces");
    // The user's grant is the scope; respect it — no artificial one-at-a-time
    // cap, and no "spanning is the exception" hedge either.
    expect(CANONICAL_INSTRUCTIONS).not.toMatch(/one doco at a time/i);
    expect(CANONICAL_INSTRUCTIONS).not.toMatch(/one workspace per session/i);
    expect(CANONICAL_INSTRUCTIONS).not.toContain(
      "spanning multiple workspaces in a single session is expected",
    );
    expect(CANONICAL_INSTRUCTIONS).toContain("use all of it");
  });

  it("tells agents to paste the server-built display lines, not manufacture them", () => {
    // The two most-missed invariants (§1 N-found, §3 tally) are handed over as
    // finished strings on every search result — the doc must point at them so
    // the agent echoes rather than rebuilds the format.
    expect(CANONICAL_INSTRUCTIONS).toContain("display.found");
    expect(CANONICAL_INSTRUCTIONS).toContain("display.tally");
    // The "echo, don't manufacture" directive for each invariant.
    expect(CANONICAL_INSTRUCTIONS).toContain("verbatim as your last line");
    expect(CANONICAL_INSTRUCTIONS).toContain("don't rebuild it");
  });

  it("leads with the three invariants; demotes the credential/OAuth mechanics below them", () => {
    // The behavioral contract (what you do every turn) comes first; the access
    // plumbing some runtimes need is reference material that follows. A 470-line
    // doc with the rules buried at the bottom is followed worse than one that
    // opens with them.
    const firstInvariant = CANONICAL_INSTRUCTIONS.indexOf("## 1. TOP OF EVERY REPLY");
    const lastInvariant = CANONICAL_INSTRUCTIONS.indexOf("## 3. CLOSING LINE OF THE TURN");
    const mechanics = CANONICAL_INSTRUCTIONS.indexOf("the mechanics");
    const credentialSharing = CANONICAL_INSTRUCTIONS.indexOf("Repo-local credential sharing");
    expect(firstInvariant).toBeGreaterThan(0);
    // All three invariants land before any of the connection/credential prose.
    expect(firstInvariant).toBeLessThan(mechanics);
    expect(lastInvariant).toBeLessThan(mechanics);
    expect(firstInvariant).toBeLessThan(credentialSharing);
  });

  it("lists exactly the catalog node types (no non-node routes like invites/audit)", () => {
    expect(CANONICAL_INSTRUCTIONS).toContain(
      "Node types: intents, ideas, rules, decisions, actions, logs, evals,",
    );
    // invites/audit are route behaviors, not node types — never in the list.
    expect(CANONICAL_INSTRUCTIONS).not.toContain("states, principals, invites, audit");
  });
});

describe("voice: never the first person", () => {
  // Design decision (Alexander, 2026-09-27): Doco never uses the first
  // person, so the example lines the protocol hands agents obey it. Since
  // 2026-09-30 the protocol no longer tells agents to avoid it themselves.
  it("obeys the rule in every example line without imposing it on agents", () => {
    expect(CANONICAL_INSTRUCTIONS).toContain("## Voice");
    expect(CANONICAL_INSTRUCTIONS).not.toMatch(/first person/i);
    expect(firstPersonLines(CANONICAL_INSTRUCTIONS)).toEqual([]);
    expect(firstPersonLines(AGENT_REFERENCE)).toEqual([]);
  });
});
