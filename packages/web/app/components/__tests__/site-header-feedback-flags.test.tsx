import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { FeedbackFlags } from "../site-header";

function render(props: Parameters<typeof FeedbackFlags>[0]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(FeedbackFlags, props)),
  );
}

describe("FeedbackFlags", () => {
  it("renders nothing when there is no pending feedback", () => {
    expect(render({ feedbackPending: null })).toBe("");
    expect(render({ feedbackPending: { bugs: 0, ideas: 0 } })).toBe("");
  });

  it("shows a bug flag linking to /feedback while bugs are uncleared", () => {
    const html = render({ feedbackPending: { bugs: 2, ideas: 0 } });
    expect(html).toContain('href="/feedback"');
    // lucide's Bug icon, the count, and an accessible summary.
    expect(html).toContain("lucide-bug");
    expect(html).toContain("2");
    expect(html).toContain("2 uncleared bugs");
    // No idea flag when there are no ideas.
    expect(html).not.toContain("lucide-lightbulb");
  });

  it("shows a lightbulb flag while ideas are uncleared", () => {
    const html = render({ feedbackPending: { bugs: 0, ideas: 1 } });
    expect(html).toContain('href="/feedback"');
    expect(html).toContain("lucide-lightbulb");
    expect(html).toContain("1 uncleared idea");
    expect(html).not.toContain("lucide-bug");
  });

  it("shows both flags together when bugs and ideas are pending", () => {
    const html = render({ feedbackPending: { bugs: 3, ideas: 4 } });
    expect(html).toContain("lucide-bug");
    expect(html).toContain("lucide-lightbulb");
    expect(html).toContain("3 uncleared bugs · 4 uncleared ideas");
  });
});
