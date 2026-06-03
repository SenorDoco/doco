import { describe, expect, it } from "vitest";
import { resolvePublishedRailWidth, resolveThinkingActive } from "../senor-doco-shell";

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

describe("resolvePublishedRailWidth", () => {
  it("reserves no width for the modal overlay drawer (narrow + expanded)", () => {
    // The expanded drawer floats over the page as a modal, so page content
    // (e.g. the node/edge dialog) should span full width behind it.
    expect(resolvePublishedRailWidth({ narrow: true, collapsed: false, railWidth: "320px" })).toBe(
      "0px",
    );
  });

  it("reserves the collapsed strip's width so the reopen handle stays clear (narrow + collapsed)", () => {
    // When collapsed the 32px strip is in flow; page content must clear it
    // or a fixed dialog would cover the only way to reopen the chat.
    expect(resolvePublishedRailWidth({ narrow: true, collapsed: true, railWidth: "32px" })).toBe(
      "32px",
    );
  });

  it("reserves the side rail's full width on wide screens", () => {
    expect(resolvePublishedRailWidth({ narrow: false, collapsed: false, railWidth: "320px" })).toBe(
      "320px",
    );
  });
});
