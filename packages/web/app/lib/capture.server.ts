import { NODE_TABLES, getDocoById, getEntity, upsertEntity, withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";
import type { AuthoringPredicate, EngineEdge, Entity, Lifecycle, Scope } from "@doco/shared";
import {
  computeEffectiveDefaultLifecycle,
  computeEffectiveGatedBy,
  evaluateScopeRules,
  globalScopeMembershipViolation,
  hardWrittenDocoRuleViolations,
  shouldRunAuthoringRuleForEntity,
} from "@doco/shared";
import { waitUntil } from "@vercel/functions";
// Server-only helpers for "capture an entity" endpoints. Single-call API
// for agents/people to write a Decision (or other entity types) without
// round-tripping for ULID generation, ID lookups, and reindex.
//
// Identifiers: every node has exactly one id — the ULID. URLs use the
// ULID; agents/users read the readable field (`summary` for most nodes,
// `purpose` for scopes) for the human handle.
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { appendAuditEvent } from "./audit-log.server";
import { rootDir } from "./db.server";
import { LlmUnavailableError, judgeProbabilisticRule, suggestImplicitEdges } from "./llm.server";
import { ensureScopeHashtagPrefixMigration } from "./migrations/scope-hashtag-prefix.server";
import { ensureV7Migration } from "./migrations/v7.server";
import { validatePatch } from "./mutability.server";
import { reindex, reindexEmbeddingsOnly } from "./redeem.server";
import { readDocoMetadata, resolveScopeIcons } from "./scope-helpers.server";

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
      summary:
        args.nodeType === "scope" ? null : typeof fm.summary === "string" ? fm.summary : null,
      purpose:
        args.nodeType === "scope" ? (typeof fm.purpose === "string" ? fm.purpose : null) : null,
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
 * Reindex synchronously (so the caller's response reflects materialized
 * edges/FTS/embeddings) and schedule the optional LLM-based
 * `attachImplicitEdges` pass in the background. The caller must have
 * already `await`-ed `persistEntity` so the new row is durably written
 * before the reindex reads it back.
 *
 * Why sync reindex: on Vercel-style serverless deploys the lambda is
 * frozen once the response is sent — a fire-and-forget background
 * promise may never run to completion, leaving the `edges` table empty
 * even though the entity row carries `intent_ids` / `born_from`. The
 * fix: await the reindex before responding. Adds a few hundred ms to
 * capture/PATCH latency; in return the graph is always consistent the
 * moment the agent sees the success line.
 *
 * `changedEntityId` triggers the incremental reindex path: only that
 * entity's FTS row + outgoing edges are rebuilt, leaving the rest of
 * the Doco's derived data untouched. Capture/patch handlers always
 * know the id of the row they just wrote, so they all pass it.
 *
 * Two-phase reindex (decision_01KRP… two-phase-reindex):
 *  1. Structural pass (FTS + edges) — runs inline, awaited. Fast: one
 *     batched INSERT per table on the changed entity's rows, ~50ms.
 *     The agent's success line reflects a real graph.
 *  2. Embedding pass — wrapped in Vercel `waitUntil` so the response
 *     returns before the OpenAI call completes. Search rankings catch
 *     up within a second or two of the response; explicit FTS keyword
 *     hits work immediately. On non-Vercel runtimes `waitUntil` is a
 *     no-op shim that runs the promise like normal `void`.
 *
 * `attachImplicitEdges` stays background because it issues an LLM call
 * (multi-second, optional). If it doesn't complete on serverless the
 * worst case is no auto-edges suggested — explicit edges still land.
 */
async function reindexAndScheduleAttach(
  docoDir: string,
  docoId: string,
  changedEntityId: string,
  attachOpts?: Parameters<typeof attachImplicitEdges>[0],
): Promise<void> {
  try {
    await reindex(docoDir, docoId, [changedEntityId], { skipEmbeddings: true });
  } catch (err) {
    console.error(`reindex failed for ${docoDir}:`, err);
  }
  waitUntil(
    (async () => {
      try {
        await reindexEmbeddingsOnly(docoDir, docoId, [changedEntityId]);
      } catch (err) {
        console.error(`reindex embeddings failed for ${docoDir}:`, err);
      }
    })(),
  );
  if (!attachOpts) return;
  waitUntil(
    (async () => {
      try {
        await attachImplicitEdges(attachOpts);
      } catch (err) {
        console.error("background attachImplicitEdges failed:", err);
      }
    })(),
  );
}

export interface DecisionDraft {
  /** Required: the question the Decision answers. */
  question: string;
  /** Required: chosen resolution (multi-line ok). */
  chosen: string;
  /** Required: at least one scope name (hashtag-shaped, e.g. "#user-flows"). */
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
const STRUCK_LIFECYCLES = new Set(["abandoned", "superseded"]);

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

export async function renderOperationLines(opts: {
  ownerSlug: string;
  docoSlug: string;
  /**
   * Phase 2d+ canonical URL identifier (the human-readable handle).
   * When provided, the footer link uses `${docoHost}/${handle}/...`.
   * Optional — when omitted, the function looks it up by `docoId` (if
   * provided) or falls back to `<owner>-<slug>` synthesis (correct for
   * every migrated Doco).
   */
  handle?: string;
  /**
   * Doco ULID — when set, the function does a single DB lookup to
   * resolve the current handle. Recommended for capture handlers that
   * already hold the ULID; the lookup keeps the URL accurate even when
   * the handle differs from `<owner>-<slug>` (e.g., custom requested_id).
   */
  docoId?: string;
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
}): Promise<string[]> {
  const Type = capType(opts.nodeType);
  // Phase 2d of slug-removal: every Doco URL is `/<handle>/...`. Use
  // the explicit handle when given; otherwise look it up by docoId;
  // otherwise fall back to `<owner>-<slug>` synthesis (correct for
  // every Doco minted from the slug-form web/CLI path AND every
  // pre-phase-1 row the migration backfilled).
  let handle: string;
  if (opts.handle) {
    handle = opts.handle;
  } else if (opts.docoId) {
    const row = await getDocoById(opts.docoId);
    handle = row?.handle || `${opts.ownerSlug}-${opts.docoSlug}`;
  } else {
    handle = `${opts.ownerSlug}-${opts.docoSlug}`;
  }
  const linkUrl = opts.docoHost ? `${opts.docoHost}/${handle}/${opts.nodeType}/${opts.id}` : null;
  const scopeSuffix =
    opts.scopes && opts.scopes.length > 0
      ? ` — ${opts.scopes.map((s) => (s.icon ? `${s.icon} ${s.name}` : s.name)).join(", ")}`
      : "";
  const buildAnchor = (summaryForLine: string): string => {
    const text = trunc(summaryForLine);
    return linkUrl ? `[${mdLinkText(text)}](${linkUrl})` : text;
  };
  // Mutation lines append `.<field>` after the anchor as dot-notation
  // (entity.property). If the summary text ends with a period, the
  // link text's trailing `.` plus the separator `.` render as `..` —
  // strip the trailing period so the dot-notation stays clean.
  const shouldStrikeMutationAnchor = opts.ops.some(
    (op) => op.kind === "set" && op.field === "lifecycle" && STRUCK_LIFECYCLES.has(op.value),
  );
  const mutationAnchor = (): string => {
    const anchor = buildAnchor(opts.summary.replace(/\.+$/, ""));
    return shouldStrikeMutationAnchor ? `~~${anchor}~~` : anchor;
  };
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
// A scope becomes unavailable for new captures when its lifecycle is
// `abandoned` (no replacement) or `superseded` (replaced by another scope).
// Both keep the scope record around so existing references stay readable.
const UNAVAILABLE_SCOPE_LIFECYCLES: ReadonlySet<string> = new Set(["abandoned", "superseded"]);

export async function resolveScopeNames(
  docoDir: string,
  names: string[],
): Promise<{
  ids: string[];
  unknown: string[];
  available: string[];
  unavailable: string[];
}> {
  const ids: string[] = [];
  const unknown: string[] = [];
  const unavailable: string[] = [];
  const available: string[] = [];
  const byName = new Map<string, { id: string; lifecycle: string }>();
  const meta = await readDocoMetadata(docoDir);
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
          if (!UNAVAILABLE_SCOPE_LIFECYCLES.has(lifecycle)) available.push(r.name);
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
    if (UNAVAILABLE_SCOPE_LIFECYCLES.has(entry.lifecycle)) unavailable.push(n);
  }
  available.sort();
  return { ids, unknown, available, unavailable };
}

/**
 * Resolve scope names → ids, returning a typed error if any are missing or
 * unavailable. Centralizes the boilerplate that all three captures + every
 * list-op share.
 *
 * When `incomingNodeType` is provided, also enforces per-scope
 * `allowed_node_types` (decision_01KRYECEA32SRSQCKFXSDCBK67,
 * rule_01KRYED1VAT3STXX6XP2GTP7V0): if any resolved scope's manifest
 * restricts the accepted node types and the incoming type isn't in the
 * allowlist, the capture is rejected. Driven by a generic attribute any
 * scope can carry (not a name check) so the framework's no-name-based-
 * behavior rule stays satisfied.
 */
async function resolveScopeOrError(
  docoDir: string,
  names: string[] | undefined,
  context: {
    verb: "tag" | "replace" | "add";
    nodeKind?: string;
    incomingNodeType?: string;
  },
): Promise<{ ids: string[] } | CaptureError> {
  // v13 (decision_01KS3DW9C2KN2X7Z80R18H1RAX): scope_names is optional.
  // No names → no scope tagging; capture proceeds without scope ids.
  if (!names || names.length === 0) return { ids: [] };
  const { ids, unknown, available, unavailable } = await resolveScopeNames(docoDir, names);
  if (unknown.length > 0) {
    const availStr =
      available.join(", ") || "(none — create scopes first via /<doco-handle>/scopes/new)";
    return { error: `Unknown scope name(s): ${unknown.join(", ")}. Available: ${availStr}` };
  }
  if (unavailable.length > 0) {
    if (context.verb === "tag") {
      const noun = context.nodeKind ?? "node";
      return {
        error: `Cannot tag a new ${noun} with abandoned or superseded scope(s): ${unavailable.join(", ")}. Activate the scope first or pick a different one. Available active scopes: ${available.join(", ")}`,
      };
    }
    if (context.verb === "replace") {
      return {
        error: `Cannot replace scopes with abandoned or superseded one(s): ${unavailable.join(", ")}. Activate first or omit them.`,
      };
    }
    return {
      error: `Cannot add abandoned or superseded scope(s) to a node: ${unavailable.join(", ")}. Activate first or pick a different scope.`,
    };
  }
  if (context.incomingNodeType && ids.length > 0) {
    const offenders = await findScopesRejectingNodeType(docoDir, ids, context.incomingNodeType);
    if (offenders.length > 0) {
      const lines = offenders.map((o) => `${o.name} (accepts only ${o.allowed.join(", ")})`);
      return {
        error: `Cannot tag a ${context.incomingNodeType} into ${lines.join("; ")}.`,
      };
    }
  }
  return { ids };
}

/**
 * Look up which of the given scope ids carry `allowed_node_types` that
 * exclude `incomingNodeType`. Returns scope name + allowed list for each
 * offender so the caller can build a readable error.
 */
async function findScopesRejectingNodeType(
  docoDir: string,
  scopeIds: string[],
  incomingNodeType: string,
): Promise<{ id: string; name: string; allowed: string[] }[]> {
  if (scopeIds.length === 0) return [];
  const meta = await readDocoMetadata(docoDir);
  if (!meta?.docoId) return [];
  const offenders: { id: string; name: string; allowed: string[] }[] = [];
  try {
    await withClient(async (c) => {
      const rows = (
        await c.query<{ id: string; name: string; raw_yaml: string }>(
          `SELECT id, name, raw_yaml FROM scopes WHERE doco_id = $1 AND id = ANY($2::text[])`,
          [meta.docoId, scopeIds],
        )
      ).rows;
      for (const r of rows) {
        let allowed: string[] = [];
        try {
          const fm = parseYaml(r.raw_yaml) as { allowed_node_types?: unknown };
          if (Array.isArray(fm?.allowed_node_types)) {
            allowed = (fm.allowed_node_types as unknown[]).filter(
              (v): v is string => typeof v === "string",
            );
          }
        } catch {}
        if (allowed.length === 0) continue;
        if (allowed.includes(incomingNodeType)) continue;
        offenders.push({ id: r.id, name: r.name, allowed });
      }
    });
  } catch {
    // PG unreachable — fail open; the scope-row read will fail elsewhere
    // and the user will see a clearer error from that path.
  }
  return offenders;
}

/**
 * Apply the three list-op shapes (replace / add / remove) for a single
 * frontmatter field. Returns the ops emitted (for footer rendering) and
 * the list of changed-keys. Used by `updateDecision` + `updateEntity`
 * for both `scopes` and `intent_ids` lists.
 *
 * `lookup` translates the input names to the ids Postgres stores:
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
  lookup: (
    names: string[],
  ) => Promise<{ ids: string[] } | CaptureError> | { ids: string[] } | CaptureError,
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
export async function resolvePrincipalUsername(username: string): Promise<string | null> {
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
  const meta = await readDocoMetadata(docoDir);
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

function findGlobalScope(allScopes: Map<string, Scope>): Scope | null {
  for (const s of allScopes.values()) {
    const name = (s as unknown as Record<string, unknown>).name;
    // Accept the canonical `#global`, the post-rename bare `global`,
    // and the legacy `constitution` — the migration may not have run
    // for every Doco yet.
    if (name === "#global" || name === "global") return s;
  }
  return null;
}

/**
 * v7: load the population of entities in each requested scope, indexed
 * by scope id. Used by within-scope predicates
 * (`unique-within-scope`, `count-within-scope`, `graph-constraint`).
 * Uses the materialized `in_scope_of` edges to enumerate members; the
 * candidate is injected into each scope it claims so completeness
 * checks see it before the row commits.
 */
async function buildNodesByScope(
  docoId: string,
  scopeIds: string[],
  candidate: Entity,
): Promise<Map<string, Entity[]>> {
  const out = new Map<string, Entity[]>();
  if (scopeIds.length === 0) return out;

  const memberIds = new Map<string, string[]>(); // scope_id → [entity_id, …]
  try {
    await withClient(async (c) => {
      const r = await c.query<{ from_id: string; to_id: string }>(
        `SELECT from_id, to_id FROM edges
          WHERE doco_id = $1
            AND edge_type = 'in_scope_of'
            AND to_id = ANY($2::text[])`,
        [docoId, scopeIds],
      );
      for (const row of r.rows) {
        const arr = memberIds.get(row.to_id) ?? [];
        arr.push(row.from_id);
        memberIds.set(row.to_id, arr);
      }
    });
  } catch {
    /* index empty — fall through with candidate-only buckets */
  }

  // Bucket member ids by their backing table.
  const byTable = new Map<string, string[]>();
  const allMemberIds = new Set<string>();
  for (const ids of memberIds.values()) for (const id of ids) allMemberIds.add(id);
  for (const id of allMemberIds) {
    const idx = id.indexOf("_");
    if (idx === -1) continue;
    const nodeType = id.slice(0, idx);
    const spec = NODE_TABLES[nodeType];
    if (!spec) continue;
    const arr = byTable.get(spec.table) ?? [];
    arr.push(id);
    byTable.set(spec.table, arr);
  }

  // Batch-fetch entity rows from each table.
  const entitiesById = new Map<string, Entity>();
  try {
    await withClient(async (c) => {
      for (const [table, ids] of byTable) {
        if (ids.length === 0) continue;
        // Table name comes from the trusted NODE_TABLES constant; ids
        // are parameterized.
        const r = await c.query<{ id: string; raw_yaml: string }>(
          `SELECT id, raw_yaml FROM ${table}
            WHERE doco_id = $1 AND id = ANY($2::text[])`,
          [docoId, ids],
        );
        for (const row of r.rows) {
          try {
            const fm = JSON.parse(row.raw_yaml);
            if (fm && typeof fm === "object") {
              entitiesById.set(row.id, fm as Entity);
            }
          } catch {
            try {
              const fm = parseYaml(row.raw_yaml);
              if (fm && typeof fm === "object") {
                entitiesById.set(row.id, fm as Entity);
              }
            } catch {
              /* skip */
            }
          }
        }
      }
    });
  } catch {
    /* fall through with whatever was already collected */
  }

  // Materialize per-scope arrays from member ids.
  for (const [scopeId, ids] of memberIds) {
    const ents: Entity[] = [];
    for (const id of ids) {
      const e = entitiesById.get(id);
      if (e) ents.push(e);
    }
    out.set(scopeId, ents);
  }

  // Inject the candidate into each scope it claims, even if the
  // in_scope_of edge isn't materialized yet.
  const candidateScopes = (candidate as unknown as { scopes?: unknown }).scopes ?? [];
  if (Array.isArray(candidateScopes)) {
    for (const sid of candidateScopes as string[]) {
      if (!scopeIds.includes(sid)) continue;
      const arr = out.get(sid) ?? [];
      const candidateId = (candidate as unknown as { id?: string }).id;
      // If the candidate's id already appears in the scope's member
      // list (loaded from DB), replace it with the candidate so any
      // overridden fields (lifecycle, kind, …) win over the persisted
      // state. Otherwise append.
      const idx = arr.findIndex((e) => (e as { id?: string }).id === candidateId);
      if (idx === -1) arr.push(candidate);
      else arr[idx] = candidate;
      out.set(sid, arr);
    }
  }

  return out;
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
  const globalScope = findGlobalScope(allScopes);
  const globalScopeId = globalScope?.id ?? null;
  const entityForEngine = entityFm as unknown as Entity;
  const allViolations: {
    scopeName: string;
    reason: string;
    severity: "error" | "warning" | "pending";
  }[] = hardWrittenDocoRuleViolations({
    entity: entityForEngine,
    entityScopes: scopeIds,
    globalScopeId,
    globalScopeName: "Global",
  }).map((v) => ({
    scopeName: v.kind === "requires_node_type" ? "Global" : "Doco",
    reason: v.reason,
    severity: v.severity,
  }));

  const formatFailures = (): { error: string } | null => {
    const fails = allViolations.filter((v) => v.severity === "error");
    if (fails.length === 0) return null;
    const lines = fails.map((f) => `${f.scopeName}: ${f.reason}`);
    return {
      error: `Scope rule${fails.length > 1 ? "s" : ""} failed — ${lines.join(" | ")}. Capture aborted.`,
    };
  };

  // Per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG) authoring rules are
  // cited by a Scope via `Scope.gated_by` (with parent-scope inheritance
  // and per-scope `excluded_rules` opt-out). The legacy
  // `Rule.kind === "authoring"` marker is gone; existing data is
  // backfilled by `ensureV7Migration` before this loader runs.
  const meta = await readDocoMetadata(docoDir);
  if (!meta?.docoId) return null;
  const docoId = meta.docoId;
  await ensureV7Migration(docoId);
  await ensureScopeHashtagPrefixMigration(docoId);

  // Collect the set of scope ids whose gated_by we need to walk:
  // - every scope the entity already lists,
  // - PLUS the Global scope (its gated_by carries project-authored
  //   Doco-wide invariants).
  // Framework-native invariants such as "Decision alternatives are
  // required" and "Global only accepts Intent/Rule nodes" are checked
  // above, not loaded from seeded Global template Rules.
  const scopesToCheck = new Set(scopeIds);
  if (globalScopeId) {
    scopesToCheck.add(globalScopeId);
  }

  // For each scope to check, compute its effective gated_by (walking
  // parent scopes + applying excluded_rules). Map each rule id to the
  // scope that cites it — that becomes its "$capture_scope" for
  // within-scope predicates.
  const ruleIdToCitingScope = new Map<string, string>();
  for (const scopeId of scopesToCheck) {
    const scope = allScopes.get(scopeId);
    if (!scope) continue;
    const effective = computeEffectiveGatedBy(scope, allScopes);
    for (const rid of effective) {
      if (!ruleIdToCitingScope.has(rid)) ruleIdToCitingScope.set(rid, scopeId);
    }
  }

  // Load the cited Rule entities (active / proposed). One query.
  type RuleRow = { id: string; summary: string; raw_yaml: string };
  let ruleRows: RuleRow[] = [];
  if (ruleIdToCitingScope.size > 0) {
    try {
      ruleRows = await withClient(async (c) => {
        const r = await c.query<RuleRow>(
          `SELECT id, summary, raw_yaml
             FROM rules
            WHERE doco_id = $1
              AND id = ANY($2::text[])
              AND COALESCE(lifecycle, 'active') IN ('active', 'proposed')`,
          [docoId, Array.from(ruleIdToCitingScope.keys())],
        );
        return r.rows;
      });
    } catch {
      ruleRows = [];
    }
  }

  type Loaded = {
    rule_id: string;
    scope_id?: string;
    predicate: AuthoringPredicate;
    lifecycle?: string;
    fires_when_node_lifecycle?: Lifecycle[];
    reason?: string;
  };
  const perScope = new Map<string, Loaded[]>();
  let needsNodesByScope = false;
  for (const row of ruleRows) {
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(row.raw_yaml) as Record<string, unknown>;
    } catch {
      try {
        const parsed = parseYaml(row.raw_yaml);
        if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    const predicate = fm.predicate as AuthoringPredicate | undefined;
    if (!predicate || typeof predicate !== "object") continue;
    const citingScope = ruleIdToCitingScope.get(row.id);
    if (!citingScope) continue;
    if (
      !shouldRunAuthoringRuleForEntity({
        ruleScopeId: citingScope,
        predicateKind: predicate.kind,
        globalScopeId,
        entityScopes: scopeIds,
      })
    ) {
      continue;
    }
    if (
      predicate.kind === "unique-within-scope" ||
      predicate.kind === "count-within-scope" ||
      predicate.kind === "graph-constraint" ||
      predicate.kind === "graph-completeness"
    ) {
      needsNodesByScope = true;
    }
    const fires = Array.isArray(fm.fires_when_node_lifecycle)
      ? (fm.fires_when_node_lifecycle as Lifecycle[])
      : undefined;
    const arr = perScope.get(citingScope) ?? [];
    arr.push({
      rule_id: row.id,
      scope_id: citingScope,
      predicate,
      lifecycle: typeof fm.lifecycle === "string" ? fm.lifecycle : "active",
      fires_when_node_lifecycle: fires,
      reason: row.summary,
    });
    perScope.set(citingScope, arr);
  }

  if (perScope.size === 0) return formatFailures();

  // Load the doco's edges for the engine (used by requires_edge /
  // forbids_edge predicates).
  const edges: EngineEdge[] = [];
  try {
    await withClient(async (c) => {
      const r = await c.query<{ from_id: string; to_id: string; edge_type: string }>(
        `SELECT from_id, to_id, edge_type FROM edges WHERE doco_id = $1`,
        [docoId],
      );
      for (const row of r.rows) edges.push(row);
    });
  } catch {
    /* index not built yet — fall through with synthesized edges only */
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

  const entitySummary = typeof entityFm.summary === "string" ? (entityFm.summary as string) : "";
  const entityNodeType =
    typeof entityFm.node_type === "string" ? (entityFm.node_type as string) : "";
  const entityBody =
    typeof entityFm.body_md === "string" ? (entityFm.body_md as string) : undefined;

  // v7: build a nodesByScope index for `unique-within-scope`,
  // `count-within-scope`, and `graph-constraint` predicates. Only build
  // it if at least one predicate needs it — the queries are non-trivial.
  const nodesByScope = needsNodesByScope
    ? await buildNodesByScope(docoId, Array.from(perScope.keys()), entityForEngine)
    : undefined;

  // user-flows v2: principal index for `requires_field_resolves_to_principal`.
  // Small table — load all rows once when at least one such predicate is
  // active in the candidate's scopes. Maps principal_id → { type }.
  const needsPrincipalIndex = Array.from(perScope.values()).some((rules) =>
    rules.some((r) => r.predicate.kind === "requires_field_resolves_to_principal"),
  );
  let principalIndex: Map<string, { type: string }> | undefined;
  if (needsPrincipalIndex) {
    principalIndex = new Map();
    try {
      await withClient(async (c) => {
        const r = await c.query<{ id: string; type: string }>(`SELECT id, type FROM principals`);
        for (const row of r.rows) principalIndex!.set(row.id, { type: row.type });
      });
    } catch {
      /* leave empty — evaluator will emit a loud error */
    }
  }

  for (const [scopeIdKey, loadedRules] of perScope) {
    const scope = allScopes.get(scopeIdKey);
    const scopeName = scope ? (scope as unknown as { name: string }).name : "(scope)";
    const v = evaluateScopeRules({
      entity: entityForEngine,
      authoring_rules: loadedRules,
      scopeName,
      allEdges: edges,
      entityScopes: scopeIds,
      nodesByScope,
      principalIndex,
    });
    for (const vv of v) {
      if (vv.severity === "error") {
        allViolations.push({ scopeName, reason: vv.reason, severity: "error" });
        continue;
      }
      if (vv.severity !== "pending" || vv.kind !== "probabilistic") {
        allViolations.push({ scopeName, reason: vv.reason, severity: vv.severity });
        continue;
      }
      // Probabilistic rule — invoke the LLM judge. Strict mode means
      // the host's OPENAI_API_KEY is now load-bearing for captures
      // into scopes carrying probabilistic rules
      // (decision_01KRPET95G2QNTPCR0YWAKSCH5). Failure to reach the
      // judge rejects the write rather than silently passing.
      const spec = vv.spec ?? "";
      if (!spec) {
        allViolations.push({
          scopeName,
          reason: `Probabilistic rule ${vv.rule_id} has no spec.`,
          severity: "error",
        });
        continue;
      }
      try {
        const judgeResult = await judgeProbabilisticRule({
          spec,
          entity: {
            id: candidateId,
            node_type: entityNodeType,
            summary: entitySummary,
            ...(entityBody ? { body: entityBody } : {}),
          },
          strict: true,
        });
        if (!judgeResult.ok) {
          allViolations.push({
            scopeName,
            reason: `Probabilistic rule failed: "${spec}" — ${judgeResult.reason}`,
            severity: "error",
          });
        }
      } catch (e) {
        if (e instanceof LlmUnavailableError) {
          allViolations.push({
            scopeName,
            reason: `Probabilistic rule judge unavailable — ${e.message} The host must reach OpenAI to capture into scopes with probabilistic rules.`,
            severity: "error",
          });
        } else {
          allViolations.push({
            scopeName,
            reason: `Probabilistic rule judge errored: ${(e as Error).message}`,
            severity: "error",
          });
        }
      }
    }
  }
  return formatFailures();
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
  const meta = await readDocoMetadata(opts.docoDir);
  if (!meta?.docoId) return 0;
  try {
    await withClient(async (c) => {
      const types: { table: string; nodeType: string; hasName: boolean }[] = [
        { table: "decisions", nodeType: "decision", hasName: false },
        { table: "intents", nodeType: "intent", hasName: false },
        { table: "rules", nodeType: "rule", hasName: false },
        { table: "actions", nodeType: "action", hasName: false },
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
            const cand: CandidateRow = {
              id: row.id,
              node_type: t.nodeType,
              summary: row.summary ?? "",
            };
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
    const docoId = String(fm.doco_id ?? "");
    await persistEntity({
      nodeType: opts.entityType,
      id: opts.entityId,
      docoId,
      fm,
      body: existing.body,
    });
    await reindex(opts.docoDir, docoId || undefined, [opts.entityId]);
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
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "Decision",
    incomingNodeType: "decision",
  });
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

  const summary = draft.summary?.trim() || distillSummary(draft.chosen) || `Decision: ${id}`;

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
  await reindexAndScheduleAttach(docoDir, docoId, id, {
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
  const footer_lines = await renderOperationLines({
    docoId,
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

  const gate = validatePatch(
    "decision",
    fm.lifecycle as string | undefined,
    patch as Record<string, unknown>,
  );
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
  await reindexAndScheduleAttach(docoDir, docoId, decisionId);
  const summary = String(fm.summary ?? decisionId);
  const duration_ms = Math.round(performance.now() - startedAt);
  const finalScopeIds = Array.isArray(fm.scopes) ? (fm.scopes as string[]) : [];
  const footer_lines = await renderOperationLines({
    docoId,
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

export type NodeTypeName =
  | "decision"
  | "intent"
  | "rule"
  | "action"
  | "log"
  | "reference"
  | "scope";

export interface EntityPatch {
  summary?: string;
  purpose?: string;
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
  const {
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    nodeType,
    id,
    patch,
    allowedFields,
    docoHost,
    actorId,
  } = opts;

  const existing = await readEntityFromPostgres(nodeType, id);
  if (!existing) return { error: `${nodeType} not found: ${id}` };
  const fm = existing.fm;
  const existingBody = existing.body;
  // Types with a markdown body get body_md; others (scope, reference)
  // are pure YAML and ignore body operations.
  const isMd = nodeType !== "scope" && nodeType !== "reference";

  if (nodeType === "scope" && Object.prototype.hasOwnProperty.call(patch, "summary")) {
    return {
      error: "Scope nodes use `purpose`; `summary` is not accepted for scopes.",
      status: 400,
    };
  }

  const gate = validatePatch(
    nodeType,
    fm.lifecycle as string | undefined,
    patch as Record<string, unknown>,
  );
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

  if (nodeType === "scope") {
    const purposePatch = typeof patch.purpose === "string" ? patch.purpose.trim() : undefined;
    setScalar("purpose", purposePatch);
    if (purposePatch !== undefined && "summary" in fm) {
      fm.summary = undefined;
      changed.push("summary");
      ops.push({ kind: "cleared", field: "summary" });
    }
  } else {
    setScalar("summary", typeof patch.summary === "string" ? patch.summary.trim() : undefined);
  }
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
    if (k === "summary" || k === "purpose") continue;
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
    const allScopes = await loadAllScopes(docoDir);
    const globalScope = findGlobalScope(allScopes);
    const nextScopes = Array.isArray(fm.scopes) ? (fm.scopes as string[]) : [];
    const beforeScopes = Array.isArray(beforeFm.scopes) ? (beforeFm.scopes as string[]) : [];
    const addedGlobal =
      Boolean(globalScope?.id) &&
      nextScopes.includes(globalScope!.id) &&
      !beforeScopes.includes(globalScope!.id);
    if (addedGlobal) {
      const globalMembershipError = globalScopeMembershipViolation({
        entityNodeType: nodeType,
        entityScopes: nextScopes,
        globalScopeId: globalScope!.id,
        globalScopeName: "Global",
      });
      if (globalMembershipError) return { error: globalMembershipError };
    }
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
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const summary = String(
    nodeType === "scope" ? (fm.purpose ?? fm.name ?? id) : (fm.summary ?? fm.name ?? id),
  );
  const duration_ms = Math.round(performance.now() - startedAt);
  const finalScopeIds = Array.isArray(fm.scopes) ? (fm.scopes as string[]) : [];
  const footer_lines = await renderOperationLines({
    docoId,
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
  /**
   * Optional: principals expected to act in this flow. Each username
   * resolves to a principal id; the resulting list is stored on the
   * Intent as `actors: [principal_id, ...]`. Used by the user-flows
   * `graph-completeness` rule to require an Action per actor before
   * the Intent moves to `active`.
   */
  actors_usernames?: string[];
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
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "Intent",
    incomingNodeType: "intent",
  });
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

  // Resolve actors_usernames → principal_ids. Each must resolve; an
  // unknown username is a typo and we'd rather catch it at capture
  // than ship a broken Intent.
  const actorIds: string[] = [];
  if (Array.isArray(draft.actors_usernames) && draft.actors_usernames.length > 0) {
    for (const uname of draft.actors_usernames) {
      const pid = await resolvePrincipalUsername(uname);
      if (!pid) return { error: `Unknown principal username in actors: ${uname}` };
      if (!actorIds.includes(pid)) actorIds.push(pid);
    }
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
    ...(actorIds.length > 0 ? { actors: actorIds } : {}),
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
  await reindexAndScheduleAttach(docoDir, docoId, id, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "intent",
    entitySummary: summary,
    alreadyReferenced: new Set([...scopeIds, ...(wantedById ? [wantedById] : []), ...actorIds]),
  });
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
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
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }
  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "Eval",
    incomingNodeType: "eval",
  });
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
  await reindexAndScheduleAttach(docoDir, docoId, id, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "eval",
    entitySummary: summary,
    alreadyReferenced: new Set([...scopeIds, ...(draft.target_ref ? [draft.target_ref] : [])]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
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
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "Action",
    incomingNodeType: "action",
  });
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
  await reindexAndScheduleAttach(docoDir, docoId, id, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "action",
    entitySummary: summary,
    alreadyReferenced: new Set([
      ...intentIds,
      ...decisionIds,
      ...follows,
      ...scopeIds,
      ...(actorId ? [actorId] : []),
    ]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
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

// ─── Log (recorded happening) ─────────────────────────────────────────────
// Parallel to Action but for instance-level happenings: a deploy that ran,
// a commit that pushed, an eval that verified. Required fields make the
// instance-vs-template distinction load-bearing: `happened_at` (when) and
// `outputs` (what concrete results came out).

export interface LogDraft {
  summary: string;
  scope_names: string[];
  /** Past-tense verb naming what happened ("pushed", "deployed", "verified"). */
  verb: string;
  /** When the event occurred. ISO 8601 UTC. */
  happened_at: string;
  /** Concrete output values from the event — commit hash, deploy URL,
   *  verification result. Non-empty in practice. */
  outputs: Record<string, unknown>;

  /** Optional: the Action template this Log instances. */
  template_id?: string;
  intent_ids?: string[];
  decision_ids?: string[];
  follows?: string[];
  inputs?: unknown;
  performed_by_username?: string;
  created_by_id?: string;
  body_md?: string;
  /** Optional override. Logs default to "succeeded" (the event happened). */
  lifecycle?: string;
}

export async function captureLog(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: LogDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.summary?.trim()) return { error: "summary is required." };
  if (!draft.verb?.trim()) return { error: "verb is required." };
  if (!draft.happened_at?.trim()) {
    return { error: "happened_at is required (ISO 8601 UTC) — Logs record a moment in time." };
  }
  if (
    !draft.outputs ||
    typeof draft.outputs !== "object" ||
    Object.keys(draft.outputs).length === 0
  ) {
    return {
      error:
        "outputs is required and must be a non-empty object — Logs record concrete results (commit hash, deploy URL, etc.).",
    };
  }
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "Log",
    incomingNodeType: "log",
  });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let actorId: string | null = null;
  if (draft.performed_by_username) {
    actorId = await resolvePrincipalUsername(draft.performed_by_username);
    if (!actorId) {
      return { error: `Unknown principal username: ${draft.performed_by_username}` };
    }
  }
  if (!actorId && draft.created_by_id) actorId = draft.created_by_id;
  if (!actorId) {
    return {
      error:
        "performed_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }

  const intentIds: string[] = Array.isArray(draft.intent_ids) ? draft.intent_ids : [];
  const decisionIds: string[] = Array.isArray(draft.decision_ids) ? draft.decision_ids : [];
  const follows: string[] = Array.isArray(draft.follows) ? draft.follows : [];

  const id = `log_${generateUlid()}`;
  const summary = draft.summary.trim();
  const now = new Date().toISOString();
  const createdById = draft.created_by_id ?? actorId;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "log",
    summary,
    actor_id: actorId,
    verb: draft.verb.trim(),
    happened_at: draft.happened_at,
    outputs: draft.outputs,
    ...(draft.template_id ? { template_id: draft.template_id } : {}),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    ...(decisionIds.length > 0 ? { decision_ids: decisionIds } : {}),
    ...(follows.length > 0 ? { follows } : {}),
    ...(draft.inputs !== undefined ? { inputs: draft.inputs } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    lifecycle: draft.lifecycle ?? "succeeded",
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "log",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? actorId ?? null,
    entity_type: "log",
    entity_id: id,
    summary,
  });
  await reindexAndScheduleAttach(docoDir, docoId, id, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "log",
    entitySummary: summary,
    alreadyReferenced: new Set([
      ...intentIds,
      ...decisionIds,
      ...follows,
      ...scopeIds,
      ...(actorId ? [actorId] : []),
      ...(draft.template_id ? [draft.template_id] : []),
    ]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    nodeType: "log",
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
    path: syntheticPath("log", id),
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
   * Optional: enforcement surface — `runtime | review | manual`.
   * Maps to the Rule's `phase` field in the stored row for compatibility
   * with the existing schema (`runtime` → `invariant`, `review`/`manual`
   * → `declared`). The original verb is preserved verbatim in an
   * `enforced_by` field so the spec stays round-trippable.
   */
  enforced_by?: "runtime" | "review" | "manual";
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
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "Rule",
    incomingNodeType: "rule",
  });
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
  await reindexAndScheduleAttach(docoDir, docoId, id, {
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
  const footer_lines = await renderOperationLines({
    docoId,
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
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "Reference",
    incomingNodeType: "reference",
  });
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
  await reindexAndScheduleAttach(docoDir, docoId, id, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "reference",
    entitySummary: `${summary} ${locator}`,
    alreadyReferenced: new Set([...intentIds, ...scopeIds, ...(createdById ? [createdById] : [])]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
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

// ─── State (v7 — state-machine node) ──────────────────────────────────────
// Per decision_01KRRR5BQ16ASY8HQEE0V499YG. A State is a node in a formal
// state machine: a position the modeled entity occupies for some span of
// time. Holds invariants while occupied; reached via Actions whose
// `follows` includes this State. Framework-general — nothing about the
// shape is state-machines-specific.

export interface StateDraft {
  /** Required: one-line summary (the State's display name, e.g. "paid", "cart"). */
  summary: string;
  /** Required: at least one scope name (bare). */
  scope_names: string[];
  /** Required: initial / intermediate / terminal. */
  kind: "initial" | "intermediate" | "terminal";

  /** Optional: predicates true while in this State. Free-form prose. */
  invariants?: string[];
  /** Optional: entity ids this state follows (typically a transition Action). */
  follows?: string[];
  /** Optional: principal id who created this entry. */
  created_by_id?: string;
  /** Optional: principal username (resolves to id). */
  created_by_username?: string;
  /** Optional: raw markdown body. */
  body_md?: string;
  /** Optional: explicit lifecycle override. If unset, falls back to the
   *  capturing scope's `default_node_lifecycle` (with parent inheritance),
   *  else "active". */
  lifecycle?: string;
}

export async function captureState(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: StateDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.summary?.trim()) return { error: "summary is required." };
  if (!draft.kind) return { error: "kind is required (initial | intermediate | terminal)." };
  if (draft.kind !== "initial" && draft.kind !== "intermediate" && draft.kind !== "terminal") {
    return {
      error: `kind must be one of initial / intermediate / terminal — got "${draft.kind}".`,
    };
  }
  if (draft.scope_names && !Array.isArray(draft.scope_names)) {
    return { error: "scope_names must be a non-empty array." };
  }

  const scopeRes = await resolveScopeOrError(docoDir, draft.scope_names, {
    verb: "tag",
    nodeKind: "State",
    incomingNodeType: "state",
  });
  if ("error" in scopeRes) return scopeRes;
  const scopeIds = scopeRes.ids;

  let createdById: string | null = draft.created_by_id ?? null;
  if (!createdById && draft.created_by_username) {
    createdById = await resolvePrincipalUsername(draft.created_by_username);
    if (!createdById) {
      return { error: `Unknown principal username: ${draft.created_by_username}` };
    }
  }

  const id = `state_${generateUlid()}`;
  const summary = draft.summary.trim();
  const now = new Date().toISOString();

  // v7: honor default_node_lifecycle from the capturing scope hierarchy
  // unless the author overrides via explicit lifecycle. Walks the first
  // listed scope's ancestors (more scopes => first wins; the project
  // owner can layer ordering if they care).
  let lifecycle = draft.lifecycle?.trim();
  if (!lifecycle && scopeIds.length > 0) {
    const allScopes = await loadAllScopes(docoDir);
    const first = allScopes.get(scopeIds[0]);
    if (first) {
      const def = computeEffectiveDefaultLifecycle(first, allScopes);
      if (def) lifecycle = def;
    }
  }
  if (!lifecycle) lifecycle = "active";

  const follows: string[] = Array.isArray(draft.follows) ? draft.follows : [];
  const invariants: string[] = Array.isArray(draft.invariants)
    ? draft.invariants.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "state",
    summary,
    kind: draft.kind,
    ...(invariants.length > 0 ? { invariants } : {}),
    ...(follows.length > 0 ? { follows } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    lifecycle,
    scopes: scopeIds,
  };

  const ruleErr = await runScopeRules({ docoDir, ownerSlug, docoSlug, entityFm: fm });
  if (ruleErr) return ruleErr;

  await persistEntity({
    nodeType: "state",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? null,
    entity_type: "state",
    entity_id: id,
    summary,
  });
  await reindexAndScheduleAttach(docoDir, docoId, id, {
    docoDir,
    ownerSlug,
    docoSlug,
    entityId: id,
    entityType: "state",
    entitySummary: summary,
    alreadyReferenced: new Set([...follows, ...scopeIds]),
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    nodeType: "state",
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
    path: syntheticPath("state", id),
    footer_lines,
    duration_ms,
  };
}
