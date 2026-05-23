import { getDocoById, getEntity, upsertEntity, withClient } from "@doco/db";
import { type AuthoringPredicate, generateUlid } from "@doco/shared";
import { waitUntil } from "@vercel/functions";
// Server-only helpers for "capture an entity" endpoints. Single-call API
// for agents/people to write a Decision (or other entity types) without
// round-tripping for ULID generation, ID lookups, and reindex.
//
// Identifiers: every node has exactly one id — the ULID. URLs use the
// ULID; agents/users read the readable field (`summary` for most nodes).
import { appendAuditEvent } from "./audit-log.server";
import { type AuthoringResult, runAuthoringPrimitives } from "./authoring-runner.server";
import { validatePatch } from "./mutability.server";
import { reindex, reindexEmbeddingsOnly } from "./redeem.server";

/**
 * Run the doco's authoring primitives against a candidate's full
 * frontmatter. Centralized here so every captureX / updateEntity path
 * applies the same enforcement: blocking violations short-circuit
 * before persistEntity, warnings get attached to the result. Replaces
 * the pre-v16 `runScopeRules` call (deleted in commit 4974339).
 */
async function enforceAuthoringPrimitives(
  docoId: string,
  fm: Record<string, unknown>,
): Promise<AuthoringResult> {
  return runAuthoringPrimitives({
    docoId,
    candidate: fm as Parameters<typeof runAuthoringPrimitives>[0]["candidate"],
  });
}

/**
 * Render non-blocking authoring-primitive warnings as footer lines.
 * Appended after the operation lines so the agent sees them inline
 * with the capture result.
 */
function renderAuthoringWarnings(warnings: AuthoringResult["warnings"]): string[] {
  return warnings.map((w) => `[🔮 Doco] ⚠️ Authoring warning: ${w.reason}`);
}

/**
 * Synthetic "path" returned in CaptureResult.path. Postgres is the only
 * storage; there is no on-disk file. Callers (footer renderer, CLI)
 * already key off the entity URL, not this string.
 */
function syntheticPath(entityType: string, id: string): string {
  return `<postgres>:${entityType}s/${id}`;
}

/**
 * Read an existing entity's parsed frontmatter + body from Postgres.
 * Replaces the prior filesystem read (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 —
 * alpha forbids back-compat).
 */
async function readEntityFromPostgres(
  entityType: string,
  id: string,
): Promise<{ fm: Record<string, unknown>; body: string } | null> {
  const row = await getEntity(entityType, id);
  if (!row) return null;
  const fm = row.data;
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
  entityType: string;
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
      entity_type: args.entityType,
      data: fm,
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
    console.error(`postgres persist failed for ${args.entityType}/${args.id}:`, err);
    throw err;
  }
}

/**
 * Reindex synchronously (so the caller's response reflects materialized
 * synapses/FTS/embeddings). The caller must have already `await`-ed
 * `persistEntity` so the new row is durably written before the reindex
 * reads it back.
 *
 * Why sync reindex: on Vercel-style serverless deploys the lambda is
 * frozen once the response is sent — a fire-and-forget background
 * promise may never run to completion, leaving the `synapses` table empty
 * even though the entity row carries `intent_ids` / `born_from`. The
 * fix: await the reindex before responding. Adds a few hundred ms to
 * capture/PATCH latency; in return the graph is always consistent the
 * moment the agent sees the success line.
 *
 * `changedEntityId` triggers the incremental reindex path: only that
 * entity's FTS row + outgoing synapses are rebuilt, leaving the rest of
 * the Doco's derived data untouched. Capture/patch handlers always
 * know the id of the row they just wrote, so they all pass it.
 *
 * Two-phase reindex (decision_01KRP… two-phase-reindex):
 *  1. Structural pass (FTS + synapses) — runs inline, awaited. Fast: one
 *     batched INSERT per table on the changed entity's rows, ~50ms.
 *     The agent's success line reflects a real graph.
 *  2. Embedding pass — wrapped in Vercel `waitUntil` so the response
 *     returns before the OpenAI call completes. Search rankings catch
 *     up within a second or two of the response; explicit FTS keyword
 *     hits work immediately. On non-Vercel runtimes `waitUntil` is a
 *     no-op shim that runs the promise like normal `void`.
 */
