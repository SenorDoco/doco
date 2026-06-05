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
  BLOCKED_NODE_JSON_EDGE_FIELD_SET,
  CAPTURE_SCHEMAS,
  type DeterministicPredicate,
  EDGE_TYPES,
  NODE_TYPES,
  type NodeType,
  type PolicyPredicate,
  generateUlid,
  summarizePredicate,
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
const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES);

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
    await reindex(docoId, [changedEntityId], { skipEmbeddings: true });
  } catch (err) {
    console.error(`reindex failed for ${docoDir}:`, err);
  } finally {
    recordPhase("reindex_structural_ms", performance.now() - start);
  }
  waitUntil(
    (async () => {
      try {
        await reindexEmbeddingsOnly(docoId, [changedEntityId]);
      } catch (err) {
        console.error(`reindex embeddings failed for ${docoDir}:`, err);
      }
    })(),
  );
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
const VALID_LIFECYCLES = new Set(["drafting", "queued", "active", "retired"]);
// Policies occupy only two stages — never the node-only `drafting`/`queued`.
const POLICY_LIFECYCLES = new Set(["active", "retired"]);
const VALID_OUTCOMES = new Set(["succeeded", "failed"]);

/**
 * Envelope keys on a `GenericNodeDraft` that the generic capture path
 * consumes itself — they must never be folded into the `attributes` bag.
 * (The legacy type-named prose key is excluded separately, by entityType.)
 */
const RESERVED_DRAFT_KEYS: ReadonlySet<string> = new Set([
  "prose",
  "attributes",
  "kind",
  "lifecycle",
  "deprecated",
  "outcome",
  "created_by_user_id",
]);

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
 * Lifecycle resolution for policies. Unlike nodes, a policy only ever
 * occupies two stages — `active` (in force) or `retired` (superseded /
 * withdrawn) — and defaults to `active`. The node-only `drafting`/`queued`
 * stages are rejected so a policy can never silently land outside the
 * `{active, retired}` pair the DB CHECK also enforces.
 */
function policyLifecycleAttrs(draft: LifecycleAttrs): ResolvedLifecycleAttrs | CaptureError {
  const attrs = lifecycleAttrs(draft, "active");
  if ("error" in attrs) return attrs;
  if (!POLICY_LIFECYCLES.has(attrs.lifecycle)) {
    return {
      error: `Policies only support lifecycle "active" or "retired"; got "${attrs.lifecycle}".`,
    };
  }
  return attrs;
}

/**
 * Resolve the lifecycle fallback for a capture: the Doco's
 * template-seeded `default_node_lifecycle` when set, otherwise the
 * node type's built-in default. Wires up the `defaultNodeLifecycle`
 * the templates already declare — it was stored on the Doco but never
 * consulted at capture time, so e.g. `org-chart`'s `drafting` default
 * (and the active-only completeness gates it implies) didn't take
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
  // Policies are not nodes: their page lives at the plural `/policies/<id>`,
  // not the generic `/<type>/<id>` node route (which 404s for `policy`). Every
  // other entity type maps straight to its singular segment.
  const entitySegment = opts.entityType === "policy" ? "policies" : opts.entityType;
  const linkUrl = opts.docoHost ? `${opts.docoHost}/${handle}/${entitySegment}/${opts.id}` : null;
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

/**
 * The raw row shape every generic node capture speaks (node-shape
 * slim-down). The API exposes the storage schema directly instead of a
 * per-type translation:
 *
 *   - `prose`       → the node's prose (→ the `prose` column).
 *   - `kind`        → the promoted `kind` column (eval/state classifiers).
 *   - `attributes`  → the free-form per-type bag (→ the `attributes` jsonb).
 *   - lifecycle / deprecated / outcome → the lifecycle envelope.
 *
 * For backward compatibility a legacy type-named prose field
 * (`decision`/`intent`/…) is still accepted as an alias for `prose`, and
 * attribute keys may be sent flat at the top level (the pre-slim-down
 * shape). Required-field and enum validation is NOT enforced here — it
 * lives in the Doco's authoring policies.
 */
