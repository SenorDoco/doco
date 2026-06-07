import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProcessPool } from "~/lib/process-perspective.server";
import { ProcessProcessList } from "../process-perspective";

// The process list renders only badges + buttons (no React Flow), but the
// module imports `@xyflow/react` at the top level. Stub it so the component
// tree renders under SSR without mounting a ReactFlow provider — mirrors the
// LOD test's approach.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useStore: () => 1,
}));

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

const draftingPool: ProcessPool = {
  id: "pool:action_1",
  process_id: "action_1",
  label: "Post a job",
  lifecycle: "drafting",
};

describe("BPMN process list (home view)", () => {
  it("renders the type + lifecycle badges inline like a pool title — not pinned to the card corners", () => {
    const html = render(<ProcessProcessList pools={[draftingPool]} onSelect={() => {}} />);
    // The process and its identity badges still read...
    expect(html).toContain("Post a job");
    expect(html).toContain("Action");
    expect(html).toContain("drafting");
    // ...but they flow inline (vertically centered in the row), exactly how
    // ProcessPoolHeaderNode renders them — never absolutely positioned at
    // `top:-7px` over the card's top corners (the "yellow thingies").
    expect(html).toContain("display:inline-block");
    expect(html).not.toContain("position:absolute");
    expect(html).not.toContain("top:-7px");
  });

  it("drops the standalone visible 'Processes' heading (keeps only the a11y name)", () => {
    const html = render(<ProcessProcessList pools={[draftingPool]} onSelect={() => {}} />);
    // No visible heading element...
    expect(html).not.toContain("<h2");
    // ...but the list is still named for assistive tech.
    expect(html).toContain('aria-label="Processes"');
  });

  it("hovers a row with the theme accent (primary), not the one-off teal accent token", () => {
    const html = render(<ProcessProcessList pools={[draftingPool]} onSelect={() => {}} />);
    // `bg-accent` is the lone teal/green hover in the app and reads as an
    // arbitrary color; the brand accent everywhere else is `primary`.
    expect(html).not.toContain("hover:bg-accent");
    expect(html).toContain("hover:bg-primary");
  });
});
