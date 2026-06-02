import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  canAccessDoco: vi.fn(),
  runDocoApiToolRequest: vi.fn(),
  listAllDocos: vi.fn(),
  internalFetch: vi.fn(),
  buildSenorDocoCorePrompt: vi.fn(),
  upsertAgentTurn: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  listWorkspacesForUser: mocks.listWorkspacesForUser,
  withClient: (fn: (client: { query: typeof mocks.query }) => unknown) =>
    fn({ query: mocks.query }),
}));

vi.mock("@doco/shared", () => ({
  generateUlid: () => "01KSJZ35Y5H6HA7WF75JWMY7J4",
}));

vi.mock("../assistant-runtime.server", () => ({
  SENOR_DOCO_DEFAULT_MAX_TOKENS: 8192,
  getSenorDocoModel: () => "claude-test",
  missingSenorDocoAnthropicMessage: () => null,
  streamSenorDocoMessage: vi.fn(),
}));

vi.mock("../doco-access.server", () => ({
  canAccessDoco: mocks.canAccessDoco,
}));

vi.mock("../doco-api-tool.server", () => ({
  DOCO_API_TOOL: {
    name: "doco_api",
    description: "Call a Doco API route",
    input_schema: { type: "object", properties: {} },
  },
  runDocoApiToolRequest: mocks.runDocoApiToolRequest,
}));

vi.mock("../dotenv.server", () => ({
  ensureEnvLoaded: vi.fn(),
}));

vi.mock("../host.server", () => ({
  listAllDocos: mocks.listAllDocos,
}));

vi.mock("../internal-fetch.server", () => ({
  internalFetch: mocks.internalFetch,
}));

vi.mock("../senor-doco-prompt.server", () => ({
  buildSenorDocoCorePrompt: mocks.buildSenorDocoCorePrompt,
}));

vi.mock("../telemetry.server", () => ({
  upsertAgentTurn: mocks.upsertAgentTurn,
}));

import { loadSnapshotForPrincipal } from "../agent-chat.server";

describe("loadSnapshotForPrincipal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not create an empty conversation when no active chat exists", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    await expect(loadSnapshotForPrincipal("user_01")).resolves.toBeNull();

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain("FROM chat_conversations");
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO"))).toBe(false);
  });
});