export interface GenericNodeDraft {
  /** Node prose; first line is the label. */
  prose?: string;
  /** Promoted classifier (eval/state). */
  kind?: string;
  /** Free-form per-type metadata bag. */
  attributes?: Record<string, unknown>;
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
  /** Legacy type-named prose field + flat attribute keys. */
  [k: string]: unknown;
}

/**
 * Per-type default lifecycle, read from the documentation-only
 * CAPTURE_SCHEMAS so the generic path needs no per-type code to know that
 * Actions/Logs default to `retired` and Ideas to `drafting`. A type the
 * schema doesn't list (none today) falls back to `active`.
 */
function defaultLifecycleForType(entityType: string): string {
  return CAPTURE_SCHEMAS[entityType as keyof typeof CAPTURE_SCHEMAS]?.defaultLifecycle ?? "active";
}

/**
 * Node types that default to a terminal lifecycle also default to a
 * `succeeded` outcome — a capture usually records work already done.
 * (Driven by the schema's default lifecycle, not a per-type branch.)
 */
function defaultOutcomeForType(entityType: string): "succeeded" | undefined {
  return STRUCK_LIFECYCLES.has(defaultLifecycleForType(entityType)) ? "succeeded" : undefined;
}

/**
 * Single generic node-capture path (node-shape slim-down, contract step).
 * Replaces the 9 per-type capture functions + the `normalizeRawCaptureDraft`
 * translation shim: it writes prose→prose, kind→kind, attributes→attributes
 * with NO per-type branching for the write. Domain validation (required
 * fields, enums) is delegated to authoring policies.
 */
