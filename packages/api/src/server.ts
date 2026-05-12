import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Action } from "@doco/shared";
import { runAllLints } from "@doco/lints";
import { checkAgainstRules } from "@doco/runtime";
import { CANONICAL_INSTRUCTIONS } from "./instructions.js";

export interface ServerOptions {
  docoRoot: string;
  /** Inject a logger; default no-op for tests. */
  log?: boolean;
}

/**
 * Doco REST API server (local-solo shape, ADR-087).
 *
 * No auth, no Principals, no invitations, no claim flow. The server assumes
 * a single Doco at `docoRoot/doco.yaml` with `.doco/cache.db` populated by
 * `doco reindex`. Hosted-multi-tenant was removed; rebuild from this base if
 * hosted demand materializes.
 */
export function makeApp(opts: ServerOptions): Hono {
  const app = new Hono();
  if (opts.log) app.use(logger());
  app.use(cors());

  app.get("/api/v1/health", (c) =>
    c.json({ ok: true, service: "doco-api", version: "0.0.1" }),
  );

  app.get("/api/v1/doco", (c) => {
    const db = openDbReadonly(opts.docoRoot);
    try {
      const root = db.prepare("SELECT raw_json FROM doco_root LIMIT 1").get() as
        | { raw_json: string }
        | undefined;
      if (!root) return c.json({ error: "no_doco" }, 404);
      const counts = countByType(db);
      return c.json({ doco: JSON.parse(root.raw_json), counts });
    } finally {
      db.close();
    }
  });

  app.get("/api/v1/doco/:type/:id", (c) => {
    const { type, id } = c.req.param();
    if (!isKnownType(type)) return c.json({ error: "unknown_type" }, 400);
    const db = openDbReadonly(opts.docoRoot);
    try {
      const row = db.prepare(`SELECT raw_json FROM ${type} WHERE id = ?`).get(id) as
        | { raw_json: string }
        | undefined;
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json(JSON.parse(row.raw_json));
    } finally {
      db.close();
    }
  });

  app.get("/api/v1/doco/:type", (c) => {
    const { type } = c.req.param();
    if (!isKnownType(type)) return c.json({ error: "unknown_type" }, 400);
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
    const db = openDbReadonly(opts.docoRoot);
    try {
      const rows = db.prepare(`SELECT raw_json FROM ${type} LIMIT ?`).all(limit) as {
        raw_json: string;
      }[];
      return c.json({ items: rows.map((r) => JSON.parse(r.raw_json)) });
    } finally {
      db.close();
    }
  });

  app.post("/api/v1/query", async (c) => {
    const body = (await c.req.json()) as { sql?: string };
    if (!body.sql) return c.json({ error: "missing_sql" }, 400);
    const db = openDbReadonly(opts.docoRoot);
    try {
      const start = performance.now();
      const rows = db.prepare(body.sql).all();
      const elapsed = performance.now() - start;
      return c.json({ rows, count: rows.length, elapsed_ms: Number(elapsed.toFixed(2)) });
    } catch (e) {
      return c.json({ error: "query_failed", detail: (e as Error).message }, 400);
    } finally {
      db.close();
    }
  });

  app.post("/api/v1/check", async (c) => {
    const action = (await c.req.json()) as Action;
    const db = openDbReadonly(opts.docoRoot);
    try {
      const report = checkAgainstRules(db, action);
      const status = report.blocked ? 422 : 200;
      return c.json(report, status);
    } finally {
      db.close();
    }
  });

  /**
   * Suggest related entities for a yet-to-be-written one (ADR-075).
   * Body: { summary: string, body?: string, type?: string, limit?: number }
   * Runs FTS5 against the indexer's `fts` table; returns top-K matches.
   */
  app.post("/api/v1/suggest", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      summary?: string;
      body?: string;
      type?: string;
      limit?: number;
    };
    if (!body.summary && !body.body) return c.json({ error: "missing_summary_or_body" }, 400);

    const limit = Math.max(1, Math.min(50, body.limit ?? 10));
    const queryText = `${body.summary ?? ""} ${body.body ?? ""}`.trim();
    const ftsQuery = ftsSanitize(queryText);
    if (!ftsQuery) return c.json({ matches: [], query: queryText });

    const db = openDbReadonly(opts.docoRoot);
    try {
      const where = body.type ? "AND node_type = ?" : "";
      const args: unknown[] = [ftsQuery];
      if (body.type) args.push(body.type);
      args.push(limit);
      const rows = db
        .prepare(
          `SELECT id, node_type, summary, bm25(fts) AS score
           FROM fts
           WHERE fts MATCH ? ${where}
           ORDER BY score
           LIMIT ?`,
        )
        .all(...args) as { id: string; node_type: string; summary: string; score: number }[];

      const suggestedScopes = aggregateSuggestedScopes(db, rows);

      return c.json({
        matches: rows,
        suggested_scopes: suggestedScopes,
        query: queryText,
        limit,
      });
    } catch (e) {
      return c.json({ error: "fts_failed", detail: (e as Error).message }, 400);
    } finally {
      db.close();
    }
  });

  app.get("/api/v1/lint", (c) => {
    const db = openDbReadonly(opts.docoRoot);
    try {
      const report = runAllLints(db);
      return c.json(report);
    } finally {
      db.close();
    }
  });

  /**
   * Agent bootstrap (ADR-080).
   *
   * Single endpoint an agent fetches at session start.
   */
  app.get("/api/v1/agent-bootstrap", (c) => {
    const db = openDbReadonly(opts.docoRoot);
    try {
      const root = db.prepare("SELECT raw_json FROM doco_root LIMIT 1").get() as
        | { raw_json: string }
        | undefined;
      const docoEntity = root ? (JSON.parse(root.raw_json) as Record<string, unknown>) : null;

      const scopeRows = db
        .prepare(
          `SELECT s.id, s.name, s.summary, s.raw_json,
                  (SELECT COUNT(*) FROM edges e
                   WHERE e.to_id = s.id
                     AND e.edge_type = 'in_scope_of'
                     AND e.from_node_type != 'scope') AS member_count,
                  (SELECT COUNT(*) FROM edges e
                   WHERE e.to_id = s.id
                     AND e.edge_type = 'in_scope_of'
                     AND e.from_node_type = 'scope') AS sub_scope_count
           FROM scope s
           ORDER BY member_count DESC, s.name ASC`,
        )
        .all() as {
        id: string;
        name: string;
        summary: string;
        raw_json: string;
        member_count: number;
        sub_scope_count: number;
      }[];
      const scopes = scopeRows.map((r) => {
        const ent = JSON.parse(r.raw_json) as Record<string, unknown>;
        const parents = Array.isArray(ent.scopes) ? (ent.scopes as string[]) : [];
        return {
          id: r.id,
          name: r.name,
          summary: r.summary,
          purpose: typeof ent.purpose === "string" ? ent.purpose : null,
          guidelines: typeof ent.guidelines === "string" ? ent.guidelines : null,
          parent_ids: parents,
          member_count: r.member_count,
          sub_scope_count: r.sub_scope_count,
        };
      });

      const lintReport = runAllLints(db);
      const issuesByLint = new Map<
        string,
        { lintId: string; warnings: number; errors: number; sample?: string }
      >();
      for (const i of lintReport.issues) {
        const entry =
          issuesByLint.get(i.lintId) ??
          ({ lintId: i.lintId, warnings: 0, errors: 0 } as {
            lintId: string;
            warnings: number;
            errors: number;
            sample?: string;
          });
        if (i.severity === "warning") entry.warnings += 1;
        else if (i.severity === "error") entry.errors += 1;
        if (!entry.sample) entry.sample = i.message;
        issuesByLint.set(i.lintId, entry);
      }

      const recentRows = db
        .prepare(
          `SELECT id, node_type, summary, created_at FROM (
             SELECT id, 'intent' AS node_type, summary, created_at FROM intent
             UNION ALL SELECT id, 'idea', summary, created_at FROM idea
             UNION ALL SELECT id, 'rule', summary, created_at FROM rule
             UNION ALL SELECT id, 'decision', summary, created_at FROM decision
             UNION ALL SELECT id, 'action', summary, created_at FROM action
             UNION ALL SELECT id, 'reasoning', summary, created_at FROM reasoning
             UNION ALL SELECT id, 'scope', summary, created_at FROM scope
           )
           WHERE created_at IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 10`,
        )
        .all() as { id: string; node_type: string; summary: string; created_at: string }[];

      const proto = c.req.header("x-forwarded-proto") ?? "http";
      const host = c.req.header("host") ?? "127.0.0.1:8787";
      const hostUrl = `${proto}://${host}`;

      return c.json({
        canonical_instructions: CANONICAL_INSTRUCTIONS,
        doco: docoEntity
          ? {
              doco_id: docoEntity.id,
              slug: docoEntity.slug,
              display_name: docoEntity.display_name,
              description: docoEntity.description,
              host_url: hostUrl,
            }
          : { host_url: hostUrl },
        counts: countByType(db),
        scopes,
        known_issues: Array.from(issuesByLint.values()).sort(
          (a, b) => b.errors - a.errors || b.warnings - a.warnings,
        ),
        recent_activity: recentRows,
      });
    } finally {
      db.close();
    }
  });

  return app;
}

