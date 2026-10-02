import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HowDocoWorks } from "../how-doco-works";

// Alexander, 2026-10-01: the home page and the invite page explain Doco with
// one block, a dial that turns through three steps (decision in the thread
// "How Doco works", option A "Triangle").
function render(): string {
  return renderToStaticMarkup(createElement(HowDocoWorks));
}

describe("How Doco works", () => {
  it("is titled as big as the home page headline", () => {
    const html = render();
    expect(html).toMatch(
      /<h2[^>]*class="text-2xl font-bold leading-tight md:text-3xl"[^>]*>How Doco works:<\/h2>/,
    );
  });

  it("names the three steps in order, in Alexander's words", () => {
    const text = render()
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    const collect = text.indexOf("Collect One workspace brings your team's knowledge together.");
    const connect = text.indexOf("Connect Your agents read that context as they work.");
    const capture = text.indexOf("Capture Agents record important decisions.");
    expect(collect).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(collect);
    expect(capture).toBeGreaterThan(connect);
  });

  it("starts with the dial pointing at the first step", () => {
    const html = render();
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*>.*?Collect/);
    expect(html).toContain("transform:rotate(0deg)");
  });
});
