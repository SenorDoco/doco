import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_COLOR } from "~/lib/node-colors";
import { pullRequestLabel } from "~/lib/pull-requests";
import {
  edgeLifecycle,
  edgeStrokeColor,
  isEdgeLifecycleVisible,
  newlyVisibleLifecycles,
} from "../lifecycle-filter";
import { PerspectiveFrame } from "../perspective-frame";

/** Strip HTML tags to recover the visible text content. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("PerspectiveFrame lifecycle filter panel", () => {
  it("labels each stage with its raw lifecycle name by default", () => {
    const html = renderToStaticMarkup(
      <PerspectiveFrame
        fillHeight
        lifecycleFilter={{
          visible: new Set(["active"]),
          available: ["queued", "active", "retired"],
          onToggle: () => {},
        }}
      >
        <div>content</div>
      </PerspectiveFrame>,
    );
    expect(html).toContain("Life cycle:");
    expect(text(html)).toContain("queued");
    expect(text(html)).toContain("active");
    expect(text(html)).toContain("retired");
  });

  it("relabels stages via labelFor — Pull requests read Open / Merged / Closed", () => {
    const html = renderToStaticMarkup(
      <PerspectiveFrame
        fillHeight
        lifecycleFilter={{
          visible: new Set(["queued", "active", "retired"]),
          available: ["queued", "active", "retired"],
          onToggle: () => {},
          labelFor: pullRequestLabel,
        }}
      >
        <div>content</div>
      </PerspectiveFrame>,
    );
    const visible = text(html);
    expect(html).toContain("Life cycle:");
    expect(visible).toContain("Open");
    expect(visible).toContain("Merged");
    expect(visible).toContain("Closed");
    // The raw lifecycle names must NOT leak through when a label map is given.
    expect(visible).not.toContain("queued");
    expect(visible).not.toContain("active");
    expect(visible).not.toContain("retired");
  });

  it("renders no panel when no lifecycle filter is supplied", () => {
    const html = renderToStaticMarkup(
      <PerspectiveFrame fillHeight>
        <div>content</div>
      </PerspectiveFrame>,
    );
    expect(html).not.toContain("Life cycle:");
  });
});

describe("newlyVisibleLifecycles", () => {
  it("re-adds nothing when every available stage is already known", () => {
    // The fix: once a stage is known, an unchecked default-visible stage
    // (e.g. 'active', removed by the user) must NOT reappear when the live
    // feed re-creates the available set on every revalidation.
    const known = new Set(["drafting", "queued", "active", "retired"]);
    const { newlyVisible, nextKnown } = newlyVisibleLifecycles(
      ["drafting", "queued", "active", "retired"],
      known,
    );
    expect(newlyVisible).toEqual([]);
    expect([...nextKnown].sort()).toEqual(["active", "drafting", "queued", "retired"]);
  });

  it("surfaces a genuinely new, non-hidden stage and records it as known", () => {
    const { newlyVisible, nextKnown } = newlyVisibleLifecycles(
      ["queued", "active", "blocked"],
      new Set(["queued", "active"]),
    );
    expect(newlyVisible).toEqual(["blocked"]);
    expect(nextKnown.has("blocked")).toBe(true);
  });

  it("records a new hide-by-default stage as known WITHOUT showing it", () => {
    // 'retired' hides by default: its first appearance in the data shouldn't
    // reveal it, but it must be marked known so it isn't re-evaluated later.
    const { newlyVisible, nextKnown } = newlyVisibleLifecycles(
      ["queued", "retired"],
      new Set(["queued"]),
    );
    expect(newlyVisible).toEqual([]);
    expect(nextKnown.has("retired")).toBe(true);
  });

  it("surfaces only the new non-hidden stages from a mixed set", () => {
    const { newlyVisible } = newlyVisibleLifecycles(
      ["queued", "active", "blocked", "retired"],
      new Set(["queued", "active"]),
    );
    expect(newlyVisible).toEqual(["blocked"]);
  });

  it("does not mutate the passed-in known set", () => {
    const known = new Set(["queued"]);
    newlyVisibleLifecycles(["queued", "blocked"], known);
    expect([...known]).toEqual(["queued"]);
  });
});

describe("edge lifecycle visibility", () => {
  it("defaults an edge with no lifecycle to active", () => {
    expect(edgeLifecycle({})).toBe("active");
    expect(edgeLifecycle({ lifecycle: null })).toBe("active");
    expect(edgeLifecycle({ lifecycle: "retired" })).toBe("retired");
  });

  it("hides a retired edge when retired is filtered out (the default)", () => {
    const visible = new Set(["drafting", "queued", "active"]);
    expect(isEdgeLifecycleVisible({ lifecycle: "retired" }, visible)).toBe(false);
    expect(isEdgeLifecycleVisible({ lifecycle: "active" }, visible)).toBe(true);
    // A lifecycle-less edge rides the active default, so it stays visible.
    expect(isEdgeLifecycleVisible({}, visible)).toBe(true);
  });

  it("reveals a retired edge once retired is toggled on", () => {
    const visible = new Set(["drafting", "queued", "active", "retired"]);
    expect(isEdgeLifecycleVisible({ lifecycle: "retired" }, visible)).toBe(true);
  });

  it("colors an edge by its OWN lifecycle, not an endpoint node's", () => {
    // A drafting edge between two active nodes is yellow, not black — the edge
    // carries its own stage. Every perspective strokes edges through this.
    expect(edgeStrokeColor({ lifecycle: "drafting" })).toBe(LIFECYCLE_COLOR.drafting);
    expect(edgeStrokeColor({ lifecycle: "queued" })).toBe(LIFECYCLE_COLOR.queued);
    expect(edgeStrokeColor({ lifecycle: "active" })).toBe(LIFECYCLE_COLOR.active);
    expect(edgeStrokeColor({ lifecycle: "retired" })).toBe(LIFECYCLE_COLOR.retired);
    // A lifecycle-less edge rides the active default.
    expect(edgeStrokeColor({})).toBe(LIFECYCLE_COLOR.active);
  });
});
