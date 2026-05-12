import type { Database } from "better-sqlite3";

/**
 * Scope selectors, per SCHEMA.md §5.
 *
 * A selector matches a candidate entity. Common forms:
 *   { all: true }                                    // wildcard
 *   { node_type: "action", verb: "deploy" }
 *   { scope: "auth" }                                // candidate carries a scope entity with name "auth"
 *   { id: "decision_01H..." }
 *   { intent_id: "intent_01H..." }                   // candidate serves this intent
 *   { actor_type: "agent" }                          // for action candidates
 *   { any_of: [<selector>, ...] }
 *   { all_of: [<selector>, ...] }
 */
export type ScopeSelector =
  | { all: true }
  | { id: string }
  | { node_type: string; verb?: string; type?: string; actor_type?: string; [key: string]: unknown }
  | { scope: string }
  | { intent_id: string }
  | { actor_type: "human" | "agent" }
  | { any_of: ScopeSelector[] }
  | { all_of: ScopeSelector[] };

/**
 * Evaluate a scope selector against a candidate entity. The candidate must
 * carry its `node_type`. Optional `db` lets the matcher resolve relational
 * facts (scopes, edges, principal lookups).
 */
export function matches(
  selector: unknown,
  candidate: Record<string, unknown>,
  db?: Database,
): boolean {
  if (selector === null || selector === undefined) return false;
  if (typeof selector !== "object") return false;

  const sel = selector as Record<string, unknown>;

  if (sel.all === true) return true;

  if (typeof sel.id === "string") return candidate.id === sel.id;

  if (Array.isArray(sel.any_of)) {
    return (sel.any_of as unknown[]).some((s) => matches(s, candidate, db));
  }
  if (Array.isArray(sel.all_of)) {
    return (sel.all_of as unknown[]).every((s) => matches(s, candidate, db));
  }

  // Scope check (resolves through the indexer's `scope` table if a db is
  // present). Renamed from "tag" in ADR-078.
  if (typeof sel.scope === "string") {
    if (!hasScope(candidate, sel.scope, db)) return false;
    if (!checkRemaining(sel, candidate, ["scope"], db)) return false;
    return true;
  }

  if (typeof sel.intent_id === "string") {
    if (!servesIntent(candidate, sel.intent_id, db)) return false;
    if (!checkRemaining(sel, candidate, ["intent_id"], db)) return false;
    return true;
  }

  // Plain field-equality form: {node_type: ..., verb: ..., type: ..., actor_type: ...}
  if (!checkRemaining(sel, candidate, [], db)) return false;
  return true;
}

function checkRemaining(
  sel: Record<string, unknown>,
  candidate: Record<string, unknown>,
  alreadyHandled: string[],
  db: Database | undefined,
): boolean {
  for (const [k, v] of Object.entries(sel)) {
    if (alreadyHandled.includes(k)) continue;
    if (k === "all" || k === "any_of" || k === "all_of") continue;

    if (k === "actor_type") {
      // Only meaningful for action candidates; resolve actor's principal type.
      if (candidate.node_type !== "action" || typeof candidate.actor_id !== "string") return false;
      if (!db) return false;
      const row = db.prepare("SELECT type FROM principal WHERE id = ?").get(candidate.actor_id) as
        | { type: string }
        | undefined;
      if (!row) return false;
      if (row.type !== v) return false;
      continue;
    }

    if (candidate[k] !== v) return false;
  }
  return true;
}

function hasScope(candidate: Record<string, unknown>, scopeName: string, db: Database | undefined): boolean {
  // The candidate's `scopes` field carries scope entity IDs; resolve their
  // `name` via the db. Renamed from hasTag in ADR-078.
  const scopes = candidate.scopes;
  if (!Array.isArray(scopes)) return false;
  if (!db) return false;
  const stmt = db.prepare("SELECT name FROM scope WHERE id = ?");
  for (const scopeId of scopes) {
    if (typeof scopeId !== "string") continue;
    const row = stmt.get(scopeId) as { name: string } | undefined;
    if (row?.name === scopeName) return true;
  }
  return false;
}

function servesIntent(
  candidate: Record<string, unknown>,
  intentId: string,
  db: Database | undefined,
): boolean {
  // direct field check first
  const ids = candidate.intent_ids;
  if (Array.isArray(ids) && ids.includes(intentId)) return true;
  // graph fallback: any 'serves' edge from candidate → intent_id
  if (!db || typeof candidate.id !== "string") return false;
  const row = db
    .prepare(
      "SELECT 1 FROM edges WHERE from_id = ? AND to_id = ? AND edge_type = 'serves' LIMIT 1",
    )
    .get(candidate.id, intentId);
  return row !== undefined;
}
