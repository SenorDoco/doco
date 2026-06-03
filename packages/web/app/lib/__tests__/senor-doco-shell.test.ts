import { describe, expect, it } from "vitest";
import {
  resolvePublishedRailWidth,
  resolveThinkingActive,
  viewOnExpand,
} from "../senor-doco-shell";

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

describe("viewOnExpand", () => {
  it("restores the open thread when the collapse happened on the same page", () => {
    // The user collapsed Señor Doco a moment ago and is reopening it in
    // place on the same page — keep them in the thread they were reading.
    expect(
      viewOnExpand({
        collapseOriginPath: "/acme/decision/decision_01",
        currentPath: "/acme/decision/decision_01",
      }),
    ).toBe("restore");
  });

  it("resets to the thread list when no same-page collapse was recorded", () => {
    // A null origin means the collapsed state was inherited from
    // localStorage on a fresh load (a previous page/session), so expanding
    // shows the list rather than dropping into a possibly-stale thread.
    expect(viewOnExpand({ collapseOriginPath: null, currentPath: "/dashboard" })).toBe("list");
  });

  it("resets to the thread list when the collapse happened on a different page", () => {
    // Collapsed on one page, navigated elsewhere, then expanded — that is
    // not "the same page", so show the list.
    expect(
      viewOnExpand({
        collapseOriginPath: "/acme/decision/decision_01",
        currentPath: "/dashboard",
      }),
    ).toBe("list");
  });
});
