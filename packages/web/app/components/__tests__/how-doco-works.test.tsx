import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HowDocoWorks } from "../how-doco-works";

// Alexander, 2026-10-02: the home page and the invite page explain Doco with
// one block, a wiring diagram of what Doco is (option A "Flow" in the thread
// "How Doco works animation proposals"): sources feed the workspace, agents
// read it, and a return wire carries what agents write back. Later that day
// he picked, of five neumorphic treatments, C "Plate": one raised plate holds
// the diagram, with the chips etched into it and the workspace pressed into
// it, LED pulses on the wires, and key-cap step numbers.
function render(): string {
  return renderToStaticMarkup(createElement(HowDocoWorks));
}

/** The two diagrams, one laid out for desktop and one upright for phones. */
function diagrams(html: string): string[] {
  return html
    .split(/(?=<div class="hdw-dia )/)
    .filter((part) => part.startsWith('<div class="hdw-dia '));
}
/** The chips' and the workspace's labels in one diagram, in document order. */
function labelsIn(diagram: string): string[] {
  return [
    ...diagram.matchAll(/<div class="hdw-(?:chip|ws)[^"]*"[^>]*>.*?<span>([^<]*)<\/span>/g),
  ].map((m) => m[1]);
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

  it("starts on the first step, with the sources wired up and lit", () => {
    const html = render();
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*>.*?Collect/);
    expect(html).toMatch(/class="hdw-wire hdw-wire-src hdw-on"/);
    expect(html).not.toMatch(/class="hdw-wire hdw-wire-agent hdw-on"/);
    for (const diagram of diagrams(html)) {
      const lit = [
        ...diagram.matchAll(/<div class="hdw-chip[^"]*hdw-on"[^>]*>.*?<span>([^<]*)<\/span>/g),
      ].map((m) => m[1]);
      expect(lit).toEqual(["People", "GitHub", "Slack", "Notion", "+ more"]);
    }
  });

  // Alexander, 2026-10-02: people first among the sources, Claude (not Claude
  // Code) and Qwen among the agents, and both columns say there are more.
  it("draws the sources, people first, and the agents, each column ending in more", () => {
    const both = diagrams(render());
    expect(both).toHaveLength(2);
    for (const diagram of both) {
      const labels = labelsIn(diagram);
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
    for (const diagram of diagrams(render())) {
      expect(diagram.match(/class="hdw-wire hdw-wire-src/g)).toHaveLength(5);
      expect(diagram.match(/class="hdw-wire hdw-wire-agent/g)).toHaveLength(5);
      expect(diagram.match(/class="hdw-wire hdw-wire-back/g)).toHaveLength(1);
    }
  });

  // The plate: both diagrams sit on it, above the steps. The wires are an
  // SVG; the chips and the workspace are HTML laid over it, so they can wear
  // the app's shadows (--neu-etched, --neu-inset), which SVG shapes cannot.
  it("sets both diagrams on one raised plate, the chips and workspace laid over the wires", () => {
    const html = render();
    expect(html.match(/class="hdw-plate"/g)).toHaveLength(1);
    const plate = html.indexOf('class="hdw-plate"');
    const steps = html.indexOf('class="hdw-steps"');
    expect(plate).toBeGreaterThan(-1);
    for (const diagram of diagrams(html)) {
      const at = html.indexOf(diagram);
      expect(at).toBeGreaterThan(plate);
      expect(at).toBeLessThan(steps);
      const wires = diagram.indexOf("</svg>");
      expect(diagram.slice(0, wires)).not.toMatch(/<rect/);
      expect(diagram.indexOf('<div class="hdw-chip')).toBeGreaterThan(wires);
      expect(diagram.match(/<div class="hdw-chip/g)).toHaveLength(10);
      expect(diagram.match(/<div class="hdw-ws"/g)).toHaveLength(1);
      expect(diagram.indexOf('<div class="hdw-ws"')).toBeGreaterThan(wires);
    }
  });
});