async function reindexAndScheduleAttach(
  docoDir: string,
  docoId: string,
  changedEntityId: string,
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
}

export interface DecisionDraft {
  /** Required: the question the Decision answers. */
  question: string;
  /** Required: chosen resolution (multi-line ok). */
  chosen: string;

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
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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
  /**
   * Non-blocking authoring-primitive violations produced by the
   * evaluator (on_violation = "warn"). Empty when no warnings fired.
   * Blocking violations short-circuit before persistence and surface as
   * a CaptureError instead.
   */
  warnings?: import("@doco/shared").Violation[];
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
const STRUCK_LIFECYCLES = new Set(["retired"]);
const VALID_LIFECYCLES = new Set(["drafted", "proposed", "active", "retired"]);
const VALID_OUTCOMES = new Set(["succeeded", "failed"]);

interface LifecycleAttrs {
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

interface ResolvedLifecycleAttrs {
  lifecycle: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

function normalizeLifecycle(value: unknown, fallback: string): string | CaptureError {
  const lifecycle = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!VALID_LIFECYCLES.has(lifecycle)) {
    return {
      error: `Unknown lifecycle: ${lifecycle}. Expected one of: ${[...VALID_LIFECYCLES].join(", ")}.`,
    };
  }
  return lifecycle;
}

function normalizeOutcome(value: unknown): "succeeded" | "failed" | undefined | CaptureError {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "succeeded" || value === "failed") return value;
  return {
    error: `Unknown outcome: ${String(value)}. Expected one of: ${[...VALID_OUTCOMES].join(", ")}.`,
  };
}

function lifecycleAttrs(
  draft: LifecycleAttrs,
  defaultLifecycle: string,
  defaultOutcome?: "succeeded" | "failed",
): ResolvedLifecycleAttrs | CaptureError {
  const lifecycle = normalizeLifecycle(draft.lifecycle, defaultLifecycle);
  if (typeof lifecycle !== "string") return lifecycle;
  const outcome = normalizeOutcome(draft.outcome ?? defaultOutcome);
  if (outcome && typeof outcome !== "string") return outcome;
  return {
    lifecycle,
    ...(draft.deprecated !== undefined ? { deprecated: Boolean(draft.deprecated) } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

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
 * Format: `[🔮 Doco] {icon} {Type} {verb}: {body}`
 *
 *   - Both `added` and mutation ops render `[<summary>](<url>)` as the
 *     body anchor. Mutations append `.<field> <change>` after the link.
 *   - The URL is built from the entity's ULID id. Readers see the
 *     summary; the id lives in the URL.
 *   - Timing trailer ` (X.Xs)` is appended on the last line of a batch.
 */

function capType(t: string): string {
  return t
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
  entityType: string;
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
  duration_ms?: number;
}): Promise<string[]> {
  const Type = capType(opts.entityType);
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
  const linkUrl = opts.docoHost ? `${opts.docoHost}/${handle}/${opts.entityType}/${opts.id}` : null;
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
        return `[🔮 Doco] ✍️ ${Type} added: ${buildAnchor(op.summary)}`;
      case "set":
        return `[🔮 Doco] 📝 ${Type} updated: ${mutationAnchor()}.${op.field} set to "${trunc(op.value, 100)}"`;
      case "cleared":
        return `[🔮 Doco] 🧹 ${Type} updated: ${mutationAnchor()}.${op.field} cleared`;
      case "added_to":
        return `[🔮 Doco] ➕ ${Type} updated: ${mutationAnchor()}.${op.field} added: ${op.names.join(", ")}`;
      case "removed_from":
        return `[🔮 Doco] ➖ ${Type} updated: ${mutationAnchor()}.${op.field} removed: ${op.names.join(", ")}`;
      case "replaced_list":
        return `[🔮 Doco] 🔁 ${Type} updated: ${mutationAnchor()}.${op.field} replaced with: ${op.names.join(", ")}`;
      case "replaced_body":
        return `[🔮 Doco] 🔁 ${Type} updated: ${mutationAnchor()}.body replaced`;
      case "appended_body":
        return `[🔮 Doco] ➕ ${Type} updated: ${mutationAnchor()}.body appended: ${trunc(op.preview, 100)}`;
      case "renamed":
        return `[🔮 Doco] 🏷️ ${Type} renamed: ${op.from} → ${buildAnchor(op.to)}`;
      case "deleted":
        return `[🔮 Doco] 🗑️ ${Type} deleted: ${buildAnchor(opts.summary)}`;
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
  /**
   * When the authoring-primitives evaluator blocks the capture, the
   * id of the primitive whose predicate produced the violation. Lets
   * the route surface a deep-link to the primitive.
   */
  primitive_id?: string;
  /**
   * Any additional non-blocking warnings produced alongside the
   * blocking violation. Useful when an agent's request fails multiple
   * checks at once.
   */
  warnings?: import("@doco/shared").Violation[];
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

  let op: "lifecycle.transition" | "synapse.add" | "entity.update";
  if (changed.includes("lifecycle")) {
    op = "lifecycle.transition";
  } else {
    const hasAddPatch = patchKeys.some((k) => k.endsWith("_add"));
    const allChangesAreEdges = changed.every((f) => f === "intent_ids");
    op = hasAddPatch && allChangesAreEdges ? "synapse.add" : "entity.update";
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
 * Apply the three list-op shapes (replace / add / remove) for a single
 * frontmatter field. Returns the ops emitted (for footer rendering) and
 * the list of changed-keys. Used by `updateDecision` + `updateEntity`
 * for the `intent_ids` list.
 *
 * `lookup` translates the input names to the ids Postgres stores;
 * `intent_ids` are already ids so the callback is a pass-through.
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
      const id = r.ids[i];
      const name = patch.add[i];
      if (!id || !name) continue;
      if (!merged.includes(id)) {
        merged.push(id);
        addedNames.push(name);
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
      const id = r.ids[i];
      const name = patch.remove[i];
      if (id && name && current.includes(id)) removedNames.push(name);
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
        "SELECT id FROM principals WHERE username = $1 LIMIT 1",
        [username],
      );
      return r.rows[0]?.id ?? null;
    });
  } catch {
    return null;
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
  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "decision",
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
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "decision",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "decision",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("decision", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

export interface DecisionPatch {
  summary?: string;
  question?: string;
  chosen?: string;
  alternatives?: { name: string; rejected_because: string }[];
  intent_ids?: string[];
  intent_ids_add?: string[];
  intent_ids_remove?: string[];
  decided_by_username?: string;
  body_md?: string;
  body_md_append?: string;
  born_from?: string | null;
  superseded_by?: string | null;
  lifecycle?: string;
  deprecated?: boolean | null;
  outcome?: "succeeded" | "failed" | null;
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

  const setScalar = (key: string, value: unknown) => {
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
      ops.push({ kind: "set", field: key, value: typeof v === "string" ? v : JSON.stringify(v) });
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
    const lifecycle = normalizeLifecycle(patch.lifecycle, "active");
    if (typeof lifecycle !== "string") return lifecycle;
    setScalar("lifecycle", lifecycle);
  }
  if (patch.deprecated !== undefined) {
    setScalar("deprecated", patch.deprecated);
  }
  if (patch.outcome !== undefined) {
    const outcome = normalizeOutcome(patch.outcome);
    if (outcome && typeof outcome !== "string") return outcome;
    setScalar("outcome", outcome ?? null);
  }
  if (patch.born_from !== undefined) {
    if (patch.born_from === null || patch.born_from === "") {
      if ("born_from" in fm) {
        fm.born_from = undefined;
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
        fm.superseded_by = undefined;
        changed.push("superseded_by");
        ops.push({ kind: "cleared", field: "superseded_by" });
      }
    } else {
      fm.superseded_by = patch.superseded_by;
      changed.push("superseded_by");
      ops.push({ kind: "set", field: "superseded_by", value: patch.superseded_by });
    }
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

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "decision",
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
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "decision",
    id: decisionId,
    summary,
    docoHost,
    ops,
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id: decisionId,
    path: syntheticPath("decision", decisionId),
    footer_lines,
    changed,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

export type NodeTypeName =
  | "decision"
  | "intent"
  | "rule"
  | "guidance_primitive"
  | "neuron_authoring_primitive"
  | "action"
  | "log"
  | "eval"
  | "idea"
  | "state"
  | "reference";

export interface EntityPatch {
  summary?: string;
  lifecycle?: string;
  deprecated?: boolean | null;
  outcome?: "succeeded" | "failed" | null;
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
  entityType: NodeTypeName;
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
    entityType,
    id,
    patch,
    allowedFields,
    docoHost,
    actorId,
  } = opts;

  const existing = await readEntityFromPostgres(entityType, id);
  if (!existing) return { error: `${entityType} not found: ${id}` };
  const fm = existing.fm;
  const existingBody = existing.body;
  // Types with a markdown body get body_md; `reference` is pure YAML
  // and ignores body operations.
  const isMd = entityType !== "reference";

  const gate = validatePatch(
    entityType,
    fm.lifecycle as string | undefined,
    patch as Record<string, unknown>,
  );
  if (!gate.allowed) {
    return {
      error: `${entityType} is frozen — patch touched disallowed field(s): ${gate.rejected.join(", ")}.`,
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
  if (patch.lifecycle !== undefined) {
    const lifecycle = normalizeLifecycle(patch.lifecycle, "active");
    if (typeof lifecycle !== "string") return lifecycle;
    setScalar("lifecycle", lifecycle);
  }
  if (patch.deprecated !== undefined) {
    setScalar("deprecated", patch.deprecated);
  }
  if (patch.outcome !== undefined) {
    const outcome = normalizeOutcome(patch.outcome);
    if (outcome && typeof outcome !== "string") return outcome;
    setScalar("outcome", outcome ?? null);
  }
  if (patch.born_from !== undefined) {
    if (patch.born_from === null || patch.born_from === "") {
      if ("born_from" in fm) {
        fm.born_from = undefined;
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
        fm.superseded_by = undefined;
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
    if (k === "summary") continue;
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

  // Compute the new body for Postgres storage. `reference` is pure
  // YAML and carries no body.
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
  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType,
    id,
    docoId,
    fm,
    body: nextBody,
  });
  emitAuditForUpdate({
    docoDir,
    docoId,
    actorId: actorId ?? null,
    entity_type: entityType,
    entity_id: id,
    changed,
    beforeFm,
    afterFm: fm,
    patchKeys: Object.keys(patch),
  });
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const summary = String(fm.summary ?? fm.name ?? id);
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType,
    id,
    summary,
    docoHost,
    ops,
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath(entityType, id),
    footer_lines,
    changed,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

export interface IntentDraft {
  /** Required: one-line "what someone wants" summary. */
  summary: string;

  /** Optional: short title (defaults to summary). */
  title?: string;
  /** Optional: markdown body — context + non-goals + success criteria. */
  body_md?: string;
  /** Optional: principal username who wants this. Resolves to id. */
  wanted_by_username?: string;
  /**
   * Optional: principals expected to act in this flow. Each username
   * resolves to a principal id; the resulting list is stored on the
   * Intent as `actors: [collaborator_id, ...]`. Used by the user-flows
   * `graph-completeness` rule to require an Action per actor before
   * the Intent moves to `active`.
   */
  actors_usernames?: string[];
  /** Optional: defaults to "active". */
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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
  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "intent",
    summary,
    title,
    wanted_by: wantedById,
    ...(actorIds.length > 0 ? { actors: actorIds } : {}),
    created_at: now,
    created_by: wantedById,
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "intent",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "intent",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("intent", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

export interface IdeaDraft {
  /** Required: one-line idea summary. */
  summary: string;
  /** Optional: markdown body with context, tradeoffs, or sketch notes. */
  body_md?: string;
  /** Optional: authenticated caller id; routes fill this automatically. */
  created_by_id?: string;
  /** Optional: entity this idea became once promoted. */
  promoted_to?: string | null;
  /** Optional: why the idea was rejected or parked. */
  rejection_reason?: string | null;
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

export async function captureIdea(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: IdeaDraft,
  docoHost?: string,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.summary?.trim()) return { error: "summary is required." };
  if (!draft.created_by_id) {
    return { error: "Authentication is required to capture an idea." };
  }

  const id = `idea_${generateUlid()}`;
  const summary = draft.summary.trim();
  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, "drafted");
  if ("error" in status) return status;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "idea",
    summary,
    proposer_id: draft.created_by_id,
    ...(draft.promoted_to ? { promoted_to: draft.promoted_to } : {}),
    ...(draft.rejection_reason ? { rejection_reason: draft.rejection_reason } : {}),
    created_at: now,
    created_by: draft.created_by_id,
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "idea",
    id,
    docoId,
    fm,
    body: draft.body_md?.trim() ?? "",
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: draft.created_by_id,
    entity_type: "idea",
    entity_id: id,
    summary,
  });
  await reindexAndScheduleAttach(docoDir, docoId, id);
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "idea",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("idea", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

export interface EvalDraft {
  /** Required: short readable name. */
  name: string;
  /** Required: criterion shape. */
  criterion: { kind: "exact" | "shape" | "llm-judge"; spec?: string };
  /** Optional: prose body. */
  body_md?: string;
  /** Optional: one-line summary; derived from description / name if absent. */
  summary?: string;
  /** Optional: what flavor of test this is. */
  kind?: "unit" | "integration" | "eval" | "process" | "doc-consistency";
  /** Optional: free-form description. */
  description?: string;
  /** Optional: status the author expects the runner to report. Defaults to "pass". */
  expected_status?: "pass" | "fail";
  /** Optional: free-form reproduction steps that produce `actual`. */
  how_to_run?: string;
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
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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
  if (
    draft.kind !== undefined &&
    !["unit", "integration", "eval", "process", "doc-consistency"].includes(draft.kind)
  ) {
    return { error: `Unknown kind: ${draft.kind}` };
  }
  if (draft.expected_status !== undefined && !["pass", "fail"].includes(draft.expected_status)) {
    return { error: `Unknown expected_status: ${draft.expected_status}` };
  }
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
  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "eval",
    summary,
    name: draft.name.trim(),
    ...(draft.kind ? { kind: draft.kind } : {}),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.expected_status ? { expected_status: draft.expected_status } : {}),
    ...(draft.how_to_run ? { how_to_run: draft.how_to_run } : {}),
    ...(draft.input !== undefined ? { input: draft.input } : {}),
    ...(draft.expected !== undefined ? { expected: draft.expected } : {}),
    criterion: draft.criterion,
    ...(draft.target_ref ? { target_ref: draft.target_ref } : {}),
    last_status: "pending",
    created_at: now,
    created_by: authoredById,
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "eval",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "eval",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("eval", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

// ─── Action ───────────────────────────────────────────────────────────────

export interface ActionDraft {
  /** Required: one-line summary of what was done. */
  summary: string;
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
  /** Optional: defaults to "retired" with `outcome: "succeeded"`. */
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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
  const status = lifecycleAttrs(draft, "retired", "succeeded");
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "action",
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
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "action",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "action",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("action", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

// ─── Log (recorded happening) ─────────────────────────────────────────────
// Parallel to Action but for instance-level happenings: a deploy that ran,
// a commit that pushed, an eval that verified. Required fields make the
// instance-vs-template distinction load-bearing: `happened_at` (when) and
// `outputs` (what concrete results came out).

export interface LogDraft {
  summary: string;
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
  /** Optional override. Logs default to "retired" with `outcome: "succeeded"`. */
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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
  const status = lifecycleAttrs(draft, "retired", "succeeded");
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "log",
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
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "log",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "log",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("log", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

// ─── Rule ─────────────────────────────────────────────────────────────────

export interface RuleDraft {
  /** Required: one-line summary of the policy. */
  summary: string;
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
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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
  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;

  // Empty selector — matches everything by having nothing to filter
  // on. Authors can still hand-edit `applies_to` via patch.
  const appliesTo = { any_of: [] as { tag: string }[] };

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "rule",
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
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "rule",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "rule",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("rule", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

// ─── Primitives ───────────────────────────────────────────────────────────

export interface GuidancePrimitiveDraft {
  /** Required: one-line summary of the guidance. */
  summary: string;
  /** Optional markdown body. Defaults to the summary so the article is readable. */
  body_md?: string;
  /** Optional: principal username who authored the article. */
  authored_by_username?: string;
  /** Optional: principal id who created this entry; defaults to authored_by. */
  created_by_id?: string;
  /** Optional: defaults to "active". */
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

export interface NeuronAuthoringPrimitiveDraft {
  /** Required: one-line summary of the capture-time check. */
  summary: string;
  /** Required: deterministic structural check or probabilistic LLM check. */
  evaluation_kind: "deterministic" | "probabilistic";
  /**
   * Deterministic articles accept an AuthoringPredicate object (or JSON
   * string) whose kind is not "probabilistic".
   */
  predicate?: AuthoringPredicate | string;
  /**
   * Probabilistic articles may pass a plain spec; it is stored as
   * { kind: "probabilistic", spec }.
   */
  spec?: string;
  fires_when_neuron_lifecycle?: string[];
  on_violation?: "block" | "warn" | "log";
  body_md?: string;
  authored_by_username?: string;
  created_by_id?: string;
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

async function resolvePrimitiveAuthor(draft: {
  authored_by_username?: string;
  created_by_id?: string;
}): Promise<string | CaptureError> {
  let authorId: string | null = null;
  if (draft.authored_by_username) {
    authorId = await resolvePrincipalUsername(draft.authored_by_username);
    if (!authorId) {
      return { error: `Unknown principal username: ${draft.authored_by_username}` };
    }
  }
  if (!authorId && draft.created_by_id) authorId = draft.created_by_id;
  if (!authorId) {
    return {
      error:
        "authored_by_username is required (or pass an authenticated request — the route fills it from `me.username`).",
    };
  }
  return authorId;
}

function parsePredicate(value: AuthoringPredicate | string | undefined): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalizeNodeAuthoringPredicate(
  draft: NeuronAuthoringPrimitiveDraft,
): AuthoringPredicate | CaptureError {
  if (draft.evaluation_kind === "probabilistic") {
    const spec =
      typeof draft.spec === "string" && draft.spec.trim().length > 0
        ? draft.spec.trim()
        : typeof draft.predicate === "object" &&
            draft.predicate !== null &&
            draft.predicate.kind === "probabilistic"
          ? draft.predicate.spec.trim()
          : "";
    if (!spec) return { error: "spec is required for probabilistic neuron_authoring_primitives." };
    return { kind: "probabilistic", spec };
  }

  const parsed = parsePredicate(draft.predicate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      error: "predicate must be a JSON object for deterministic neuron_authoring_primitives.",
    };
  }
  const predicate = parsed as AuthoringPredicate;
  if (predicate.kind === "probabilistic") {
    return {
      error:
        "deterministic neuron_authoring_primitives cannot use a probabilistic predicate; choose probabilistic instead.",
    };
  }
  if (typeof predicate.kind !== "string" || predicate.kind.length === 0) {
    return { error: "predicate.kind is required." };
  }
  return predicate;
}

export type PrimitiveCaptureExtras = Record<string, never>;

type PrimitiveType = "guidance_primitive" | "neuron_authoring_primitive";

interface PrimitivePayload {
  id: string;
  entityType: PrimitiveType;
  summary: string;
  lifecycle: string;
  fm: Record<string, unknown>;
  body: string;
  authorId: string;
  createdById: string;
  now: string;
}

async function buildGuidancePrimitivePayload(
  docoId: string,
  draft: GuidancePrimitiveDraft,
  _extras: PrimitiveCaptureExtras,
): Promise<PrimitivePayload | CaptureError> {
  if (!draft.summary?.trim()) return { error: "summary is required." };
  const author = await resolvePrimitiveAuthor(draft);
  if (typeof author !== "string") return author;

  const id = `guidance_primitive_${generateUlid()}`;
  const summary = draft.summary.trim();
  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;
  const lifecycle = String(status.lifecycle);
  const createdById = draft.created_by_id ?? author;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    primitive_kind: "guidance",
    summary,
    created_at: now,
    created_by: createdById,
    ...status,
  };

  return {
    id,
    entityType: "guidance_primitive",
    summary,
    lifecycle,
    fm,
    body: draft.body_md?.trim() || summary,
    authorId: author,
    createdById,
    now,
  };
}

async function buildNeuronAuthoringPrimitivePayload(
  docoId: string,
  draft: NeuronAuthoringPrimitiveDraft,
  _extras: PrimitiveCaptureExtras,
): Promise<PrimitivePayload | CaptureError> {
  if (!draft.summary?.trim()) return { error: "summary is required." };
  if (draft.evaluation_kind !== "deterministic" && draft.evaluation_kind !== "probabilistic") {
    return { error: "evaluation_kind must be deterministic or probabilistic." };
  }
  const author = await resolvePrimitiveAuthor(draft);
  if (typeof author !== "string") return author;
  const predicate = normalizeNodeAuthoringPredicate(draft);
  if ("error" in predicate) return predicate;

  const id = `neuron_authoring_primitive_${generateUlid()}`;
  const summary = draft.summary.trim();
  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;
  const lifecycle = String(status.lifecycle);
  const createdById = draft.created_by_id ?? author;
  const firesWhen = Array.isArray(draft.fires_when_neuron_lifecycle)
    ? draft.fires_when_neuron_lifecycle.filter((v) => typeof v === "string" && v.length > 0)
    : [];
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    primitive_kind: "neuron_authoring",
    evaluation_kind: draft.evaluation_kind,
    summary,
    predicate,
    ...(firesWhen.length > 0 ? { fires_when_neuron_lifecycle: firesWhen } : {}),
    on_violation: draft.on_violation ?? "block",
    created_at: now,
    created_by: createdById,
    ...status,
  };

  return {
    id,
    entityType: "neuron_authoring_primitive",
    summary,
    lifecycle,
    fm,
    body: draft.body_md?.trim() ?? "",
    authorId: author,
    createdById,
    now,
  };
}

export async function captureGuidancePrimitive(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: GuidancePrimitiveDraft,
  docoHost?: string,
  extras: PrimitiveCaptureExtras = {},
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  const payload = await buildGuidancePrimitivePayload(docoId, draft, extras);
  if ("error" in payload) return payload;

  const pred = await enforceAuthoringPrimitives(docoId, payload.fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: payload.entityType,
    id: payload.id,
    docoId,
    fm: payload.fm,
    body: payload.body,
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: payload.createdById,
    entity_type: payload.entityType,
    entity_id: payload.id,
    summary: payload.summary,
  });
  await reindexAndScheduleAttach(docoDir, docoId, payload.id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: payload.entityType,
    id: payload.id,
    summary: payload.summary,
    docoHost,
    ops: [{ kind: "added", summary: payload.summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id: payload.id,
    path: syntheticPath(payload.entityType, payload.id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

export async function captureNeuronAuthoringPrimitive(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: NeuronAuthoringPrimitiveDraft,
  docoHost?: string,
  extras: PrimitiveCaptureExtras = {},
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  const payload = await buildNeuronAuthoringPrimitivePayload(docoId, draft, extras);
  if ("error" in payload) return payload;

  const pred = await enforceAuthoringPrimitives(docoId, payload.fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: payload.entityType,
    id: payload.id,
    docoId,
    fm: payload.fm,
    body: payload.body,
  });
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: payload.createdById,
    entity_type: payload.entityType,
    entity_id: payload.id,
    summary: payload.summary,
  });
  await reindexAndScheduleAttach(docoDir, docoId, payload.id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: payload.entityType,
    id: payload.id,
    summary: payload.summary,
    docoHost,
    ops: [{ kind: "added", summary: payload.summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id: payload.id,
    path: syntheticPath(payload.entityType, payload.id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

/**
 * Lifecycle transition for a Doco primitive. Writes the new
 * lifecycle to the underlying table and emits a `lifecycle.transition`
 * audit event under the Doco scope.
 */
export async function transitionPrimitiveLifecycle(opts: {
  scope: "doco";
  scopeId: string;
  entityType: "guidance_primitive" | "neuron_authoring_primitive";
  primitiveId: string;
  newLifecycle: "active" | "retired";
  supersededBy?: string;
  actorId: string | null;
  reason?: string;
}): Promise<{ ok: true } | CaptureError> {
  const table =
    opts.entityType === "guidance_primitive"
      ? "guidance_primitives"
      : "neuron_authoring_primitives";
  const scopeCol = "doco_id";

  const before = await withClient(async (c) => {
    const r = await c.query<{ lifecycle: string | null; data: Record<string, unknown> }>(
      `SELECT lifecycle, data FROM ${table} WHERE id = $1 AND ${scopeCol} = $2`,
      [opts.primitiveId, opts.scopeId],
    );
    return r.rows[0] ?? null;
  });
  if (!before) {
    return { error: `Primitive ${opts.primitiveId} not found in scope.`, status: 404 };
  }

  const fm: Record<string, unknown> = { ...(before.data ?? {}) };
  fm.lifecycle = opts.newLifecycle;
  if (opts.supersededBy) fm.superseded_by = opts.supersededBy;
  const updated_at = new Date().toISOString();

  await withClient(async (c) => {
    await c.query(
      `UPDATE ${table}
          SET lifecycle = $1,
              data      = $2::jsonb,
              updated_at = $3,
              updated_by = $4
        WHERE id = $5 AND ${scopeCol} = $6`,
      [
        opts.newLifecycle,
        JSON.stringify(fm),
        updated_at,
        opts.actorId,
        opts.primitiveId,
        opts.scopeId,
      ],
    );
  });

  const evt: Parameters<typeof appendAuditEvent>[0] = {
    docoDir: "",
    docoId: opts.scopeId,
    by: opts.actorId,
    entity_type: opts.entityType,
    entity_id: opts.primitiveId,
    op: "lifecycle.transition",
    before: { lifecycle: before.lifecycle ?? "active" },
    after: {
      lifecycle: opts.newLifecycle,
      ...(opts.supersededBy ? { superseded_by: opts.supersededBy } : {}),
    },
  };
  if (opts.reason !== undefined) evt.reason = opts.reason;
  try {
    appendAuditEvent(evt);
  } catch (err) {
    console.error("audit-log: lifecycle transition append failed", err);
  }

  return { ok: true };
}

/** Fetch a Doco primitive's persisted fields (for the edit page). */
export async function loadPrimitiveForEdit(opts: {
  scope: "doco";
  scopeId: string;
  entityType: "guidance_primitive" | "neuron_authoring_primitive";
  primitiveId: string;
}): Promise<
  | {
      ok: true;
      summary: string;
      body_md: string;
      lifecycle: string;
      data: Record<string, unknown>;
    }
  | CaptureError
> {
  const table =
    opts.entityType === "guidance_primitive"
      ? "guidance_primitives"
      : "neuron_authoring_primitives";
  const scopeCol = "doco_id";
  const row = await withClient(async (c) => {
    const r = await c.query<{
      summary: string | null;
      body_md: string | null;
      lifecycle: string | null;
      data: Record<string, unknown> | null;
    }>(
      `SELECT summary, body_md, lifecycle, data FROM ${table}
        WHERE id = $1 AND ${scopeCol} = $2`,
      [opts.primitiveId, opts.scopeId],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return { error: `Primitive ${opts.primitiveId} not found.`, status: 404 };
  return {
    ok: true,
    summary: row.summary ?? "",
    body_md: row.body_md ?? "",
    lifecycle: row.lifecycle ?? "active",
    data: row.data ?? {},
  };
}

const REF_TYPES = new Set(["file", "url", "ticket", "commit", "document", "other"]);

export interface ReferenceDraft {
  ref_type: string;
  locator: string;
  summary?: string;
  body_md?: string;
  content_hash?: string | null;
  intent_ids?: string[];
  created_by_username?: string;
  created_by_id?: string;
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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
  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "reference",
    summary,
    ref_type: draft.ref_type,
    locator,
    ...(draft.content_hash ? { content_hash: draft.content_hash } : {}),
    ...(intentIds.length > 0 ? { intent_ids: intentIds } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "reference",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "reference",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("reference", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
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
  /** Optional: explicit lifecycle override. Defaults to "active". */
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
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

  const status = lifecycleAttrs(draft, "active");
  if ("error" in status) return status;

  const follows: string[] = Array.isArray(draft.follows) ? draft.follows : [];
  const invariants: string[] = Array.isArray(draft.invariants)
    ? draft.invariants.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    neuron_type: "state",
    summary,
    kind: draft.kind,
    ...(invariants.length > 0 ? { invariants } : {}),
    ...(follows.length > 0 ? { follows } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  const pred = await enforceAuthoringPrimitives(docoId, fm);
  if (pred.blocking) {
    return {
      error: `Authoring primitive violation: ${pred.blocking.reason}`,
      primitive_id: pred.blocking.primitive_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await persistEntity({
    entityType: "state",
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
  await reindexAndScheduleAttach(docoDir, docoId, id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "state",
    id,
    summary,
    docoHost,
    ops: [{ kind: "added", summary }],
    duration_ms,
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath("state", id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}
