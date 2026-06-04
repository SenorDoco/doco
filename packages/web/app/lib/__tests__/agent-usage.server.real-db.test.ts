// Real-database exercise of the /admin/agent-usage Anthropic roll-up. Points
// `@doco/db`'s `withClient` at an in-process PGlite loaded with the REAL
// schema, so the SUM/GROUP BY query runs against actual Postgres semantics.
// The point of the test: the dashboard prices each window PER MODEL (Señor
// Doco on Sonnet, the authoring-policy judge on Haiku) rather than blending
// every turn at one model's rate — so a mixed window isn't understated.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

import { aggregateAnthropicUsage } from "../agent-usage.server";

const USER = "user_usage0000000000000000000";
const CONV = "conv_usage0000000000000000000";

let turnSeq = 0;
async function insertTurn(opts: {
  model: string;
  input: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  totalMs?: number;
  startedAt?: string; // SQL expression, e.g. "now() - INTERVAL '2 hours'"
}): Promise<void> {
  turnSeq += 1;
  const id = `atm_${String(turnSeq).padStart(26, "0")}`;
  await dbm.db.query(
    `INSERT INTO agent_turn_metrics
       (id, conversation_id, user_id, model, started_at, total_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES ($1,$2,$3,$4,${opts.startedAt ?? "now()"},$5,$6,$7,$8,$9)`,
    [
      id,
      CONV,
      USER,
      opts.model,
      opts.totalMs ?? 100,
      opts.input,
      opts.output ?? 0,
      opts.cacheRead ?? 0,
      opts.cacheCreation ?? 0,
    ],
  );
}

describe("aggregateAnthropicUsage (real DB)", () => {
  beforeEach(async () => {
    turnSeq = 0;
    dbm.db = new PGlite();
    await dbm.db.exec(schemaSql);
    await dbm.db.query("INSERT INTO users (id, data) VALUES ($1,'{}')", [USER]);
    await dbm.db.query("INSERT INTO chat_conversations (id, user_id) VALUES ($1,$2)", [CONV, USER]);
  });

  it("returns zeroed usage and cost for an empty window", async () => {
    expect(await aggregateAnthropicUsage("true")).toEqual({
      turn_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_ms: 0,
      cost_usd: 0,
    });
  });

  it("sums tokens across models but prices each model at its own rate", async () => {
    // Señor Doco turn on Sonnet (input priced at $3/M).
    await insertTurn({ model: "claude-sonnet-4-6", input: 1_000_000, totalMs: 120 });
    // Judge turn on Haiku (input priced at $0.8/M).
    await insertTurn({ model: "claude-haiku-4-5", input: 1_000_000, totalMs: 80 });

    const bucket = await aggregateAnthropicUsage("true");

    expect(bucket.turn_count).toBe(2);
    expect(bucket.input_tokens).toBe(2_000_000);
    expect(bucket.total_ms).toBe(200);
    // Per-model: 1M*$3 (Sonnet) + 1M*$0.8 (Haiku) = $3.80 — NOT the old
    // flat-Haiku blend of 2M*$0.8 = $1.60 that understated Sonnet spend.
    expect(bucket.cost_usd).toBeCloseTo(3.8, 6);
    expect(bucket.cost_usd).toBeGreaterThan(1.6);
  });

  it("honors the window clause, excluding turns outside it", async () => {
    await insertTurn({ model: "claude-sonnet-4-6", input: 1_000_000, totalMs: 50 });
    await insertTurn({
      model: "claude-sonnet-4-6",
      input: 9_000_000,
      totalMs: 999,
      startedAt: "now() - INTERVAL '2 hours'",
    });

    const lastHour = await aggregateAnthropicUsage("started_at >= now() - INTERVAL '1 hour'");
    expect(lastHour.turn_count).toBe(1);
    expect(lastHour.input_tokens).toBe(1_000_000);
    expect(lastHour.total_ms).toBe(50);
    expect(lastHour.cost_usd).toBeCloseTo(3, 6);
  });
});
