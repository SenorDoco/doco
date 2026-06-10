import { describe, expect, it } from "vitest";
import { AGENT_REFERENCE, CANONICAL_INSTRUCTIONS } from "../instructions.server";

describe("CANONICAL_INSTRUCTIONS", () => {
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
    expect(AGENT_REFERENCE).toContain("delete a doco");
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

  it("teaches the /mcp endpoint and the multi-workspace 'act as me' reach", () => {
    expect(CANONICAL_INSTRUCTIONS).toContain("MCP connector lives at");
    // The endpoint is /mcp now, not the interim /me/mcp.
    expect(CANONICAL_INSTRUCTIONS).not.toContain("/me/mcp");
    // An actor connection reaches every workspace, one doco at a time — the old
    // "one workspace per session, never cross workspaces" rule is gone.
    expect(CANONICAL_INSTRUCTIONS).not.toMatch(/one workspace per session/i);
    expect(CANONICAL_INSTRUCTIONS).toContain("list_workspaces");
    expect(CANONICAL_INSTRUCTIONS).toMatch(/one doco at a time/i);
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
