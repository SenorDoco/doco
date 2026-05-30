import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../internal-fetch.server", () => ({
  internalFetch: vi.fn(),
}));

import { internalFetch } from "../internal-fetch.server";
import {
  SLACK_BOT_SCOPES,
  buildSlackConnectCommandResponse,
  buildSlackDocoAnswerQuery,
  buildSlackLlmUserPrompt,
  cleanSlackMentionText,
  detectSlackDocoOverviewQuestion,
  detectSlackRepairMessage,
  formatSlackDefaultResponse,
  formatSlackDocoAnswerResponse,
  generateSlackDocoLlmAnswer,
  parseSlackCommandPayload,
  runSlackDocoApiTool,
  signSlackPersonalAuthorizationState,
  signSlackState,
  slackConnectUrl,
  slackLlmSystemPrompt,
  verifySlackPersonalAuthorizationState,
  verifySlackRequestSignature,
  verifySlackState,
} from "../slack.server";

describe("slack.server", () => {
  it("signs and verifies Slack OAuth state", () => {
    const state = {
      installerId: "user_alice",
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
      text: "Connect your Doco account to Slack, or manage Señor Doco's shared workspace defaults.",
    });
  });

  it("includes a private personal authorization button in /doco connect", () => {
    const originalSecret = process.env.SLACK_SIGNING_SECRET;
    process.env.SLACK_SIGNING_SECRET = "secret";
    try {
      const payload = parseSlackCommandPayload(
        "team_id=T123&team_domain=acme&channel_id=C123&channel_name=product&user_id=U123&text=connect",
      );
      const request = new Request("https://doco.test/integrations/slack/commands", {
        method: "POST",
      });

      const response = buildSlackConnectCommandResponse(request, payload);
      const buttons = response.blocks[1]?.elements ?? [];

      expect(JSON.stringify(buttons)).toContain("Authorize my Doco account");
      expect(JSON.stringify(buttons)).toContain("/integrations/slack/link?state=");
      expect(JSON.stringify(buttons)).toContain("Manage workspace defaults");
    } finally {
      if (originalSecret === undefined) {
        process.env.SLACK_SIGNING_SECRET = undefined;
      } else {
        process.env.SLACK_SIGNING_SECRET = originalSecret;
      }
    }
  });

  it("signs and verifies Slack personal authorization state", () => {
    const state = {
      workspaceId: "T123",
      chatUserId: "U123",
      nonce: "nonce",
      issuedAt: 1_000,
    };
    const encoded = signSlackPersonalAuthorizationState(state, "secret");

    expect(verifySlackPersonalAuthorizationState(encoded, "secret", 1_500)).toEqual(state);
    expect(() => verifySlackPersonalAuthorizationState(encoded, "wrong-secret", 1_500)).toThrow(
      "Invalid Slack personal authorization state signature.",
    );
    expect(() => verifySlackPersonalAuthorizationState(encoded, "secret", 16 * 60 * 1000)).toThrow(
      "Expired Slack personal authorization state.",
    );
  });

  it("requests the scopes Slack requires for direct-message and channel context", () => {
    expect(SLACK_BOT_SCOPES).toContain("channels:history");
    expect(SLACK_BOT_SCOPES).toContain("groups:history");
    expect(SLACK_BOT_SCOPES).toContain("im:history");
    expect(SLACK_BOT_SCOPES).toContain("mpim:history");
  });

  it("cleans Slack app mentions out of message text", () => {
    expect(cleanSlackMentionText("Hola, <@U999>")).toBe("Hola,");
    expect(cleanSlackMentionText("<@U999> How many neurons do we have?")).toBe(
      "How many neurons do we have?",
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

  it("routes Slack access, inventory, and count questions into the LLM query path", () => {
    expect(buildSlackDocoAnswerQuery("Who are you? What do you have access to?")).toMatchObject({
      questionText: "Who are you? What do you have access to?",
    });
    expect(buildSlackDocoAnswerQuery("What docos do we have?")).toMatchObject({
      questionText: "What docos do we have?",
    });
    expect(buildSlackDocoAnswerQuery("How many neurons does bpm26o have?")).toMatchObject({
      questionText: "How many neurons does bpm26o have?",
      overview: false,
    });
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

  it("treats Slack formatting complaints as repair messages", () => {
    const messages = [
      {
        text: "Show the org chart",
        ts: "123.100",
        userId: "U123",
        botId: null,
      },
      {
        text: "Alexander ├── Cata | └── Diana",
        ts: "123.200",
        userId: null,
        botId: "B123",
      },
    ];
    const query = buildSlackDocoAnswerQuery("not looking nice", messages);
    const lineBreakQuery = buildSlackDocoAnswerQuery("add line breaks", messages);

    expect(detectSlackRepairMessage("not looking nice")).toBe(true);
    expect(detectSlackRepairMessage("this formatting is messy")).toBe(true);
    expect(detectSlackRepairMessage("add line breaks")).toBe(true);
    expect(detectSlackRepairMessage("format it as bullets")).toBe(true);
    expect(query).toMatchObject({
      questionText: "Show the org chart",
      overview: true,
      repair: true,
    });
    expect(query?.text).toContain("Alexander");
    expect(lineBreakQuery).toMatchObject({
      questionText: "Show the org chart",
      repairText: "add line breaks",
      overview: true,
      repair: true,
    });
    expect(lineBreakQuery?.text).toContain("add line breaks");

    const repairPrompt = buildSlackLlmUserPrompt({
      questionText: lineBreakQuery?.questionText ?? "",
      repairText: lineBreakQuery?.repairText,
      overview: true,
      repair: true,
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
      recentMessages: messages,
      hits: [],
    });
    expect(repairPrompt).toContain("Current Slack message: Show the org chart");
    expect(repairPrompt).toContain("Repair requested: add line breaks");
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
      repairText: null,
    });

    expect(prompt).toContain("Doco access available in this Slack request");
    expect(prompt).not.toContain("Repair requested:");
    expect(prompt).toContain("all doco's docos as reader via shared default");
    expect(prompt).toContain("Personal Doco authorization for this Slack user");
    expect(prompt).toContain("User: What do the docos we have explain?");
    expect(prompt).toContain("Intent in doco/doco-bpms: Doco core work loop");
  });

  it("uses the shared Señor Doco persona with Slack-only limits", () => {
    const prompt = slackLlmSystemPrompt();

    expect(prompt).toContain("You are Señor Doco");
    expect(prompt).toContain('policies" never "constitution');
    expect(prompt).toContain("Principal vs principle vs user");
    expect(prompt).toContain("Voice — dry, cerebral wit");
    expect(prompt).toContain("Slack can use doco_api for reads authorized");
    expect(prompt).toContain("Slack can use POST/PATCH/DELETE doco_api calls");
    expect(prompt).toContain("run /doco connect and authorize their own Doco account for Slack");
    expect(prompt).toContain("Do not mention going to the website as a workaround");
    expect(prompt).toContain("try the appropriate doco_api write");
    expect(prompt).toContain("paste every returned footer_lines entry verbatim");
    expect(prompt).toContain("asks for line breaks");
    expect(prompt).toContain("For line-break repair requests");
    expect(prompt).toContain("treat it as a formatting repair");
    expect(prompt).toContain("Do not mix bold Markdown with ASCII tree glyphs");
    expect(prompt).toContain("owner for creating Docos or changing policies");
    expect(prompt).toContain("GET /api/v1/docos.json");
    expect(prompt).toContain("GET /<handle>/api/audit.json");
    expect(prompt).toContain("total_count");
    expect(prompt).toContain("average_seconds_per_event");
    expect(prompt).toContain("GET /<handle>/api/perspectives.json");
    expect(prompt).toContain("GET /<handle>/api/authoring-contract.json");
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

  it("summarizes from collected tool results instead of posting pre-tool progress at the limit", async () => {
    const createMessage = vi.fn();
    for (let i = 0; i < 6; i += 1) {
      createMessage.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me find the very first event." },
          {
            type: "tool_use",
            id: `toolu_${i}`,
            name: "doco_api",
            input: { method: "GET", path: `/bpm26o/api/audit.json?before=${i}` },
          },
        ],
        stop_reason: "tool_use",
      });
    }
    createMessage.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "I found 300 audit events. The import took 90 seconds, about 0.3 seconds per event.",
        },
      ],
      stop_reason: "end_turn",
    });
    const runTool = vi.fn(async (block) => ({
      result: {
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: JSON.stringify({
          status: 200,
          ok: true,
          body: { total_count: 300, duration_seconds: 90, average_seconds_per_event: 0.3 },
        }),
      },
      preview: "GET /bpm26o/api/audit.json -> 200",
      ok: true,
    }));

    const answer = await generateSlackDocoLlmAnswer(
      {
        questionText: "How many events did bpm26o import?",
        overview: false,
        repair: false,
        connections: [
          {
            channelId: "*",
            channelName: "workspace",
            targetLevel: "doco",
            targetId: "doco_01",
            targetLabel: "test/bpm26o",
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

    expect(answer).toBe(
      "I found 300 audit events. The import took 90 seconds, about 0.3 seconds per event.",
    );
    expect(answer).not.toContain("Let me find");
    expect(runTool).toHaveBeenCalledTimes(6);
    expect(createMessage).toHaveBeenCalledTimes(7);
    const finalCall = createMessage.mock.calls.at(-1)?.[0];
    expect(finalCall?.tools).toBeUndefined();
    expect(JSON.stringify(finalCall?.messages)).toContain("tool-turn limit");
  });

  it("preserves Slack LLM line breaks and repairs inline bullets", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "This workspace has one doco: - 7 decisions - 1 intent",
        },
      ],
      stop_reason: "end_turn",
    });

    const answer = await generateSlackDocoLlmAnswer(
      {
        questionText: "What docos do we have?",
        repairText: "add line breaks",
        overview: true,
        repair: true,
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
      },
    );

    expect(answer).toBe("This workspace has one doco:\n- 7 decisions\n- 1 intent");
  });

  it("converts Markdown links in Slack LLM answers to Slack links", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Open [Francisco](https://doco.test/torre-org-chart/principal/principal_01).",
        },
      ],
      stop_reason: "end_turn",
    });

    const answer = await generateSlackDocoLlmAnswer(
      {
        questionText: "Show me Francisco",
        overview: false,
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
      },
    );

    expect(answer).toBe(
      "Open <https://doco.test/torre-org-chart/principal/principal_01|Francisco>.",
    );
  });

  it("rewrites a bold-wrapped bare URL into a clean Slack link", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Here you go: **https://doco.com/torre/glossary**",
        },
      ],
      stop_reason: "end_turn",
    });

    const answer = await generateSlackDocoLlmAnswer(
      {
        questionText: "What's the link to the glossary?",
        overview: false,
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
      },
    );

    expect(answer).toBe("Here you go: <https://doco.com/torre/glossary>");
  });

  it("collapses CommonMark double-asterisk bold to Slack single-asterisk bold", async () => {
    const createMessage = vi.fn().mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "**Torrex** is a full-time member of the team.",
        },
      ],
      stop_reason: "end_turn",
    });

    const answer = await generateSlackDocoLlmAnswer(
      {
        questionText: "What is a Torrex?",
        overview: false,
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
      },
    );

    expect(answer).toBe("*Torrex* is a full-time member of the team.");
  });

  it("preserves doco_api footer lines with Slack-renderable links", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "toolu_write",
            name: "doco_api",
            input: {
              method: "POST",
              path: "/torre-org-chart/api/principals.json",
              body: { name: "Francisco Laso" },
            },
          },
        ],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: "[🔮 Doco] 👤 Principal added: Francisco Laso\n\nFrancisco is now live.",
          },
        ],
        stop_reason: "end_turn",
      });
    const runTool = vi.fn(async (block) => ({
      result: {
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: JSON.stringify({
          status: 200,
          ok: true,
          body: {
            id: "principal_01",
            footer_lines: [
              "[🔮 Doco] 👤 Principal added: [Francisco Laso](https://doco.test/torre-org-chart/principal/principal_01)",
            ],
          },
        }),
      },
      preview: "POST /torre-org-chart/api/principals.json -> 200",
      ok: true,
    }));

    const answer = await generateSlackDocoLlmAnswer(
      {
        questionText: "Add Francisco to the org chart",
        overview: false,
        repair: false,
        connections: [
          {
            channelId: "*",
            channelName: "workspace",
            targetLevel: "doco",
            targetId: "doco_01",
            targetLabel: "torre/torre-org-chart",
            role: "author",
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

    expect(answer).toBe(
      "[🔮 Doco] 👤 Principal added: <https://doco.test/torre-org-chart/principal/principal_01|Francisco Laso>\n\nFrancisco is now live.",
    );
  });

  it("asks for personal Doco authorization when Slack doco_api writes are blocked", async () => {
    vi.mocked(internalFetch).mockReset();
    const result = await runSlackDocoApiTool(
      {
        type: "tool_use",
        id: "toolu_write",
        name: "doco_api",
        input: {
          method: "POST",
          path: "/api/v1/docos.json",
          body: { name: "use-slack" },
        },
      } as never,
      {
        questionText: "Create a doco for me",
        overview: false,
        repair: false,
        personalAuthorizationCommand: "/doco connect",
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
    );

    const content = String(result.result.content);
    expect(result.ok).toBe(false);
    expect(content).toContain("run /doco connect and authorize their own Doco account for Slack");
    expect(content).toContain("needs_personal_doco_authorization");
  });

  it("runs Slack doco_api writes as the linked Doco user", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(
      Response.json({
        ok: true,
        id: "principal_01",
        footer_lines: ["[🔮 Doco] 👤 Principal added: [Francisco](https://doco.test/x)"],
      }),
    );

    const result = await runSlackDocoApiTool(
      {
        type: "tool_use",
        id: "toolu_write",
        name: "doco_api",
        input: {
          method: "POST",
          path: "/torre-org-chart/api/principals.json",
          body: { name: "Francisco Laso", body_md: "Algorithms Engineer" },
        },
      } as never,
      {
        questionText: "Add Francisco to the org chart",
        overview: false,
        repair: false,
        origin: "https://doco.test",
        personalAuthorizationCommand: "/doco connect",
        personalActors: [{ userId: "user_01ABC", username: "alex" }],
        connections: [
          {
            channelId: "*",
            channelName: "personal",
            targetLevel: "doco",
            targetId: "doco_01",
            targetLabel: "torre/torre-org-chart",
            role: "author",
            source: "personal",
            userId: "user_01ABC",
            userUsername: "alex",
          },
        ],
        recentMessages: [],
        hits: [],
      },
    );

    expect(result.ok).toBe(true);
    expect(vi.mocked(internalFetch)).toHaveBeenCalledWith({
      method: "POST",
      path: "/torre-org-chart/api/principals.json",
      origin: "https://doco.test",
      cookieHeader: "doco_session=user_01ABC",
      body: { name: "Francisco Laso", body_md: "Algorithms Engineer" },
      userAgent: "Doco-Slack-Assistant/1",
    });
    expect(String(result.result.content)).toContain("Principal added");
  });
});
