import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Action } from "@evalo/shared";
import { runAllLints } from "@evalo/lints";
import { checkAgainstRules } from "@evalo/runtime";
import { TokenStore, parseBearer } from "./auth.js";

export interface ServerOptions {
  evaloRoot: string;
  /** When true, the server requires a valid Bearer token on every request. */
  requireToken?: boolean;
  /** When set, unauthenticated requests are accepted as this principal (local-dev mode). */
  defaultPrincipalId?: string;
  /** Inject a logger; default no-op for tests. */
  log?: boolean;
}

/**
 * Build the Hono app for an Evalo. Stateless w.r.t. the request — the index
 * db is opened per-request (cheap with WAL mode + better-sqlite3).
 */
type Variables = { principal_id: string };

export function makeApp(opts: ServerOptions): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  if (opts.log) app.use(logger());
  app.use(cors());

  const tokenStore = TokenStore.forEvalo(opts.evaloRoot);

  // Auth middleware — populates `principal_id` on the context.
  app.use("/api/*", async (c, next) => {
    const tokenHeader = parseBearer(c.req.header("authorization"));
    if (tokenHeader) {
      const sess = await tokenStore.resolve(tokenHeader);
      if (sess) {
        c.set("principal_id", sess.principal_id);
        return next();
      }
      if (opts.requireToken) return c.json({ error: "invalid_token" }, 401);
    } else if (opts.requireToken) {
      return c.json({ error: "missing_token" }, 401);
    }
    if (opts.defaultPrincipalId) {
      c.set("principal_id", opts.defaultPrincipalId);
    }
    return next();
  });

  app.get("/api/v1/health", (c) => c.json({ ok: true, service: "evalo-api", version: "0.0.1" }));

  // GET /api/v1/evalo — root metadata + entity counts
  app.get("/api/v1/evalo", (c) => {
    const db = openDbReadonly(opts.evaloRoot);
    try {
      const root = db.prepare("SELECT raw_json FROM evalo_root LIMIT 1").get() as
        | { raw_json: string }
        | undefined;
      if (!root) return c.json({ error: "no_evalo" }, 404);
      const counts = countByType(db);
      return c.json({ evalo: JSON.parse(root.raw_json), counts });
    } finally {
      db.close();
    }
  });

  // GET /api/v1/evalo/{type}/{id} — single entity
  app.get("/api/v1/evalo/:type/:id", (c) => {
    const { type, id } = c.req.param();
    if (!isKnownType(type)) return c.json({ error: "unknown_type" }, 400);
    const db = openDbReadonly(opts.evaloRoot);
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

  // GET /api/v1/evalo/{type} — list by type
  app.get("/api/v1/evalo/:type", (c) => {
    const { type } = c.req.param();
    if (!isKnownType(type)) return c.json({ error: "unknown_type" }, 400);
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
    const db = openDbReadonly(opts.evaloRoot);
    try {
      const rows = db.prepare(`SELECT raw_json FROM ${type} LIMIT ?`).all(limit) as {
        raw_json: string;
      }[];
      return c.json({ items: rows.map((r) => JSON.parse(r.raw_json)) });
    } finally {
      db.close();
    }
  });

  // POST /api/v1/query — run SQL (read-only)
  app.post("/api/v1/query", async (c) => {
    const body = (await c.req.json()) as { sql?: string };
    if (!body.sql) return c.json({ error: "missing_sql" }, 400);
    const db = openDbReadonly(opts.evaloRoot);
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

  // POST /api/v1/check — run runtime checks against a draft Action
  app.post("/api/v1/check", async (c) => {
    const action = (await c.req.json()) as Action;
    const db = openDbReadonly(opts.evaloRoot);
    try {
      const report = checkAgainstRules(db, action);
      const status = report.blocked ? 422 : 200;
      return c.json(report, status);
    } finally {
      db.close();
    }
  });

  // GET /api/v1/lint — run all system lints
  app.get("/api/v1/lint", (c) => {
    const db = openDbReadonly(opts.evaloRoot);
    try {
      const report = runAllLints(db);
      return c.json(report);
    } finally {
      db.close();
    }
  });

  return app;
}

function openDbReadonly(root: string): Database {
  return new BetterSqlite3(`${root}/.evalo/cache.db`, { readonly: true, fileMustExist: true });
}

function countByType(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [
    "principal",
    "intent",
    "rule",
    "decision",
    "action",
    "reasoning",
    "evaluation",
    "reference",
    "tag",
  ]) {
    const row = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get() as { n: number };
    out[t] = row.n;
  }
  return out;
}

function isKnownType(t: string): boolean {
  return [
    "evalo_root",
    "principal",
    "intent",
    "rule",
    "decision",
    "action",
    "reasoning",
    "evaluation",
    "reference",
    "tag",
  ].includes(t);
}

/** Re-export so the CLI can spawn the server. */
export { TokenStore, parseBearer } from "./auth.js";
