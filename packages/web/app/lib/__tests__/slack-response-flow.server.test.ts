import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
    intent: { table: "intents", body: false, typeNamedColumn: "intent" },
  },
  DOCO_NEURON_TABLE_SPECS: [
    { table: "decisions", entityType: "decision", body: false },
    { table: "intents", entityType: "intent", body: false },
  ],
  getCollaboratorById: vi.fn(),
  getEntity: vi.fn(),
  listDocoUsers: vi.fn(),
  listEntitiesByDoco: vi.fn(),
  withClient: mocks.withClient,
}));

import { buildSlackAppMentionResponse } from "../slack.server";

describe("Slack response flow", () => {
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
});
