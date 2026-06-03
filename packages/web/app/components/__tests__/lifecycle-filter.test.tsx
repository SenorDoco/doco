import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { perspectiveHonorsLifecycleFilter } from "../lifecycle-filter";
import { PerspectiveFrame } from "../perspective-frame";

describe("perspectiveHonorsLifecycleFilter", () => {
  it("hides the lifecycle filter on the pull-requests perspective", () => {
    // The Pull requests perspective shows every imported PR Reference across
    // all stages (Merged / Open / Closed) as one flat list and never reads the
    // visible-lifecycle set, so the page lifecycle filter must not appear: the
    // checkboxes change nothing, and the page-level re-seed flips any the user
    // unchecks back on within seconds.
    expect(perspectiveHonorsLifecycleFilter("pull-requests")).toBe(false);
  });

  it("keeps the lifecycle filter on every node-graph perspective", () => {
    for (const kind of ["graph", "list", "bpmn", "org-tree", "sla", "glossary"]) {
      expect(perspectiveHonorsLifecycleFilter(kind)).toBe(true);
    }
  });
});

describe("PerspectiveFrame lifecycle filter by perspective kind", () => {
  // Render the real frame with the filter spec the route would build for a
  // given perspective kind, then look for the panel's "Life cycle:" label.
  function frameHtmlForKind(kind: string): string {
    const spec = perspectiveHonorsLifecycleFilter(kind)
      ? {
          visible: new Set(["active"]),
          available: ["queued", "active"],
          onToggle: () => {},
        }
      : undefined;
    return renderToStaticMarkup(
      <PerspectiveFrame fillHeight lifecycleFilter={spec}>
        <div>content</div>
      </PerspectiveFrame>,
    );
  }

  it("renders the Life cycle panel for a node-graph perspective", () => {
    expect(frameHtmlForKind("graph")).toContain("Life cycle:");
  });

  it("omits the Life cycle panel for the pull-requests perspective", () => {
    expect(frameHtmlForKind("pull-requests")).not.toContain("Life cycle:");
  });
});
