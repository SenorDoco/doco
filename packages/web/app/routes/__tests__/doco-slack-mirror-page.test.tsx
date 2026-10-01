// The Slack page of a mirroring Doco says how far back the history copy goes
// and how far each channel has got, in months a person reads at a glance.
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { SlackMirrorStatus } from "~/lib/slack-mirror-setup.server";

const mocks = vi.hoisted(() => ({ loaderData: {} as Record<string, unknown> }));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    Form: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
    useLoaderData: () => mocks.loaderData,
    useActionData: () => undefined,
  };
});
vi.mock("@doco/db", () => ({ getWorkspaceRole: vi.fn() }));
vi.mock("~/lib/doco-access.server", () => ({ loadDocoRouteForRead: vi.fn() }));
vi.mock("~/lib/slack.server", () => ({ buildSlackInstallUrl: vi.fn(), getSlackConfig: vi.fn() }));
vi.mock("~/lib/slack-mirror-setup.server", () => ({
  MIRROR_HISTORY_YEARS: 6,
  loadSlackMirrorStatus: vi.fn(),
  setSlackMirrorChannelExcluded: vi.fn(),
  stopSlackMirror: vi.fn(),
}));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));

import DocoSlackMirrorPage from "../$docoHandle.integrations.slack";

const channel = { excluded: false, joined: true, archived: false, messages: 1200 };

const status: SlackMirrorStatus = {
  teamName: "Torre",
  teamDomain: "torre",
  consentedAt: "2026-09-27T00:00:00.000Z",
  historySince: "2020-09-27T00:00:00.000Z",
  messageCount: 3600,
  threadsPending: 0,
  channels: [
    {
      ...channel,
      channelId: "C1",
      name: "general",
      historyBackTo: "2025-12-10T00:00:00.000Z",
      historyDone: false,
    },
    { ...channel, channelId: "C2", name: "random", historyBackTo: null, historyDone: false },
    {
      ...channel,
      channelId: "C3",
      name: "team",
      historyBackTo: "2020-09-27T00:00:00.000Z",
      historyDone: true,
    },
  ],
};

function render(): string {
  mocks.loaderData = {
    me: { id: "user_alex" },
    handle: "torre-slack",
    ownerSlug: "torre",
    visibility: "private",
    canManage: false,
    slackConfigured: true,
    historyYears: 6,
    status,
  };
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DocoSlackMirrorPage)),
  );
}

describe("/:docoHandle/integrations/slack", () => {
  it("names the month the history copy goes back to", () => {
    expect(render()).toContain("copying history back to Sep 2020");
  });

  it("says how far back each channel is copied so far", () => {
    const html = render();
    expect(html).toContain("copied back to Dec 2025 so far");
    expect(html).not.toContain("2025-12-10");
    expect(html).toContain("history queued");
    expect(html).toContain("history complete");
  });
});
