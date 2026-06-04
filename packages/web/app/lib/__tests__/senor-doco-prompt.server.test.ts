import { describe, expect, it } from "vitest";
import {
  SENOR_DOCO_DOCUMENTATION_CONTRACT_PROMPT,
  SENOR_DOCO_USER_FACING_VOCABULARY_PROMPT,
  SENOR_DOCO_VOICE_PROMPT,
  buildSenorDocoCorePrompt,
} from "../senor-doco-prompt.server";

describe("senor-doco-prompt.server", () => {
  it("builds the shared Señor Doco contract for any surface", () => {
    const prompt = buildSenorDocoCorePrompt({
      surfaceDescription: "a test surface",
      accessDescription: "Use test access only.",
      capabilityDescription: "answer Doco questions.",
      inScopePrefix: "the accessible",
      surfaceLimits: ["Only test-surface actions are available."],
    });

    expect(prompt).toContain("You are Señor Doco, a test surface.");
    expect(prompt).toContain(SENOR_DOCO_USER_FACING_VOCABULARY_PROMPT);
    expect(prompt).toContain(SENOR_DOCO_DOCUMENTATION_CONTRACT_PROMPT);
    expect(prompt).toContain(SENOR_DOCO_VOICE_PROMPT);
    expect(prompt).toContain("Principal vs principle vs user");
    expect(prompt).toContain("Documentation contract");
    expect(prompt).toContain("do not create a near-duplicate");
    expect(prompt).toContain("Only test-surface actions are available.");
  });

  it("teaches Señor Doco to link a policy by its stable URL when citing it", () => {
    expect(SENOR_DOCO_DOCUMENTATION_CONTRACT_PROMPT).toContain("Referring to policies");
    expect(SENOR_DOCO_DOCUMENTATION_CONTRACT_PROMPT).toContain(
      "/<doco-handle>/policies/<policy-id>",
    );
    // The guidance must reach any surface that builds the shared core prompt.
    const prompt = buildSenorDocoCorePrompt({
      surfaceDescription: "a test surface",
      accessDescription: "Use test access only.",
      capabilityDescription: "answer Doco questions.",
      inScopePrefix: "the accessible",
    });
    expect(prompt).toContain("/<doco-handle>/policies/<policy-id>");
  });
});
