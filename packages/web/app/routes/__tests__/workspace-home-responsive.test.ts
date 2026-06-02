import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle._index.tsx", import.meta.url), "utf8");
const searchSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle.search.tsx", import.meta.url), "utf8");
const settingsSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle.settings.tsx", import.meta.url), "utf8");

const workspaceTwoColumnGrid = "grid grid-cols-1 gap-6 min-[840px]:grid-cols-[minmax(0,1fr)_420px]";

describe("/workspaces/:workspaceHandle responsive layout", () => {
  it("uses the shared wide page width and desktop sidebar grid", () => {
    const src = routeSource();

    expect(src).toContain("mx-auto w-full max-w-6xl px-6");
    expect(src).toContain(workspaceTwoColumnGrid);
    expect(src).not.toContain("workspace-home-layout-shell");
    expect(src).not.toContain("workspace-home-layout-grid");
  });

  it("puts the constitution + activity feed in the left column and the docos sidebar in the right", () => {
    const src = routeSource();
    const grid = src.indexOf(workspaceTwoColumnGrid);
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
    // the page uses the shared workspace width instead of reverting to the
    // narrow Doco-page width.
    expect(src).not.toContain("max-w-3xl");
    expect(src).not.toContain("max-w-4xl");
  });

  it("lists the workspace's Docos by name without the redundant owner prefix", () => {
    const src = routeSource();
    const docosCard = src.indexOf('"Docos in this workspace"');
    const hideOwner = src.indexOf("showOwner={false}");

    // The Docos list lives in this workspace, so prefixing each entry with the
    // workspace handle ("torre / …") is redundant — show just the Doco name.
    expect(docosCard).toBeGreaterThan(-1);
    expect(hideOwner).toBeGreaterThan(docosCard);
  });

  it("splits workspace search and settings pages into content and side columns", () => {
    for (const src of [searchSource(), settingsSource()]) {
      expect(src).toContain(workspaceTwoColumnGrid);
      expect(src).toContain("<aside");
    }
  });
});
