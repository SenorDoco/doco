import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Action, EntityId } from "@doco/shared";
import { computeCoverage, runAllLints } from "@doco/lints";
import { checkAgainstRules } from "@doco/runtime";
import { addAgentPrincipal, findPrincipalById, redeemInvitation } from "./agents.js";
import { detectMode } from "@doco/host";
import { TokenStore, parseBearer } from "./auth.js";
import { CANONICAL_INSTRUCTIONS } from "./instructions.js";
import { ftsSanitize } from "./fts.js";

export interface ServerOptions {
  docoRoot: string;
  /** When true, the server requires a valid Bearer token on every request. */
  requireToken?: boolean;
  /** When set, unauthenticated requests are accepted as this principal (local-dev mode). */
  defaultPrincipalId?: string;
  /** Inject a logger; default no-op for tests. */
  log?: boolean;
}

type Variables = { principal_id: string };

export function makeApp(opts: ServerOptions): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  if (opts.log) app.use(logger());
  app.use(cors());

  const tokenStore = TokenStore.forDoco(opts.docoRoot);
  const mode = detectMode(opts.docoRoot);

  // Auth middleware — populates `principal_id` on the context.
  // Routes that consume invitation tokens (which are not session tokens) handle
  // their own auth and are skipped here.
  const skipAuthPaths = new Set(["/api/v1/invitations/redeem"]);
  app.use("/api/*", async (c, next) => {
    if (skipAuthPaths.has(c.req.path)) return next();
    const tokenHeader = parseBearer(c.req.header("authorization"));
    if (tokenHeader) {
      const sess = await tokenStore.resolve(tokenHeader);
      if (sess) {
        c.set("principal_id", sess.principal_id);
        return next();
      }
      // A Bearer token was supplied but didn't resolve — never fall back to the
      // default principal; the caller is asserting an identity that doesn't hold.
      return c.json({ error: "invalid_token" }, 401);
    }
    if (opts.requireToken) {
      return c.json({ error: "missing_token" }, 401);
    }
    if (opts.defaultPrincipalId) {
      c.set("principal_id", opts.defaultPrincipalId);
    }
    return next();
  });

  app.get("/api/v1/health", (c) =>
    c.json({ ok: true, service: "doco-api", version: "0.0.1", mode }),
  );

  // ─────────────────────────────────────────────── Invitation flow (ADR-068)

  /**
   * Issue a 5-min invitation token. Caller must be a signed-in human.
   * Returns the token + the URL the agent should visit.
   */
  app.post("/api/v1/invitations", async (c) => {
    if (mode !== "host") return c.json({ error: "host_mode_only" }, 400);
    const principalId = c.get("principal_id");
    if (!principalId) return c.json({ error: "not_authenticated" }, 401);
    const inviter = findPrincipalById(opts.docoRoot, principalId);
    if (!inviter) return c.json({ error: "inviter_not_found" }, 401);

    const inv = await tokenStore.issueInvitationToken(principalId as EntityId<"principal">);
    const proto = c.req.header("x-forwarded-proto") ?? "http";
    const host = c.req.header("host") ?? "127.0.0.1:8787";
    const url = `${proto}://${host}/invite/${inv.token}`;
    return c.json({
      token: inv.token,
      url,
      expires_at: inv.expires_at,
      issued_at: inv.issued_at,
      inviter: { id: inviter.id, username: inviter.username, type: inviter.type },
    });
  });

  /**
   * Redeem an invitation. Bearer token must be the invitation token.
   * Body: { display_name, model?, provider?, capabilities? }
   * Creates a Principal{type: agent}, issues a session token, marks invite used.
   */
  app.post("/api/v1/invitations/redeem", async (c) => {
    if (mode !== "host") return c.json({ error: "host_mode_only" }, 400);
    const tokenHeader = parseBearer(c.req.header("authorization"));
    if (!tokenHeader) return c.json({ error: "missing_invitation_token" }, 401);

    const body = (await c.req.json().catch(() => ({}))) as {
      display_name?: string;
      model?: string;
      provider?: string;
      capabilities?: string[];
    };
    const result = await redeemInvitation(opts.docoRoot, tokenHeader, body);
    if ("error" in result) {
      const e = result.error;
      if (e.kind === "invalid_or_expired_invitation")
        return c.json({ error: "invalid_or_expired_invitation" }, 401);
      if (e.kind === "inviter_no_longer_exists")
        return c.json({ error: "inviter_no_longer_exists" }, 410);
      return c.json({ error: "create_principal_failed", detail: e.detail }, 500);
    }
    return c.json(result);
  });

  /**
   * Agent-spawns-agent: a session-authenticated agent creates a child agent.
   * The child's owner_id is the calling principal — preserves the human-ancestry chain.
   */
  app.post("/api/v1/agents/spawn", async (c) => {
    if (mode !== "host") return c.json({ error: "host_mode_only" }, 400);
    const callerId = c.get("principal_id");
    if (!callerId) return c.json({ error: "not_authenticated" }, 401);
    const caller = findPrincipalById(opts.docoRoot, callerId);
    if (!caller) return c.json({ error: "caller_not_found" }, 401);

    const body = (await c.req.json().catch(() => ({}))) as {
      display_name?: string;
      model?: string;
      provider?: string;
      capabilities?: string[];
    };
    const isoNow = new Date().toISOString();
    const username = `${caller.username}/${isoNow}`;
    const displayName = body.display_name ?? `agent ${username}`;

    let principalId: EntityId<"principal">;
    try {
      principalId = await addAgentPrincipal(opts.docoRoot, {
        username,
        display_name: displayName,
        owner_id: callerId as EntityId<"principal">,
        agent_metadata: {
          provider: body.provider ?? "unknown",
          model: body.model ?? "unknown",
          capabilities: body.capabilities ?? [],
          created_at: isoNow,
        },
      });
    } catch (e) {
      return c.json({ error: "create_principal_failed", detail: (e as Error).message }, 500);
    }
    const session = await tokenStore.issueSessionToken(
      principalId,
      callerId as EntityId<"principal">,
    );
    return c.json({
      session_token: session.token,
      principal: {
        id: principalId,
        username,
        display_name: displayName,
        type: "agent",
        owner_id: callerId,
      },
    });
  });

  /** Revoke a session token with strict cascade (ADR-038). */
  app.post("/api/v1/sessions/:token/revoke", async (c) => {
    if (mode !== "host") return c.json({ error: "host_mode_only" }, 400);
    const callerId = c.get("principal_id");
    if (!callerId) return c.json({ error: "not_authenticated" }, 401);
    const caller = findPrincipalById(opts.docoRoot, callerId);
    if (!caller || caller.type !== "human") {
      return c.json({ error: "human_only" }, 403);
    }
    const target = c.req.param("token");
    const count = await tokenStore.revoke(target, true);
    return c.json({ revoked: count });
  });

  // ─────────────────────────────────────────────── Existing endpoints

  // The single-Doco endpoints below assume a per-Doco SQLite cache.
  // In host mode they no-op; the per-Doco API would scope to /:owner/:doco
  // (deferred — for now host-mode reads happen via the web's per-Doco loaders).

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
   * Designed for use at write-time, before an agent creates a new entity:
   * find existing nodes that overlap so the new node can link them.
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
    // FTS query: tokenize the input, OR the terms, sanitize.
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

      // ADR-079: aggregate scope memberships across the matches and surface
      // the most-frequent ones as suggested_scopes for the agent to assign.
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
      const report = runAllLints(db, { docoRoot: opts.docoRoot });
      return c.json(report);
    } finally {
      db.close();
    }
  });

  /** Drift report — modified-but-uncovered files (ADR-090). */
  app.get("/api/v1/coverage", (c) => {
    const report = computeCoverage(opts.docoRoot);
    return c.json(report);
  });

  /**
   * Agent bootstrap (ADR-080).
   *
   * Single endpoint an agent fetches at session start. Returns:
   *   - canonical_instructions: markdown the agent must read before working.
   *     Updated centrally — repos carry only a thin AGENT.md stub.
   *   - doco: { name, doco_id, mode, host_url } so the agent knows where it is.
   *   - scopes: every Scope with member_count, sorted by usage. The agent
   *     uses these to assign scopes to new entities (no need to invent names).
   *   - known_issues: lint summary (counts by lintId + severity). Tells the
   *     agent which graph problems are already on the radar.
   *   - recent_activity: last 10 entities (by created_at) so the agent has
   *     context for what's happening lately.
   *
   * Single-Doco mode only. Host-mode equivalent is per-Doco at
   * /api/v1/<owner>/<doco>/agent-bootstrap (deferred — ADR-080 §what's deferred).
   */
  app.get("/api/v1/agent-bootstrap", (c) => {
    const db = openDbReadonly(opts.docoRoot);
    try {
      // The Doco itself.
      const root = db.prepare("SELECT raw_json FROM doco_root LIMIT 1").get() as
        | { raw_json: string }
        | undefined;
      const docoEntity = root ? (JSON.parse(root.raw_json) as Record<string, unknown>) : null;

      // Scopes + their member counts + purpose / guidelines / parent (ADR-081, ADR-082).
      // raw_json holds the full entity; we read purpose/guidelines/scopes from there.
      // member_count counts content nodes in scope (excludes scope-to-scope edges, so
      // sub-scopes don't double-count toward a parent's member count).
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

      // Lint summary — keep it small; the full lint report is at /api/v1/lint.
      const lintReport = runAllLints(db, { docoRoot: opts.docoRoot });
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

      // Recent activity across content + scope types.
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

      // Drift signal (ADR-090): how many modified files lack an Action.
      const coverage = computeCoverage(opts.docoRoot);
      const uncoveredChanges = {
        count: coverage.uncovered.length,
        sample: coverage.uncovered.slice(0, 10),
      };

      return c.json({
        canonical_instructions: CANONICAL_INSTRUCTIONS,
        doco: docoEntity
          ? {
              doco_id: docoEntity.id,
              slug: docoEntity.slug,
              display_name: docoEntity.display_name,
              description: docoEntity.description,
              mode,
              host_url: hostUrl,
            }
          : { mode, host_url: hostUrl },
        counts: countByType(db),
        scopes,
        known_issues: Array.from(issuesByLint.values()).sort(
          (a, b) => b.errors - a.errors || b.warnings - a.warnings,
        ),
        uncovered_changes: uncoveredChanges,
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

/**
 * Aggregate scope memberships across a set of FTS-matched entities, weighting
 * by inverse rank — earlier (higher-scoring) matches contribute more. Returns
 * top-N scope candidates ranked by aggregate weight. Per ADR-079.
 */
function aggregateSuggestedScopes(
  db: Database,
  matches: { id: string; score: number }[],
  topN: number = 5,
): { id: string; name: string; score: number; matched_in: number }[] {
  const scoreByScope = new Map<string, { score: number; matched_in: number }>();
  const stmt = db.prepare(
    "SELECT to_id FROM edges WHERE from_id = ? AND edge_type = 'in_scope_of'",
  );
  // FTS5 bm25 returns negative numbers (lower = better). Use rank-position
  // weighting: 1 / (1 + i) — first match contributes 1.0, second 0.5, etc.
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
  // Resolve scope names + sort by aggregate score.
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

function countByType(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [
    "principal",
    "organization",
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
    "principal",
    "organization",
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

/** Re-export so the CLI can spawn the server. */
export { TokenStore, parseBearer } from "./auth.js";
export {
  addAgentPrincipal,
  findPrincipalById,
  redeemInvitation,
  type AddAgentPrincipalOpts,
  type PrincipalSummary,
  type RedemptionBody,
  type RedemptionError,
  type RedemptionResult,
} from "./agents.js";
