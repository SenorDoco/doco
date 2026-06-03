import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));

import SlackLinkPage from "../integrations.slack.link";

function render(boundWorkspaceHandle: string | null): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(SlackLinkPage, {
        loaderData: {
          username: "torrenegra",
          workspaceId: "T_SLACK",
          chatUserId: "U1",
          boundWorkspaceHandle,
        },
      }),
    ),
  );
}

describe("/integrations/slack/link confirmation copy", () => {
  it("when bound, scopes the promise to the one workspace (no account-wide claim)", () => {
    const markup = render("torre");
    expect(markup).toContain("in the torre workspace");
    expect(markup).toContain("only within the torre workspace");
    expect(markup).toContain("never any other workspace");
    // The old, misleading account-wide phrasing is gone.
    expect(markup).not.toContain("Slack can use your Doco access");
    expect(markup).not.toContain("Doco permissions for Slack requests");
  });

  it("when unbound, says there is no access yet (no success claim)", () => {
    const markup = render(null);
    expect(markup).toContain("has no Doco workspace yet");
    expect(markup).toContain("use your access yet");
    expect(markup).toContain("connect this Slack team to a Doco workspace");
    expect(markup).not.toContain("Slack can use your Doco access");
  });
});
