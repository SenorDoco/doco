import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  buildSlackInstallUrl: vi.fn(),
  exchangeSlackOAuthCode: vi.fn(),
  getSlackConfig: vi.fn(),
  upsertSlackInstallation: vi.fn(),
  verifySlackState: vi.fn(),
  verifySlackRequest: vi.fn(),
  parseSlackCommandPayload: vi.fn(),
  buildSlackConnectCommandResponse: vi.fn(),
  buildSlackAppMentionResponse: vi.fn(),
  fetchSlackConversationContext: vi.fn(),
  getSlackBotUserId: vi.fn(),
  postSlackMessage: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/slack.server", () => ({
  buildSlackInstallUrl: mocks.buildSlackInstallUrl,
  exchangeSlackOAuthCode: mocks.exchangeSlackOAuthCode,
  getSlackConfig: mocks.getSlackConfig,
  upsertSlackInstallation: mocks.upsertSlackInstallation,
  verifySlackState: mocks.verifySlackState,
  verifySlackRequest: mocks.verifySlackRequest,
  parseSlackCommandPayload: mocks.parseSlackCommandPayload,
  buildSlackConnectCommandResponse: mocks.buildSlackConnectCommandResponse,
  buildSlackAppMentionResponse: mocks.buildSlackAppMentionResponse,
  fetchSlackConversationContext: mocks.fetchSlackConversationContext,
  getSlackBotUserId: mocks.getSlackBotUserId,
  postSlackMessage: mocks.postSlackMessage,
}));

import { loader as callbackLoader } from "../integrations.slack.callback";
import { action as commandsAction } from "../integrations.slack.commands";
import {
  action as eventsAction,
  isSlackRetryRequest,
  shouldFetchSlackConversationContext,
  shouldInspectSlackImplicitReplyEvent,
  shouldReplyToSlackEvent,
  shouldTreatSlackMessageAsImplicitReply,
} from "../integrations.slack.events";
import { loader as installLoader } from "../integrations.slack.install";

