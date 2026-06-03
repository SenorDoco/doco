import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootSource = () => readFileSync(new URL("../../root.tsx", import.meta.url), "utf8");
const sidebarSource = () =>
  readFileSync(new URL("../../components/agent-sidebar.tsx", import.meta.url), "utf8");
const appCss = () => readFileSync(new URL("../../app.css", import.meta.url), "utf8");

describe("signed-in shell responsive layout", () => {
  it("keeps the rail-plus-scrolling-main shell structure in the root chrome", () => {
    expect(rootSource()).toContain("doco-shell-body");
    expect(rootSource()).toContain("doco-shell-main");
    expect(rootSource()).not.toContain('className="flex min-h-0 flex-1"');

    expect(sidebarSource()).toContain("senor-doco-rail");
    expect(sidebarSource()).toContain("--senor-doco-current-width");
  });

  it("seats Señor Doco as an in-flow side rail and never stacks it on top of the page", () => {
    const css = appCss();
    // The shell lays the rail out in a row beside the scrolling page, and
    // the rail takes its published width — there is no full-width in-flow
    // stack that pushes the page down anymore.
    expect(css).toContain(".doco-shell-body");
    expect(css).toContain("flex-direction: row");
    expect(css).toContain("width: var(--senor-doco-current-width)");
    // The old stacked layout (full-width rail with a "stack height") is gone.
    expect(css).not.toContain("--senor-doco-stack-height");
    expect(sidebarSource()).not.toContain("42svh");
  });

  it("floats the expanded rail over a dimmed page below 640px, snapping to a side rail above it", () => {
    const css = appCss();
    // Below 640px the expanded rail floats over the page as an overlay...
    expect(css).toContain('.senor-doco-rail:not([data-collapsed="true"])');
    expect(css).toContain("position: absolute");
    // ...behind a dimming backdrop...
    expect(css).toContain(".senor-doco-backdrop");
    // ...and snaps back to an in-flow side rail at the 640px breakpoint.
    expect(css).toContain("@media (min-width: 640px)");

    const sidebar = sidebarSource();
    // The aside advertises its collapsed state so the overlay rule targets
    // only the expanded drawer, and a backdrop click collapses it.
    expect(sidebar).toContain("data-collapsed");
    expect(sidebar).toContain("senor-doco-backdrop");
  });
});
