// `doco import <bundle>` — write the contents of a `doco export` bundle
// into the configured Postgres (DOCO_DATABASE_URL or DATABASE_URL).
//
// Round-trips with `doco export`. Used to migrate from filesystem
// storage (legacy ADR-002) into Phase 2 Postgres storage
// (decision_01KRKEVEE3RQGPWHAPMZ0MS9G9).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import {
  appendAuditEventRow,
  ensureSchema,
  pingDb,
  upsertEntity,
  withTransaction,
  type EntityRecord,
} from "@doco/db";
import { c, cross, checkmark } from "../output.js";

interface Manifest {
  schema_version: number;
  exported_at: string;
  doco_id: string;
  counts: Record<string, number>;
  audit_events: number;
  total_rows: number;
}

const ENTITY_FILES = [
  "doco.jsonl",
  "principal.jsonl",
  "organization.jsonl",
  "intent.jsonl",
  "decision.jsonl",
  "rule.jsonl",
  "action.jsonl",
  "reasoning.jsonl",
  "eval.jsonl",
  "scope.jsonl",
  "reference.jsonl",
  "idea.jsonl",
  "tag.jsonl",
];

function readJsonlIfExists<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export const importCmd = defineCommand({
  meta: {
    name: "import",
    description:
      "Import a bundle (produced by `doco export`) into the configured Postgres. Used to migrate filesystem-storage docos into Phase 2 Postgres storage.",
  },
  args: {
    bundle: {
      type: "positional",
      description: "Path to the bundle directory (containing manifest.json + *.jsonl).",
      required: true,
    },
    "skip-audit": {
      type: "boolean",
      description: "Skip importing audit_events (default: import them all).",
    },
  },
  async run({ args }) {
    const bundleDir = resolve(process.cwd(), String(args.bundle));
    const manifestPath = join(bundleDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      console.error(cross(`No manifest.json at ${bundleDir}.`));
      process.exit(2);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.schema_version !== 1) {
      console.error(cross(`Unsupported bundle schema_version: ${manifest.schema_version}.`));
      process.exit(2);
    }

    try {
      const ping = await pingDb();
      console.log(c.dim(`Connected: ${ping.version.split(",")[0]}`));
    } catch (e) {
      console.error(cross(`Cannot reach Postgres: ${(e as Error).message}`));
      console.error(c.warn("  Ensure DOCO_DATABASE_URL is set (default: postgres://postgres:doco@127.0.0.1:5433/doco)."));
      process.exit(1);
    }
    await ensureSchema();
    console.log(c.dim("Schema applied."));

    let inserted = 0;
    await withTransaction(async (client) => {
      for (const file of ENTITY_FILES) {
        const path = join(bundleDir, file);
        const rows = readJsonlIfExists<EntityRecord>(path);
        for (const r of rows) {
          await upsertEntity(r, client);
          inserted++;
        }
        if (rows.length > 0) console.log(c.dim(`  ${file.replace(".jsonl", "")}: ${rows.length}`));
      }
    });
    console.log(checkmark(`Imported ${inserted} entity row(s).`));

    if (!args["skip-audit"]) {
      const auditPath = join(bundleDir, "audit_events.jsonl");
      const events = readJsonlIfExists<{
        event_id: string;
        at: string;
        by: string | null;
        doco_id: string;
        entity_type: string;
        entity_id: string;
        op: string;
        before?: Record<string, unknown>;
        after?: Record<string, unknown>;
        reason?: string | null;
      }>(auditPath);
      let auditInserted = 0;
      for (const evt of events) {
        try {
          await appendAuditEventRow({
            event_id: evt.event_id,
            at: evt.at,
            by_principal: evt.by,
            doco_id: evt.doco_id,
            entity_type: evt.entity_type,
            entity_id: evt.entity_id,
            op: evt.op,
            before_json: evt.before ?? null,
            after_json: evt.after ?? null,
            reason: evt.reason ?? null,
          });
          auditInserted++;
        } catch (e) {
          // Likely duplicate event_id from a re-import; tolerate.
        }
      }
      console.log(checkmark(`Imported ${auditInserted} audit event(s).`));
    }

    console.log(checkmark(`Bundle imported: doco_id=${manifest.doco_id}.`));
  },
});
