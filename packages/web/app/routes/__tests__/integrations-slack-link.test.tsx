import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

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
  it("scopes the promise to the team's one workspace (no account-wide claim)", () => {
    const markup = render("torre");
    expect(markup).toContain("in the torre workspace");
    expect(markup).toContain("only within the torre workspace");
    expect(markup).toContain("never any other workspace");
    // The old, misleading account-wide phrasing is gone.
    expect(markup).not.toContain("Slack can use your Doco access");
    expect(markup).not.toContain("Doco permissions for Slack requests");
    // The unbound "no workspace yet" screen was removed (teams bind at install).
    expect(markup).not.toContain("has no Doco workspace yet");
  });

  it("still reads sensibly if the handle is momentarily unavailable", () => {
    const markup = render(null);
    expect(markup).toContain("only within the workspace");
    expect(markup).not.toContain("has no Doco workspace yet");
  });
});
