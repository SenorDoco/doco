import { describe, expect, it } from "vitest";
import { CANONICAL_INSTRUCTIONS } from "../instructions.server";

describe("CANONICAL_INSTRUCTIONS", () => {
  it("teaches agents to link a policy by its stable URL when citing it", () => {
    // The stable per-policy URL pattern the Policy page is served at.
    expect(CANONICAL_INSTRUCTIONS).toContain("https://doco.to/<handle>/policies/<policy_id>");
    // And the directive to actually link it whenever a policy is referenced.
    // (Match contiguous phrases — the surrounding prose hard-wraps mid-sentence.)
    expect(CANONICAL_INSTRUCTIONS).toMatch(/cite, or quote a policy/i);
    expect(CANONICAL_INSTRUCTIONS).toMatch(/link to it at that URL/i);
  });
});
