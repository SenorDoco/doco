import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type {
  GitHubIntegrationStatus,
  IntegrationStatus,
  SlackIntegrationStatus,
} from "~/lib/integration-status.server";
import { IntegrationStatusCard } from "../integration-status-card";

const NOW = new Date("2026-09-27T15:00:00.000Z");

function render(status: IntegrationStatus): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(IntegrationStatusCard, { handle: "torre-slack", status, now: NOW }),
    ),
  );
}

const github: GitHubIntegrationStatus = {
  integration: "github",
  latestAt: "2026-09-27T14:55:00.000Z",
  state: "importing",
  reposDone: 1,
  repos: 4,
};

const slack: SlackIntegrationStatus = {
  integration: "slack",
  teamName: "Torre",
  latestAt: "2026-09-27T14:58:00.000Z",
  state: "importing",
  backTo: "2025-03-10T00:00:00.000Z",
  since: "2020-09-27T00:00:00.000Z",
  channelsDone: 12,
  channels: 40,
  threadsPending: 130,
};

describe("IntegrationStatusCard", () => {
  it("shows GitHub's live updates and the old-PR import's progress", () => {
    const html = render(github);
    expect(html).toContain("GitHub integration");
    expect(html).toContain("Latest PR update 5m ago");
    expect(html).toContain("Importing old PRs: 1 of 4 repos");
    expect(html.match(/<a [^>]*>Manage<\/a>/)?.[0]).toContain(
      'href="/torre-slack/integrations/github"',
    );
  });

  it("says when every old PR is imported", () => {
    expect(render({ ...github, state: "done" })).toContain("All past PRs imported");
  });

  it("flags a stalled import", () => {
    expect(render({ ...github, state: "stalled" })).toContain(
      "Old-PR import stalled at 1 of 4 repos",
    );
  });

  it("shows Slack's newest message and how far back the history copy has got", () => {
    const html = render(slack);
    expect(html).toContain("Slack integration");
    expect(html).toContain("Newest message 2m ago");
    expect(html).toContain("Copying history: back to Mar 2025 of Sep 2020");
    expect(html).toContain("12 of 40 channels complete");
    expect(html).toContain("130 threads to fetch");
    expect(html).toContain('href="/torre-slack/integrations/slack"');
  });

  it("says when the history copy hasn't reached a date yet", () => {
    expect(render({ ...slack, backTo: null })).toContain("Copying history: starting");
  });

  it("flags a stalled history copy", () => {
    expect(render({ ...slack, state: "stalled" })).toContain("History copy stalled");
  });

  it("says when all history is copied", () => {
    expect(render({ ...slack, state: "done" })).toContain("All history copied back to Sep 2020");
  });

  it("says when nothing has been copied yet", () => {
    expect(render({ ...slack, latestAt: null })).toContain("No messages copied yet");
  });
});