describe("Slack integration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSlackConfig.mockReturnValue({ signingSecret: "secret", configured: true });
    mocks.verifySlackRequest.mockResolvedValue(true);
    mocks.fetchSlackConversationContext.mockResolvedValue([]);
    mocks.getSlackBotUserId.mockResolvedValue("U999");
  });

  it("redirects a signed-in user to Slack OAuth installation", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.buildSlackInstallUrl.mockReturnValue("https://slack.com/oauth/v2/authorize?client_id=x");

    const response = (await installLoader({
      request: new Request("https://doco.test/integrations/slack/install"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://slack.com/oauth/v2/authorize?client_id=x",
    );
    expect(mocks.buildSlackInstallUrl).toHaveBeenCalledWith(
      expect.any(Request),
      "collaborator_alice",
    );
  });

  it("stores a Slack installation after OAuth callback", async () => {
    mocks.verifySlackState.mockReturnValue({ installerId: "collaborator_alice" });
    mocks.exchangeSlackOAuthCode.mockResolvedValue({
      ok: true,
      team: { id: "T123", name: "Acme" },
      access_token: "xoxb-token",
    });
    mocks.upsertSlackInstallation.mockResolvedValue(undefined);

    const response = (await callbackLoader({
      request: new Request(
        "https://doco.test/integrations/slack/callback?code=abc&state=signed-state",
      ),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/integrations/slack/setup?team_id=T123");
    expect(mocks.upsertSlackInstallation).toHaveBeenCalledWith({
      response: expect.objectContaining({ team: { id: "T123", name: "Acme" } }),
      installedByCollaboratorId: "collaborator_alice",
    });
  });

  it("returns a Doco configuration link for /doco connect", async () => {
    mocks.parseSlackCommandPayload.mockReturnValue({
      team_id: "T123",
      channel_id: "C123",
      channel_name: "product",
    });
    mocks.buildSlackConnectCommandResponse.mockReturnValue({
      response_type: "ephemeral",
      text: "Open Doco",
    });

    const response = await commandsAction({
      request: new Request("https://doco.test/integrations/slack/commands", {
        method: "POST",
        body: "team_id=T123&channel_id=C123",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: "Open Doco",
    });
  });

  it("answers Slack URL verification events", async () => {
    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({ type: "url_verification", challenge: "challenge-code" }),
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge-code" });
  });

  it("posts an app mention answer instead of repeating default permissions", async () => {
    mocks.buildSlackAppMentionResponse.mockResolvedValue("doco has 42 neurons.");
    mocks.fetchSlackConversationContext.mockResolvedValue([
      {
        text: "User A: how many neurons are in Doco?",
        ts: "1700000000.000050",
        userId: "U456",
        botId: null,
      },
    ]);

    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "app_mention",
            channel: "C123",
            channel_type: "channel",
            user: "U123",
            text: "How many neurons do we have, <@U999>?",
            ts: "1700000000.000100",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.buildSlackAppMentionResponse).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      chatUserId: "U123",
      messageText: "How many neurons do we have, <@U999>?",
      recentMessages: [
        {
          text: "User A: how many neurons are in Doco?",
          ts: "1700000000.000050",
          userId: "U456",
          botId: null,
        },
      ],
      origin: "https://doco.test",
    });
    expect(mocks.fetchSlackConversationContext).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      latestTs: "1700000000.000100",
    });
    expect(mocks.postSlackMessage).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      text: "doco has 42 neurons.",
    });
  });

  it("posts threaded app mention answers back into the Slack thread", async () => {
    mocks.buildSlackAppMentionResponse.mockResolvedValue("Francisco is there.");
    mocks.fetchSlackConversationContext.mockResolvedValue([
      {
        text: "Am I there?",
        ts: "1700000000.000050",
        userId: "U456",
        botId: null,
      },
    ]);

    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "app_mention",
            channel: "C123",
            channel_type: "channel",
            user: "U123",
            text: "Will you respond if I don't directly tag you? <@U999>",
            ts: "1700000001.000100",
            thread_ts: "1700000000.000000",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.fetchSlackConversationContext).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      latestTs: "1700000001.000100",
      threadTs: "1700000000.000000",
    });
    expect(mocks.buildSlackAppMentionResponse).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      chatUserId: "U123",
      messageText: "Will you respond if I don't directly tag you? <@U999>",
      recentMessages: [
        {
          text: "Am I there?",
          ts: "1700000000.000050",
          userId: "U456",
          botId: null,
        },
      ],
      origin: "https://doco.test",
    });
    expect(mocks.postSlackMessage).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      text: "Francisco is there.",
      threadTs: "1700000000.000000",
    });
  });

  it("posts a direct-message answer from Slack message.im events", async () => {
    mocks.buildSlackAppMentionResponse.mockResolvedValue(
      "Here’s what the accessible Docos explain:\n• Decision in doco/bpms: Slack works.",
    );
    mocks.fetchSlackConversationContext.mockResolvedValue([
      {
        text: "What do we have in Doco?",
        ts: "1700000000.000100",
        userId: "U123",
        botId: null,
      },
    ]);

    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "message",
            channel_type: "im",
            channel: "D123",
            user: "U123",
            text: "And what do they explain?",
            ts: "1700000001.000100",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.fetchSlackConversationContext).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "D123",
      latestTs: "1700000001.000100",
    });
    expect(mocks.buildSlackAppMentionResponse).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "D123",
      chatUserId: "U123",
      messageText: "And what do they explain?",
      recentMessages: [
        {
          text: "What do we have in Doco?",
          ts: "1700000000.000100",
          userId: "U123",
          botId: null,
        },
      ],
      origin: "https://doco.test",
    });
    expect(mocks.postSlackMessage).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "D123",
      text: "Here’s what the accessible Docos explain:\n• Decision in doco/bpms: Slack works.",
    });
  });

  it("acknowledges Slack retries without posting duplicate answers", async () => {
    const request = new Request("https://doco.test/integrations/slack/events", {
      method: "POST",
      headers: {
        "x-slack-retry-num": "1",
        "x-slack-retry-reason": "http_timeout",
      },
      body: JSON.stringify({
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          channel_type: "im",
          channel: "D123",
          user: "U123",
          text: "What do we document?",
          ts: "1700000001.000100",
        },
      }),
    });

    const response = await eventsAction({ request });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(isSlackRetryRequest(request)).toBe(true);
    expect(mocks.buildSlackAppMentionResponse).not.toHaveBeenCalled();
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it("posts an app-home message answer from Slack Messages tab events", async () => {
    mocks.buildSlackAppMentionResponse.mockResolvedValue("Hola. I can hear you from Slack.");

    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "message",
            channel_type: "app_home",
            channel: "D123",
            user: "U123",
            text: "Hi",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.buildSlackAppMentionResponse).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "D123",
      chatUserId: "U123",
      messageText: "Hi",
      recentMessages: [],
      origin: "https://doco.test",
    });
    expect(mocks.postSlackMessage).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "D123",
      text: "Hola. I can hear you from Slack.",
    });
  });

  it("ignores normal channel message events without an app mention", async () => {
    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "message",
            channel_type: "channel",
            channel: "C123",
            user: "U123",
            text: "What do we document?",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.buildSlackAppMentionResponse).not.toHaveBeenCalled();
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it("continues Slack thread replies under Señor Doco without requiring a mention", async () => {
    mocks.buildSlackAppMentionResponse.mockResolvedValue("Cleaner now.");
    mocks.fetchSlackConversationContext.mockResolvedValue([
      {
        text: "Here’s the org chart.",
        ts: "1700000000.000000",
        userId: "U999",
        botId: "B999",
      },
      {
        text: "not looking nice",
        ts: "1700000001.000100",
        userId: "U123",
        botId: null,
      },
    ]);

    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "message",
            channel_type: "channel",
            channel: "C123",
            user: "U123",
            text: "not looking nice",
            ts: "1700000001.000100",
            thread_ts: "1700000000.000000",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.fetchSlackConversationContext).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      latestTs: "1700000001.000100",
      threadTs: "1700000000.000000",
    });
    expect(mocks.getSlackBotUserId).toHaveBeenCalledWith("T123");
    expect(mocks.buildSlackAppMentionResponse).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      chatUserId: "U123",
      messageText: "not looking nice",
      recentMessages: [
        {
          text: "Here’s the org chart.",
          ts: "1700000000.000000",
          userId: "U999",
          botId: "B999",
        },
        {
          text: "not looking nice",
          ts: "1700000001.000100",
          userId: "U123",
          botId: null,
        },
      ],
      origin: "https://doco.test",
    });
    expect(mocks.postSlackMessage).toHaveBeenCalledWith({
      workspaceId: "T123",
      channelId: "C123",
      text: "Cleaner now.",
      threadTs: "1700000000.000000",
    });
  });

  it("ignores untagged thread replies when the thread parent is not Señor Doco", async () => {
    mocks.fetchSlackConversationContext.mockResolvedValue([
      {
        text: "A normal human thread.",
        ts: "1700000000.000000",
        userId: "U456",
        botId: null,
      },
    ]);

    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "message",
            channel_type: "channel",
            channel: "C123",
            user: "U123",
            text: "what about this?",
            ts: "1700000001.000100",
            thread_ts: "1700000000.000000",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.buildSlackAppMentionResponse).not.toHaveBeenCalled();
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it("ignores courtesy replies in Señor Doco threads", async () => {
    mocks.fetchSlackConversationContext.mockResolvedValue([
      {
        text: "Here’s the answer.",
        ts: "1700000000.000000",
        userId: "U999",
        botId: "B999",
      },
    ]);

    const response = await eventsAction({
      request: new Request("https://doco.test/integrations/slack/events", {
        method: "POST",
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T123",
          event: {
            type: "message",
            channel_type: "channel",
            channel: "C123",
            user: "U123",
            text: "thanks",
            ts: "1700000001.000100",
            thread_ts: "1700000000.000000",
          },
        }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.buildSlackAppMentionResponse).not.toHaveBeenCalled();
    expect(mocks.postSlackMessage).not.toHaveBeenCalled();
  });

  it("identifies Slack events that should receive replies", () => {
    expect(shouldReplyToSlackEvent({ type: "app_mention" })).toBe(true);
    expect(shouldReplyToSlackEvent({ type: "message", channel_type: "im" })).toBe(true);
    expect(shouldReplyToSlackEvent({ type: "message", channel_type: "app_home" })).toBe(true);
    expect(shouldReplyToSlackEvent({ type: "message", channel_type: "channel" })).toBe(false);
  });

  it("fetches recent Slack context only where the installed scopes support it", () => {
    expect(shouldFetchSlackConversationContext({ type: "message", channel_type: "im" })).toBe(true);
    expect(shouldFetchSlackConversationContext({ type: "message", channel_type: "app_home" })).toBe(
      true,
    );
    expect(
      shouldFetchSlackConversationContext({ type: "app_mention", channel_type: "channel" }),
    ).toBe(true);
    expect(
      shouldFetchSlackConversationContext({ type: "app_mention", channel_type: "group" }),
    ).toBe(true);
    expect(
      shouldFetchSlackConversationContext({
        type: "message",
        channel_type: "channel",
        ts: "2",
        thread_ts: "1",
      }),
    ).toBe(true);
    expect(shouldFetchSlackConversationContext({ type: "message", channel_type: "channel" })).toBe(
      false,
    );
  });

  it("identifies implicit Slack thread replies conservatively", () => {
    expect(
      shouldInspectSlackImplicitReplyEvent({
        type: "message",
        channel_type: "channel",
        ts: "2",
        thread_ts: "1",
      }),
    ).toBe(true);
    expect(
      shouldTreatSlackMessageAsImplicitReply(
        {
          type: "message",
          channel_type: "channel",
          text: "add line breaks",
          ts: "2",
          thread_ts: "1",
        },
        [{ text: "Answer", ts: "1", userId: "U999", botId: "B999" }],
        "U999",
      ),
    ).toBe(true);
    expect(
      shouldTreatSlackMessageAsImplicitReply(
        {
          type: "message",
          channel_type: "channel",
          text: "yes",
          ts: "2",
          thread_ts: "1",
        },
        [{ text: "Answer", ts: "1", userId: "U999", botId: "B999" }],
        "U999",
      ),
    ).toBe(true);
    expect(
      shouldTreatSlackMessageAsImplicitReply(
        {
          type: "message",
          channel_type: "channel",
          text: "thanks",
          ts: "2",
          thread_ts: "1",
        },
        [{ text: "Answer", ts: "1", userId: "U999", botId: "B999" }],
        "U999",
      ),
    ).toBe(false);
  });
});
