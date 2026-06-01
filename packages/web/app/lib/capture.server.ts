import {
  ALL_ENTITY_TABLES,
  type CommitSource,
  type PoolClient,
  getDocoById,
  getEntity,
  recordEntityVersion,
  upsertEntity,
  withClient,
  withTransaction,
} from "@doco/db";
import {
  type AuthoringPredicate,
  BLOCKED_NODE_JSON_EDGE_FIELD_SET,
  EDGE_TYPES,
  generateUlid,
} from "@doco/shared";
import { waitUntil } from "@vercel/functions";
// Server-only helpers for "capture an entity" endpoints. Single-call API
// for agents/people to write a Decision (or other entity types) without
// round-tripping for ULID generation, ID lookups, and reindex.
//
// Identifiers: every node has exactly one id — the ULID. URLs use the
// ULID; agents/users read the readable field (`summary` for most nodes).
import { appendAuditEvent } from "./audit-log.server";
import { type AuthoringResult, runAuthoringPolicies } from "./authoring-runner.server";

/**
 * System-managed identity / audit columns that PATCH must never
 * touch. Step B of the node shape sweep removed per-type field
 * whitelists; every field except these is patchable. (The old
 * frozen-claim gate that further restricted patches by lifecycle has
 * been removed — any writer may edit any node or edge at any
 * lifecycle; history lives in the append-only audit log + immutable
 * version snapshots.)
 */
const SYSTEM_MANAGED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "doco_id",
  "entity_type",
  "node_type",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);
const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

function isSystemManagedField(key: string): boolean {
  return SYSTEM_MANAGED_FIELDS.has(key);
}
import { reindex, reindexEmbeddingsOnly } from "./redeem.server";
import { recordPhase } from "./telemetry.server";

export interface AuthoringWriteContext {
  source?: CommitSource;
  metadata?: Record<string, unknown> | null;
}

/**
 * Run the doco's authoring policies against a candidate's full
 * frontmatter. Centralized here so every captureX / updateEntity path
 * applies the same enforcement: blocking violations short-circuit
 * before persistEntity, warnings get attached to the result. Replaces
 * the pre-v16 `runScopeRules` call (deleted in commit 4974339).
 *
 * When `client` is provided, the enforcer reads on that connection so
 * the load and the subsequent upsert share one DB snapshot.
 */
async function enforceAuthoringPolicies(
  docoId: string,
  fm: Record<string, unknown>,
  client?: PoolClient,
): Promise<AuthoringResult> {
  const start = performance.now();
  try {
    return await runAuthoringPolicies({
      docoId,
      candidate: fm as Parameters<typeof runAuthoringPolicies>[0]["candidate"],
      ...(client ? { client } : {}),
    });
  } finally {
    recordPhase("authoring_ms", performance.now() - start);
  }
}

/**
 * Atomic enforce-then-persist: opens one transaction, evaluates the
 * doco's authoring policies against `fm`, and — if nothing blocks —
 * upserts the entity on the same connection. Concurrent writers can no
 * longer slip a new active block policy into the doco between the
 * check and the write, and the loader / persister see the same row
 * snapshot.
 *
 * Returns the AuthoringResult unchanged so callers keep their existing
 * blocking/warnings branches. When `result.blocking` is set the upsert
 * was skipped.
 */
async function enforceAndPersist(args: {
  docoId: string;
  fm: Record<string, unknown>;
  entityType: string;
  id: string;
  body?: string;
  authoring?: AuthoringWriteContext;
}): Promise<AuthoringResult> {
  return withTransaction(async (c) => {
    const pred = await enforceAuthoringPolicies(args.docoId, args.fm, c);
    if (pred.blocking) return pred;
    await persistEntity({
      entityType: args.entityType,
      id: args.id,
      docoId: args.docoId,
      fm: args.fm,
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.authoring ? { authoring: args.authoring } : {}),
      client: c,
    });
    return pred;
  });
}

/**
 * Render non-blocking authoring-policy warnings as footer lines.
 * Appended after the operation lines so the agent sees them inline
 * with the capture result.
 */
function renderAuthoringWarnings(warnings: AuthoringResult["warnings"]): string[] {
  return warnings.map((w) => `[🔮 Doco] ⚠️ Authoring warning: ${w.reason}`);
}

export function authoringPoliciesPassed(
  result: Partial<Pick<AuthoringResult, "passed" | "evaluated" | "violations">>,
): number {
  if (typeof result.passed === "number" && Number.isFinite(result.passed)) {
    return Math.max(0, result.passed);
  }
  const evaluated =
    typeof result.evaluated === "number" && Number.isFinite(result.evaluated)
      ? result.evaluated
      : 0;
  const violations = Array.isArray(result.violations) ? result.violations.length : 0;
  return Math.max(0, evaluated - violations);
}

function renderOperationTiming(opts: {
  duration_ms?: number;
  authoringPoliciesPassed?: number;
}): string | null {
  if (typeof opts.duration_ms !== "number") return null;
  const seconds = (opts.duration_ms / 1000).toFixed(1);
  if (
    typeof opts.authoringPoliciesPassed === "number" &&
    Number.isFinite(opts.authoringPoliciesPassed)
  ) {
    const count = Math.max(0, Math.trunc(opts.authoringPoliciesPassed));
    const noun = count === 1 ? "policy" : "policies";
    return `✅ ${count} authoring ${noun} passed in ${seconds}s`;
  }
  return `${seconds}s`;
}

