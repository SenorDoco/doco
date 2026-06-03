import { describe, expect, it } from "vitest";
import {
  PR_LIFECYCLE_ORDER,
  parsePrLifecycles,
  pullRequestLabel,
  togglePrLifecycleParam,
  visiblePrLifecycles,
} from "../pull-requests";

describe("pullRequestLabel", () => {
  it("maps PR lifecycle stages to Open / Merged / Closed", () => {
    expect(pullRequestLabel("queued")).toBe("Open");
    expect(pullRequestLabel("active")).toBe("Merged");
    expect(pullRequestLabel("retired")).toBe("Closed");
  });

  it("treats any other stage as Open — the catch-all PR state", () => {
    expect(pullRequestLabel("drafting")).toBe("Open");
    expect(pullRequestLabel("whatever")).toBe("Open");
  });
});

describe("parsePrLifecycles", () => {
  it("returns null (meaning: all stages) when the param is absent", () => {
    expect(parsePrLifecycles(null)).toBeNull();
  });

  it("returns the whitelisted stages in canonical order", () => {
    expect(parsePrLifecycles("retired,queued")).toEqual(["queued", "retired"]);
  });

  it("drops unknown tokens and dedupes", () => {
    expect(parsePrLifecycles("active,bogus,active")).toEqual(["active"]);
  });

  it("returns an empty list (meaning: none) for an explicit empty value", () => {
    expect(parsePrLifecycles("")).toEqual([]);
  });
});

describe("visiblePrLifecycles", () => {
  it("shows every stage checked by default (absent param)", () => {
    expect(visiblePrLifecycles(null)).toEqual(new Set(PR_LIFECYCLE_ORDER));
  });

  it("reflects exactly the selected subset", () => {
    expect(visiblePrLifecycles("queued,active")).toEqual(new Set(["queued", "active"]));
  });

  it("is empty when the param is explicitly empty", () => {
    expect(visiblePrLifecycles("")).toEqual(new Set());
  });
});

describe("togglePrLifecycleParam", () => {
  it("unchecking one stage from the default writes the remaining subset", () => {
    // Default (null = all) → uncheck Merged (active) → keep Open + Closed.
    expect(togglePrLifecycleParam(null, "active")).toBe("queued,retired");
  });

  it("re-checking the last missing stage clears the param (back to all)", () => {
    expect(togglePrLifecycleParam("queued,retired", "active")).toBeNull();
  });

  it("keeps canonical order regardless of toggle order", () => {
    const afterRetired = togglePrLifecycleParam("", "retired");
    expect(afterRetired).toBe("retired");
    expect(togglePrLifecycleParam(afterRetired, "queued")).toBe("queued,retired");
  });

  it("unchecking the only remaining stage yields the explicit empty (none)", () => {
    expect(togglePrLifecycleParam("active", "active")).toBe("");
  });

  it("ignores unknown stages", () => {
    expect(togglePrLifecycleParam("queued", "bogus")).toBe("queued");
  });
});
