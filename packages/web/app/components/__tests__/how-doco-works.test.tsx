import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HowDocoWorks } from "../how-doco-works";

// Alexander, 2026-10-02: the home page and the invite page explain Doco with
// one block, a wiring diagram of what Doco is (option A "Flow" in the thread
// "How Doco works animation proposals"): sources feed the workspace, agents
// read it, and a return wire carries what agents write back.
function render(): string {
  return renderToStaticMarkup(createElement(HowDocoWorks));
}

/** The labels drawn in one of the diagram's SVGs, in document order. */
function labelsIn(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}
function diagrams(html: string): string[] {
  // Split where each diagram starts, not at the icons' own nested <svg>s.
  return html
    .split(/(?=<svg class="hdw-flow)/)
    .filter((part) => part.startsWith('<svg class="hdw-flow'));
}

describe("How Doco works", () => {
  // Alexander, 2026-10-02: the headline-sized title was too big; it sits a
  // step below the headline (text-2xl/3xl).
  it("is titled a step smaller than the home page headline", () => {
    const html = render();
    expect(html).toMatch(
      /<h2[^>]*class="text-lg font-bold leading-tight md:text-xl"[^>]*>How Doco works:<\/h2>/,
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

  it("starts on the first step, with the sources wired up", () => {
    const html = render();
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*>.*?Collect/);
    expect(html).toMatch(/class="hdw-wire hdw-wire-src hdw-on"/);
    expect(html).not.toMatch(/class="hdw-wire hdw-wire-agent hdw-on"/);
  });

  // Alexander, 2026-10-02: people first among the sources, Claude (not Claude
  // Code) and Qwen among the agents, and both columns say there are more.
  it("draws the sources, people first, and the agents, each column ending in more", () => {
    const svgs = diagrams(render());
    expect(svgs).toHaveLength(2); // one laid out for desktop, one upright for phones
    for (const svg of svgs) {
      const labels = labelsIn(svg);
      const sources = ["People", "GitHub", "Slack", "Notion", "+ more"].map((l) =>
        labels.indexOf(l),
      );
      const agents = ["Claude", "Cursor", "Codex", "Qwen"].map((l) => labels.indexOf(l));
      expect(sources.every((i) => i > -1)).toBe(true);
      expect(agents.every((i) => i > -1)).toBe(true);
      expect([...sources]).toEqual([...sources].sort((a, b) => a - b));
      expect([...agents]).toEqual([...agents].sort((a, b) => a - b));
      expect(labels.filter((l) => l === "+ more")).toHaveLength(2);
      expect(labels.lastIndexOf("+ more")).toBeGreaterThan(labels.indexOf("Qwen"));
      expect(labels).toContain("Your workspace");
      expect(labels).not.toContain("Claude Code");
    }
  });

  it("wires every source and agent to the workspace, and the agents back to it", () => {
    for (const svg of diagrams(render())) {
      expect(svg.match(/class="hdw-wire hdw-wire-src/g)).toHaveLength(5);
      expect(svg.match(/class="hdw-wire hdw-wire-agent/g)).toHaveLength(5);
      expect(svg.match(/class="hdw-wire hdw-wire-back/g)).toHaveLength(1);
    }
  });
});
