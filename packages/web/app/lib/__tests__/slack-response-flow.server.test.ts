import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
    intent: { table: "intents", body: false, typeNamedColumn: "intent" },
  },
  DOCO_NODE_TABLE_SPECS: [
    { table: "decisions", entityType: "decision", body: false },
    { table: "intents", entityType: "intent", body: false },
  ],
  getUserById: vi.fn(),
  getEntity: vi.fn(),
  listDocoUsers: vi.fn(),
  listEntitiesByDoco: vi.fn(),
  withClient: mocks.withClient,
}));

import {
  buildSlackAppMentionResponse,
  clearSlackIntegrationContextCache,
  getSlackBotIdentity,
} from "../slack.server";

describe("Slack response flow", () => {
  beforeEach(() => {
    clearSlackIntegrationContextCache();
    mocks.query.mockReset();
    mocks.withClient.mockReset();
  });

  it("still asks the LLM when the preliminary Doco search has no excerpts", async () => {
    mocks.withClient.mockImplementation(async (callback) => callback({ query: mocks.query }));
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            channel_id: "*",
            channel_name: "workspace",
            target_level: "org",
            target_id: "organization_doco",
            role: "reader",
            target_label: "doco",
            doco_handle: null,
            org_handle: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const answerGenerator = vi.fn(async () => "LLM answer from the Slack tool loop.");

    const answer = await buildSlackAppMentionResponse({
      workspaceId: "T123",
      channelId: "C123",
      messageText: "What does it explain?",
      recentMessages: [],
      answerGenerator,
    });

    expect(answer).toBe("LLM answer from the Slack tool loop.");
    expect(answerGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        hits: [],
        connections: [expect.objectContaining({ targetLabel: "doco", role: "reader" })],
      }),
    );
  });

  it("reuses the resolved Slack integration context across turns", async () => {
    mocks.withClient.mockImplementation(async (callback) => callback({ query: mocks.query }));
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            channel_id: "*",
            channel_name: "workspace",
            target_level: "org",
            target_id: "organization_doco",
            role: "reader",
            target_label: "doco",
            doco_handle: null,
            org_handle: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const answerGenerator = vi.fn(async () => "cached context answer");

    const first = await buildSlackAppMentionResponse({
      workspaceId: "T-cache",
      channelId: "C-cache",
      chatUserId: "U-cache",
      messageText: "hello",
      recentMessages: [],
      answerGenerator,
    });
    const second = await buildSlackAppMentionResponse({
      workspaceId: "T-cache",
      channelId: "C-cache",
      chatUserId: "U-cache",
      messageText: "hi",
      recentMessages: [],
      answerGenerator,
    });

    expect(first).toBe("cached context answer");
    expect(second).toBe("cached context answer");
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(answerGenerator).toHaveBeenCalledTimes(2);
    expect(answerGenerator).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connections: expect.arrayContaining([
          expect.objectContaining({ targetLabel: "doco", role: "reader" }),
        ]),
        personalActors: [],
        integrationContextCache: expect.objectContaining({ status: "hit" }),
      }),
    );
  });
});

describe("getSlackBotIdentity", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.withClient.mockReset();
    mocks.withClient.mockImplementation(async (callback) => callback({ query: mocks.query }));
    vi.unstubAllGlobals();
  });

  it("returns the stored identity without calling Slack when both ids are present", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ bot_user_id: "U1", data: { bot_id: "B1" } }] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const identity = await getSlackBotIdentity("T1");

    expect(identity).toEqual({ userId: "U1", botId: "B1" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("resolves a missing bot id via auth.test and backfills the install row", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ bot_user_id: "U1", data: null }] })
      .mockResolvedValueOnce({ rows: [{ bot_access_token: "xoxb-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, user_id: "U1", bot_id: "B1" }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const identity = await getSlackBotIdentity("T1");

    expect(identity).toEqual({ userId: "U1", botId: "B1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("degrades to the stored user id when auth.test is unavailable", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ bot_user_id: "U1", data: null }] })
      .mockResolvedValueOnce({ rows: [{ bot_access_token: "xoxb-1" }] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ ok: false }) })),
    );

    const identity = await getSlackBotIdentity("T1");

    expect(identity).toEqual({ userId: "U1", botId: null });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
