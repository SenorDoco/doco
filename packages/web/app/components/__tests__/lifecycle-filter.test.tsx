import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pullRequestLabel } from "~/lib/pull-requests";
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
