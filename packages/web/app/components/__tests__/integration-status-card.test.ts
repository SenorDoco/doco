import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type {
  GitHubIntegrationStatus,
  IntegrationStatus,
  NotionIntegrationStatus,
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
  item: "pull request",
  items: "pull requests",
  latestAt: "2026-09-27T14:55:00.000Z",
  state: "importing",
  reposDone: 1,
  repos: 4,
  skipped: 0,
  refused: false,
  permission: "Pull requests",
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

const notion: NotionIntegrationStatus = {
  integration: "notion",
  workspaceName: "Torre",
  latestAt: "2026-09-27T14:57:00.000Z",
  state: "importing",
  needsReauth: false,
  pagesDone: 1240,
  pages: 5300,
  listingCapped: false,
};

describe("IntegrationStatusCard", () => {
  it("shows Notion's newest page edit and how many pages are copied", () => {
    const html = render(notion);
    expect(html).toContain("Notion integration");
    expect(html).toContain("Newest page edit 3m ago");
    expect(html).toContain("Copying pages: 1,240 of 5,300 pages");
    expect(html).toContain('href="/torre-slack/integrations/notion"');
  });

  it("says when Notion pages are still being discovered, stalled, done, or need a reconnect", () => {
    expect(render({ ...notion, pages: 0, pagesDone: 0, latestAt: null })).toContain(
      "Discovering the pages shared with Doco",
    );
    expect(render({ ...notion, latestAt: null })).toContain("No pages copied yet");
    expect(render({ ...notion, state: "stalled" })).toContain(
      "Page copy stalled at 1,240 of 5,300 pages",
    );
    expect(render({ ...notion, state: "done", pagesDone: 5300 })).toContain(
      "All 5,300 pages copied",
    );
    expect(render({ ...notion, state: "done", pages: 0, pagesDone: 0 })).toContain(
      "Nothing shared with Doco yet",
    );
    expect(render({ ...notion, state: "stalled", needsReauth: true })).toContain(
      "reconnect to resume",
    );
    expect(render({ ...notion, listingCapped: true })).toContain(
      "Copying pages: 1,240 of 5,300 pages (listing capped by Notion)",
    );
    expect(render({ ...notion, state: "done", pagesDone: 5300, listingCapped: true })).toContain(
      "All 5,300 pages copied (listing capped by Notion)",
    );
  });

  it("shows GitHub's live updates and the old items' import progress", () => {
    const html = render(github);
    expect(html).toContain("GitHub integration");
    expect(html).toContain("Latest pull request update 5m ago");
    expect(html).toContain("Importing pull requests: 1 of 4 repos");
    expect(html.match(/<a [^>]*>Manage<\/a>/)?.[0]).toContain(
      'href="/torre-slack/integrations/github"',
    );
  });

  it("says when every past item is imported", () => {
    expect(render({ ...github, state: "done" })).toContain("All pull requests imported");
  });

  it("never says everything was imported when GitHub refused repositories", () => {
    const files = { ...github, item: "file", items: "files", permission: "Contents" };
    const html = render({
      ...files,
      state: "done",
      repos: 14,
      reposDone: 14,
      skipped: 14,
      refused: true,
    });
    expect(html).not.toContain("All files imported");
    expect(html).toContain("14 of 14 repos skipped");
    expect(html).toContain(
      "GitHub hasn&#x27;t given Doco&#x27;s GitHub App access to their files yet. Accept the App&#x27;s request for Contents access in GitHub. The import runs again once it&#x27;s accepted.",
    );
    // Skipped for another reason: re-importing may bring them.
    expect(render({ ...files, state: "done", repos: 3, skipped: 1, refused: false })).toContain(
      "GitHub didn&#x27;t return them. Re-import to try again.",
    );
  });

  it("flags a stalled import", () => {
    expect(render({ ...github, state: "stalled" })).toContain(
      "Import of pull requests stalled at 1 of 4 repos",
    );
  });

  it("speaks of bugs for a GitHub bugs Doco", () => {
    const bugs = { ...github, item: "bug", items: "bugs" };
    expect(render(bugs)).toContain("Latest bug update 5m ago");
    expect(render({ ...bugs, latestAt: null })).toContain("No bugs copied yet");
  });

  it("shows Slack's newest message and how far back the history copy has got", () => {
    const html = render(slack);
    expect(html).toContain("Slack integration");
    expect(html).toContain("Newest message 2m ago");
    expect(html).toContain(
      "History copied back to Mar 2025 so far, going back to Sep 2020 · 12 of 40 channels complete · 130 threads to fetch",
    );
    expect(html).toContain('href="/torre-slack/integrations/slack"');
  });

  it("writes large Slack counts with thousands separators", () => {
    expect(render({ ...slack, channelsDone: 619, channels: 1966, threadsPending: 7091 })).toContain(
      "619 of 1,966 channels complete · 7,091 threads to fetch",
    );
  });

  it("names only the target date while the history copy hasn't reached one", () => {
    const html = render({ ...slack, backTo: null });
    expect(html).toContain("Copying history back to Sep 2020 · 12 of 40 channels complete");
    expect(html).not.toContain("starting");
  });

  it("flags a stalled history copy, with where it stopped", () => {
    expect(render({ ...slack, state: "stalled" })).toContain(
      "History copy stalled at Mar 2025 on its way back to Sep 2020",
    );
    expect(render({ ...slack, state: "stalled", backTo: null })).toContain(
      "History copy back to Sep 2020 stalled",
    );
  });

  it("says when all history is copied", () => {
    expect(render({ ...slack, state: "done" })).toContain("All history copied back to Sep 2020");
  });

  it("says when nothing has been copied yet", () => {
    expect(render({ ...slack, latestAt: null })).toContain("No messages copied yet");
  });

  it("says a Doco's source isn't connected, and leads to connecting it", () => {
    const html = render({ integration: "github", state: "unconnected" });
    expect(html).toContain("GitHub integration");
    expect(html).toContain("Not connected");
    expect(html).toContain("Nothing comes into this doco until it is.");
    expect(html).not.toContain("Live");
    expect(html.match(/<a [^>]*>Pick repositories<\/a>/)?.[0]).toContain(
      'href="/torre-slack/integrations/github"',
    );
    expect(render({ integration: "slack", state: "unconnected" })).toContain(">Connect Slack</a>");
    expect(render({ integration: "notion", state: "unconnected" })).toContain(
      ">Connect Notion</a>",
    );
  });
});
