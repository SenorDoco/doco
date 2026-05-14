// Server-only helpers for "capture an entity" endpoints. Single-call API
// for agents/people to write a Decision (or other entity types) without
// round-tripping for ULID generation, ID lookups, and reindex.
//
// Identifiers: every node has exactly one id — the ULID. URLs use the
// ULID; agents/users read the `summary` field for the readable
// handle.
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { generateUlid } from "@doco/shared";
import type { Entity, Scope } from "@doco/shared";
import {
  evaluateScopeRules,
  type EngineEdge,
} from "@doco/core";
import { suggestImplicitEdges } from "@doco/api";
import { rootDir } from "./db.server";
import { reindex } from "./redeem.server";
import { readDocoMetadata, resolveScopeIcons } from "./scope-helpers.server";
import { validatePatch } from "./mutability.server";
import { appendAuditEvent } from "./audit-log.server";
import { getEntity, upsertEntity, withClient } from "@doco/db";

/**
 * Synthetic "path" returned in CaptureResult.path. Postgres is the only
 * storage; there is no on-disk file. Callers (footer renderer, CLI)
 * already key off the entity URL, not this string.
 */
function syntheticPath(nodeType: string, id: string): string {
  return `<postgres>:${nodeType}s/${id}`;
}

/**
 * Read an existing entity's parsed frontmatter + body from Postgres.
 * Replaces the prior filesystem read (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 —
 * alpha forbids back-compat).
 */
async function readEntityFromPostgres(
  nodeType: string,
  id: string,
): Promise<{ fm: Record<string, unknown>; body: string } | null> {
  const row = await getEntity(nodeType, id);
  if (!row) return null;
  const fm = JSON.parse(row.raw_yaml) as Record<string, unknown>;
  const body = row.body_md ?? "";
  return { fm, body };
}

/**
 * Persist an entity to Postgres. The sole writer for entity content
 * (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat;
 * filesystem dual-write is gone).
 *
 * Returns a promise that resolves once the row is durably written.
 * Callers MUST await this before scheduling reindex — otherwise the
 * reindex would race the upsert and may not see the new row.
 */
async function persistEntity(args: {
  nodeType: string;
  id: string;
  docoId: string;
  fm: Record<string, unknown>;
  body?: string;
}): Promise<void> {
  const { fm } = args;
  try {
    await upsertEntity({
      id: args.id,
      doco_id: args.docoId,
      node_type: args.nodeType,
      raw_yaml: JSON.stringify(fm),
      body_md: args.body,
      summary: typeof fm.summary === "string" ? fm.summary : null,
      lifecycle: typeof fm.lifecycle === "string" ? fm.lifecycle : null,
      name: typeof fm.name === "string" ? fm.name : null,
      created_at: typeof fm.created_at === "string" ? fm.created_at : null,
      created_by: typeof fm.created_by === "string" ? fm.created_by : null,
      updated_at: typeof fm.updated_at === "string" ? fm.updated_at : null,
      updated_by: typeof fm.updated_by === "string" ? fm.updated_by : null,
    });
  } catch (err) {
    console.error(`postgres persist failed for ${args.nodeType}/${args.id}:`, err);
    throw err;
  }
}

/**
 * Run reindex (and optionally `attachImplicitEdges`) after the
 * user-visible response has already returned. Fire-and-forget; the
 * caller must have already `await`-ed `persistEntity` so the new row
 * is durably written before the background work starts. Failures
 * log but do not surface — the response committed.
 *
 * A search issued in the same turn that just captured a node may
 * briefly miss it until reindex completes (~seconds with embeddings
 * on). Agents don't re-search what they just wrote, so this is
 * acceptable.
 */
function scheduleBackgroundIndex(
  docoDir: string,
  attachOpts?: Parameters<typeof attachImplicitEdges>[0],
): void {
  void (async () => {
    try {
      await reindex(docoDir);
    } catch (err) {
      console.error(`background reindex failed for ${docoDir}:`, err);
    }
    if (!attachOpts) return;
    try {
      await attachImplicitEdges(attachOpts);
    } catch (err) {
      console.error("background attachImplicitEdges failed:", err);
    }
  })();
}

export interface DecisionDraft {
  /** Required: the question the Decision answers. */
  question: string;
  /** Required: chosen resolution (multi-line ok). */
  chosen: string;
  /** Required: at least one scope name (bare, e.g. "user-flows"). */
  scope_names: string[];

  /** Optional: one-line summary; derived from chosen if absent. */
  summary?: string;
  /** Optional: rejected alternatives. */
  alternatives?: { name: string; rejected_because: string }[];
  /** Optional: intent ids to link via `intent_ids`. */
  intent_ids?: string[];
  /** Optional: principal username who made the decision (resolves to id). */
  decided_by_username?: string;
  /** Optional: principal id who created this entry; defaults to decided_by. */
  created_by_id?: string;
  /** Optional: raw markdown body appended after frontmatter. */
  body_md?: string;
  /** Optional: reference another entity as origin (e.g. born_from a bugfix). */
  born_from?: string;
  /** Optional: defaults to "active". */
  lifecycle?: string;
}

export interface CaptureResult {
  ok: true;
  id: string;
  path: string;
  /** One line per operation. The agent emits each line as its own line. */
  footer_lines: string[];
  /**
   * Wall-clock duration of the whole capture/update batch (write +
   * reindex), measured server-side via `performance.now()`. The
   * renderer appends this as ` (X.Xs)` to the last footer line.
   */
  duration_ms: number;
}

/**
 * Structured per-operation change. Helpers accumulate these as a patch
 * is applied; the route renders one footer line per entry.
 */
export type Op =
  | { kind: "added"; summary: string }
  | { kind: "set"; field: string; value: string }
  | { kind: "cleared"; field: string }
  | { kind: "added_to"; field: string; names: string[] }
  | { kind: "removed_from"; field: string; names: string[] }
  | { kind: "replaced_list"; field: string; names: string[] }
  | { kind: "replaced_body" }
  | { kind: "appended_body"; preview: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "deleted" };

const TRUNC = 120;

/**
 * Escape `\`, `[`, `]` for safe use inside the text portion of a markdown
 * link. Free-form summaries often contain literal brackets (technical
 * prose like `[<id>](<url>)`); without escaping, those close the link
 * parser early and the entire footer line renders as a broken link in
 * chat UIs.
 */
function mdLinkText(s: string): string {
  return s.replace(/[\\[\]]/g, "\\$&");
}

function trunc(s: string, cap = TRUNC): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= cap) return flat;
  const cut = flat.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > cap / 2 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Render one footer line per operation.
 *
 * Format: `[🔮 Doco] {icon} {Type} {verb}: {body} — {scope-suffix}`
 *
 *   - Both `added` and mutation ops render `[<summary>](<url>)` as the
 *     body anchor. Mutations append `.<field> <change>` after the link.
 *   - The URL is built from the entity's ULID id. Readers see the
 *     summary; the id lives in the URL.
 *   - Scope tail (` — <icon> <name>, …`) is omitted when no scopes.
 *   - Timing trailer ` (X.Xs)` lands AFTER the scope tail on the last
 *     line of a batch (appended at end of function).
 */

