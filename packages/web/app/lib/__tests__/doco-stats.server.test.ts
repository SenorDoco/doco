import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_TYPES_FOR_STATS } from "../doco-stats.server";

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
