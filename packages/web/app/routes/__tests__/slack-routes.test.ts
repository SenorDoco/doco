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
  listSlackChannelConnections: vi.fn(),
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
  listSlackChannelConnections: mocks.listSlackChannelConnections,
  postSlackMessage: mocks.postSlackMessage,
}));

import { loader as callbackLoader } from "../integrations.slack.callback";
import { action as commandsAction } from "../integrations.slack.commands";
import { action as eventsAction } from "../integrations.slack.events";
import { loader as installLoader } from "../integrations.slack.install";

describe("Slack integration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSlackConfig.mockReturnValue({ signingSecret: "secret", configured: true });
    mocks.verifySlackRequest.mockResolvedValue(true);
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
    expect(response.headers.get("Location")).toBe(
      "/integrations?provider=slack&slack_installed=Acme",
    );
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
});
