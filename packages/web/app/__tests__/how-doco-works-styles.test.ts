import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Alexander, 2026-10-02, on the plate (PR #1332): "Make the animations
// smoother so that when something turns purple or goes back to gray, it's a
// smoother transition. Also, I don't like the purple borders on the boxes.
// Keep the original borders. Just change the background to be maybe
// purplish." So the chips and the workspace in play keep their etched and
// pressed edges and take a purplish fill, and everything that turns purple
// or gray fades over one gentle duration.
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const hdw = appCss.slice(appCss.indexOf("/* How Doco works"));

/** The declarations of the rule with exactly this selector. */
function rule(selector: string): string {
  const at = hdw.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return hdw.slice(at, hdw.indexOf("}", at));
}

describe("How Doco works styles", () => {
  it("fills the boxes in play with a purplish tint and keeps their edges", () => {
    // Mixed in sRGB: in oklch the paper's hue wins and the tint goes tan.
    expect(rule(".hdw")).toMatch(
      /--hdw-tint: color-mix\(in srgb, var\(--color-primary\) \d+%, var\(--color-background\)\)/,
    );
    for (const selector of [".hdw-chip.hdw-on", '.hdw-ws[data-lit="true"]']) {
      const lit = rule(selector);
      expect(lit).toMatch(/background: var\(--hdw-tint\)/);
      expect(lit).not.toMatch(/box-shadow|border|--hdw-ring/);
    }
  });

  it("fades everything that turns purple or gray over one gentle duration", () => {
    const fade = Number(rule(".hdw").match(/--hdw-fade: (\d+)ms/)?.[1]);
    expect(fade).toBeGreaterThanOrEqual(600);
    const eases = (declarations: string, ...properties: string[]) => {
      for (const property of properties) {
        expect(declarations).toMatch(
          new RegExp(`transition:[^;]*\\b${property} var\\(--hdw-fade\\) ease-in-out`),
        );
      }
    };
    eases(rule(".hdw-chip,\n.hdw-ws"), "background-color", "color");
    eases(rule(".hdw-ic"), "color");
    eases(rule(".hdw-verb"), "color");
    eases(rule(".hdw-wire"), "stroke", "stroke-width", "stroke-dasharray", "filter");
    // The wires' dashes grow shut rather than jumping to a solid line: the
    // resting and the lit dash lists have the same two entries, the lit gap 0.
    expect(rule(".hdw-wire")).toMatch(/stroke-dasharray: \d+ \d+;/);
    expect(rule(".hdw-wire.hdw-on")).toMatch(/stroke-dasharray: \d+ 0;/);
  });
});
