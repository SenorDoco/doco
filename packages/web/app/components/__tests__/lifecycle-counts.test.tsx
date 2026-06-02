import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_COLOR } from "~/lib/node-colors";
import { LifecycleCountsLabel } from "../lifecycle-counts";

/** Strip HTML tags to recover the visible text content. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

describe("LifecycleCountsLabel", () => {
  it("renders the three counts as 'drafting / asserted / retired'", () => {
    const html = renderToStaticMarkup(
      <LifecycleCountsLabel counts={{ drafting: 1, asserted: 33, retired: 2 }} />,
    );
    expect(text(html)).toBe("1 / 33 / 2");
    // Each number is painted in its lifecycle color.
    expect(html).toContain(LIFECYCLE_COLOR.drafting);
    expect(html).toContain(LIFECYCLE_COLOR.asserted);
    expect(html).toContain(LIFECYCLE_COLOR.retired);
  });

  it("always shows all three stages, even the zeros", () => {
    const html = renderToStaticMarkup(
      <LifecycleCountsLabel counts={{ drafting: 0, asserted: 40, retired: 0 }} />,
    );
    expect(text(html)).toBe("0 / 40 / 0");
  });
});
