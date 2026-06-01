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
});
