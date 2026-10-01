import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withClient } from "@doco/db";
import { describe, expect, it, vi } from "vitest";
import { NODE_TYPES_FOR_STATS, listDocoStats } from "../doco-stats.server";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

const schemaSql = readFileSync(
  resolve(import.meta.dirname, "../../../../../packages/db/src/schema.sql"),
  "utf8",
);

function tableRegex(prefix: string, table: string): RegExp {
  return new RegExp(String.raw`\b${prefix}\s+${table}\b`, "i");
}

function tableBlock(table: string): string {
  const match = new RegExp(
    String.raw`CREATE TABLE IF NOT EXISTS ${table}\s*\(([\s\S]*?)\n\);`,
    "i",
  ).exec(schemaSql);
  return match?.[1] ?? "";
}

describe("doco stats", () => {
  // Post-collapse: stats read the unified `nodes` table (filtered by
  // node_type) rather than the per-type tables. Validate the single
  // table the queries hit is available and shaped as expected.
  it("queries the unified nodes table, which schema.sql leaves available", () => {
    expect(tableRegex("CREATE TABLE IF NOT EXISTS", "nodes").test(schemaSql)).toBe(true);
    expect(tableRegex("DROP TABLE IF EXISTS", "nodes").test(schemaSql)).toBe(false);
  });

  it("counts Doco-authored role principals as node stats", () => {
    expect(NODE_TYPES_FOR_STATS).toContain("principal");
  });

  it("can fall back to entity updated_at for pre-audit content", () => {
    expect(tableBlock("nodes")).toMatch(/\bupdated_at\s+timestamptz\b/i);
  });
});

describe("listDocoStats lifecycle breakdown", () => {
  it("splits a Doco's node count into drafting / queued / active / retired", async () => {
    const query = async (sql: string) => {
      if (/FROM edges/i.test(sql)) return { rows: [{ doco_id: "doco_1", n: "4" }] };
      if (/FROM audit_events/i.test(sql))
        return { rows: [{ doco_id: "doco_1", last_at: "2026-05-31T10:00:00.000Z" }] };
      return {
        rows: [
          {
            doco_id: "doco_1",
            n: "8",
            drafting_n: "1",
            queued_n: "2",
            active_n: "4",
            retired_n: "1",
            last_entity_at: "2026-05-30T10:00:00.000Z",
          },
        ],
      };
    };
    vi.mocked(withClient).mockImplementation(async (callback) => callback({ query } as never));

    const stats = await listDocoStats(["doco_1"]);
    expect(stats.get("doco_1")?.counts).toEqual({ drafting: 1, queued: 2, active: 4, retired: 1 });
    expect(stats.get("doco_1")?.nodes).toBe(8);
  });

  it("defaults every requested Doco to all-zero counts", async () => {
    const query = async () => ({ rows: [] });
    vi.mocked(withClient).mockImplementation(async (callback) => callback({ query } as never));

    const stats = await listDocoStats(["doco_x"]);
    expect(stats.get("doco_x")?.counts).toEqual({ drafting: 0, queued: 0, active: 0, retired: 0 });
  });
});
