import { describe, expect, it } from "vitest";

import { createMainScrollRestorer } from "../main-scroll-restoration";

type FakeScrollPane = {
  scrollLeft: number;
  scrollTop: number;
};

function pane(top = 0, left = 0): FakeScrollPane {
  return { scrollLeft: left, scrollTop: top };
}

describe("main scroll restoration", () => {
  it("resets the persistent main pane for forward navigation and restores it on history navigation", () => {
    const restorer = createMainScrollRestorer();
    const element = pane();

    restorer.applyNavigation({ element, key: "home", navigationType: "PUSH" });
    element.scrollTop = 440;
    element.scrollLeft = 12;

    restorer.applyNavigation({ element, key: "settings", navigationType: "PUSH" });

    expect(element.scrollTop).toBe(0);
    expect(element.scrollLeft).toBe(0);

    element.scrollTop = 80;
    element.scrollLeft = 4;

    restorer.applyNavigation({ element, key: "home", navigationType: "POP" });

    expect(element.scrollTop).toBe(440);
    expect(element.scrollLeft).toBe(12);
  });

  it("treats replace navigation as a new page instead of carrying the prior scroll", () => {
    const restorer = createMainScrollRestorer();
    const element = pane();

    restorer.applyNavigation({ element, key: "start", navigationType: "PUSH" });
    element.scrollTop = 275;

    restorer.applyNavigation({ element, key: "redirected", navigationType: "REPLACE" });

    expect(element.scrollTop).toBe(0);
    expect(element.scrollLeft).toBe(0);
  });

  it("preserves scroll when a forward navigation opts out of reset", () => {
    // In-place toggles (e.g. ?confirm=delete revealing a confirm form on the
    // same page) push a new history entry but must not yank the pane to top.
    const restorer = createMainScrollRestorer();
    const element = pane();

    restorer.applyNavigation({ element, key: "settings", navigationType: "PUSH" });
    element.scrollTop = 600;
    element.scrollLeft = 8;

    restorer.applyNavigation({
      element,
      key: "settings-confirm",
      navigationType: "PUSH",
      preventReset: true,
    });

    expect(element.scrollTop).toBe(600);
    expect(element.scrollLeft).toBe(8);
  });

  it("preserves scroll when a replace navigation opts out of reset", () => {
    // In-place filters (setSearchParams({ replace: true })) update query params
    // on the same page; opting out keeps the reader where they were.
    const restorer = createMainScrollRestorer();
    const element = pane();

    restorer.applyNavigation({ element, key: "list", navigationType: "PUSH" });
    element.scrollTop = 210;

    restorer.applyNavigation({
      element,
      key: "list-filtered",
      navigationType: "REPLACE",
      preventReset: true,
    });

    expect(element.scrollTop).toBe(210);
  });

  it("still records scroll on an opt-out navigation so history restore works", () => {
    const restorer = createMainScrollRestorer();
    const element = pane();

    restorer.applyNavigation({ element, key: "a", navigationType: "PUSH" });
    element.scrollTop = 300;

    restorer.applyNavigation({ element, key: "b", navigationType: "PUSH", preventReset: true });
    element.scrollTop = 320;

    restorer.applyNavigation({ element, key: "c", navigationType: "PUSH" });
    expect(element.scrollTop).toBe(0);

    restorer.applyNavigation({ element, key: "b", navigationType: "POP" });
    expect(element.scrollTop).toBe(320);
  });
});