export async function captureGenericNode(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  entityType: string,
  draft: GenericNodeDraft,
  docoHost?: string,
  authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();

  // Resolve prose: the raw `prose` key wins; the legacy type-named field
  // (`decision`/`intent`/…) is accepted as an alias for back-compat.
  const proseRaw =
    typeof draft.prose === "string"
      ? draft.prose
      : typeof draft[entityType] === "string"
        ? (draft[entityType] as string)
        : undefined;
  if (!proseRaw?.trim()) return { error: "prose is required." };
  const prose = proseRaw.trim();

  // Gather the attributes bag: explicit `attributes` keys plus any flat
  // top-level keys that aren't envelope/identity fields. An explicit
  // top-level key wins over the same key nested in `attributes`.
  const attributes: Record<string, unknown> = {};
  const nested = draft.attributes;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    Object.assign(attributes, nested);
  }
  for (const [k, v] of Object.entries(draft)) {
    if (RESERVED_DRAFT_KEYS.has(k) || k === entityType) continue;
    attributes[k] = v;
  }

  // Reject first-class-edge keys wherever they appear (top-level or bag).
  const edgeKeyError =
    rejectNodeJsonEdgeKeys(draft as Record<string, unknown>) ?? rejectNodeJsonEdgeKeys(attributes);
  if (edgeKeyError) return edgeKeyError;

  const id = `${entityType}_${generateUlid()}`;
  const label = firstLine(prose);
  const now = new Date().toISOString();

  const createdById = userCreatorId(draft);
  if (typeof createdById !== "string" && createdById !== null) return createdById;

  const status = lifecycleAttrs(
    draft,
    await resolveDefaultLifecycle(docoId, defaultLifecycleForType(entityType)),
    defaultOutcomeForType(entityType),
  );
  if ("error" in status) return status;

  const fm: Record<string, unknown> = {
    id,
    doco_id: docoId,
    node_type: entityType,
    // Prose lands under the type-named key so storage's `computeTypeNamedValue`
    // promotes it to the `prose` column.
    [entityType]: prose,
    // Flatten attributes onto the data bag; storage re-bags them into the
    // `attributes` jsonb (excluding the envelope/promoted columns).
    ...attributes,
    // A top-level `kind` is the promoted classifier (eval/state); it wins
    // over any `kind` that slipped into the attributes bag.
    ...(typeof draft.kind === "string" ? { kind: draft.kind } : {}),
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
    entityType,
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
  | "policy"
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
  }
  // Policies carry no type-named prose column: their `kind`, `predicate`,
  // `on_violation`, and `fires_when_node_lifecycle` flow through the generic
  // data-jsonb loop below; `body_md` is handled via the `isMd` body path.
  if (normalizedPatch.lifecycle !== undefined) {
    const lifecycle = normalizeLifecycle(normalizedPatch.lifecycle, "active");
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
    "created_by_user_id",
    // Slug is not a node data field.
    "slug",
    // `attributes` is flattened onto the data bag below, never stored as a
    // nested object (storage re-bags the flat keys into the attributes jsonb).
    "attributes",
    ...(typeNamedColumn ? [typeNamedColumn] : []),
  ]);
  // Apply a flat key onto the data bag with set/clear semantics, tracking the
  // change + op. Shared by the generic top-level loop and the `attributes`
  // flatten below.
  const applyDataField = (k: string, v: unknown) => {
    if (isSystemManagedField(k)) return;
    if (v === undefined) return;
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
  };
  for (const k of Object.keys(normalizedPatch)) {
    if (SPECIAL_CASED_KEYS.has(k)) continue;
    applyDataField(k, normalizedPatch[k]);
  }
  // A patch may carry a nested `attributes` bag (e.g. the GitHub PR sync sets
  // `attributes.body_md` for the title/body split). The storage round-trip
  // keeps per-node domain fields as FLAT keys in `data` (rowToRecord flattens
  // the attributes jsonb on read; buildAttributes re-collects flat keys on
  // write), so merge each attribute onto the data bag as a flat key rather than
  // storing the nested object. A `null` value clears that attribute.
  const patchAttributes = normalizedPatch.attributes;
  if (patchAttributes && typeof patchAttributes === "object" && !Array.isArray(patchAttributes)) {
    for (const [k, v] of Object.entries(patchAttributes as Record<string, unknown>)) {
      applyDataField(k, v);
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

// ─── Policies ───────────────────────────────────────────────────────────

export interface PolicyDraft {
  /** Required: the standalone classifier. */
  kind: "suggestion" | "deterministic" | "probabilistic";
  /**
   * suggestion / probabilistic → the single natural-language instruction for
   * the agent / LLM judge. Required for those kinds.
   */
  agent_instruction?: string;
  /**
   * deterministic → the structured check, keyed by `sub_kind` (an object or a
   * JSON string). Required for deterministic.
   */
  predicate?: DeterministicPredicate | string;
  /** Optional node-type scope for a probabilistic check. */
  when_node_type?: string[];
  /**
   * Edge scoping for an EDGE-scoped probabilistic policy. When `edge_type` is
   * set on a `probabilistic` draft, the policy fires on EDGE creation (the LLM
   * judge sees BOTH endpoint nodes) instead of on a single node candidate —
   * e.g. "a sub-process child Intent's name is the base form of the calling
   * Action that `supports` it". `when_node_type` is ignored for an edge-scoped policy.
   */
  edge_type?: string;
  from_node_type?: string;
  to_node_type?: string;
  fires_when_node_lifecycle?: string[];
  on_violation?: "block" | "warn" | "log";
  /** Optional: principal id who authored the policy. */
  authored_by_principal_id?: string;
  /** Internal route-filled user id that created this entry. */
  created_by_user_id?: string;
  /** Optional: defaults to "active". */
  lifecycle?: string;
  deprecated?: boolean;
  outcome?: "succeeded" | "failed";
}

/**
 * Resolve the optional Principal author of a policy. Authorship is a
 * graph link (the `authored_by` edge) to a Principal node, so it is
 * optional: when the route can't map the signed-in user to a Principal
 * — e.g. a BPMN-imported Doco whose principals are renamed roles
 * ("Talent seeker", "Torre"), not a "user"/"human" persona — the policy
 * is still captured, just without an author. `null` means "no author".
 * When a value IS supplied it must be a Principal id, never a user id.
 */
async function resolvePolicyAuthor(draft: {
  authored_by_principal_id?: string;
}): Promise<string | null | CaptureError> {
  const value = draft.authored_by_principal_id?.trim();
  if (!value) return null;
  return assertNotUserId(value, "authored_by_principal_id") ?? value;
}

function parsePredicate(value: DeterministicPredicate | string | undefined): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function normalizeDeterministicPredicate(
  draft: PolicyDraft,
): DeterministicPredicate | CaptureError {
  const parsed = parsePredicate(draft.predicate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "predicate must be a JSON object for deterministic policies." };
  }
  const predicate = parsed as DeterministicPredicate;
  if (typeof predicate.sub_kind !== "string" || predicate.sub_kind.length === 0) {
    return { error: "predicate.sub_kind is required for deterministic policies." };
  }
  const edgeTypeError = validateEdgeTypeReference(predicate);
  if (edgeTypeError) return edgeTypeError;
  return predicate;
}

function validateEdgeTypeReference(predicate: DeterministicPredicate): CaptureError | null {
  const edgeType = predicateEdgeType(predicate);
  if (edgeType === null) return null;
  if (typeof edgeType !== "string" || edgeType.length === 0) {
    return { error: `predicate.edge_type is required for \`${predicate.sub_kind}\`.` };
  }
  if (!EDGE_TYPE_SET.has(edgeType)) {
    return {
      error: `predicate.edge_type \`${edgeType}\` is not a first-class edge type. Valid edge types: ${EDGE_TYPES.join(", ")}.`,
    };
  }
  return null;
}

function predicateEdgeType(predicate: DeterministicPredicate): string | null {
  if (
    predicate.sub_kind !== "requires_edge" &&
    predicate.sub_kind !== "limits_edge" &&
    predicate.sub_kind !== "forbids_edge" &&
    predicate.sub_kind !== "graph-completeness"
  ) {
    return null;
  }
  const edgeType = predicate.edge_type;
  return typeof edgeType === "string" ? edgeType : "";
}

/**
 * Build the seeded predicate for an EDGE-scoped probabilistic policy. Validates
 * the edge_type against the first-class edge families and any endpoint node
 * types against the node-type allowlist. The result fires on edge creation and
 * hands the judge both endpoints (see `runEdgeAuthoringPolicies`).
 */
function buildEdgeProbabilisticPredicate(
  instruction: string,
  draft: PolicyDraft,
): PolicyPredicate | CaptureError {
  const edgeType = draft.edge_type?.trim() ?? "";
  if (!EDGE_TYPE_SET.has(edgeType)) {
    return {
      error: `predicate.edge_type \`${edgeType}\` is not a first-class edge type. Valid edge types: ${EDGE_TYPES.join(", ")}.`,
    };
  }
  const fromNodeType = draft.from_node_type?.trim();
  const toNodeType = draft.to_node_type?.trim();
  for (const [field, value] of [
    ["from_node_type", fromNodeType],
    ["to_node_type", toNodeType],
  ] as const) {
    if (value && !NODE_TYPE_SET.has(value)) {
      return {
        error: `predicate.${field} \`${value}\` is not a node type. Valid node types: ${NODE_TYPES.join(", ")}.`,
      };
    }
  }
  return {
    agent_instruction: instruction,
    edge_type: edgeType,
    ...(fromNodeType ? { from_node_type: fromNodeType as NodeType } : {}),
    ...(toNodeType ? { to_node_type: toNodeType as NodeType } : {}),
  };
}

export interface PolicyCaptureExtras {
  authoring?: AuthoringWriteContext;
}

interface PolicyPayload {
  id: string;
  entityType: "policy";
  /** Human label derived from the predicate — used in audit + footer surfaces. */
  label: string;
  lifecycle: string;
  fm: Record<string, unknown>;
  body: string;
  authorId: string | null;
  createdById: string | null;
  now: string;
}

async function buildPolicyPayload(
  docoId: string,
  draft: PolicyDraft,
  _extras: PolicyCaptureExtras,
): Promise<PolicyPayload | CaptureError> {
  if (
    draft.kind !== "suggestion" &&
    draft.kind !== "deterministic" &&
    draft.kind !== "probabilistic"
  ) {
    return { error: "kind must be suggestion, deterministic, or probabilistic." };
  }
  const author = await resolvePolicyAuthor(draft);
  if (author !== null && typeof author !== "string") return author;

  // Build the predicate per kind: deterministic carries a structured check,
  // suggestion / probabilistic carry a single agent instruction.
  let predicate: PolicyPredicate;
  if (draft.kind === "deterministic") {
    const det = normalizeDeterministicPredicate(draft);
    if ("error" in det) return det;
    predicate = det;
  } else {
    const instruction = draft.agent_instruction?.trim();
    if (!instruction) {
      return { error: `agent_instruction is required for ${draft.kind} policies.` };
    }
    // Edge-scoped probabilistic: an `edge_type` on a probabilistic draft makes
    // the policy fire on edge creation (the judge sees both endpoints) instead
    // of on a node. `when_node_type` does not apply to an edge-scoped policy.
    const edgeType = draft.kind === "probabilistic" ? draft.edge_type?.trim() : undefined;
    if (edgeType) {
      const edgePredicate = buildEdgeProbabilisticPredicate(instruction, draft);
      if ("error" in edgePredicate) return edgePredicate;
      predicate = edgePredicate;
    } else {
      const whenNodeType =
        draft.kind === "probabilistic" && Array.isArray(draft.when_node_type)
          ? (draft.when_node_type.filter(
              (v) => typeof v === "string" && v.length > 0,
            ) as NodeType[])
          : [];
      predicate = {
        agent_instruction: instruction,
        ...(whenNodeType.length > 0 ? { when_node_type: whenNodeType } : {}),
      };
    }
  }

  const id = `policy_${generateUlid()}`;
  const now = new Date().toISOString();
  const status = policyLifecycleAttrs(draft);
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
    kind: draft.kind,
    predicate,
    ...(author ? { authored_by: author } : {}),
    ...(firesWhen.length > 0 ? { fires_when_node_lifecycle: firesWhen } : {}),
    // Suggestions are advisory — `on_violation` is meaningless for them.
    ...(draft.kind !== "suggestion" ? { on_violation: draft.on_violation ?? "block" } : {}),
    created_at: now,
    ...(createdById ? { created_by: createdById } : {}),
    ...status,
  };

  return {
    id,
    entityType: "policy",
    label: summarizePredicate(predicate),
    lifecycle,
    fm,
    body: "",
    authorId: author,
    createdById,
    now,
  };
}

