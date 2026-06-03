import { describe, expect, it } from "vitest";
import { resolveThinkingActive } from "../senor-doco-shell";

describe("resolveThinkingActive", () => {
  it("is on when thinking is enabled, in chat view, on a wide shell", () => {
    expect(resolveThinkingActive({ showThinking: true, view: "chat", narrow: false })).toBe(true);
  });

  it("is off in the narrow overlay drawer even when the user enabled thinking", () => {
    // Below 640px the rail is a narrow overlay drawer: the wide thinking
    // column can't fit and its toggle is hidden, so thinking is forced
    // off there regardless of the stored preference.
    expect(resolveThinkingActive({ showThinking: true, view: "chat", narrow: true })).toBe(false);
  });

  it("is off outside chat view", () => {
    expect(resolveThinkingActive({ showThinking: true, view: "list", narrow: false })).toBe(false);
  });

  it("is off when the user hasn't enabled thinking", () => {
    expect(resolveThinkingActive({ showThinking: false, view: "chat", narrow: false })).toBe(false);
  });
});
