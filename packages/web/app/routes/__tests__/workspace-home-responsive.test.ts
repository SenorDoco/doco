import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle._index.tsx", import.meta.url), "utf8");
const briefSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle.brief.tsx", import.meta.url), "utf8");
const settingsSource = () =>
  readFileSync(new URL("../workspaces.$workspaceHandle.settings.tsx", import.meta.url), "utf8");

// The two-column split waits for `lg` (1024px) — the same width at which the
// SiteHeader swaps its inline nav for the hamburger. Below it there isn't room
// for the 420px sidebar *and* a comfortable left column (the constitution's
// wide-tracked title would overflow and its body wrap to ~one word per line),
// so the page renders as a single column, like the rest of the app's
// two-column pages (integrations, etc.). Anything lower (the old 840px) left a
// cramped two-column layout in the 840–1024px band.
const workspaceTwoColumnGrid = "grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]";

describe("/workspaces/:workspaceHandle responsive layout", () => {
  it("uses the shared wide page width and desktop sidebar grid", () => {
    const src = routeSource();

    expect(src).toContain("<PageMain");
    expect(src).toContain(workspaceTwoColumnGrid);
    // The two-column split must not kick in before there's room for it: the
    // old 840px breakpoint left a cramped two-column band below the nav's
    // 1024px collapse. Guard against regressing to it.
    expect(src).not.toContain("min-[840px]:grid-cols-[minmax(0,1fr)_420px]");
    expect(src).not.toContain("workspace-home-layout-shell");
    expect(src).not.toContain("workspace-home-layout-grid");
  });

  it("puts the constitution + activity feed in the left column and the docos sidebar in the right", () => {
    const src = routeSource();
    const grid = src.indexOf(workspaceTwoColumnGrid);
    const constitution = src.indexOf("<WorkspaceConstitutionCard");
    const aside = src.indexOf("<aside");
    const brief = src.indexOf("/workspaces/${workspace.handle}/brief");
    const latestActivity = src.indexOf("Latest activity");

    // The constitution now lives inside the grid's left column, not above it.
    expect(grid).toBeGreaterThan(-1);
    expect(constitution).toBeGreaterThan(grid);
    // Left column (constitution + latest activity feed) precedes the right aside.
    expect(constitution).toBeLessThan(aside);
    expect(latestActivity).toBeLessThan(aside);
    // "What applies to…?" (and the docos list) sit in the right-hand sidebar.
    expect(brief).toBeGreaterThan(aside);

    // The constitution fills the column instead of being capped/centered, and
    // the page uses the shared workspace width instead of reverting to the
    // narrow Doco-page width.
    expect(src).not.toContain("max-w-3xl");
    expect(src).not.toContain("max-w-4xl");
  });

  it("drops the latest activity feed to the bottom of the stacked (narrow) view", () => {
    const src = routeSource();

    // Below `lg` the page is a single column. Readers want the constitution
    // and the workspace's Docos first, so the cross-Doco activity feed should
    // fall to the very bottom — after the docos sidebar — instead of wedging
    // between the constitution and the sidebar.
    //
    // The left column dissolves into the grid (`contents`) below `lg` so its
    // children become direct grid items that can be ordered past the sidebar,
    // then reflows as a real column (`lg:block`) beneath the constitution at
    // `lg`, where the feed sits in its natural spot again.
    expect(src).toContain("contents lg:block");

    // The feed card carries `order-last` so it sorts after the sidebar in the
    // stacked grid, and resets to natural flow (`lg:order-none`) in the
    // two-column layout.
    const feedTitle = src.indexOf('<CardTitle className="text-sm">Latest activity</CardTitle>');
    expect(feedTitle).toBeGreaterThan(-1);
    // `<Card ` (trailing space) matches the card's opening tag, not the
    // `<CardHeader`/`<CardTitle` that nest inside it.
    const feedCardOpen = src.lastIndexOf("<Card ", feedTitle);
    expect(src.slice(feedCardOpen, feedTitle)).toContain("order-last");
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

  it("splits the workspace brief and settings pages into content and side columns", () => {
    for (const src of [briefSource(), settingsSource()]) {
      expect(src).toContain(workspaceTwoColumnGrid);
      expect(src).toContain("<aside");
    }
  });
});
