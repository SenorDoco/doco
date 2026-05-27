import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSlackConnectCommandResponse,
  cleanSlackMentionText,
  detectSlackCountKind,
  formatSlackCountResponse,
  parseSlackCommandPayload,
  signSlackState,
  slackConnectUrl,
  verifySlackRequestSignature,
  verifySlackState,
} from "../slack.server";

describe("slack.server", () => {
  it("signs and verifies Slack OAuth state", () => {
    const state = {
      installerId: "collaborator_alice",
      nonce: "nonce",
      issuedAt: 1_000,
    };
    const encoded = signSlackState(state, "secret");

    expect(verifySlackState(encoded, "secret", 1_500)).toEqual(state);
    expect(() => verifySlackState(encoded, "wrong-secret", 1_500)).toThrow(
      "Invalid Slack OAuth state signature.",
    );
    expect(() => verifySlackState(encoded, "secret", 16 * 60 * 1000)).toThrow(
      "Expired Slack OAuth state.",
    );
  });

  it("verifies Slack request signatures against the raw body", () => {
    const rawBody = "team_id=T123&channel_id=C123&text=connect";
    const timestamp = "1700000000";
    const secret = "signing-secret";
    const signature = `v0=${createHmac("sha256", secret)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex")}`;

    expect(
      verifySlackRequestSignature({
        rawBody,
        timestamp,
        signature,
        signingSecret: secret,
        nowSeconds: 1_700_000_000,
      }),
    ).toBe(true);
    expect(
      verifySlackRequestSignature({
        rawBody: `${rawBody}&tampered=1`,
        timestamp,
        signature,
        signingSecret: secret,
        nowSeconds: 1_700_000_000,
      }),
    ).toBe(false);
    expect(
      verifySlackRequestSignature({
        rawBody,
        timestamp,
        signature,
        signingSecret: secret,
        nowSeconds: 1_700_001_000,
      }),
    ).toBe(false);
  });

  it("builds a web configuration URL from a slash command payload", () => {
    const rawBody =
      "team_id=T123&team_domain=acme&channel_id=C123&channel_name=product&user_id=U123&text=connect";
    const payload = parseSlackCommandPayload(rawBody);
    const request = new Request("https://doco.test/integrations/slack/commands", {
      method: "POST",
    });

    expect(slackConnectUrl(request, payload)).toBe(
      "https://doco.test/integrations/slack/setup?team_id=T123&team_name=acme",
    );
    expect(buildSlackConnectCommandResponse(request, payload)).toMatchObject({
      response_type: "ephemeral",
      text: "Open Doco to choose Señor Doco's default permissions for this Slack workspace.",
    });
  });

  it("cleans Slack app mentions out of message text", () => {
    expect(cleanSlackMentionText("Hola, <@U999>")).toBe("Hola,");
    expect(cleanSlackMentionText("<@U999> How many nodes do we have?")).toBe(
      "How many nodes do we have?",
    );
  });

  it("detects count questions from Slack mentions", () => {
    expect(detectSlackCountKind("How many nodes do we have?")).toBe("nodes");
    expect(detectSlackCountKind("count decisions")).toBe("decisions");
    expect(detectSlackCountKind("hola")).toBeNull();
  });

  it("formats Slack count answers with qualified Doco labels", () => {
    expect(
      formatSlackCountResponse(
        [
          {
            connection: {
              channelId: "*",
              channelName: "workspace",
              targetLevel: "org",
              targetId: "organization_doco",
              targetLabel: "doco",
              role: "approver",
            },
            docoCount: 3,
            counts: {
              nodes: 42,
              docos: 3,
              decisions: 4,
              intents: 5,
              actions: 6,
              logs: 7,
              rules: 8,
              evals: 2,
              references: 3,
              ideas: 1,
              states: 4,
              principals: 2,
            },
          },
        ],
        "nodes",
      ),
    ).toBe("doco/* has 42 nodes across 3 Docos.");
  });
});
