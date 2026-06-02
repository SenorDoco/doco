import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle._index.tsx", import.meta.url), "utf8");
const appCss = () => readFileSync(new URL("../../app.css", import.meta.url), "utf8");

describe("/workspaces/:workspaceHandle responsive layout", () => {
  it("stacks the two-column shell until its own width reaches the shared 840px breakpoint", () => {
    expect(routeSource()).toContain("workspace-home-layout-shell");
    expect(routeSource()).toContain("workspace-home-layout-grid");
    expect(routeSource()).not.toContain("min-[840px]:grid-cols-[minmax(0,1fr)_320px]");

    expect(appCss()).toContain("container-type: inline-size");
    expect(appCss()).toContain("@container (min-width: 840px)");
    // The two columns split the shell evenly (50/50) once it widens, instead
    // of a flexible left column beside a fixed 320px sidebar.
    expect(appCss()).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
    expect(appCss()).not.toContain("minmax(0, 1fr) 320px");
  });

  it("puts the constitution + activity feed in the left column and the docos sidebar in the right, split 50/50", () => {
    const src = routeSource();
    const grid = src.indexOf("workspace-home-layout-grid");
    const constitution = src.indexOf("<WorkspaceConstitutionCard");
    const aside = src.indexOf("<aside");
    const search = src.indexOf("/workspaces/${workspace.handle}/search");
    const latestActivity = src.indexOf("Latest activity");

    // The constitution now lives inside the grid's left column, not above it.
    expect(grid).toBeGreaterThan(-1);
    expect(constitution).toBeGreaterThan(grid);
    // Left column (constitution + latest activity feed) precedes the right aside.
    expect(constitution).toBeLessThan(aside);
    expect(latestActivity).toBeLessThan(aside);
    // Search (and the docos list) moved into the right-hand sidebar.
    expect(search).toBeGreaterThan(aside);

    // The constitution fills the column instead of being capped/centered, and
    // the page spans the full viewport width like the perspective views do.
    expect(src).not.toContain("max-w-3xl");
    expect(src).not.toContain("max-w-6xl");
  });
});