function openDbReadonly(root: string): Database {
  return new BetterSqlite3(`${root}/.doco/cache.db`, { readonly: true, fileMustExist: true });
}

function aggregateSuggestedScopes(
  db: Database,
  matches: { id: string; score: number }[],
  topN: number = 5,
): { id: string; name: string; score: number; matched_in: number }[] {
  const scoreByScope = new Map<string, { score: number; matched_in: number }>();
  const stmt = db.prepare(
    "SELECT to_id FROM edges WHERE from_id = ? AND edge_type = 'in_scope_of'",
  );
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const w = 1 / (1 + i);
    const scopes = stmt.all(m.id) as { to_id: string }[];
    for (const s of scopes) {
      const cur = scoreByScope.get(s.to_id) ?? { score: 0, matched_in: 0 };
      cur.score += w;
      cur.matched_in += 1;
      scoreByScope.set(s.to_id, cur);
    }
  }
  const lookupName = db.prepare("SELECT name FROM scope WHERE id = ?");
  const out: { id: string; name: string; score: number; matched_in: number }[] = [];
  for (const [id, agg] of scoreByScope) {
    const row = lookupName.get(id) as { name: string } | undefined;
    out.push({
      id,
      name: row?.name ?? id,
      score: Number(agg.score.toFixed(4)),
      matched_in: agg.matched_in,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topN);
}

/**
 * Sanitize free-text input into an FTS5 MATCH query. Strips characters that
 * FTS5 treats as operators, splits on whitespace, drops short tokens, ORs
 * the rest. ADR-075 — used by /api/v1/suggest.
 */
function ftsSanitize(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 30);
  if (tokens.length === 0) return "";
  return tokens.join(" OR ");
}

function countByType(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [
    "intent",
    "idea",
    "rule",
    "decision",
    "action",
    "reasoning",
    "evaluation",
    "reference",
    "scope",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get() as { n: number };
    out[t] = row.n;
  }
  return out;
}

function isKnownType(t: string): boolean {
  return [
    "doco_root",
    "intent",
    "idea",
    "rule",
    "decision",
    "action",
    "reasoning",
    "evaluation",
    "reference",
    "scope",
  ].includes(t);
}
