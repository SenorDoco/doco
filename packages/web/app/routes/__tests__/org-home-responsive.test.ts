import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = () =>
  readFileSync(new URL("../orgs.$orgHandle._index.tsx", import.meta.url), "utf8");
const appCss = () => readFileSync(new URL("../../app.css", import.meta.url), "utf8");

describe("/orgs/:orgHandle responsive layout", () => {
  it("stacks the two-column shell until its own width reaches the shared 840px breakpoint", () => {
    expect(routeSource()).toContain("org-home-layout-shell");
    expect(routeSource()).toContain("org-home-layout-grid");
    expect(routeSource()).not.toContain("min-[840px]:grid-cols-[minmax(0,1fr)_320px]");

    expect(appCss()).toContain("container-type: inline-size");
    expect(appCss()).toContain("@container (min-width: 840px)");
    expect(appCss()).toContain("grid-template-columns: minmax(0, 1fr) 320px");
  });
});
