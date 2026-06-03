import { afterEach, describe, expect, it } from "vitest";
import { SENOR_DOCO_DEFAULT_MODEL, getSenorDocoModel } from "../assistant-runtime.server";

const originalModel = process.env.SENOR_DOCO_ANTHROPIC_MODEL;
const originalFallbackModel = process.env.DOCO_ASSISTANT_MODEL;

describe("assistant-runtime.server", () => {
  afterEach(() => {
    restoreEnv("SENOR_DOCO_ANTHROPIC_MODEL", originalModel);
    restoreEnv("DOCO_ASSISTANT_MODEL", originalFallbackModel);
  });

  it("defaults Señor Doco to Haiku — simple, cheap, MCP-for-complex", () => {
    // Señor Doco is positioned as the in-product Haiku assistant for simple
    // work; complex work is delegated to a user's own agent over the MCP.
    expect(SENOR_DOCO_DEFAULT_MODEL).toBe("claude-haiku-4-5");
  });

  it("uses the shared Señor Doco model default", () => {
    process.env.SENOR_DOCO_ANTHROPIC_MODEL = "";
    process.env.DOCO_ASSISTANT_MODEL = "";

    expect(getSenorDocoModel()).toBe(SENOR_DOCO_DEFAULT_MODEL);
  });

  it("lets all Señor Doco surfaces share one model override", () => {
    process.env.SENOR_DOCO_ANTHROPIC_MODEL = "claude-test-shared";
    process.env.DOCO_ASSISTANT_MODEL = "claude-test-fallback";

    expect(getSenorDocoModel()).toBe("claude-test-shared");
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  process.env[name] = value ?? "";
}
