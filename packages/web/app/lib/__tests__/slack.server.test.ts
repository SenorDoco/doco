import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SLACK_BOT_SCOPES,
  buildSlackConnectCommandResponse,
  cleanSlackMentionText,
  detectSlackAccessQuestion,
  detectSlackCountKind,
  detectSlackInventoryQuestion,
  formatSlackAccessResponse,
  formatSlackCountResponse,
  formatSlackDefaultResponse,
  formatSlackInventoryResponse,
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

  it("requests the scope Slack requires for direct-message events", () => {
    expect(SLACK_BOT_SCOPES).toContain("im:history");
  });

  it("cleans Slack app mentions out of message text", () => {
    expect(cleanSlackMentionText("Hola, <@U999>")).toBe("Hola,");
    expect(cleanSlackMentionText("<@U999> How many neurons do we have?")).toBe(
      "How many neurons do we have?",
    );
  });

  it("detects count questions from Slack mentions", () => {
    expect(detectSlackCountKind("How many neurons do we have?")).toBe("neurons");
    expect(detectSlackCountKind("How many nodes do we have?")).toBe("neurons");
    expect(detectSlackCountKind("how many docos do we have?")).toBe("docos");
    expect(detectSlackCountKind("count decisions")).toBe("decisions");
    expect(detectSlackCountKind("hola")).toBeNull();
  });

  it("detects inventory and access questions from Slack messages", () => {
    expect(detectSlackInventoryQuestion("what docos do we have?")).toBe(true);
    expect(detectSlackInventoryQuestion("What do we have in Doco?")).toBe(true);
    expect(detectSlackInventoryQuestion("how many docos do we have?")).toBe(false);
    expect(detectSlackAccessQuestion("Who are you?")).toBe(true);
    expect(detectSlackAccessQuestion("Who are you? What do you have access to?")).toBe(true);
    expect(detectSlackAccessQuestion("What do we have in Doco?")).toBe(false);
  });

  it("formats Slack access answers with the default role and limits", () => {
    expect(
      formatSlackAccessResponse([
        {
          channelId: "*",
          channelName: "workspace",
          targetLevel: "org",
          targetId: "organization_doco",
          targetLabel: "doco",
          role: "approver",
        },
      ]),
    ).toBe(
      "I’m Señor Doco, Doco’s Slack assistant. By default in this Slack workspace, I can use all doco's docos as approver. That shared default applies to everyone here. People can still link their own Doco account for higher personal access they already hold, but I never get more than their Doco permissions. Owner-only actions, like creating Docos or changing policies, still require that person to be an owner in Doco.",
    );
  });

  it("formats the default Slack fallback with the quick Doco check", () => {
    expect(
      formatSlackDefaultResponse(
        [
          {
            channelId: "*",
            channelName: "workspace",
            targetLevel: "org",
            targetId: "organization_doco",
            targetLabel: "doco",
            role: "approver",
          },
        ],
        "Do you doco?",
      ),
    ).toBe(
      "I’m here. By default, I can answer questions accessing all doco's docos. Try “what docos do we have?” for a quick check.",
    );
  });

  it("formats Slack inventory answers with qualified Doco labels and counts", () => {
    expect(
      formatSlackInventoryResponse([
        {
          connection: {
            channelId: "*",
            channelName: "workspace",
            targetLevel: "org",
            targetId: "organization_doco",
            targetLabel: "doco",
            role: "approver",
          },
          docoCount: 1,
          docoLabels: ["doco/bpms"],
          counts: {
            neurons: 7,
            docos: 1,
            decisions: 2,
            intents: 1,
            actions: 3,
            logs: 0,
            rules: 1,
            evals: 0,
            references: 0,
            ideas: 0,
            states: 0,
            principals: 0,
          },
        },
      ]),
    ).toBe(
      "all doco's docos as approver: 1 Doco (doco/bpms). It contains 7 neurons: 2 decisions, 1 intent, 3 actions, and 1 rule.",
    );
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
            docoLabels: ["doco/bpms", "doco/product", "doco/team"],
            counts: {
              neurons: 42,
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
        "neurons",
      ),
    ).toBe("doco has 42 neurons across 3 Docos.");
  });
});
