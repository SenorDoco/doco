import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { ruleNodeFields } from "../capture.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

describe("ruleNodeFields", () => {
  it("omits the vestigial modality / expected / applies_to fields", () => {
    const fields = ruleNodeFields({
      rule: "  Secrets must never be committed.  ",
      predicate: "  no plaintext credentials in the repo  ",
      severity: "hard",
      enforced_by: "runtime",
    });

    // Pre-Policy-model leftovers: modality was hardcoded "must", expected
    // "true", applies_to an empty selector. None were ever read.
    expect(fields).not.toHaveProperty("modality");
    expect(fields).not.toHaveProperty("expected");
    expect(fields).not.toHaveProperty("applies_to");

    // The fields that drive rendering are derived as before.
    expect(fields).toMatchObject({
      rule: "Secrets must never be committed.",
      severity: "blocker",
      phase: "invariant",
      enforced_by: "runtime",
      predicate: "no plaintext credentials in the repo",
      on_violation: "block",
    });
  });

  it("defaults severity→warning, phase→declared, on_violation→warn", () => {
    const fields = ruleNodeFields({ rule: "Prefer small PRs.", predicate: "PR diff < 400 lines" });
    expect(fields).toMatchObject({
      severity: "warning",
      phase: "declared",
      on_violation: "warn",
    });
    expect(fields).not.toHaveProperty("enforced_by");
  });
});

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