export async function capturePolicy(
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: PolicyDraft,
  docoHost?: string,
  extras: PolicyCaptureExtras = {},
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();
  const payload = await buildPolicyPayload(docoId, draft, extras);
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
    label: payload.label,
  });
  await reindexAndScheduleAttach(docoDir, docoId, payload.id);

  const duration_ms = Math.round(performance.now() - startedAt);
  const footer_lines = await renderOperationLines({
    docoId,
    ownerSlug,
    docoSlug,
    entityType: payload.entityType,
    id: payload.id,
    label: payload.label,
    docoHost,
    ops: [{ kind: "added", summary: payload.label }],
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
  policyId: string;
  newLifecycle: "active" | "retired";
  supersededBy?: string;
  actorId: string | null;
  reason?: string;
}): Promise<{ ok: true } | CaptureError> {
  const table = "policies";
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
  // An active policy is by definition not superseded — clear any stale pointer
  // (from a prior supersession or re-seed churn) when re-activating. A
  // `undefined` value is dropped by JSON.stringify, so the key leaves the blob.
  if (opts.newLifecycle === "active") fm.superseded_by = undefined;
  else if (opts.supersededBy) fm.superseded_by = opts.supersededBy;
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
    entity_type: "policy",
    entity_id: opts.policyId,
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

/** Fetch a Doco policy's persisted fields (for the edit page). */
export async function loadPolicyForEdit(opts: {
  scope: "doco";
  scopeId: string;
  policyId: string;
}): Promise<
  | {
      ok: true;
      lifecycle: string;
      data: Record<string, unknown>;
    }
  | CaptureError
> {
  const scopeCol = "doco_id";
  const row = await withClient(async (c) => {
    const r = await c.query<{
      lifecycle: string | null;
      data: Record<string, unknown> | null;
    }>(
      `SELECT lifecycle, data FROM policies
        WHERE id = $1 AND ${scopeCol} = $2`,
      [opts.policyId, opts.scopeId],
    );
    return r.rows[0] ?? null;
  });
  if (!row) return { error: `Policy ${opts.policyId} not found.`, status: 404 };
  return {
    ok: true,
    lifecycle: row.lifecycle ?? "active",
    data: row.data ?? {},
  };
}
