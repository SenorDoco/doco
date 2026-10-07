import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HowDocoWorks } from "../how-doco-works";

// Alexander, 2026-10-06: the home page and the invite page explain Doco with
// three steps instead of the animation, in his words.
function render(): string {
  return renderToStaticMarkup(createElement(HowDocoWorks));
}

/** The list items, in order. */
function items(html: string): string[] {
  return [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]);
}

describe("How Doco works", () => {
  // Alexander, 2026-10-02: the title sits a step below the home page
  // headline (text-2xl/3xl).
  it("is titled a step smaller than the home page headline", () => {
    expect(render()).toMatch(
      /<h2[^>]*class="text-lg font-bold leading-tight md:text-xl"[^>]*>How Doco works:<\/h2>/,
    );
  });

  // Alexander, 2026-10-07: "We have titles and text after all." Each step's
  // bold lead-in is its title, on its own line, and the rest is its text.
  it("gives each of Alexander's three steps a title and a text, in his words", () => {
    const steps = items(render());
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.match(/<h3[^>]*>(.*?)<\/h3>/)?.[1])).toEqual([
      "Your knowledge is collected",
      "Agents query such knowledge",
      "Agents capture more knowledge",
    ]);
    expect(steps.map((step) => step.match(/<p[^>]*>(.*?)<\/p>/)?.[1])).toEqual([
      "Including chats, GitHub, Slack, Notion, and AI agents",
      "When agents work, Doco tells them what to keep in mind for their task at hand",
      "Important decisions and chats are collected and shared",
    ]);
  });

  // The animation is gone: nothing moves, and nothing looks clickable that
  // isn't (one clay: only what can be clicked is purple or raised as a key).
  it("is still: no diagram, nothing to click, the numbers sunk into the page", () => {
    const html = render();
    expect(html).not.toMatch(/<svg|<button|<a |aria-current/);
    expect(html).not.toMatch(/text-primary|neu-button/);
    const numbers = [...html.matchAll(/<span[^>]*class="([^"]*)"[^>]*>(\d)<\/span>/g)];
    expect(numbers.map((m) => m[2])).toEqual(["1", "2", "3"]);
    for (const [, className] of numbers) expect(className).toMatch(/\bneu-well\b/);
  });

  // Three columns where there is room (the home page and the invite page on a
  // computer); one step under the other on phones. The steps span the page
  // (Alexander, 2026-10-07: "448px and 1152 - no 768px").
  it("sits the steps side by side only when its own width allows", () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*class="[^"]*@container/);
    expect(html).toMatch(/<ol[^>]*class="[^"]*@2xl:grid-cols-3/);
    expect(html).not.toMatch(/max-w-/);
  });
});