function capType(t: string): string {
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

export function renderOperationLines(opts: {
  ownerSlug: string;
  docoSlug: string;
  nodeType: string;
  /** Entity ULID id — used to build the markdown link URL. */
  id: string;
  /**
   * Readable summary used as the link text on every op line.
   */
  summary: string;
  /**
   * Absolute base URL for entity links (e.g., `http://localhost:5173`).
   * Typically `new URL(request.url).origin` from the API route. When
   * omitted, the body is rendered without a markdown link.
   */
  docoHost?: string;
  ops: Op[];
  scopes?: { name: string; icon?: string }[];
  duration_ms?: number;
}): string[] {
  const Type = capType(opts.nodeType);
  const linkUrl = opts.docoHost
    ? `${opts.docoHost}/${opts.ownerSlug}/${opts.docoSlug}/${opts.nodeType}/${opts.id}`
    : null;
  const scopeSuffix =
    opts.scopes && opts.scopes.length > 0
      ? ` — ${opts.scopes
          .map((s) => (s.icon ? `${s.icon} ${s.name}` : s.name))
          .join(", ")}`
      : "";
  const buildAnchor = (summaryForLine: string): string => {
    const text = trunc(summaryForLine);
    return linkUrl ? `[${mdLinkText(text)}](${linkUrl})` : text;
  };
  // Mutation lines append `.<field>` after the anchor as dot-notation
  // (entity.property). If the summary text ends with a period, the
  // link text's trailing `.` plus the separator `.` render as `..` —
  // strip the trailing period so the dot-notation stays clean.
  const mutationAnchor = (): string =>
    buildAnchor(opts.summary.replace(/\.+$/, ""));
  const lines = opts.ops.map((op) => {
    switch (op.kind) {
      case "added":
        return `[🔮 Doco] ✍️ ${Type} added: ${buildAnchor(op.summary)}${scopeSuffix}`;
      case "set":
        return `[🔮 Doco] 📝 ${Type} updated: ${mutationAnchor()}.${op.field} set to "${trunc(op.value, 100)}"${scopeSuffix}`;
      case "cleared":
        return `[🔮 Doco] 🧹 ${Type} updated: ${mutationAnchor()}.${op.field} cleared${scopeSuffix}`;
      case "added_to":
        return `[🔮 Doco] ➕ ${Type} updated: ${mutationAnchor()}.${op.field} added: ${op.names.join(", ")}${scopeSuffix}`;
      case "removed_from":
        return `[🔮 Doco] ➖ ${Type} updated: ${mutationAnchor()}.${op.field} removed: ${op.names.join(", ")}${scopeSuffix}`;
      case "replaced_list":
        return `[🔮 Doco] 🔁 ${Type} updated: ${mutationAnchor()}.${op.field} replaced with: ${op.names.join(", ")}${scopeSuffix}`;
      case "replaced_body":
        return `[🔮 Doco] 🔁 ${Type} updated: ${mutationAnchor()}.body replaced${scopeSuffix}`;
      case "appended_body":
        return `[🔮 Doco] ➕ ${Type} updated: ${mutationAnchor()}.body appended: ${trunc(op.preview, 100)}${scopeSuffix}`;
      case "renamed":
        return `[🔮 Doco] 🏷️ ${Type} renamed: ${op.from} → ${buildAnchor(op.to)}${scopeSuffix}`;
      case "deleted":
        return `[🔮 Doco] 🗑️ ${Type} deleted: ${buildAnchor(opts.summary)}${scopeSuffix}`;
    }
  });
  if (typeof opts.duration_ms === "number" && lines.length > 0) {
    const seconds = (opts.duration_ms / 1000).toFixed(1);
    lines[lines.length - 1] = `${lines[lines.length - 1]} (${seconds}s)`;
  }
  return lines;
}

export interface CaptureError {
  error: string;
  /** HTTP status the route should return. Defaults to 400 when absent. */
  status?: number;
  /** When the mutability gate rejects a frozen-claim PATCH, list of disallowed fields the request touched. */
  rejected?: string[];
  /** Human-readable hint pointing at the supersession affordance for frozen claims. */
  hint?: string;
}

/**
 * Decide which audit op type best describes a successful update, and
 * emit one event with before/after deltas for the changed fields.
 *
 * Rule: lifecycle change wins (op = lifecycle.transition). Otherwise,
 * if every changed field is an additive edge (`*_add` was used in the
 * patch) → edge.add. Otherwise → entity.update.
 */
function emitAuditForUpdate(opts: {
  docoDir: string;
  docoId: string;
  actorId: string | null;
  entity_type: string;
  entity_id: string;
  changed: string[];
  beforeFm: Record<string, unknown>;
  afterFm: Record<string, unknown>;
  patchKeys: string[];
}): void {
  const { changed, beforeFm, afterFm, patchKeys } = opts;
  if (changed.length === 0) return;

  let op: "lifecycle.transition" | "edge.add" | "entity.update";
  if (changed.includes("lifecycle")) {
    op = "lifecycle.transition";
  } else {
    const hasAddPatch = patchKeys.some((k) => k.endsWith("_add"));
    const allChangesAreEdges = changed.every((f) => f === "scopes" || f === "intent_ids");
    op = hasAddPatch && allChangesAreEdges ? "edge.add" : "entity.update";
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of changed) {
    if (field === "body") {
      before.body = "<changed>";
      after.body = "<changed>";
      continue;
    }
    before[field] = beforeFm[field] ?? null;
    after[field] = afterFm[field] ?? null;
  }

  try {
    appendAuditEvent({
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      by: opts.actorId,
      entity_type: opts.entity_type,
      entity_id: opts.entity_id,
      op,
      before,
      after,
    });
  } catch (err) {
    // Audit log append must not block the user-visible mutation result.
    // The entity write already succeeded; surface the failure in
    // server logs but return the original success response.
    console.error("audit-log: failed to append event", err);
  }
}

/**
 * Emit an entity.create audit event after a successful capture write.
 */
function emitAuditForCreate(opts: {
  docoDir: string;
  docoId: string;
  actorId: string | null;
  entity_type: string;
  entity_id: string;
  summary?: string;
}): void {
  try {
    appendAuditEvent({
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      by: opts.actorId,
      entity_type: opts.entity_type,
      entity_id: opts.entity_id,
      op: "entity.create",
      after: opts.summary ? { summary: opts.summary } : undefined,
    });
  } catch (err) {
    console.error("audit-log: failed to append create event", err);
  }
}

/**
 * Distill a one-line summary from a (possibly multi-paragraph) body.
 */
function distillSummary(body: string, cap = 180): string {
  const firstLine = body.trim().split(/\n/)[0]?.trim() ?? "";
  if (!firstLine) return "";
  const sentenceMatch = firstLine.match(/^.{1,300}?[.!?](?=\s|$)/);
  const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : firstLine;
  if (firstSentence.length <= cap) return firstSentence;
  const cut = firstSentence.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  const snapped = lastSpace > cap / 2 ? cut.slice(0, lastSpace) : cut;
  return `${snapped.replace(/[\s.,;:!?-]+$/, "")}…`;
}

/**
 * Map a list of bare scope names to their entity ids by reading the
 * Doco's scopes/ directory.
 */
// A scope is "retired" when its lifecycle is `abandoned` (retired with no
// replacement) or `superseded` (replaced by another scope). Both keep the
// scope on disk so existing references stay readable, but new captures
// referencing them are rejected here — pick a different scope or
// reactivate the retired one.
const RETIRED_LIFECYCLES: ReadonlySet<string> = new Set(["abandoned", "superseded"]);

export async function resolveScopeNames(
  docoDir: string,
  names: string[],
): Promise<{
  ids: string[];
  unknown: string[];
  available: string[];
  retired: string[];
}> {
  const ids: string[] = [];
  const unknown: string[] = [];
  const retired: string[] = [];
  const available: string[] = [];
  const byName = new Map<string, { id: string; lifecycle: string }>();
  const meta = readDocoMetadata(docoDir);
  if (meta?.docoId) {
    try {
      await withClient(async (c) => {
        const rows = (
          await c.query<{ id: string; name: string; raw_yaml: string }>(
            `SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1`,
            [meta.docoId],
          )
        ).rows;
        for (const r of rows) {
          let lifecycle = "active";
          try {
            const e = parseYaml(r.raw_yaml) as { lifecycle?: string };
            if (typeof e?.lifecycle === "string") lifecycle = e.lifecycle;
          } catch {}
          byName.set(r.name, { id: r.id, lifecycle });
          if (!RETIRED_LIFECYCLES.has(lifecycle)) available.push(r.name);
        }
      });
    } catch {
      // PG unreachable — fall through with empty maps.
    }
  }
  for (const n of names) {
    const entry = byName.get(n);
    if (!entry) {
      unknown.push(n);
      continue;
    }
    ids.push(entry.id);
    if (RETIRED_LIFECYCLES.has(entry.lifecycle)) retired.push(n);
  }
  available.sort();
  return { ids, unknown, available, retired };
}

/**
 * Resolve scope names → ids, returning a typed error if any are missing or
 * retired. Centralizes the boilerplate that all three captures + every
 * list-op share.
 */
async function resolveScopeOrError(
  docoDir: string,
  names: string[],
  context: { verb: "tag" | "replace" | "add"; nodeKind?: string },
): Promise<{ ids: string[] } | CaptureError> {
  const { ids, unknown, available, retired } = await resolveScopeNames(docoDir, names);
  if (unknown.length > 0) {
    const availStr = available.join(", ") || "(none — create scopes first via /<owner>/<doco>/scopes/new)";
    return { error: `Unknown scope name(s): ${unknown.join(", ")}. Available: ${availStr}` };
  }
  if (retired.length > 0) {
    if (context.verb === "tag") {
      const noun = context.nodeKind ?? "node";
      return {
        error: `Cannot tag a new ${noun} with retired scope(s): ${retired.join(", ")}. Reactivate the scope first or pick a different one. Available active scopes: ${available.join(", ")}`,
      };
    }
    if (context.verb === "replace") {
      return { error: `Cannot replace scopes with retired one(s): ${retired.join(", ")}. Reactivate first or omit them.` };
    }
    return { error: `Cannot add retired scope(s) to a node: ${retired.join(", ")}. Reactivate first or pick a different scope.` };
  }
  return { ids };
}

/**
 * Apply the three list-op shapes (replace / add / remove) for a single
 * frontmatter field. Returns the ops emitted (for footer rendering) and
 * the list of changed-keys. Used by `updateDecision` + `updateEntity`
 * for both `scopes` and `intent_ids` lists.
 *
 * `lookup` translates the input names to the ids stored on disk:
 *   - for scopes:   name → scope_<ULID> (uses resolveScopeNames)
 *   - for intents:  the input IS the id (pass-through)
 */
async function applyListOp(
  fm: Record<string, unknown>,
  fieldKey: string,
  patch: {
    replace?: string[];
    add?: string[];
    remove?: string[];
  },
  lookup: (names: string[]) => Promise<{ ids: string[] } | CaptureError> | { ids: string[] } | CaptureError,
): Promise<{ changed: boolean; ops: Op[]; error?: string }> {
  const ops: Op[] = [];
  let changedField = false;

  if (patch.replace !== undefined) {
    const r = await lookup(patch.replace);
    if ("error" in r) return { changed: false, ops, error: r.error };
    fm[fieldKey] = r.ids;
    ops.push({ kind: "replaced_list", field: fieldKey, names: patch.replace });
    changedField = true;
  }
  if (patch.add !== undefined) {
    const r = await lookup(patch.add);
    if ("error" in r) return { changed: false, ops, error: r.error };
    const current = Array.isArray(fm[fieldKey]) ? (fm[fieldKey] as string[]) : [];
    const merged = [...current];
    const addedNames: string[] = [];
    for (let i = 0; i < r.ids.length; i++) {
      const id = r.ids[i]!;
      if (!merged.includes(id)) {
        merged.push(id);
        addedNames.push(patch.add[i]!);
      }
    }
    if (addedNames.length > 0) {
      fm[fieldKey] = merged;
      ops.push({ kind: "added_to", field: fieldKey, names: addedNames });
      changedField = true;
    }
  }
  if (patch.remove !== undefined) {
    const r = await lookup(patch.remove);
    if ("error" in r) return { changed: false, ops, error: r.error };
    const current = Array.isArray(fm[fieldKey]) ? (fm[fieldKey] as string[]) : [];
    const removedNames: string[] = [];
    for (let i = 0; i < r.ids.length; i++) {
      if (current.includes(r.ids[i]!)) removedNames.push(patch.remove[i]!);
    }
    const filtered = current.filter((s) => !r.ids.includes(s));
    if (filtered.length !== current.length) {
      fm[fieldKey] = filtered;
      ops.push({ kind: "removed_from", field: fieldKey, names: removedNames });
      changedField = true;
    }
  }
  return { changed: changedField, ops };
}

/**
 * Look up a host-level Principal by username from Postgres. Returns null
 * if no row matches or the lookup fails (alpha: PG unreachable is a
 * soft-null, not a throw).
 */
export async function resolvePrincipalUsername(
  username: string,
): Promise<string | null> {
  try {
    return await withClient(async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM principals WHERE username = $1 LIMIT 1`,
        [username],
      );
      return r.rows[0]?.id ?? null;
    });
  } catch {
    return null;
  }
}

async function loadAllScopes(docoDir: string): Promise<Map<string, Scope>> {
  const scopes = new Map<string, Scope>();
  const meta = readDocoMetadata(docoDir);
  if (!meta?.docoId) return scopes;
  try {
    await withClient(async (c) => {
      const r = await c.query<{ raw_yaml: string }>(
        `SELECT raw_yaml FROM scopes WHERE doco_id = $1`,
        [meta.docoId],
      );
      for (const row of r.rows) {
        try {
          const e = parseYaml(row.raw_yaml) as Record<string, unknown>;
          if (e && typeof e.id === "string") scopes.set(e.id, e as unknown as Scope);
        } catch {}
      }
    });
  } catch {
    // PG unreachable — return empty.
  }
  return scopes;
}

export async function runScopeRules(opts: {
  docoDir: string;
  ownerSlug: string;
  docoSlug: string;
  entityFm: Record<string, unknown>;
}): Promise<{ error: string } | null> {
  const { docoDir, entityFm } = opts;
  const scopeIds = Array.isArray(entityFm.scopes) ? (entityFm.scopes as string[]) : [];
  const allScopes = await loadAllScopes(docoDir);

  const readRules = (s: Scope): unknown[] => {
    const rec = s as unknown as Record<string, unknown>;
    return Array.isArray(rec.rules) ? (rec.rules as unknown[]) : [];
  };

  const rulesToRun: { scope: Scope; rules: unknown[] }[] = [];
  for (const sid of scopeIds) {
    const s = allScopes.get(sid);
    if (!s) continue;
    const rules = readRules(s);
    if (rules.length > 0) rulesToRun.push({ scope: s, rules });
  }
  for (const s of allScopes.values()) {
    const sname = (s as unknown as Record<string, unknown>).name;
    if (sname !== "constitution") continue;
    if (scopeIds.includes(s.id)) break;
    const rules = readRules(s);
    const onlyMandatory = rules.filter(
      (r) => (r as Record<string, unknown>).kind === "mandatory_scope",
    );
    if (onlyMandatory.length > 0) rulesToRun.push({ scope: s, rules: onlyMandatory });
    break;
  }
  if (rulesToRun.length === 0) return null;

  const edges: EngineEdge[] = [];
  const meta = readDocoMetadata(docoDir);
  if (meta?.docoId) {
    try {
      await withClient(async (c) => {
        const r = await c.query<{ from_id: string; to_id: string; edge_type: string }>(
          `SELECT from_id, to_id, edge_type FROM edges WHERE doco_id = $1`,
          [meta.docoId],
        );
        for (const row of r.rows) edges.push(row);
      });
    } catch {
      /* index not built yet — fall through with synthesized edges only */
    }
  }
  const candidateId = (entityFm.id as string) ?? "";
  if (candidateId) {
    if (Array.isArray(entityFm.intent_ids)) {
      for (const t of entityFm.intent_ids as string[]) {
        edges.push({ from_id: candidateId, to_id: t, edge_type: "serves" });
      }
    }
    if (Array.isArray(entityFm.decision_ids)) {
      for (const t of entityFm.decision_ids as string[]) {
        edges.push({ from_id: candidateId, to_id: t, edge_type: "enacts" });
      }
    }
    if (Array.isArray(entityFm.scopes)) {
      for (const t of entityFm.scopes as string[]) {
        edges.push({ from_id: candidateId, to_id: t, edge_type: "in_scope_of" });
      }
    }
    if (typeof entityFm.born_from === "string") {
      edges.push({ from_id: candidateId, to_id: entityFm.born_from, edge_type: "born_from" });
    }
    if (typeof entityFm.target_ref === "string") {
      edges.push({ from_id: candidateId, to_id: entityFm.target_ref, edge_type: "tests" });
    }
  }

  const entityForEngine = entityFm as unknown as Entity;
  const allViolations: { scopeName: string; reason: string; severity: "error" | "warning" | "pending" }[] = [];
  for (const { scope, rules } of rulesToRun) {
    const filteredScope = {
      ...(scope as unknown as Record<string, unknown>),
      rules,
    } as unknown as Scope;
    const v = evaluateScopeRules({
      entity: entityForEngine,
      scope: filteredScope,
      allEdges: edges,
      entityScopes: scopeIds,
    });
    const scopeName = (scope as unknown as { name: string }).name;
    allViolations.push(...v.map((vv) => ({ scopeName, reason: vv.reason, severity: vv.severity })));
  }
  const fails = allViolations.filter((v) => v.severity === "error");
  if (fails.length === 0) return null;
  const lines = fails.map((f) => `${f.scopeName}: ${f.reason}`);
  return {
    error: `Scope rule${fails.length > 1 ? "s" : ""} failed — ${lines.join(" | ")}. Capture aborted.`,
  };
}

async function attachImplicitEdges(opts: {
  docoDir: string;
  ownerSlug: string;
  docoSlug: string;
  entityId: string;
  entityType: string;
  entitySummary: string;
  alreadyReferenced: Set<string>;
}): Promise<number> {
  type CandidateRow = { id: string; node_type: string; summary: string; name?: string };
  let candidates: CandidateRow[] = [];
  const meta = readDocoMetadata(opts.docoDir);
  if (!meta?.docoId) return 0;
  try {
    await withClient(async (c) => {
      const types: { table: string; nodeType: string; hasName: boolean }[] = [
        { table: "decisions", nodeType: "decision", hasName: false },
        { table: "intents", nodeType: "intent", hasName: false },
        { table: "rules", nodeType: "rule", hasName: false },
        { table: "actions", nodeType: "action", hasName: false },
        { table: "reasoning", nodeType: "reasoning", hasName: false },
        { table: "scopes", nodeType: "scope", hasName: true },
        { table: "evals", nodeType: "eval", hasName: true },
      ];
      for (const t of types) {
        try {
          const cols = t.hasName ? "id, summary, name" : "id, summary";
          const r = await c.query<Record<string, string>>(
            `SELECT ${cols} FROM ${t.table}
              WHERE doco_id = $1
              ORDER BY created_at DESC
              LIMIT 20`,
            [meta.docoId],
          );
          for (const row of r.rows) {
            if (row.id === opts.entityId) continue;
            if (opts.alreadyReferenced.has(row.id)) continue;
            const cand: CandidateRow = { id: row.id, node_type: t.nodeType, summary: row.summary ?? "" };
            if (row.name) cand.name = row.name;
            candidates.push(cand);
          }
        } catch {
          /* table missing */
        }
      }
    });
  } catch {
    return 0;
  }
  candidates = candidates.slice(0, 50);
  if (candidates.length === 0) return 0;
  const proposed = await suggestImplicitEdges({
    source: {
      id: opts.entityId,
      node_type: opts.entityType,
      summary: opts.entitySummary,
    },
    candidates,
  });
  if (proposed.length === 0) return 0;
  try {
    const existing = await readEntityFromPostgres(opts.entityType, opts.entityId);
    if (!existing) return 0;
    const fm = existing.fm;
    const prior = Array.isArray(fm.auto_edges) ? (fm.auto_edges as unknown[]) : [];
    fm.auto_edges = [
      ...prior,
      ...proposed.map((p) => ({ to_id: p.to_id, edge_type: p.edge_type, reason: p.reason })),
    ];
    await persistEntity({
      nodeType: opts.entityType,
      id: opts.entityId,
      docoId: String(fm.doco_id ?? ""),
      fm,
      body: existing.body,
    });
    await reindex(opts.docoDir);
    return proposed.length;
  } catch {
    return 0;
  }
}

export async function captureDecision(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: DecisionDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.question?.trim()) return { error: "question is required." };
  if (!draft.chosen?.trim()) return { error: "chosen is required." };
  if (!Array.isArray(draft.scope_names) || draft.scope_names.length === 0) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, { verb: "tag", nodeKind: "node" });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  const intentIds: string[] = Array.isArray(draft.intent_ids) ? draft.intent_ids : [];

  let decidedById: string | null = null;
  if (draft.decided_by_username) {
    decidedById = await resolvePrincipalUsername(draft.decided_by_username);
    if (!decidedById) {
      return { error: `Unknown principal username: ${draft.decided_by_username}` };
    }
  }
  if (!decidedById && draft.created_by_id) {
    decidedById = draft.created_by_id;
  }
  if (!decidedById) {
    return {
      error:
        "decided_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }

  const id = `decision_${generateUlid()}`;

  const summary =
    draft.summary?.trim() ||
    distillSummary(draft.chosen) ||
    `Decision: ${id}`;

  const now = new Date().toISOString();
  const createdById = draft.created_by_id ?? decidedById ?? null;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "decision",
    summary,
    ...(draft.born_from ? { born_from: draft.born_from } : {}),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    question: draft.question.trim(),
    chosen: draft.chosen.trim(),
    ...(Array.isArray(draft.alternatives) && draft.alternatives.length > 0
      ? { alternatives: draft.alternatives }
      : {}),
    decided_by: decidedById,
    decided_at: now,
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    lifecycle: draft.lifecycle ?? "active",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "decision",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? decidedById ?? null,
    entity_type: "decision",
    entity_id: id,
    summary,
  });
  scheduleBackgroundIndex(docoDir, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "decision",
    entitySummary: summary,
    alreadyReferenced: new Set([
      ...intentIds,
      ...scopeIds,
      ...(typeof draft.born_from === "string" ? [draft.born_from] : []),
    ]),
  });
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "decision",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    scopes: await resolveScopeIcons(docoDir, scopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath("decision", id),
    footer_lines,
    duration_ms,
  };
}

export interface DecisionPatch {
  summary?: string;
  question?: string;
  chosen?: string;
  alternatives?: { name: string; rejected_because: string }[];
  scope_names?: string[];
  scope_names_add?: string[];
  scope_names_remove?: string[];
  intent_ids?: string[];
  intent_ids_add?: string[];
  intent_ids_remove?: string[];
  decided_by_username?: string;
  body_md?: string;
  body_md_append?: string;
  born_from?: string | null;
  superseded_by?: string | null;
  lifecycle?: string;
}

export interface UpdateResult extends CaptureResult {
  changed: string[];
}

export async function updateDecision(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  decisionId: string,
  patch: DecisionPatch,
  docoHost?: string,
  actorId?: string | null,
): Promise<UpdateResult | CaptureError> {
  const startedAt = performance.now();
  const existing = await readEntityFromPostgres("decision", decisionId);
  if (!existing) return { error: `Decision not found: ${decisionId}` };
  const fm = existing.fm;
  const existingBody = existing.body;

  const gate = validatePatch("decision", fm.lifecycle as string | undefined, patch as Record<string, unknown>);
  if (!gate.allowed) {
    return {
      error: `Decision is frozen — patch touched disallowed field(s): ${gate.rejected.join(", ")}.`,
      status: 409,
      rejected: gate.rejected,
      hint: gate.hint,
    };
  }

  // Snapshot pre-mutation values for the audit log; only the fields
  // that get mutated below are inspected later, so a shallow copy of
  // primitives + reference grab for arrays is sufficient.
  const beforeFm: Record<string, unknown> = { ...fm };

  const changed: string[] = [];
  const ops: Op[] = [];

  const setScalar = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    const v = value;
    if (v === "" || v === null) {
      if (key in fm) {
        delete fm[key];
        changed.push(key);
        ops.push({ kind: "cleared", field: key });
      }
    } else if (fm[key] !== v) {
      fm[key] = v;
      changed.push(key);
      ops.push({ kind: "set", field: key, value: v });
    }
  };

  setScalar("summary", patch.summary?.trim());
  setScalar("question", patch.question?.trim());
  setScalar("chosen", patch.chosen?.trim());
  if (patch.alternatives !== undefined) {
    fm.alternatives = patch.alternatives;
    changed.push("alternatives");
    ops.push({
      kind: "replaced_list",
      field: "alternatives",
      names: patch.alternatives.map((a) => a.name),
    });
  }
  if (patch.lifecycle !== undefined) {
    setScalar("lifecycle", patch.lifecycle);
  }
  if (patch.born_from !== undefined) {
    if (patch.born_from === null || patch.born_from === "") {
      if ("born_from" in fm) {
        delete fm.born_from;
        changed.push("born_from");
        ops.push({ kind: "cleared", field: "born_from" });
      }
    } else {
      fm.born_from = patch.born_from;
      changed.push("born_from");
      ops.push({ kind: "set", field: "born_from", value: patch.born_from });
    }
  }
  if (patch.superseded_by !== undefined) {
    if (patch.superseded_by === null || patch.superseded_by === "") {
      if ("superseded_by" in fm) {
        delete fm.superseded_by;
        changed.push("superseded_by");
        ops.push({ kind: "cleared", field: "superseded_by" });
      }
    } else {
      fm.superseded_by = patch.superseded_by;
      changed.push("superseded_by");
      ops.push({ kind: "set", field: "superseded_by", value: patch.superseded_by });
    }
  }

  // scopes (replace/add/remove)
  const scopeResult = await applyListOp(
    fm,
    "scopes",
    {
      ...(patch.scope_names !== undefined ? { replace: patch.scope_names } : {}),
      ...(patch.scope_names_add !== undefined ? { add: patch.scope_names_add } : {}),
      ...(patch.scope_names_remove !== undefined ? { remove: patch.scope_names_remove } : {}),
    },
    async (names) => resolveScopeOrError(docoDir, names, { verb: "replace" }),
  );
  if (scopeResult.error) return { error: scopeResult.error };
  if (scopeResult.changed) {
    if (!changed.includes("scopes")) changed.push("scopes");
    ops.push(...scopeResult.ops);
  }

  // intent_ids (replace/add/remove) — input is already an id, pass-through.
  const intentResult = await applyListOp(
    fm,
    "intent_ids",
    {
      ...(patch.intent_ids !== undefined ? { replace: patch.intent_ids } : {}),
      ...(patch.intent_ids_add !== undefined ? { add: patch.intent_ids_add } : {}),
      ...(patch.intent_ids_remove !== undefined ? { remove: patch.intent_ids_remove } : {}),
    },
    (ids) => ({ ids }),
  );
  if (intentResult.changed) {
    if (!changed.includes("intent_ids")) changed.push("intent_ids");
    ops.push(...intentResult.ops);
  }

  if (patch.decided_by_username !== undefined) {
    const pid = await resolvePrincipalUsername(patch.decided_by_username);
    if (!pid) return { error: `Unknown principal username: ${patch.decided_by_username}` };
    if (fm.decided_by !== pid) {
      fm.decided_by = pid;
      changed.push("decided_by");
      ops.push({ kind: "set", field: "decided_by", value: patch.decided_by_username });
    }
  }

  let finalBody: string;
  if (patch.body_md !== undefined) {
    finalBody = `\n${patch.body_md.trim()}\n`;
    if (patch.body_md.trim() !== existingBody.trim()) {
      changed.push("body");
      ops.push({ kind: "replaced_body" });
    }
  } else if (patch.body_md_append !== undefined) {
    finalBody = existingBody
      ? `\n${existingBody.replace(/\n+$/, "")}\n\n${patch.body_md_append.trim()}\n`
      : `\n${patch.body_md_append.trim()}\n`;
    changed.push("body");
    ops.push({ kind: "appended_body", preview: patch.body_md_append });
  } else {
    finalBody = `\n${existingBody}`;
  }

  if (changed.length === 0) {
    return { error: "No fields changed." };
  }

  await persistEntity({
    nodeType: "decision",
    id: decisionId,
    docoId,
    fm,
    body: finalBody.trim(),
  });
  emitAuditForUpdate({
    docoDir,
    docoId,
    actorId: actorId ?? null,
    entity_type: "decision",
    entity_id: decisionId,
    changed,
    beforeFm,
    afterFm: fm,
    patchKeys: Object.keys(patch),
  });
  scheduleBackgroundIndex(docoDir);
  const summary = String(fm.summary ?? decisionId);
  const duration_ms = Math.round(performance.now() - startedAt);
  const finalScopeIds = Array.isArray(fm.scopes) ? (fm.scopes as string[]) : [];
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "decision",
    id: decisionId,
    summary,
    docoHost,
    ops,
    scopes: await resolveScopeIcons(docoDir, finalScopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id: decisionId,
    path: syntheticPath("decision", decisionId),
    footer_lines,
    changed,
    duration_ms,
  };
}

type NodeTypeName =
  | "decision"
  | "intent"
  | "rule"
  | "action"
  | "reasoning"
  | "reference"
  | "scope";

export interface EntityPatch {
  summary?: string;
  lifecycle?: string;
  scope_names?: string[];
  scope_names_add?: string[];
  scope_names_remove?: string[];
  intent_ids?: string[];
  intent_ids_add?: string[];
  intent_ids_remove?: string[];
  body_md?: string;
  body_md_append?: string;
  born_from?: string | null;
  superseded_by?: string | null;
  [k: string]: unknown;
}

export async function updateEntity(opts: {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  nodeType: NodeTypeName;
  pluralDir: string;
  id: string;
  patch: EntityPatch;
  allowedFields: string[];
  docoHost?: string;
  actorId?: string | null;
}): Promise<UpdateResult | CaptureError> {
  const startedAt = performance.now();
  const { docoDir, docoId, ownerSlug, docoSlug, nodeType, id, patch, allowedFields, docoHost, actorId } = opts;

  const existing = await readEntityFromPostgres(nodeType, id);
  if (!existing) return { error: `${nodeType} not found: ${id}` };
  const fm = existing.fm;
  const existingBody = existing.body;
  // Types with a markdown body get body_md; others (scope, reference)
  // are pure YAML and ignore body operations.
  const isMd = nodeType !== "scope" && nodeType !== "reference";

  const gate = validatePatch(nodeType, fm.lifecycle as string | undefined, patch as Record<string, unknown>);
  if (!gate.allowed) {
    return {
      error: `${nodeType} is frozen — patch touched disallowed field(s): ${gate.rejected.join(", ")}.`,
      status: 409,
      rejected: gate.rejected,
      hint: gate.hint,
    };
  }

  // Snapshot pre-mutation values for the audit log.
  const beforeFm: Record<string, unknown> = { ...fm };

  const changed: string[] = [];
  const ops: Op[] = [];

  const setScalar = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (value === null || value === "") {
      if (key in fm) {
        delete fm[key];
        changed.push(key);
        ops.push({ kind: "cleared", field: key });
      }
    } else if (fm[key] !== value) {
      fm[key] = value;
      changed.push(key);
      ops.push({ kind: "set", field: key, value: String(value) });
    }
  };

  setScalar("summary", typeof patch.summary === "string" ? patch.summary.trim() : undefined);
  setScalar("lifecycle", patch.lifecycle);
  if (patch.born_from !== undefined) {
    if (patch.born_from === null || patch.born_from === "") {
      if ("born_from" in fm) {
        delete fm.born_from;
        changed.push("born_from");
        ops.push({ kind: "cleared", field: "born_from" });
      }
    } else {
      fm.born_from = patch.born_from;
      changed.push("born_from");
      ops.push({ kind: "set", field: "born_from", value: patch.born_from });
    }
  }
  if (patch.superseded_by !== undefined) {
    if (patch.superseded_by === null || patch.superseded_by === "") {
      if ("superseded_by" in fm) {
        delete fm.superseded_by;
        changed.push("superseded_by");
        ops.push({ kind: "cleared", field: "superseded_by" });
      }
    } else {
      fm.superseded_by = patch.superseded_by;
      changed.push("superseded_by");
      ops.push({ kind: "set", field: "superseded_by", value: patch.superseded_by });
    }
  }

  for (const k of allowedFields) {
    if (k in patch && patch[k] !== undefined) {
      const v = patch[k];
      if (v === null || v === "") {
        if (k in fm) {
          delete fm[k];
          changed.push(k);
          ops.push({ kind: "cleared", field: k });
        }
      } else if (fm[k] !== v) {
        fm[k] = v;
        changed.push(k);
        ops.push({ kind: "set", field: k, value: typeof v === "string" ? v : JSON.stringify(v) });
      }
    }
  }

  // scopes (replace/add/remove)
  const eScopeResult = await applyListOp(
    fm,
    "scopes",
    {
      ...(patch.scope_names !== undefined ? { replace: patch.scope_names } : {}),
      ...(patch.scope_names_add !== undefined ? { add: patch.scope_names_add } : {}),
      ...(patch.scope_names_remove !== undefined ? { remove: patch.scope_names_remove } : {}),
    },
    async (names) => resolveScopeOrError(docoDir, names, { verb: "replace" }),
  );
  if (eScopeResult.error) return { error: eScopeResult.error };
  if (eScopeResult.changed) {
    if (!changed.includes("scopes")) changed.push("scopes");
    ops.push(...eScopeResult.ops);
  }

  // intent_ids (replace/add/remove)
  const eIntentResult = await applyListOp(
    fm,
    "intent_ids",
    {
      ...(patch.intent_ids !== undefined ? { replace: patch.intent_ids } : {}),
      ...(patch.intent_ids_add !== undefined ? { add: patch.intent_ids_add } : {}),
      ...(patch.intent_ids_remove !== undefined ? { remove: patch.intent_ids_remove } : {}),
    },
    (ids) => ({ ids }),
  );
  if (eIntentResult.changed) {
    if (!changed.includes("intent_ids")) changed.push("intent_ids");
    ops.push(...eIntentResult.ops);
  }

  let bodyOp: "replace" | "append" | "none" = "none";
  if (isMd) {
    if (patch.body_md !== undefined) bodyOp = "replace";
    else if (patch.body_md_append !== undefined) bodyOp = "append";
  }
  if (bodyOp !== "none") {
    changed.push("body");
    if (bodyOp === "replace") ops.push({ kind: "replaced_body" });
    else ops.push({ kind: "appended_body", preview: String(patch.body_md_append ?? "") });
  }

  if (changed.length === 0) {
    return { error: "No fields changed." };
  }

  // Compute the new body for Postgres storage. Pure-YAML types (scope,
  // reference) carry no body.
  let nextBody = "";
  if (isMd) {
    if (patch.body_md !== undefined) {
      nextBody = String(patch.body_md).trim();
    } else if (patch.body_md_append !== undefined) {
      nextBody = existingBody
        ? `${existingBody.replace(/\n+$/, "")}\n\n${String(patch.body_md_append).trim()}`
        : String(patch.body_md_append).trim();
    } else {
      nextBody = existingBody.trim();
    }
  }
  await persistEntity({
    nodeType,
    id,
    docoId,
    fm,
    body: nextBody,
  });
  emitAuditForUpdate({
    docoDir,
    docoId,
    actorId: actorId ?? null,
    entity_type: nodeType,
    entity_id: id,
    changed,
    beforeFm,
    afterFm: fm,
    patchKeys: Object.keys(patch),
  });
  scheduleBackgroundIndex(docoDir);

  const summary = String(fm.summary ?? fm.name ?? id);
  const duration_ms = Math.round(performance.now() - startedAt);
  const finalScopeIds = Array.isArray(fm.scopes) ? (fm.scopes as string[]) : [];
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType,
    id,
    summary,
    docoHost,
    ops,
    scopes: await resolveScopeIcons(docoDir, finalScopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath(nodeType, id),
    footer_lines,
    changed,
    duration_ms,
  };
}

export interface IntentDraft {
  /** Required: one-line "what someone wants" summary. */
  summary: string;
  /** Required: at least one scope name. */
  scope_names: string[];

  /** Optional: short title (defaults to summary). */
  title?: string;
  /** Optional: markdown body — context + non-goals + success criteria. */
  body_md?: string;
  /** Optional: principal username who wants this. Resolves to id. */
  wanted_by_username?: string;
  /** Optional: defaults to "active". */
  lifecycle?: string;
}

export async function captureIntent(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: IntentDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.summary?.trim()) return { error: "summary is required." };
  if (!Array.isArray(draft.scope_names) || draft.scope_names.length === 0) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, { verb: "tag", nodeKind: "Intent" });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let wantedById: string | null = null;
  if (draft.wanted_by_username) {
    wantedById = await resolvePrincipalUsername(draft.wanted_by_username);
    if (!wantedById) {
      return { error: `Unknown principal username: ${draft.wanted_by_username}` };
    }
  }
  if (!wantedById) {
    return {
      error:
        "wanted_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }

  const id = `intent_${generateUlid()}`;
  const summary = draft.summary.trim();
  const title = draft.title?.trim() || summary;

  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "intent",
    summary,
    title,
    wanted_by: wantedById,
    created_at: now,
    created_by: wantedById,
    lifecycle: draft.lifecycle ?? "active",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "intent",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: wantedById,
    entity_type: "intent",
    entity_id: id,
    summary,
  });
  scheduleBackgroundIndex(docoDir, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "intent",
    entitySummary: summary,
    alreadyReferenced: new Set([...scopeIds, ...(wantedById ? [wantedById] : [])]),
  });
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "intent",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    scopes: await resolveScopeIcons(docoDir, scopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath("intent", id),
    footer_lines,
    duration_ms,
  };
}

export interface EvalDraft {
  /** Required: short readable name. */
  name: string;
  /** Required: at least one scope name. */
  scope_names: string[];
  /** Required: criterion shape. */
  criterion: { kind: "exact" | "shape" | "llm-judge"; spec?: string };
  /** Optional: prose body. */
  body_md?: string;
  /** Optional: one-line summary; derived from description / name if absent. */
  summary?: string;
  /** Optional: free-form description. */
  description?: string;
  /** Optional: input value (any shape). */
  input?: unknown;
  /** Optional: expected outcome (any shape; prose for llm-judge). */
  expected?: unknown;
  /** Optional: id of the entity this Eval tests. */
  target_ref?: string;
  /** Optional: intent ids to link via `intent_ids`. */
  intent_ids?: string[];
  /** Optional: principal username who authored the Eval. */
  authored_by_username?: string;
  /** Optional default: lifecycle = "active". */
  lifecycle?: string;
}

export async function captureEval(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: EvalDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.name?.trim()) return { error: "name is required." };
  if (!draft.criterion?.kind) return { error: "criterion.kind is required." };
  if (!["exact", "shape", "llm-judge"].includes(draft.criterion.kind)) {
    return { error: `Unknown criterion.kind: ${draft.criterion.kind}` };
  }
  if (!Array.isArray(draft.scope_names) || draft.scope_names.length === 0) {
    return { error: "scope_names must be a non-empty array." };
  }
  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, { verb: "tag", nodeKind: "Eval" });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let authoredById: string | null = null;
  if (draft.authored_by_username) {
    authoredById = await resolvePrincipalUsername(draft.authored_by_username);
    if (!authoredById) {
      return { error: `Unknown principal username: ${draft.authored_by_username}` };
    }
  }
  if (!authoredById) {
    return {
      error:
        "authored_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }

  const intentIds: string[] = Array.isArray(draft.intent_ids) ? draft.intent_ids : [];

  const id = `eval_${generateUlid()}`;

  const now = new Date().toISOString();
  const summary =
    draft.summary?.trim() ||
    (typeof draft.description === "string" && draft.description.trim()) ||
    `Eval: ${draft.name.trim()}`;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "eval",
    summary,
    name: draft.name.trim(),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.input !== undefined ? { input: draft.input } : {}),
    ...(draft.expected !== undefined ? { expected: draft.expected } : {}),
    criterion: draft.criterion,
    ...(draft.target_ref ? { target_ref: draft.target_ref } : {}),
    last_status: "pending",
    created_at: now,
    created_by: authoredById,
    lifecycle: draft.lifecycle ?? "active",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "eval",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: authoredById,
    entity_type: "eval",
    entity_id: id,
    summary,
  });
  scheduleBackgroundIndex(docoDir, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "eval",
    entitySummary: summary,
    alreadyReferenced: new Set([
      ...scopeIds,
      ...(draft.target_ref ? [draft.target_ref] : []),
    ]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "eval",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    scopes: await resolveScopeIcons(docoDir, scopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath("eval", id),
    footer_lines,
    duration_ms,
  };
}

// ─── Action ───────────────────────────────────────────────────────────────

export interface ActionDraft {
  /** Required: one-line summary of what was done. */
  summary: string;
  /** Required: at least one scope name (bare). */
  scope_names: string[];
  /** Required: short verb naming the action (`refactor`, `migrate`, …). */
  verb: string;

  /** Optional: intent ids the action serves. */
  intent_ids?: string[];
  /** Optional: decision ids the action enacts. */
  decision_ids?: string[];
  /** Optional: reasoning ids consulted by the action. */
  reasoning_ids?: string[];
  /** Optional: entity ids this action follows (chronological / causal). */
  follows?: string[];
  /** Optional: verb-specific inputs (any shape). */
  inputs?: unknown;
  /** Optional: verb-specific outputs (any shape). */
  outputs?: unknown;
  /** Optional: principal username who performed the action. Resolves to id. */
  performed_by_username?: string;
  /** Optional: principal id who created this entry; defaults to performed_by. */
  created_by_id?: string;
  /** Optional: raw markdown body appended after frontmatter. */
  body_md?: string;
  /** Optional: defaults to "succeeded". */
  lifecycle?: string;
}

export async function captureAction(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: ActionDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.summary?.trim()) return { error: "summary is required." };
  if (!draft.verb?.trim()) return { error: "verb is required." };
  if (!Array.isArray(draft.scope_names) || draft.scope_names.length === 0) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, { verb: "tag", nodeKind: "Action" });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let actorId: string | null = null;
  if (draft.performed_by_username) {
    actorId = await resolvePrincipalUsername(draft.performed_by_username);
    if (!actorId) {
      return { error: `Unknown principal username: ${draft.performed_by_username}` };
    }
  }
  if (!actorId && draft.created_by_id) {
    actorId = draft.created_by_id;
  }
  if (!actorId) {
    return {
      error:
        "performed_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }

  const intentIds: string[] = Array.isArray(draft.intent_ids) ? draft.intent_ids : [];
  const decisionIds: string[] = Array.isArray(draft.decision_ids) ? draft.decision_ids : [];
  const reasoningIds: string[] = Array.isArray(draft.reasoning_ids) ? draft.reasoning_ids : [];
  const follows: string[] = Array.isArray(draft.follows) ? draft.follows : [];

  const id = `action_${generateUlid()}`;
  const summary = draft.summary.trim();
  const now = new Date().toISOString();
  const createdById = draft.created_by_id ?? actorId;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "action",
    summary,
    actor_id: actorId,
    verb: draft.verb.trim(),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    ...(decisionIds.length > 0 ? { decision_ids: decisionIds } : {}),
    ...(reasoningIds.length > 0 ? { reasoning_ids: reasoningIds } : {}),
    ...(follows.length > 0 ? { follows } : {}),
    ...(draft.inputs !== undefined ? { inputs: draft.inputs } : {}),
    ...(draft.outputs !== undefined ? { outputs: draft.outputs } : {}),
    performed_at: now,
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    lifecycle: draft.lifecycle ?? "succeeded",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "action",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? actorId ?? null,
    entity_type: "action",
    entity_id: id,
    summary,
  });
  scheduleBackgroundIndex(docoDir, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "action",
    entitySummary: summary,
    alreadyReferenced: new Set([
      ...intentIds,
      ...decisionIds,
      ...reasoningIds,
      ...follows,
      ...scopeIds,
      ...(actorId ? [actorId] : []),
    ]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "action",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    scopes: await resolveScopeIcons(docoDir, scopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath("action", id),
    footer_lines,
    duration_ms,
  };
}

// ─── Rule ─────────────────────────────────────────────────────────────────

export interface RuleDraft {
  /** Required: one-line summary of the policy. */
  summary: string;
  /** Required: at least one scope name. */
  scope_names: string[];
  /** Required: machine-checkable / prose predicate the Rule asserts. */
  predicate: string;

  /** Optional: intent ids the Rule serves. */
  intent_ids?: string[];
  /**
   * Optional: enforcement surface — `lint | runtime | review | manual`.
   * Maps to the Rule's `phase` field on disk for compatibility with the
   * existing schema (`lint` → `declared`, `runtime` → `invariant`,
   * `review`/`manual` → `declared`). The original verb is preserved
   * verbatim in an `enforced_by` field so the spec stays round-trippable.
   */
  enforced_by?: "lint" | "runtime" | "review" | "manual";
  /** Optional: severity — `hard` (blocker) or `soft` (warning). Maps to schema. */
  severity?: "hard" | "soft";
  /** Optional: id of the Decision this Rule was born from. */
  born_from?: string;
  /** Optional: principal username who authored the Rule. */
  authored_by_username?: string;
  /** Optional: principal id who created this entry; defaults to authored_by. */
  created_by_id?: string;
  /** Optional: raw markdown body appended after frontmatter. */
  body_md?: string;
  /** Optional: defaults to "active". */
  lifecycle?: string;
}

export async function captureRule(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: RuleDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.summary?.trim()) return { error: "summary is required." };
  if (!draft.predicate?.trim()) return { error: "predicate is required." };
  if (!Array.isArray(draft.scope_names) || draft.scope_names.length === 0) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, { verb: "tag", nodeKind: "Rule" });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let authorId: string | null = null;
  if (draft.authored_by_username) {
    authorId = await resolvePrincipalUsername(draft.authored_by_username);
    if (!authorId) {
      return { error: `Unknown principal username: ${draft.authored_by_username}` };
    }
  }
  if (!authorId && draft.created_by_id) {
    authorId = draft.created_by_id;
  }
  if (!authorId) {
    return {
      error:
        "authored_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }

  const intentIds: string[] = Array.isArray(draft.intent_ids) ? draft.intent_ids : [];

  // Map the CLI/spec-facing enforcement vocabulary to the schema's `phase`
  // field. The original verb is preserved verbatim under `enforced_by`
  // so the spec is round-trippable.
  let phase: "declared" | "pre" | "post" | "invariant" = "declared";
  if (draft.enforced_by === "runtime") phase = "invariant";

  // Severity: `hard` → blocker, `soft` → warning. Defaults to warning
  // when unspecified (matches the existing on-disk convention).
  let severity: "blocker" | "warning" | "info" = "warning";
  if (draft.severity === "hard") severity = "blocker";

  const id = `rule_${generateUlid()}`;
  const summary = draft.summary.trim();
  const now = new Date().toISOString();
  const createdById = draft.created_by_id ?? authorId;

  // `applies_to` defaults to the scopes-as-tags selector — matches the
  // most common shape seen in existing rule files.
  const appliesTo = {
    any_of: scopeIds.map((sid) => ({ tag: sid })),
  };

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "rule",
    summary,
    ...(draft.born_from ? { born_from: draft.born_from } : {}),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    modality: "must",
    severity,
    phase,
    ...(draft.enforced_by ? { enforced_by: draft.enforced_by } : {}),
    applies_to: appliesTo,
    predicate: draft.predicate.trim(),
    expected: true,
    on_violation: severity === "blocker" ? "block" : "warn",
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    lifecycle: draft.lifecycle ?? "active",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "rule",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? authorId ?? null,
    entity_type: "rule",
    entity_id: id,
    summary,
  });
  scheduleBackgroundIndex(docoDir, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "rule",
    entitySummary: summary,
    alreadyReferenced: new Set([
      ...intentIds,
      ...scopeIds,
      ...(authorId ? [authorId] : []),
      ...(typeof draft.born_from === "string" ? [draft.born_from] : []),
    ]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "rule",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    scopes: await resolveScopeIcons(docoDir, scopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath("rule", id),
    footer_lines,
    duration_ms,
  };
}

// ─── Reasoning ────────────────────────────────────────────────────────────

export interface ReasoningDraft {
  /** Required: the claim / conclusion the reasoning establishes. */
  claim: string;
  /** Required: at least one scope name. */
  scope_names: string[];

  /** Optional: one-line summary; defaults to the claim. */
  summary?: string;
  /** Optional: intent ids the reasoning serves. */
  intent_ids?: string[];
  /** Optional: entity ids supported by this reasoning (`supports` edge). */
  supports?: string[];
  /** Optional: evidence list / JSON shape. */
  evidence?: unknown;
  /** Optional: principal username who authored the reasoning. */
  authored_by_username?: string;
  /** Optional: principal id who created this entry; defaults to authored_by. */
  created_by_id?: string;
  /** Optional: raw markdown body appended after frontmatter. */
  body_md?: string;
  /** Optional: defaults to "active". */
  lifecycle?: string;
}

export async function captureReasoning(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: ReasoningDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.claim?.trim()) return { error: "claim is required." };
  if (!Array.isArray(draft.scope_names) || draft.scope_names.length === 0) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, { verb: "tag", nodeKind: "Reasoning" });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let authorId: string | null = null;
  if (draft.authored_by_username) {
    authorId = await resolvePrincipalUsername(draft.authored_by_username);
    if (!authorId) {
      return { error: `Unknown principal username: ${draft.authored_by_username}` };
    }
  }
  if (!authorId && draft.created_by_id) {
    authorId = draft.created_by_id;
  }
  if (!authorId) {
    return {
      error:
        "authored_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }

  const intentIds: string[] = Array.isArray(draft.intent_ids) ? draft.intent_ids : [];
  const supports: string[] = Array.isArray(draft.supports) ? draft.supports : [];

  const id = `reasoning_${generateUlid()}`;
  const summary = draft.summary?.trim() || distillSummary(draft.claim) || `Reasoning: ${id}`;
  const now = new Date().toISOString();
  const createdById = draft.created_by_id ?? authorId;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "reasoning",
    summary,
    author_id: authorId,
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    premises: [],
    inference: draft.claim.trim(),
    ...(supports.length > 0 ? { supports } : {}),
    ...(draft.evidence !== undefined ? { evidence: draft.evidence } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    lifecycle: draft.lifecycle ?? "active",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "reasoning",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? authorId ?? null,
    entity_type: "reasoning",
    entity_id: id,
    summary,
  });
  scheduleBackgroundIndex(docoDir, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "reasoning",
    entitySummary: summary,
    alreadyReferenced: new Set([
      ...intentIds,
      ...supports,
      ...scopeIds,
      ...(authorId ? [authorId] : []),
    ]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "reasoning",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    scopes: await resolveScopeIcons(docoDir, scopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath("reasoning", id),
    footer_lines,
    duration_ms,
  };
}

const REF_TYPES = new Set(["file", "url", "ticket", "commit", "document", "other"]);

export interface ReferenceDraft {
  ref_type: string;
  locator: string;
  scope_names: string[];
  summary?: string;
  body_md?: string;
  content_hash?: string | null;
  intent_ids?: string[];
  created_by_username?: string;
  created_by_id?: string;
  lifecycle?: string;
}

export async function captureReference(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: ReferenceDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.ref_type || !REF_TYPES.has(draft.ref_type)) {
    return { error: `ref_type must be one of: ${[...REF_TYPES].join(", ")}.` };
  }
  if (!draft.locator?.trim()) return { error: "locator is required." };
  if (!Array.isArray(draft.scope_names) || draft.scope_names.length === 0) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, { verb: "tag", nodeKind: "Reference" });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let createdById: string | null = null;
  if (draft.created_by_username) {
    createdById = await resolvePrincipalUsername(draft.created_by_username);
    if (!createdById) {
      return { error: `Unknown principal username: ${draft.created_by_username}` };
    }
  }
  if (!createdById && draft.created_by_id) createdById = draft.created_by_id;

  const intentIds: string[] = Array.isArray(draft.intent_ids) ? draft.intent_ids : [];

  const id = `reference_${generateUlid()}`;
  const locator = draft.locator.trim();
  const summary = draft.summary?.trim() || `${draft.ref_type}: ${locator}`;
  const now = new Date().toISOString();

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "reference",
    summary,
    ref_type: draft.ref_type,
    locator,
    ...(draft.content_hash ? { content_hash: draft.content_hash } : {}),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    lifecycle: draft.lifecycle ?? "active",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "reference",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? null,
    entity_type: "reference",
    entity_id: id,
    summary,
  });
  scheduleBackgroundIndex(docoDir, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "reference",
    entitySummary: `${summary} ${locator}`,
    alreadyReferenced: new Set([...intentIds, ...scopeIds, ...(createdById ? [createdById] : [])]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "reference",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    scopes: await resolveScopeIcons(docoDir, scopeIds),
    duration_ms,
  });
  return {
    ok: true,
    id,
    path: syntheticPath("reference", id),
    footer_lines,
    duration_ms,
  };
}
