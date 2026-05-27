import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SLACK_BOT_SCOPES,
  buildSlackConnectCommandResponse,
  buildSlackDocoAnswerQuery,
  buildSlackLlmUserPrompt,
  cleanSlackMentionText,
  detectSlackAccessQuestion,
  detectSlackCountKind,
  detectSlackDocoOverviewQuestion,
  detectSlackInventoryQuestion,
  detectSlackRepairMessage,
  formatSlackAccessResponse,
  formatSlackCountResponse,
  formatSlackDefaultResponse,
  formatSlackDocoAnswerResponse,
  formatSlackInventoryResponse,
  generateSlackDocoLlmAnswer,
  parseSlackCommandPayload,
  signSlackState,
  slackConnectUrl,
  slackLlmSystemPrompt,
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
    expect(detectSlackCountKind("What do the docos we have explain?")).toBeNull();
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

  it("builds a Doco overview query for vague Slack follow-ups", () => {
    const query = buildSlackDocoAnswerQuery("And what do they explain?", [
      {
        text: "all doco's docos as reader: 1 Doco (doco/doco-bpms). It contains 94 neurons.",
        ts: "123.456",
        userId: null,
        botId: "B123",
      },
    ]);

    expect(query).toMatchObject({
      overview: true,
    });
    expect(query?.text).toContain("what do they explain");
    expect(query?.text).toContain("94 neurons");
    expect(detectSlackDocoOverviewQuestion("What do we document?")).toBe(true);
    expect(detectSlackDocoOverviewQuestion("What do the docos we have explain?")).toBe(true);
  });

  it("turns Slack repair messages into the prior unanswered question", () => {
    const query = buildSlackDocoAnswerQuery("You didn't answer my question", [
      {
        text: "What do the docos we have explain?",
        ts: "123.100",
        userId: "U123",
        botId: null,
      },
      {
        text: "doco has 1 Doco available by default.",
        ts: "123.200",
        userId: null,
        botId: "B123",
      },
    ]);

    expect(detectSlackRepairMessage("You didn't answer my question")).toBe(true);
    expect(query).toMatchObject({
      questionText: "What do the docos we have explain?",
      overview: true,
      repair: true,
    });
    expect(query?.text).toContain("You didn't answer my question");
  });

  it("builds an LLM prompt with Slack context and Doco excerpts", () => {
    const prompt = buildSlackLlmUserPrompt({
      questionText: "What do the docos we have explain?",
      overview: true,
      repair: false,
      connections: [
        {
          channelId: "*",
          channelName: "workspace",
          targetLevel: "org",
          targetId: "organization_doco",
          targetLabel: "doco",
          role: "reader",
        },
      ],
      recentMessages: [
        {
          text: "What do the docos we have explain?",
          ts: "123.100",
          userId: "U123",
          botId: null,
        },
      ],
      hits: [
        {
          entityId: "intent_01",
          docoLabel: "doco/doco-bpms",
          neuronType: "intent",
          summary: "Doco core work loop",
          body: "Doco captures software project memory as typed neurons.",
          rank: 1,
        },
      ],
    });

    expect(prompt).toContain("Default Doco access");
    expect(prompt).toContain("all doco's docos as reader");
    expect(prompt).toContain("User: What do the docos we have explain?");
    expect(prompt).toContain("Intent in doco/doco-bpms: Doco core work loop");
  });

  it("uses the shared Señor Doco persona with Slack-only limits", () => {
    const prompt = slackLlmSystemPrompt();

    expect(prompt).toContain("You are Señor Doco");
    expect(prompt).toContain('policies" never "constitution');
    expect(prompt).toContain("Principal vs principle vs collaborator");
    expect(prompt).toContain("Voice — dry, cerebral wit");
    expect(prompt).toContain("Slack can use doco_api for read-only Doco endpoints");
    expect(prompt).toContain("GET /api/v1/docos.json");
    expect(prompt).toContain("Keep the answer under 900 characters");
  });

  it("formats Doco answer hits instead of the default permission prompt", () => {
    expect(
      formatSlackDocoAnswerResponse(
        [
          {
            entityId: "decision_01",
            docoLabel: "doco/doco-bpms",
            neuronType: "decision",
            summary: "Slack follow-up questions should search Doco content.",
            body: null,
            rank: 1,
          },
          {
            entityId: "rule_01",
            docoLabel: "doco/doco-bpms",
            neuronType: "rule",
            summary: "Default Slack access is shared, while linked users can use higher access.",
            body: null,
            rank: 0.8,
          },
        ],
        { overview: true },
      ),
    ).toBe(
      [
        "Here’s what the accessible Docos explain:",
        "• Decision in doco/doco-bpms: Slack follow-up questions should search Doco content.",
        "• Rule in doco/doco-bpms: Default Slack access is shared, while linked users can use higher access.",
      ].join("\n"),
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

  it("lets the Slack LLM call doco_api before answering", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "doco_api",
            input: { method: "GET", path: "/api/v1/docos.json" },
          },
        ],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "I can see doco/doco-bpms." }],
        stop_reason: "end_turn",
      });
    const runTool = vi.fn(async (block) => ({
      result: {
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: JSON.stringify({
          status: 200,
          ok: true,
          body: { docos: [{ qualified_handle: "doco/doco-bpms" }] },
        }),
      },
      preview: "GET /api/v1/docos.json -> 200",
      ok: true,
    }));

    const answer = await generateSlackDocoLlmAnswer(
      {
        questionText: "What docos do we have?",
        overview: true,
        repair: false,
        connections: [
          {
            channelId: "*",
            channelName: "workspace",
            targetLevel: "org",
            targetId: "organization_doco",
            targetLabel: "doco",
            role: "reader",
          },
        ],
        recentMessages: [],
        hits: [],
      },
      {
        createMessage: createMessage as never,
        runTool,
      },
    );

    expect(answer).toBe("I can see doco/doco-bpms.");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledTimes(2);
    const secondCall = createMessage.mock.calls[1]?.[0];
    expect(secondCall?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "doco_api" })]),
    );
    expect(secondCall?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_1" })],
        }),
      ]),
    );
  });
});
