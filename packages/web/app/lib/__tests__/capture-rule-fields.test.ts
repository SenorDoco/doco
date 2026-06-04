import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

// Node-shape slim-down: the per-type `ruleNodeFields` derivation (which
// translated enforced_by/severity into phase/on_violation) is gone. Rule
// capture now stores the conventional `predicate`/`severity`/`enforced_by`
// attribute keys verbatim through the single generic node-capture path; the
// generic writer's behaviour is pinned in `capture-generic.server.test.ts`.

describe("nodes schema", () => {
  it("no longer carries the never-read `modality` column", async () => {
    const db = new PGlite();
    await db.exec(schemaSql);
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'nodes' AND column_name = 'modality'`,
    );
    expect(r.rows.length).toBe(0);
  });
});
