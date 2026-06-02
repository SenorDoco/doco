import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { GithubIntegrationCard } from "../github-integration-card";

function render(props: { handle: string; importing: boolean }): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(GithubIntegrationCard, props)),
  );
}

describe("GithubIntegrationCard", () => {
  it("shows the integration title, active status, and a Manage link to the GitHub detail page", () => {
    const markup = render({ handle: "torre-prs", importing: false });
    expect(markup).toContain("GitHub integration");
    expect(markup).toContain("Active");
    // Green status indicator emoji.
    expect(markup).toContain("🟢");
    const manage = markup.match(/<a [^>]*>Manage<\/a>/)?.[0] ?? "";
    expect(manage).toContain('href="/torre-prs/integrations/github"');
  });

  it("hides the importing note when not importing", () => {
    const markup = render({ handle: "torre-prs", importing: false });
    expect(markup).not.toContain("importing old PRs");
  });

  it("shows the importing note while old PRs are being backfilled", () => {
    const markup = render({ handle: "torre-prs", importing: true });
    expect(markup).toContain("Currently importing old PRs");
    // The Active status and Manage action stay visible during import.
    expect(markup).toContain("Active");
    expect(markup).toContain('href="/torre-prs/integrations/github"');
  });
});
