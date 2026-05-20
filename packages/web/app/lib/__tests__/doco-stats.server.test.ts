import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_TABLES } from "../doco-stats.server";

const schemaSql = readFileSync(
  resolve(import.meta.dirname, "../../../../../packages/db/src/schema.sql"),
  "utf8",
);

function tableRegex(prefix: string, table: string): RegExp {
  return new RegExp(String.raw`\b${prefix}\s+${table}\b`, "i");
}

describe("dashboard doco stats entity tables", () => {
  it("only queries entity tables that schema.sql leaves available", () => {
    for (const table of ENTITY_TABLES) {
      expect(tableRegex("CREATE TABLE IF NOT EXISTS", table).test(schemaSql)).toBe(true);
      expect(tableRegex("DROP TABLE IF EXISTS", table).test(schemaSql)).toBe(false);
    }
  });
});
