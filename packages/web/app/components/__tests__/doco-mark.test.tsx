import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocoMark } from "../doco-mark";

// Alexander, 2026-10-03: "Add biomorphic [neumorphic] design to the logo of
// Doco in the home page." The raised logo stands out of the page like the How
// Doco works plate, lit from the top left: a highlight above it, a shadow
// below it, and a soft bevel on the purple itself, so it reads as molded.
const appCss = readFileSync(new URL("../../app.css", import.meta.url), "utf8");

function render(props: Parameters<typeof DocoMark>[0]): string {
  return renderToStaticMarkup(createElement(DocoMark, props));
}

describe("DocoMark", () => {
  it("bevels the orb and the wordmark together when raised", () => {
    const html = render({ height: 72, raised: true });
    expect(html).toMatch(/<svg[^>]*class="[^"]*\bdoco-mark-raised\b/);
    const filterId = html.match(/<filter id="([^"]+)"/)?.[1];
    expect(filterId).toBeTruthy();
    // One filtered group holds the orb and the wordmark, so both share the
    // same light; the working-state mist stays outside it.
    const group = html.indexOf(`filter="url(#${filterId})"`);
    expect(group).toBeGreaterThan(0);
    expect(html.indexOf("doco-mark-glyph-motion")).toBeGreaterThan(group);
    expect(html.indexOf("M23.600-56.500")).toBeGreaterThan(group);
    expect(html.indexOf("doco-mark-mist")).toBeGreaterThan(html.indexOf("M23.600-56.500"));
  });

  it("stays flat everywhere else", () => {
    for (const html of [
      render({ height: 28 }),
      render({ height: 28, variant: "mark", active: true }),
    ]) {
      expect(html).not.toContain("doco-mark-raised");
      expect(html).not.toContain("<filter");
    }
  });

  it("lifts the raised logo with the site's neumorphic shadow and highlight", () => {
    const at = appCss.indexOf("\n.doco-mark-raised {");
    expect(at).toBeGreaterThan(0);
    const rule = appCss.slice(at, appCss.indexOf("}", at));
    expect(rule).toMatch(
      /filter: drop-shadow\(\d+px \d+px \d+px var\(--neu-shadow\)\) drop-shadow\(-\d+px -\d+px \d+px var\(--neu-highlight\)\)/,
    );
  });
});
