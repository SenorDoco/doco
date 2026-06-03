import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_COLOR, LIFECYCLE_DESCRIPTION } from "~/lib/node-colors";
import { LifecycleCountsLabel } from "../lifecycle-counts";

/** Strip HTML tags to recover the visible text content. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

describe("LifecycleCountsLabel", () => {
  it("renders the four counts as 'drafting / queued / active / retired'", () => {
    const html = renderToStaticMarkup(
      <LifecycleCountsLabel counts={{ drafting: 1, queued: 7, active: 33, retired: 2 }} />,
    );
    expect(text(html)).toBe("1/7/33/2");
    // Each number is painted in its lifecycle color.
    expect(html).toContain(LIFECYCLE_COLOR.drafting);
    expect(html).toContain(LIFECYCLE_COLOR.queued);
    expect(html).toContain(LIFECYCLE_COLOR.active);
    expect(html).toContain(LIFECYCLE_COLOR.retired);
    // ...and carries a hover title explaining what that color means.
    expect(html).toContain(`title="${LIFECYCLE_DESCRIPTION.drafting}"`);
    expect(html).toContain(`title="${LIFECYCLE_DESCRIPTION.queued}"`);
    expect(html).toContain(`title="${LIFECYCLE_DESCRIPTION.active}"`);
    expect(html).toContain(`title="${LIFECYCLE_DESCRIPTION.retired}"`);
  });

  it("always shows all four stages, even the zeros", () => {
    const html = renderToStaticMarkup(
      <LifecycleCountsLabel counts={{ drafting: 0, queued: 0, active: 40, retired: 0 }} />,
    );
    expect(text(html)).toBe("0/0/40/0");
  });
});
