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
});
