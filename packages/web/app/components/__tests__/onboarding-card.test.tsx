import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { firstPersonLines } from "~/lib/__tests__/first-person";
import type { OnboardingProgress } from "~/lib/onboarding.server";
import { OnboardingCard } from "../onboarding-card";

function render(progress: OnboardingProgress): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(OnboardingCard, { progress })),
  );
}

const NOTHING_DONE = { workspace: false, agent: false, sources: false };

describe("OnboardingCard", () => {
  it("walks a new person through the three steps, in order", () => {
    const html = render(NOTHING_DONE);
    const workspace = html.indexOf("Create a workspace");
    const agent = html.indexOf("Connect your agent");
    const sources = html.indexOf("Connect sources of knowledge");
    expect(workspace).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(workspace);
    expect(sources).toBeGreaterThan(agent);
  });

  it("links each step to where it is done", () => {
    const html = render(NOTHING_DONE);
    expect(html).toContain('href="/new-workspace"');
    // The agent instructions live on the home page, with the Copy button.
    expect(html).toContain('href="/#instructions"');
    expect(html).toContain('href="/integrations"');
  });

  it("marks finished steps done and drops their link", () => {
    const html = render({ workspace: true, agent: false, sources: false });
    expect(html).not.toContain('href="/new-workspace"');
    expect(html).toContain("Done");
  });

  it("disappears once every step is done", () => {
    expect(render({ workspace: true, agent: true, sources: true })).toBe("");
  });

  it("never speaks in the first person", () => {
    const text = render(NOTHING_DONE).replace(/<[^>]+>/g, "\n");
    expect(firstPersonLines(text)).toEqual([]);
  });
});
