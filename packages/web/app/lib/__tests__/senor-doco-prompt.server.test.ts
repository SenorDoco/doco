import { describe, expect, it } from "vitest";
import {
  SENOR_DOCO_DOCUMENTATION_CONTRACT_PROMPT,
  SENOR_DOCO_USER_FACING_VOCABULARY_PROMPT,
  SENOR_DOCO_VOICE_PROMPT,
  buildSenorDocoCorePrompt,
} from "../senor-doco-prompt.server";
import { expectBaselineDuties } from "./baseline-duties";

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

  it("makes documenting decisions and recording conversations the default, not a proposal", () => {
    const p = SENOR_DOCO_DOCUMENTATION_CONTRACT_PROMPT;
    expect(p).toContain("**Record the conversation.**");
    expect(p).toContain("**Document every decision.**");
    expectBaselineDuties(p);
    expect(p).not.toMatch(/needs no Log/);
    expect(p).toMatch(/at the start of (a|every) conversation/i);
    // The old hedge that ambient observations only get proposed is gone.
    expect(p).not.toContain("should be proposed/drafting unless the user clearly authorizes");
  });

  // Alexander, 2026-10-02 (decision_01M3YYQ1JRBS04Z99KEP869F26): the "load
  // context" duty calls the brief engine, the same one agents and the
  // workspace page use, instead of searching doco by doco.
  it("has Señor Doco brief himself through the engine before he acts", () => {
    const p = SENOR_DOCO_DOCUMENTATION_CONTRACT_PROMPT;
    const duty = p.slice(
      p.indexOf("**Load context first.**"),
      p.indexOf("**Record the conversation.**"),
    );
    expect(duty).toContain("doco_api GET `/api/v1/brief.json?about=<what the user raised>");
    expect(duty).toContain("workspace=<the chat's workspace handle>");
    expect(duty).toContain("obey its first tier (Must obey)");
    expect(duty).toContain("cite its ids");
    expect(duty).not.toContain("search the docos in reach");
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
