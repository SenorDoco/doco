import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { SlackPerspectiveData, SlackReaderMessage } from "~/lib/slack-mirror-read.server";
import { SlackPerspective } from "../slack-perspective";

function message(overrides: Partial<SlackReaderMessage>): SlackReaderMessage {
  return {
    channelId: "C_ENG",
    channelName: "eng",
    ts: "1700000100.000100",
    threadTs: null,
    author: "Ana",
    avatarUrl: null,
    text: "hello",
    postedAt: "2023-11-14T22:15:00.000Z",
    files: [],
    permalink: "https://acme.slack.com/archives/C_ENG/p1700000100000100",
    replyCount: 0,
    replies: [],
    ...overrides,
  };
}

const base: SlackPerspectiveData = {
  teamDomain: "acme",
  channels: [
    { channelId: "C_ENG", name: "eng", archived: false, lastPostedAt: null },
    { channelId: "C_GEN", name: "general", archived: false, lastPostedAt: null },
  ],
  channelId: "C_ENG",
  query: "",
  moreChannels: false,
  channelLimit: 50,
  messages: [],
  olderBefore: null,
};

function render(data: SlackPerspectiveData, url = "/"): string {
  const Stub = createRoutesStub([
    { path: "/", Component: () => createElement(SlackPerspective, { data, handle: "acme-slack" }) },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [url] }));
}

describe("SlackPerspective", () => {
  it("points a Doco that doesn't mirror Slack at the setup page", () => {
    const html = render({ ...base, teamDomain: "", channels: [], channelId: null });
    expect(html).toContain('href="/acme-slack/integrations/slack"');
  });

  it("lists channels as links that keep the Slack perspective open", () => {
    const html = render(base);
    expect(html).toContain("perspective=slack&amp;slack_channel=C_GEN");
    expect(html).toContain("general");
  });

  it("offers Show more under the channel list when more channels exist", () => {
    expect(render(base)).not.toContain("Show more");

    const html = render({ ...base, moreChannels: true }, "/?perspective=slack&slack_channel=C_GEN");
    expect(html).toContain("Show more");
    expect(html).toContain(
      'href="/?perspective=slack&amp;slack_channel=C_GEN&amp;slack_channel_limit=100"',
    );
  });

  it("keeps a grown channel list while reading, paging and searching", () => {
    const html = render({
      ...base,
      channelLimit: 100,
      messages: [message({})],
      olderBefore: "1700000100.000100",
    });
    expect(html).toContain("slack_channel=C_GEN&amp;slack_channel_limit=100");
    expect(html).toContain("slack_before=1700000100.000100&amp;slack_channel_limit=100");
    expect(html).toContain('name="slack_channel_limit" value="100"');
  });

  it("shows a thread's replies, links to Slack, and file links", () => {
    const html = render({
      ...base,
      messages: [
        message({
          text: "we are hitting the connection limit",
          threadTs: "1700000100.000100",
          replyCount: 2,
          replies: [
            message({
              ts: "1700000200.000100",
              author: "Ben",
              text: "switching the pooler",
              files: [{ name: "pool.png", permalink: "https://acme.slack.com/files/F1" }],
            }),
          ],
        }),
      ],
    });

    expect(html).toContain("we are hitting the connection limit");
    expect(html).toContain("2 replies");
    expect(html).toContain("switching the pooler");
    expect(html).toContain('href="https://acme.slack.com/files/F1"');
    expect(html).toContain("1 more in Slack");
    expect(html).toContain('href="https://acme.slack.com/archives/C_ENG/p1700000100000100"');
  });

  it("offers older messages when there are more", () => {
    const html = render({ ...base, messages: [message({})], olderBefore: "1700000100.000100" });
    expect(html).toContain("slack_before=1700000100.000100");
  });

  it("labels search results with their channel", () => {
    const html = render({ ...base, channelId: null, query: "pooler", messages: [message({})] });
    expect(html).toContain("#eng");
    expect(html).toContain('value="pooler"');
  });
});