export function appendOperationTiming(
  line: string,
  opts: { duration_ms?: number; authoringPoliciesPassed?: number },
): string {
  const timing = renderOperationTiming(opts);
  return timing ? `${line} (${timing})` : line;
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
 * Persist an entity to Postgres. This is the sole writer for entity
 * content.
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
  /** When provided, the upsert runs on this client (used to share a
   *  transaction with the authoring enforcer). */
  client?: PoolClient;
  authoring?: AuthoringWriteContext;
}): Promise<void> {
  const { fm } = args;
  const start = performance.now();
  try {
    await upsertEntity(
      {
        id: args.id,
        doco_id: args.docoId,
        entity_type: args.entityType,
        data: fm,
        body_md: args.body,
        lifecycle: typeof fm.lifecycle === "string" ? fm.lifecycle : null,
        name: typeof fm.name === "string" ? fm.name : null,
        type_named_value: computeTypeNamedValue(args.entityType, fm),
        created_at: typeof fm.created_at === "string" ? fm.created_at : null,
        created_by: typeof fm.created_by === "string" ? fm.created_by : null,
        updated_at: typeof fm.updated_at === "string" ? fm.updated_at : null,
        updated_by: typeof fm.updated_by === "string" ? fm.updated_by : null,
      },
      args.client,
    );
    // Append-only history: record an immutable version snapshot +
    // changeset for this write — atomic with the projection when a tx client is
    // provided. op (create/update/retire) is derived inside recordEntityVersion.
    const versionActor =
      (typeof fm.updated_by === "string" && fm.updated_by) ||
      (typeof fm.created_by === "string" ? fm.created_by : null);
    const recordVersion = (c: PoolClient) =>
      recordEntityVersion(c, {
        docoId: args.docoId,
        entityType: args.entityType,
        entityId: args.id,
        payload: fm,
        actor: versionActor,
        source: args.authoring?.source,
        metadata: args.authoring?.metadata,
      });
    if (args.client) await recordVersion(args.client);
    else await withClient(recordVersion);
  } catch (err) {
    console.error(`postgres persist failed for ${args.entityType}/${args.id}:`, err);
    throw err;
  } finally {
    recordPhase("persist_ms", performance.now() - start);
  }
}

/**
 * Migration-022/023: derive the type-named column value for a migrated
 * node (`intent` for intent rows, `decision` for decision rows, …).
 * After PR #80 every captureX path populates `fm[entityType]` directly
 * with the full prose content; the value is whatever the caller stored
 * there. Non-migrated entities (policies, principal) have no
 * type-named column and the empty string is fine — `upsertEntity` only
 * binds this column when the table spec declares one.
 */
function computeTypeNamedValue(entityType: string, fm: Record<string, unknown>): string {
  const direct = fm[entityType];
  return typeof direct === "string" ? direct : "";
}

/**
 * Reindex synchronously (so the caller's response reflects persisted
 * rows/FTS/embeddings). The caller must have already `await`-ed
 * `persistEntity` so the new row is durably written before the reindex
 * reads it back.
 *
 * Why sync reindex: on Vercel-style serverless deploys the lambda is
 * frozen once the response is sent — a fire-and-forget background
 * promise may never run to completion. The fix: await the reindex before
 * responding. Adds a few hundred ms to capture/PATCH latency; in return the
 * graph is always consistent the moment the agent sees the success line.
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
 */
