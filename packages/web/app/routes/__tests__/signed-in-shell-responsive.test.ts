import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootSource = () => readFileSync(new URL("../../root.tsx", import.meta.url), "utf8");
const sidebarSource = () =>
  readFileSync(new URL("../../components/agent-sidebar.tsx", import.meta.url), "utf8");
const appCss = () => readFileSync(new URL("../../app.css", import.meta.url), "utf8");

describe("signed-in shell responsive layout", () => {
  it("stacks Señor Doco above page content until the shared 840px two-column breakpoint", () => {
    expect(rootSource()).toContain("doco-shell-body");
    expect(rootSource()).toContain("doco-shell-main");
    expect(rootSource()).not.toContain('className="flex min-h-0 flex-1"');

    expect(sidebarSource()).toContain("senor-doco-rail");
    expect(sidebarSource()).toContain("--senor-doco-current-width");
    expect(sidebarSource()).toContain('"min(320px, 42svh)"');

    expect(appCss()).toContain(".doco-shell-body");
    expect(appCss()).toContain("flex-direction: column");
    expect(appCss()).toContain(".senor-doco-rail");
    expect(appCss()).toContain("height: var(--senor-doco-stack-height)");
    expect(appCss()).toContain("@media (min-width: 840px)");
    expect(appCss()).toContain("flex-direction: row");
    expect(appCss()).toContain("width: var(--senor-doco-current-width)");
  });
});
