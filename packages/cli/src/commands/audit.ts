// `doco history <id>` and `doco activity` — read-side wrappers around
// /api/audit.json (decision_01KRKESCBTYG4005VMPKYNYR53).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { c, cross } from "../output.js";

const DOCO_BASE_URL = "https://doco.to";

type Env = { token: string; docoId: string };

function loadDotenv(): void {
  for (const k of ["DOCO_TOKEN", "DOCO_ID"] as const) {
    if (process.env[k]) continue;
    try {
      const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\s*export\s+/, "");
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[m[1]]) process.env[m[1]] = v;
      }
      break;
    } catch {
      break;
    }
  }
}

function requireEnv(): Env {
  loadDotenv();
  const token = process.env.DOCO_TOKEN ?? "";
  const docoId = process.env.DOCO_ID ?? "";
  const missing = Object.entries({ DOCO_TOKEN: token, DOCO_ID: docoId })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(cross(`Missing env: ${missing.join(", ")}. Set in shell or in ./.env.`));
    process.exit(2);
  }
  return { token, docoId };
}

interface AuditEvent {
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
}

async function fetchEvents(query: Record<string, string>): Promise<AuditEvent[]> {
  const { token, docoId } = requireEnv();
  const qs = new URLSearchParams(query).toString();
  const url = `${DOCO_BASE_URL}/by-id/${encodeURIComponent(docoId)}/api/audit.json${qs ? `?${qs}` : ""}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    console.error(cross(`Network error GETting ${url}: ${(e as Error).message}`));
    process.exit(1);
  }
  if (!resp.ok) {
    const text = await resp.text();
    console.error(cross(`HTTP ${resp.status}: ${text}`));
    process.exit(1);
  }
  const body = (await resp.json()) as { events: AuditEvent[] };
  return body.events;
}

function formatEvent(e: AuditEvent): string {
  const at = e.at.replace("T", " ").slice(0, 19) + "Z";
  const by = e.by ?? "anonymous";
  const target = `${e.entity_type}/${e.entity_id}`;
  const delta = (() => {
    if (e.op === "lifecycle.transition" && e.before && e.after) {
      return ` ${String(e.before.lifecycle ?? "?")} → ${String(e.after.lifecycle ?? "?")}`;
    }
    if (e.op === "edge.add" && e.after) {
      const keys = Object.keys(e.after);
      const k = keys[0];
      if (k) return ` +${k} ${JSON.stringify(e.after[k])}`;
    }
    if (e.op === "entity.update" && e.before && e.after) {
      const fields = Array.from(new Set([...Object.keys(e.before), ...Object.keys(e.after)]));
      return ` fields=[${fields.join(",")}]`;
    }
    return "";
  })();
  return `${at}  ${c.dim(by)}  ${c.bold(e.op)}  ${target}${delta}`;
}

export const historyCmd = defineCommand({
  meta: {
    name: "history",
    description: "Show audit-events history for one entity (newest-first).",
  },
  args: {
    id: {
      type: "positional",
      description: "The entity's ULID (e.g. 'decision_01KR…' or 'scope_01KR…').",
      required: true,
    },
    limit: {
      type: "string",
      description: "Max events to fetch. Default 50, max 1000.",
    },
  },
  async run({ args }) {
    const id = String(args.id);
    const limit = String(args.limit ?? "50");
    const events = await fetchEvents({ entity_id: id, limit });
    if (events.length === 0) {
      console.log(c.dim(`No history for ${id}.`));
      return;
    }
    for (const e of events) console.log(formatEvent(e));
    console.log(c.dim(`\n${events.length} event(s).`));
  },
});

export const activityCmd = defineCommand({
  meta: {
    name: "activity",
    description: "Stream the per-Doco audit-events log with optional filters.",
  },
  args: {
    type: {
      type: "string",
      description: "Filter by entity type (e.g. 'decision', 'scope', 'rule').",
    },
    op: {
      type: "string",
      description:
        "Filter by op type. Comma-separated. Allowed: entity.create, entity.update, entity.delete, lifecycle.transition, edge.add.",
    },
    by: {
      type: "string",
      description: "Filter by Principal id (the actor who made the change).",
    },
    since: {
      type: "string",
      description: "ISO8601 lower bound on event.at (e.g. '2026-05-01').",
    },
    until: {
      type: "string",
      description: "ISO8601 upper bound on event.at.",
    },
    limit: {
      type: "string",
      description: "Max events to fetch. Default 100, max 1000.",
    },
  },
  async run({ args }) {
    const query: Record<string, string> = {};
    if (args.type) query.entity_type = String(args.type);
    if (args.op) query.op = String(args.op);
    if (args.by) query.by = String(args.by);
    if (args.since) query.since = String(args.since);
    if (args.until) query.until = String(args.until);
    query.limit = String(args.limit ?? "100");
    const events = await fetchEvents(query);
    if (events.length === 0) {
      console.log(c.dim("No events match the current filters."));
      return;
    }
    for (const e of events) console.log(formatEvent(e));
    console.log(c.dim(`\n${events.length} event(s).`));
  },
});