export async function reindexAndScheduleAttach(
  docoDir: string,
  docoId: string,
  changedEntityId: string,
): Promise<void> {
  const start = performance.now();
  try {
    await reindex(docoDir, docoId, [changedEntityId], { skipEmbeddings: true });
  } catch (err) {
    console.error(`reindex failed for ${docoDir}:`, err);
  } finally {
    recordPhase("reindex_structural_ms", performance.now() - start);
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
  /** Required: the full Decision prose (first line = label). */
  decision: string;
  /** Required: the question the Decision answers. */
  question: string;
  /** Optional: chosen resolution (multi-line ok). Resolution-style
   *  Decisions (ADRs, glossary terms) carry a `chosen`; BPMN gateway
   *  Decisions route flow through outgoing `flows_to` edges and have no
   *  single chosen answer. Templates that need it re-require it via a
   *  `requires_field` policy (e.g. glossaries). Matches the entity type,
   *  where `chosen` is `string | null` (null while drafting). */
  chosen?: string;

  /** Optional: rejected alternatives. */
  alternatives?: { name: string; rejected_because: string }[];
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
  /** Optional: defaults to "asserted". */
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
   * reindex), measured server-side via `performance.now()`. The footer
   * renderer combines this with the authoring-policy pass count on the
   * last operation line.
   */
  duration_ms: number;
  /**
   * Non-blocking authoring-policy violations produced by the
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
const VALID_LIFECYCLES = new Set(["drafting", "asserted", "retired"]);
const VALID_OUTCOMES = new Set(["succeeded", "failed"]);

/**
 * Sentinel error returned by updateEntity when a PATCH would change nothing.
 * Callers that re-apply idempotent updates (e.g. the GitHub PR sync) treat this
 * as "already current", not a failure — so it's exported rather than inlined.
 */
export const NO_FIELDS_CHANGED = "No fields changed.";

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
  // A default outcome (e.g. Action/Log default to retired+succeeded)
  // only makes sense when the node actually lands in a terminal
  // lifecycle. When a Doco's `default_node_lifecycle` (or an explicit
  // draft) pulls the node to a non-terminal state, don't stamp the
  // success outcome onto a still-in-flight node.
  const effectiveDefaultOutcome = STRUCK_LIFECYCLES.has(lifecycle) ? defaultOutcome : undefined;
  const outcome = normalizeOutcome(draft.outcome ?? effectiveDefaultOutcome);
  if (outcome && typeof outcome !== "string") return outcome;
  return {
    lifecycle,
    ...(draft.deprecated !== undefined ? { deprecated: Boolean(draft.deprecated) } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * Resolve the lifecycle fallback for a capture: the Doco's
 * template-seeded `default_node_lifecycle` when set, otherwise the
 * node type's built-in default. Wires up the `defaultNodeLifecycle`
 * the templates already declare — it was stored on the Doco but never
 * consulted at capture time, so e.g. `org-chart`'s `drafting` default
 * (and the asserted-only completeness gates it implies) didn't take
 * effect through the capture API. A per-process memo keeps this to one
 * Doco read even across a multi-node changeset.
 */
const docoDefaultLifecycleCache = new Map<string, string | null>();
async function resolveDefaultLifecycle(docoId: string, perTypeFallback: string): Promise<string> {
  let dflt = docoDefaultLifecycleCache.get(docoId);
  if (dflt === undefined) {
    dflt = (await getDocoById(docoId))?.default_node_lifecycle ?? null;
    docoDefaultLifecycleCache.set(docoId, dflt);
  }
  return dflt && VALID_LIFECYCLES.has(dflt) ? dflt : perTypeFallback;
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
 * First non-empty line of a (possibly multi-line) prose string. Used to
 * derive the short label that identifies a migrated node in footer
 * lines and audit events from the type-named prose field.
 */
function firstLine(text: string): string {
  const lines = text.split(/\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return text.trim();
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
 *   - Timing trailer is appended on the last line of a batch. Capture
 *     endpoints that run authoring policies render
 *     `(✅ X authoring policies passed in X.Xs)`.
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
   * Canonical URL identifier.
   * When provided, the footer link uses `${docoHost}/${handle}/...`.
   * Optional — when omitted, the function looks it up by `docoId` (if
   * provided) or falls back to historical `<owner>-<slug>` synthesis.
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
   * Readable label used as the link text on every op line. For nodes
   * this is the first line of the type-named prose field
   * (`firstLine(fm[entityType])`); policies/principals pass their
   * display text directly.
   */
  label: string;
  /**
   * Absolute base URL for entity links (e.g., `http://localhost:5173`).
   * Typically `new URL(request.url).origin` from the API route. When
   * omitted, the body is rendered without a markdown link.
   */
  docoHost?: string;
  ops: Op[];
  duration_ms?: number;
  authoringPoliciesPassed?: number;
}): Promise<string[]> {
  const Type = capType(opts.entityType);
  // Every Doco URL is `/<handle>/...`. Use the explicit handle when
  // given; otherwise look it up by docoId; otherwise fall back to the
  // historical `<owner>-<slug>` synthesis used by old call sites.
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
  const buildAnchor = (labelForLine: string): string => {
    const text = trunc(labelForLine);
    return linkUrl ? `[${mdLinkText(text)}](${linkUrl})` : text;
  };
  // Mutation lines append `.<field>` after the anchor as dot-notation
  // (entity.property). If the label text ends with a period, the
  // link text's trailing `.` plus the separator `.` render as `..` —
  // strip the trailing period so the dot-notation stays clean.
  const shouldStrikeMutationAnchor = opts.ops.some(
    (op) => op.kind === "set" && op.field === "lifecycle" && STRUCK_LIFECYCLES.has(op.value),
  );
  const mutationAnchor = (): string => {
    const anchor = buildAnchor(opts.label.replace(/\.+$/, ""));
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
        return `[🔮 Doco] 🗑️ ${Type} deleted: ${buildAnchor(opts.label)}`;
    }
  });
  if (lines.length > 0) {
    lines[lines.length - 1] = appendOperationTiming(lines[lines.length - 1], {
      duration_ms: opts.duration_ms,
      authoringPoliciesPassed: opts.authoringPoliciesPassed,
    });
  }
  return lines;
}

export interface CaptureError {
  error: string;
  /** HTTP status the route should return. Defaults to 400 when absent. */
  status?: number;
  /**
   * When the authoring-policies evaluator blocks the capture, the
   * id of the policy whose predicate produced the violation. Lets
   * the route surface a deep-link to the policy.
   */
  policy_id?: string;
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
 * Rule: lifecycle change wins (op = lifecycle.transition). Otherwise this is
 * an entity.update; edge mutations are recorded by the edge capture path.
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
  const { changed, beforeFm, afterFm } = opts;
  if (changed.length === 0) return;

  const op: "lifecycle.transition" | "entity.update" = changed.includes("lifecycle")
    ? "lifecycle.transition"
    : "entity.update";

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
 *
 * `label` is the short identifier — for migrated nodes it's the
 * first line of the type-named prose field, for policies it's the
 * one-line `policy` rule, for principals it's the slug `name`. The
 * audit event records it under the right key per entity type.
 */
function emitAuditForCreate(opts: {
  docoDir: string;
  docoId: string;
  actorId: string | null;
  entity_type: string;
  entity_id: string;
  label?: string;
}): void {
  try {
    let after: Record<string, unknown> | undefined;
    if (opts.label) {
      const typeNamedColumn = ALL_ENTITY_TABLES[opts.entity_type]?.typeNamedColumn;
      const labelKey = typeNamedColumn
        ? typeNamedColumn
        : opts.entity_type === "principal"
          ? "name"
          : "policy";
      after = { [labelKey]: opts.label };
    }
    appendAuditEvent({
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      by: opts.actorId,
      entity_type: opts.entity_type,
      entity_id: opts.entity_id,
      op: "entity.create",
      after,
    });
  } catch (err) {
    console.error("audit-log: failed to append create event", err);
  }
}

function requiredPrincipalId(
  value: string | undefined,
  field: string,
  fallbackDescription?: string,
): string | CaptureError {
  const principalId = value?.trim();
  if (!principalId) {
    return {
      error: `${field} is required${fallbackDescription ? ` (${fallbackDescription})` : ""}.`,
    };
  }
  const bad = assertNotUserId(principalId, field);
  if (bad) return bad;
  return principalId;
}

/**
 * Refuse `user_*` ids on capture paths that expect a Principal.
 * Users are the OAuth identity layer; Principals are the
 * role-personas policies reference. They share humans but they aren't
 * interchangeable.
 */
function assertNotUserId(value: string, field: string): CaptureError | null {
  if (!value.startsWith("user_")) return null;
  return {
    error: `${field} must be a Principal NODE id (\`principal_<ulid>\`), not a user id (\`${value}\`). Users are OAuth identities; Principals are the role-personas nodes reference. To fix: GET /<doco-handle>/api/principals.json and read \`principal_nodes\`. If empty or no matching role exists, POST /<doco-handle>/api/principals.json with body {"name": "user"} (or another role name) to create one — that endpoint returns the new id. Then retry the capture with the explicit principal id in \`${field}\`.`,
  };
}

type UserCreatorDraft = {
  created_by_user_id?: string;
};

function userCreatorId(draft: UserCreatorDraft): string | null | CaptureError {
  const creatorId = draft.created_by_user_id?.trim();
  if (!creatorId) return null;
  if (!creatorId.startsWith("user_")) {
    return { error: "created_by_user_id must be a user id." };
  }
  return creatorId;
}

function rejectNodeJsonEdgeKeys(record: unknown): CaptureError | null {
  if (!record || typeof record !== "object") return null;
  for (const [field, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (BLOCKED_NODE_JSON_EDGE_FIELD_SET.has(field)) {
      return {
        error: `${field} is not a node JSON field. Create, update, or retire a first-class edge instead.`,
      };
    }
  }
  return null;
}

/**
 * Shared tail for every node `captureX()` create path. Each capture
 * function does its own type-specific work — prose/required-field
 * validation, principal-id resolution, `id`/`label`/`now`/`createdById`/
 * lifecycle setup, and `fm` construction — then hands the finished `fm`
 * here. This runs the identical scaffold the 9 node creators shared
 * verbatim:
 *
 *   enforceAndPersist → blocking short-circuit → emitAuditForCreate →
 *   reindexAndScheduleAttach → renderOperationLines → append authoring
 *   warnings → return the CaptureResult.
 *
 * Behavior-preserving extraction (the per-type body stays local in each
 * captureX). `createdById` is already narrowed to `string | null` by the
 * caller's `userCreatorId` guard, so `actorId: createdById ?? null`
 * passes byte-identical values to the prior call sites (some passed
 * `createdById`, two passed `createdById ?? null`).
 */
async function finishNodeCapture(args: {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  docoHost?: string;
  entityType: string;
  id: string;
  label: string;
  fm: Record<string, unknown>;
  createdById: string | null;
  startedAt: number;
  authoring?: AuthoringWriteContext;
}): Promise<CaptureResult | CaptureError> {
  const {
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType,
    id,
    label,
    fm,
    createdById,
    authoring,
  } = args;
  const pred = await enforceAndPersist({ docoId, fm, entityType, id, authoring });
  if (pred.blocking) {
    return {
      error: `Authoring policy violation: ${pred.blocking.reason}`,
      policy_id: pred.blocking.policy_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: createdById ?? null,
    entity_type: entityType,
    entity_id: id,
    label,
  });
  await reindexAndScheduleAttach(docoDir, docoId, id);
  const duration_ms = Math.round(performance.now() - args.startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType,
    id,
    label,
    docoHost,
    ops: [{ kind: "added", summary: label }],
    duration_ms,
    authoringPoliciesPassed: authoringPoliciesPassed(pred),
  });
  footer_lines.push(...renderAuthoringWarnings(pred.warnings));
  return {
    ok: true,
    id,
    path: syntheticPath(entityType, id),
    footer_lines,
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}

export async function captureDecision(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: DecisionDraft,
  docoHost?: string,
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.decision?.trim()) return { error: "decision is required." };
  if (!draft.question?.trim()) return { error: "question is required." };
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
  // `chosen` is optional: a BPMN gateway Decision routes flow through outgoing
  // `flows_to` edges and has no single chosen answer. Resolution-style
  // Decisions still get `chosen` enforced by their template (glossaries' and
  // any ADR-style requires_field policy).

  const id = `decision_${generateUlid()}`;

  const decisionText = draft.decision.trim();
  const label = firstLine(decisionText);

  const now = new Date().toISOString();
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  const status = lifecycleAttrs(draft, await resolveDefaultLifecycle(docoId, "asserted"));
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "decision",
    decision: decisionText,
    question: draft.question.trim(),
    ...(draft.chosen?.trim() ? { chosen: draft.chosen.trim() } : {}),
    ...(Array.isArray(draft.alternatives) && draft.alternatives.length > 0
      ? { alternatives: draft.alternatives }
      : {}),
    decided_at: now,
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "decision",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

export interface DecisionPatch {
  decision?: string;
  question?: string;
  chosen?: string;
  alternatives?: { name: string; rejected_because: string }[];
  lifecycle?: string;
  deprecated?: boolean | null;
  outcome?: "succeeded" | "failed" | null;
  [k: string]: unknown;
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
  authoring?: AuthoringWriteContext,
): Promise<UpdateResult | CaptureError> {
  const startedAt = performance.now();
  const existing = await readEntityFromPostgres("decision", decisionId);
  if (!existing) return { error: `Decision not found: ${decisionId}` };
  const fm = existing.fm;
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(patch as Record<string, unknown>);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;

  // Snapshot pre-mutation values for the audit log; only the fields
  // that get mutated below are inspected later, so a shallow copy of
  // policies + reference grab for arrays is sufficient.
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

  setScalar("decision", patch.decision?.trim());
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
    const lifecycle = normalizeLifecycle(patch.lifecycle, "asserted");
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
  if (changed.length === 0) {
    return { error: NO_FIELDS_CHANGED };
  }

  const pred = await enforceAndPersist({
    docoId,
    fm,
    entityType: "decision",
    id: decisionId,
    authoring,
  });
  if (pred.blocking) {
    return {
      error: `Authoring policy violation: ${pred.blocking.reason}`,
      policy_id: pred.blocking.policy_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }
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
  const label = firstLine(typeof fm.decision === "string" ? fm.decision : decisionId);
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: "decision",
    id: decisionId,
    label,
    docoHost,
    ops,
    duration_ms,
    authoringPoliciesPassed: authoringPoliciesPassed(pred),
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
  | "guidance_policy"
  | "node_authoring_policy"
  | "action"
  | "log"
  | "eval"
  | "idea"
  | "state"
  | "reference";

export interface EntityPatch {
  lifecycle?: string;
  deprecated?: boolean | null;
  outcome?: "succeeded" | "failed" | null;
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
  /**
   * Legacy per-route whitelist. Now ignored — Step B of the node
   * shape sweep removed per-type field restrictions; every field
   * except system-managed identity/audit columns is patchable. Kept
   * as `undefined` in the type so the factory keeps compiling while we
   * let stragglers fall away.
   */
  allowedFields?: undefined;
  docoHost?: string;
  actorId?: string | null;
  authoring?: AuthoringWriteContext;
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
    docoHost,
    actorId,
    authoring,
  } = opts;

  const existing = await readEntityFromPostgres(entityType, id);
  if (!existing) return { error: `${entityType} not found: ${id}` };
  const fm = existing.fm;
  const existingBody = existing.body;
  const normalizedPatch = patch;
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(patch);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
  // Migration-022/023: 9 node types collapsed summary+body_md+extras
  // into a single type-named prose column. Policies use the `policy`
  // column (renamed from `summary` by 038) + body_md. Principals use
  // `name` + `body_md` after 037 dropped the summary column.
  // Distinguished by whether ALL_ENTITY_TABLES exposes a typeNamedColumn.
  const typeNamedColumn = ALL_ENTITY_TABLES[entityType]?.typeNamedColumn;
  // Types with a markdown body get body_md; `reference` is pure YAML
  // and ignores body operations. For migrated nodes body_md is gone
  // entirely; only policies/principal still carry it.
  const isMd = !typeNamedColumn && entityType !== "reference";

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

  if (typeNamedColumn && typeNamedColumn in normalizedPatch) {
    // Node prose lives in the type-named field; body_md remains the
    // long-form markdown body.
    const v = normalizedPatch[typeNamedColumn];
    setScalar(typeNamedColumn, typeof v === "string" ? v.trim() : undefined);
  } else if (!typeNamedColumn && "policy" in normalizedPatch) {
    // Policies (the only non-typeNamedColumn entity reaching this
    // PATCH path — NodeTypeName doesn't include "principal", which
    // has its own dedicated route).
    setScalar(
      "policy",
      typeof normalizedPatch.policy === "string" ? normalizedPatch.policy.trim() : undefined,
    );
  }
  if (normalizedPatch.lifecycle !== undefined) {
    const lifecycle = normalizeLifecycle(normalizedPatch.lifecycle, "asserted");
    if (typeof lifecycle !== "string") return lifecycle;
    setScalar("lifecycle", lifecycle);
  }
  if (normalizedPatch.deprecated !== undefined) {
    setScalar("deprecated", normalizedPatch.deprecated);
  }
  if (normalizedPatch.outcome !== undefined) {
    const outcome = normalizeOutcome(normalizedPatch.outcome);
    if (outcome && typeof outcome !== "string") return outcome;
    setScalar("outcome", outcome ?? null);
  }
  // Apply every other field in the patch to the entity's data jsonb.
  // Step B of the node shape sweep dropped per-type whitelists: any
  // user-supplied field that isn't system-managed (id/audit columns),
  // isn't a special-cased scalar handled above (lifecycle, outcome,
  // deprecated), and isn't a prose body operation (body_md /
  // body_md_append) is written straight through.
  const SPECIAL_CASED_KEYS = new Set<string>([
    "lifecycle",
    "outcome",
    "deprecated",
    "body_md",
    "body_md_append",
    "policy",
    "created_by_user_id",
    // Slug is not a node data field.
    "slug",
    ...(typeNamedColumn ? [typeNamedColumn] : []),
  ]);
  for (const k of Object.keys(normalizedPatch)) {
    if (SPECIAL_CASED_KEYS.has(k)) continue;
    if (isSystemManagedField(k)) continue;
    const v = normalizedPatch[k];
    if (v === undefined) continue;
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

  let bodyOp: "replace" | "append" | "none" = "none";
  if (isMd) {
    if (normalizedPatch.body_md !== undefined) bodyOp = "replace";
    else if (normalizedPatch.body_md_append !== undefined) bodyOp = "append";
  }
  if (bodyOp !== "none") {
    changed.push("body");
    if (bodyOp === "replace") ops.push({ kind: "replaced_body" });
    else ops.push({ kind: "appended_body", preview: String(normalizedPatch.body_md_append ?? "") });
  }

  if (changed.length === 0) {
    return { error: NO_FIELDS_CHANGED };
  }

  // Compute the new body for Postgres storage. Only policies/principal
  // still have a separate body_md column; the migrated nodes fold
  // prose into the type-named column above.
  let nextBody: string | undefined;
  if (isMd) {
    if (normalizedPatch.body_md !== undefined) {
      nextBody = String(normalizedPatch.body_md).trim();
    } else if (normalizedPatch.body_md_append !== undefined) {
      nextBody = existingBody
        ? `${existingBody.replace(/\n+$/, "")}\n\n${String(normalizedPatch.body_md_append).trim()}`
        : String(normalizedPatch.body_md_append).trim();
    } else {
      nextBody = existingBody.trim();
    }
  }
  const pred = await enforceAndPersist({
    docoId,
    fm,
    entityType,
    id,
    authoring,
    ...(nextBody !== undefined ? { body: nextBody } : {}),
  });
  if (pred.blocking) {
    return {
      error: `Authoring policy violation: ${pred.blocking.reason}`,
      policy_id: pred.blocking.policy_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }
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

  const label = typeNamedColumn
    ? firstLine(typeof fm[typeNamedColumn] === "string" ? (fm[typeNamedColumn] as string) : id)
    : String(fm.policy ?? fm.name ?? id);
  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType,
    id,
    label,
    docoHost,
    ops,
    duration_ms,
    authoringPoliciesPassed: authoringPoliciesPassed(pred),
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
  /** Required: the full Intent prose (first line = label). */
  intent: string;

  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
  /** Optional: defaults to "asserted". */
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.intent?.trim()) return { error: "intent is required." };
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
  const id = `intent_${generateUlid()}`;
  const intentText = draft.intent.trim();
  const label = firstLine(intentText);

  const now = new Date().toISOString();
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  const status = lifecycleAttrs(draft, await resolveDefaultLifecycle(docoId, "asserted"));
  if ("error" in status) return status;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "intent",
    intent: intentText,
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "intent",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

export interface IdeaDraft {
  /** Required: the full Idea prose (first line = label). */
  idea: string;
  /** Internal route-filled user id that created/proposed this idea. */
  created_by_user_id?: string;
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.idea?.trim()) return { error: "idea is required." };
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  if (!createdById) {
    return { error: "Authentication is required to capture an idea." };
  }

  const id = `idea_${generateUlid()}`;
  const ideaText = draft.idea.trim();
  const label = firstLine(ideaText);
  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, await resolveDefaultLifecycle(docoId, "drafting"));
  if ("error" in status) return status;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "idea",
    idea: ideaText,
    proposer_id: createdById,
    ...(draft.promoted_to ? { promoted_to: draft.promoted_to } : {}),
    ...(draft.rejection_reason ? { rejection_reason: draft.rejection_reason } : {}),
    created_at: now,
    created_by: createdById,
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "idea",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

export interface EvalDraft {
  /** Required: the full Eval prose (first line = label). */
  eval: string;
  /** Required: criterion shape. */
  criterion: { kind: "exact" | "shape" | "llm-judge"; spec?: string };
  /** Optional: what flavor of test this is. */
  kind?: "unit" | "integration" | "eval" | "process" | "doc-consistency";
  /** Optional: status the author expects the runner to report. Defaults to "pass". */
  expected_status?: "pass" | "fail";
  /** Optional: free-form reproduction steps that produce `actual`. */
  how_to_run?: string;
  /** Optional: input value (any shape). */
  input?: unknown;
  /** Optional: expected outcome (any shape; prose for llm-judge). */
  expected?: unknown;
  /** Internal route-filled user id that created this Eval. */
  created_by_user_id?: string;
  /** Optional default: lifecycle = "asserted". */
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.eval?.trim()) return { error: "eval is required." };
  if (!draft.criterion?.kind) return { error: "criterion.kind is required." };
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
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
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;

  const id = `eval_${generateUlid()}`;
  const evalText = draft.eval.trim();
  const label = firstLine(evalText);

  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, await resolveDefaultLifecycle(docoId, "asserted"));
  if ("error" in status) return status;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "eval",
    eval: evalText,
    ...(draft.kind ? { kind: draft.kind } : {}),
    ...(draft.expected_status ? { expected_status: draft.expected_status } : {}),
    ...(draft.how_to_run ? { how_to_run: draft.how_to_run } : {}),
    ...(draft.input !== undefined ? { input: draft.input } : {}),
    ...(draft.expected !== undefined ? { expected: draft.expected } : {}),
    criterion: draft.criterion,
    last_status: "pending",
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "eval",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────

export interface ActionDraft {
  /** Required: the full Action prose (first line = label). */
  action: string;
  /** Required: short verb naming the action (`refactor`, `migrate`, …). */
  verb: string;

  /** Optional: verb-specific inputs (any shape). */
  inputs?: unknown;
  /** Optional: verb-specific outputs (any shape). */
  outputs?: unknown;
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.action?.trim()) return { error: "action is required." };
  if (!draft.verb?.trim()) return { error: "verb is required." };
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
  const id = `action_${generateUlid()}`;
  const actionText = draft.action.trim();
  const label = firstLine(actionText);
  const now = new Date().toISOString();
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  const status = lifecycleAttrs(
    draft,
    await resolveDefaultLifecycle(docoId, "retired"),
    "succeeded",
  );
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "action",
    action: actionText,
    verb: draft.verb.trim(),
    ...(draft.inputs !== undefined ? { inputs: draft.inputs } : {}),
    ...(draft.outputs !== undefined ? { outputs: draft.outputs } : {}),
    performed_at: now,
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "action",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

// ─── Log (recorded happening) ─────────────────────────────────────────────
// Parallel to Action but for instance-level happenings: a deploy that ran,
// a commit that pushed, an eval that verified. Required fields make the
// instance-vs-template distinction load-bearing: `happened_at` (when) and
// `outputs` (what concrete results came out).

export interface LogDraft {
  /** Required: the full Log prose (first line = label). */
  log: string;
  /** Past-tense verb naming what happened ("pushed", "deployed", "verified"). */
  verb: string;
  /** When the event occurred. ISO 8601 UTC. */
  happened_at: string;
  /** Concrete output values from the event — commit hash, deploy URL,
   *  verification result. Non-empty in practice. */
  outputs: Record<string, unknown>;

  inputs?: unknown;
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.log?.trim()) return { error: "log is required." };
  if (!draft.verb?.trim()) return { error: "verb is required." };
  if (!draft.happened_at?.trim()) {
    return { error: "happened_at is required (ISO 8601 UTC) — Logs record a moment in time." };
  }
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
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
  const id = `log_${generateUlid()}`;
  const logText = draft.log.trim();
  const label = firstLine(logText);
  const now = new Date().toISOString();
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  const status = lifecycleAttrs(
    draft,
    await resolveDefaultLifecycle(docoId, "retired"),
    "succeeded",
  );
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "log",
    log: logText,
    verb: draft.verb.trim(),
    happened_at: draft.happened_at,
    outputs: draft.outputs,
    ...(draft.inputs !== undefined ? { inputs: draft.inputs } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "log",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

// ─── Rule ─────────────────────────────────────────────────────────────────

export interface RuleDraft {
  /** Required: the full Rule prose (first line = label). */
  rule: string;
  /** Required: machine-checkable / prose predicate the Rule asserts. */
  predicate: string;

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
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
  /** Optional: defaults to "asserted". */
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.rule?.trim()) return { error: "rule is required." };
  if (typeof draft.predicate !== "string") {
    return { error: "predicate must be a string (a prose or machine-checkable assertion)." };
  }
  if (!draft.predicate.trim()) return { error: "predicate is required." };
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
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
  const ruleText = draft.rule.trim();
  const label = firstLine(ruleText);
  const now = new Date().toISOString();
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  const status = lifecycleAttrs(draft, await resolveDefaultLifecycle(docoId, "asserted"));
  if ("error" in status) return status;

  // Empty selector — matches everything by having nothing to filter
  // on. Authors can still hand-edit `applies_to` via patch.
  const appliesTo = { any_of: [] as { tag: string }[] };

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "rule",
    rule: ruleText,
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

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "rule",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

// ─── Policies ───────────────────────────────────────────────────────────

export interface GuidancePolicyDraft {
  /** Required: one-line rule statement. */
  policy: string;
  /** Optional markdown body. Defaults to the policy so the article is readable. */
  body_md?: string;
  /** Optional: principal id who authored the article. */
  authored_by_principal_id?: string;
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
  /** Optional: defaults to "asserted". */
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

export interface NodeAuthoringPolicyDraft {
  /** Required: one-line rule statement that describes the check. */
  policy: string;
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
  fires_when_node_lifecycle?: string[];
  on_violation?: "block" | "warn" | "log";
  body_md?: string;
  authored_by_principal_id?: string;
  created_by_user_id?: string;
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

async function resolvePolicyAuthor(draft: {
  authored_by_principal_id?: string;
}): Promise<string | CaptureError> {
  const author = requiredPrincipalId(
    draft.authored_by_principal_id,
    "authored_by_principal_id",
    "or pass an authenticated request; the route fills it from `me.id`",
  );
  return author;
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
  draft: NodeAuthoringPolicyDraft,
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
    if (!spec) return { error: "spec is required for probabilistic node_authoring_policies." };
    return { kind: "probabilistic", spec };
  }

  const parsed = parsePredicate(draft.predicate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      error: "predicate must be a JSON object for deterministic node_authoring_policies.",
    };
  }
  const predicate = parsed as AuthoringPredicate;
  if (predicate.kind === "probabilistic") {
    return {
      error:
        "deterministic node_authoring_policies cannot use a probabilistic predicate; choose probabilistic instead.",
    };
  }
  if (typeof predicate.kind !== "string" || predicate.kind.length === 0) {
    return { error: "predicate.kind is required." };
  }
  const edgeTypeError = validateEdgeTypeReference(predicate);
  if (edgeTypeError) return edgeTypeError;
  return predicate;
}

function validateEdgeTypeReference(predicate: AuthoringPredicate): CaptureError | null {
  const edgeType = predicateEdgeType(predicate);
  if (edgeType === null) return null;
  if (typeof edgeType !== "string" || edgeType.length === 0) {
    return { error: `predicate.edge_type is required for \`${predicate.kind}\`.` };
  }
  if (!EDGE_TYPE_SET.has(edgeType)) {
    return {
      error: `predicate.edge_type \`${edgeType}\` is not a first-class edge type. Valid edge types: ${EDGE_TYPES.join(", ")}.`,
    };
  }
  if (predicate.kind === "requires_edge_role") {
    const edgeRole = predicate.edge_role;
    if (typeof edgeRole !== "string" || edgeRole.trim().length === 0) {
      return { error: "predicate.edge_role is required for `requires_edge_role`." };
    }
  }
  return null;
}

function predicateEdgeType(predicate: AuthoringPredicate): string | null {
  if (
    predicate.kind !== "requires_edge" &&
    predicate.kind !== "requires_edge_role" &&
    predicate.kind !== "forbids_edge" &&
    predicate.kind !== "graph-completeness"
  ) {
    return null;
  }
  const edgeType = predicate.edge_type;
  return typeof edgeType === "string" ? edgeType : "";
}

export interface PolicyCaptureExtras {
  authoring?: AuthoringWriteContext;
}

type PolicyType = "guidance_policy" | "node_authoring_policy";

interface PolicyPayload {
  id: string;
  entityType: PolicyType;
  policy: string;
  lifecycle: string;
  fm: Record<string, unknown>;
  body: string;
  authorId: string;
  createdById: string | null;
  now: string;
}

async function buildGuidancePolicyPayload(
  docoId: string,
  draft: GuidancePolicyDraft,
  _extras: PolicyCaptureExtras,
): Promise<PolicyPayload | CaptureError> {
  if (!draft.policy?.trim()) return { error: "policy is required." };
  const author = await resolvePolicyAuthor(draft);
  if (typeof author !== "string") return author;

  const id = `guidance_policy_${generateUlid()}`;
  const policy = draft.policy.trim();
  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, "asserted");
  if ("error" in status) return status;
  const lifecycle = String(status.lifecycle);
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    policy_kind: "guidance",
    policy,
    authored_by: author,
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return {
    id,
    entityType: "guidance_policy",
    policy,
    lifecycle,
    fm,
    body: draft.body_md?.trim() || policy,
    authorId: author,
    createdById,
    now,
  };
}

async function buildNodeAuthoringPolicyPayload(
  docoId: string,
  draft: NodeAuthoringPolicyDraft,
  _extras: PolicyCaptureExtras,
): Promise<PolicyPayload | CaptureError> {
  if (!draft.policy?.trim()) return { error: "policy is required." };
  if (draft.evaluation_kind !== "deterministic" && draft.evaluation_kind !== "probabilistic") {
    return { error: "evaluation_kind must be deterministic or probabilistic." };
  }
  const author = await resolvePolicyAuthor(draft);
  if (typeof author !== "string") return author;
  const predicate = normalizeNodeAuthoringPredicate(draft);
  if ("error" in predicate) return predicate;

  const id = `node_authoring_policy_${generateUlid()}`;
  const policy = draft.policy.trim();
  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, "asserted");
  if ("error" in status) return status;
  const lifecycle = String(status.lifecycle);
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;
  const firesWhen = Array.isArray(draft.fires_when_node_lifecycle)
    ? draft.fires_when_node_lifecycle.filter((v) => typeof v === "string" && v.length > 0)
    : [];
  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    policy_kind: "node_authoring",
    evaluation_kind: draft.evaluation_kind,
    policy,
    predicate,
    authored_by: author,
    ...(firesWhen.length > 0 ? { fires_when_node_lifecycle: firesWhen } : {}),
    on_violation: draft.on_violation ?? "block",
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return {
    id,
    entityType: "node_authoring_policy",
    policy,
    lifecycle,
    fm,
    body: draft.body_md?.trim() ?? "",
    authorId: author,
    createdById,
    now,
  };
}

export async function captureGuidancePolicy(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: GuidancePolicyDraft,
  docoHost?: string,
  extras: PolicyCaptureExtras = {},
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  const payload = await buildGuidancePolicyPayload(docoId, draft, extras);
  if ("error" in payload) return payload;

  const pred = await enforceAndPersist({
    docoId,
    fm: payload.fm,
    entityType: payload.entityType,
    id: payload.id,
    body: payload.body,
    authoring: extras.authoring,
  });
  if (pred.blocking) {
    return {
      error: `Authoring policy violation: ${pred.blocking.reason}`,
      policy_id: pred.blocking.policy_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: payload.createdById,
    entity_type: payload.entityType,
    entity_id: payload.id,
    label: payload.policy,
  });
  await reindexAndScheduleAttach(docoDir, docoId, payload.id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: payload.entityType,
    id: payload.id,
    label: payload.policy,
    docoHost,
    ops: [{ kind: "added", summary: payload.policy }],
    duration_ms,
    authoringPoliciesPassed: authoringPoliciesPassed(pred),
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

export async function captureNodeAuthoringPolicy(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: NodeAuthoringPolicyDraft,
  docoHost?: string,
  extras: PolicyCaptureExtras = {},
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  const payload = await buildNodeAuthoringPolicyPayload(docoId, draft, extras);
  if ("error" in payload) return payload;

  const pred = await enforceAndPersist({
    docoId,
    fm: payload.fm,
    entityType: payload.entityType,
    id: payload.id,
    body: payload.body,
    authoring: extras.authoring,
  });
  if (pred.blocking) {
    return {
      error: `Authoring policy violation: ${pred.blocking.reason}`,
      policy_id: pred.blocking.policy_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }
  emitAuditForCreate({
    docoDir,
    docoId,
    actorId: payload.createdById,
    entity_type: payload.entityType,
    entity_id: payload.id,
    label: payload.policy,
  });
  await reindexAndScheduleAttach(docoDir, docoId, payload.id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: payload.entityType,
    id: payload.id,
    label: payload.policy,
    docoHost,
    ops: [{ kind: "added", summary: payload.policy }],
    duration_ms,
    authoringPoliciesPassed: authoringPoliciesPassed(pred),
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
 * Lifecycle transition for a Doco policy. Writes the new
 * lifecycle to the underlying table and emits a `lifecycle.transition`
 * audit event under the Doco scope.
 */
export async function transitionPolicyLifecycle(opts: {
  scope: "doco";
  scopeId: string;
  entityType: "guidance_policy" | "node_authoring_policy";
  policyId: string;
  newLifecycle: "asserted" | "retired";
  supersededBy?: string;
  actorId: string | null;
  reason?: string;
}): Promise<{ ok: true } | CaptureError> {
  const table =
    opts.entityType === "guidance_policy" ? "guidance_policies" : "node_authoring_policies";
  const scopeCol = "doco_id";

  const before = await withClient(async (c) => {
    const r = await c.query<{ lifecycle: string | null; data: Record<string, unknown> }>(
      `SELECT lifecycle, data FROM ${table} WHERE id = $1 AND ${scopeCol} = $2`,
      [opts.policyId, opts.scopeId],
    );
    return r.rows[0] ?? null;
  });
  if (!before) {
    return { error: `Policy ${opts.policyId} not found in scope.`, status: 404 };
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
        opts.policyId,
        opts.scopeId,
      ],
    );
  });

  const evt: Parameters<typeof appendAuditEvent>[0] = {
    docoDir: "",
    docoId: opts.scopeId,
    by: opts.actorId,
    entity_type: opts.entityType,
    entity_id: opts.policyId,
    op: "lifecycle.transition",
    before: { lifecycle: before.lifecycle ?? "asserted" },
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

/** Fetch a Doco policy's persisted fields (for the edit page). */
export async function loadPolicyForEdit(opts: {
  scope: "doco";
  scopeId: string;
  entityType: "guidance_policy" | "node_authoring_policy";
  policyId: string;
}): Promise<
  | {
      ok: true;
      policy: string;
      body_md: string;
      lifecycle: string;
      data: Record<string, unknown>;
    }
  | CaptureError
> {
  const table =
    opts.entityType === "guidance_policy" ? "guidance_policies" : "node_authoring_policies";
  const scopeCol = "doco_id";
  const row = await withClient(async (c) => {
    const r = await c.query<{
      policy: string | null;
      body_md: string | null;
      lifecycle: string | null;
      data: Record<string, unknown> | null;
    }>(
      `SELECT policy, body_md, lifecycle, data FROM ${table}
        WHERE id = $1 AND ${scopeCol} = $2`,
      [opts.policyId, opts.scopeId],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return { error: `Policy ${opts.policyId} not found.`, status: 404 };
  return {
    ok: true,
    policy: row.policy ?? "",
    body_md: row.body_md ?? "",
    lifecycle: row.lifecycle ?? "asserted",
    data: row.data ?? {},
  };
}

const REF_TYPES = new Set(["file", "url", "ticket", "commit", "document", "other"]);

export interface ReferenceDraft {
  /** Required: the full Reference prose (first line = label). */
  reference: string;
  ref_type: string;
  locator: string;
  content_hash?: string | null;
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.reference?.trim()) return { error: "reference is required." };
  if (!draft.ref_type || !REF_TYPES.has(draft.ref_type)) {
    return { error: `ref_type must be one of: ${[...REF_TYPES].join(", ")}.` };
  }
  if (!draft.locator?.trim()) return { error: "locator is required." };
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;

  const id = `reference_${generateUlid()}`;
  const locator = draft.locator.trim();
  const referenceText = draft.reference.trim();
  const label = firstLine(referenceText);
  const now = new Date().toISOString();
  const status = lifecycleAttrs(draft, await resolveDefaultLifecycle(docoId, "asserted"));
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "reference",
    reference: referenceText,
    ref_type: draft.ref_type,
    locator,
    ...(draft.content_hash ? { content_hash: draft.content_hash } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "reference",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}

// ─── State (v7 — state-machine node) ──────────────────────────────────────
// Per decision_01KRRR5BQ16ASY8HQEE0V499YG. A State is a node in a formal
// state machine: a position the modeled entity occupies for some span of
// time. Holds invariants while occupied.

export interface StateDraft {
  /** Required: the full State prose (first line = label / display name). */
  state: string;
  /** Required: initial / intermediate / terminal. */
  kind: "initial" | "intermediate" | "terminal";

  /** Optional: predicates true while in this State. Free-form prose. */
  invariants?: string[];
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
  /** Optional: explicit lifecycle override. Defaults to "asserted". */
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
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  if (!draft.state?.trim()) return { error: "state is required." };
  if (!draft.kind) return { error: "kind is required (initial | intermediate | terminal)." };
  if (draft.kind !== "initial" && draft.kind !== "intermediate" && draft.kind !== "terminal") {
    return {
      error: `kind must be one of initial / intermediate / terminal — got "${draft.kind}".`,
    };
  }
  const nodeJsonEdgeKeyError = rejectNodeJsonEdgeKeys(draft);
  if (nodeJsonEdgeKeyError) return nodeJsonEdgeKeyError;
  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;

  const id = `state_${generateUlid()}`;
  const stateText = draft.state.trim();
  const label = firstLine(stateText);
  const now = new Date().toISOString();

  const status = lifecycleAttrs(draft, await resolveDefaultLifecycle(docoId, "asserted"));
  if ("error" in status) return status;

  const invariants: string[] = Array.isArray(draft.invariants)
    ? draft.invariants.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: "state",
    state: stateText,
    kind: draft.kind,
    ...(invariants.length > 0 ? { invariants } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return finishNodeCapture({
    docoDir,
    docoId,
    ownerSlug,
    docoSlug,
    docoHost,
    entityType: "state",
    id,
    label,
    fm,
    createdById,
    startedAt,
    authoring,
  });
}
