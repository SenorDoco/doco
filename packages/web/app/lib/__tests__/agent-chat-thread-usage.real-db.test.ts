// Real-database exercise of the per-thread usage roll-up that backs the
// Thinking panel meter. Points `@doco/db`'s `withClient` at an in-process
// PGlite loaded with the REAL schema, so the SUM/GROUP BY query runs
// against actual Postgres semantics (bigint casts, COALESCE, FK scoping).
// The Anthropic/tool boundaries agent-chat.server pulls in are stubbed —
// this test never drives a turn, it only reads aggregated metrics.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
  listWorkspacesForUser: async () => [],
}));
vi.mock("../assistant-runtime.server", () => ({
  SENOR_DOCO_DEFAULT_MAX_TOKENS: 8192,
  getSenorDocoModel: () => "claude-test",
  missingSenorDocoAnthropicMessage: () => null,
  streamSenorDocoMessage: vi.fn(),
}));
vi.mock("../doco-api-tool.server", () => ({
  DOCO_API_TOOL: {
    name: "doco_api",
    description: "Call a Doco API route",
    input_schema: { type: "object", properties: {} },
  },
  runDocoApiToolRequest: vi.fn(),
}));
vi.mock("../senor-doco-prompt.server", () => ({ buildSenorDocoCorePrompt: () => "SYSTEM PROMPT" }));
vi.mock("../host.server", () => ({ listAllDocos: async () => [] }));
vi.mock("../doco-access.server", () => ({ canAccessDoco: async () => true }));
vi.mock("../internal-fetch.server", () => ({ internalFetch: vi.fn(async () => null) }));
vi.mock("../dotenv.server", () => ({ ensureEnvLoaded: vi.fn() }));
vi.mock("../telemetry.server", () => ({ upsertAgentTurn: vi.fn(async () => {}) }));

import { loadThreadUsage } from "../agent-chat.server";

const USER = "user_usage0000000000000000000";
const CONV = "conv_usage0000000000000000000";
const OTHER = "conv_other0000000000000000000";

async function insertTurn(opts: {
  id: string;
  conversationId: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}): Promise<void> {
  await dbm.db.query(
    `INSERT INTO agent_turn_metrics
       (id, conversation_id, user_id, model, total_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      opts.id,
      opts.conversationId,
      USER,
      opts.model,
      100,
      opts.input,
      opts.output,
      opts.cacheRead ?? 0,
      opts.cacheCreation ?? 0,
    ],
  );
}

describe("loadThreadUsage", () => {
  beforeEach(async () => {
    dbm.db = new PGlite({ extensions: { vector } });
    await dbm.db.exec(schemaSql);
    await dbm.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
    await dbm.db.query("INSERT INTO chat_conversations (id, user_id) VALUES ($1,$2)", [CONV, USER]);
    await dbm.db.query("INSERT INTO chat_conversations (id, user_id) VALUES ($1,$2)", [
      OTHER,
      USER,
    ]);
  });

  it("returns zeroed usage for a thread with no recorded turns", async () => {
    expect(await loadThreadUsage(CONV)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      turn_count: 0,
      estimated_cost_usd: 0,
    });
  });

  it("sums tokens, counts turns, prices the thread, and scopes to one conversation", async () => {
    await insertTurn({
      id: "atm_1",
      conversationId: CONV,
      model: "claude-sonnet-4-6",
      input: 1000,
      output: 200,
      cacheRead: 500,
    });
    await insertTurn({
      id: "atm_2",
      conversationId: CONV,
      model: "claude-sonnet-4-6",
      input: 3000,
      output: 800,
      cacheCreation: 100,
    });
    // A turn on a different thread must not leak into this thread's total.
    await insertTurn({
      id: "atm_other",
      conversationId: OTHER,
      model: "claude-sonnet-4-6",
      input: 99999,
      output: 99999,
    });

    const usage = await loadThreadUsage(CONV);
    expect(usage.input_tokens).toBe(4000);
    expect(usage.output_tokens).toBe(1000);
    expect(usage.cache_read_tokens).toBe(500);
    expect(usage.cache_creation_tokens).toBe(100);
    expect(usage.turn_count).toBe(2);
    // (4000*3 + 1000*15 + 500*0.3 + 100*3.75) / 1e6
    expect(usage.estimated_cost_usd).toBeCloseTo(0.027525, 9);
  });
});
