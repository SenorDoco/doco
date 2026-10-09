// Generic graph-authoring changesets.
//
// This endpoint is deliberately not BPMN-specific. It lets agents create
// nodes and add typed relations in one request; perspective-specific
// contracts then interpret those relations for rendering.

import { getEntity, withClient } from "@doco/db";
import { NODE_CATALOG } from "@doco/shared";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import {
  type AuthoringWriteContext,
  type CaptureError,
  type EntityPatch,
  NO_FIELDS_CHANGED,
  updateEntity,
} from "~/lib/capture.server";
import { loadDocoRouteForRead, requireDocoTypeWritesForRequest } from "~/lib/doco-access.server";
import { captureEdge, edgeExists, retireActiveEdgesRequest } from "~/lib/edge-capture.server";
import {
  PERSPECTIVE_CONTRACTS,
  type RelationKindSpec,
  relationKind,
  unsupportedNodeJsonEdgeKeyError,
} from "~/lib/graph-authoring-contract.server";
import { CAPTURE_REGISTRY_BY_NODE_TYPE, type MeLike } from "~/lib/node-capture-registry.server";

type Operation =
  | CreateOperation
  | RelateOperation
  | RelateManyOperation
  | AppendOperation
  | ActivateOperation
  | QueueOperation
  | RetireOperation
  | SupersedeOperation;

interface CreateOperation {
  op: "create";
  node_type: string;
  alias?: string;
  body: Record<string, unknown>;
}

interface RelationInput {
  relation_kind?: string;
  kind?: string;
  from: string;
  to: string;
  label?: string;
  condition?: string;
  relation_props?: Record<string, unknown>;
  // Stage the new edge starts in (drafting | queued | active). Omit to let the
  // edge default to `active` when both endpoints are active, else `drafting`
  // (the "active edge ⟹ active endpoints" rule). An explicit `active` against a
  // non-active endpoint is rejected.
  lifecycle?: string;
}

interface RelateOperation extends RelationInput {
  op: "relate";
}

interface RelateManyOperation {
  op: "relate_many";
  relations: RelationInput[];
}

interface AppendOperation {
  op: "append";
  node_type: string;
  alias?: string;
  body: Record<string, unknown>;
  after: string;
  relation_kind: string;
  label?: string;
  condition?: string;
  relation_props?: Record<string, unknown>;
}

// Lifecycle transitions — append-only-safe (history is kept in the immutable
// audit log; "retire" is a tombstone, never a hard delete). `target` is a node
// id or a `$alias` defined earlier in the same changeset.
// Move a node to `active` (in force). Renamed from the former `assert` op.
interface ActivateOperation {
  op: "activate";
  target: string;
}

// Move a node to `queued` (ready, awaiting activation).
interface QueueOperation {
  op: "queue";
  target: string;
  // Opt-in cascade: also retire the node's active edges so the demoted node
  // carries no active edges (the "active edge ⟹ active endpoints" rule).
  // Defaults to false — edges are left untouched.
  retire_active_edges?: boolean;
}

interface RetireOperation {
  op: "retire";
  target: string;
  // Opt-in cascade — see QueueOperation. Defaults to false.
  retire_active_edges?: boolean;
}

// Replace a node: create the replacement, retire the old one, and link them
// with a first-class `replaces` edge.
interface SupersedeOperation {
  op: "supersede";
  target: string;
  node_type: string;
  alias?: string;
  body: Record<string, unknown>;
}

interface ChangesetBody {
  operations?: unknown;
  validate_against?: unknown;
}

interface ChangesetContext {
  dir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  docoHost: string;
  handle: string;
  actorId: string | null;
  authoring: AuthoringWriteContext;
  me: MeLike;
  request: Request;
}

interface OperationResult {
  op_index: number;
  op: Operation["op"];
  ok: boolean;
  id?: string;
  alias?: string;
  relation?: {
    kind: string;
    from: string;
    to: string;
    edge_id?: string;
  };
  relations?: {
    kind: string;
    from: string;
    to: string;
    edge_id?: string;
  }[];
  skipped?: boolean;
  error?: string;
  footer_lines?: string[];
}

const ENTITY_ID_RE = /^([a-z][a-z0-9_]*?)_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function loader() {
  return Response.json(
    {
      error:
        "Use POST with { operations: [...] }. See /<doco-handle>/api/authoring-contract.json for relation kinds and examples.",
    },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }

  const { dir, docoSlug, me, meta, ownerSlug } = await loadDocoRouteForRead(
    request,
    params,
    "reader",
  );
  if (!me) {
    return Response.json({ error: "Authentication required to write." }, { status: 401 });
  }
  let body: ChangesetBody;
  try {
    body = (await request.json()) as ChangesetBody;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }
  if (!Array.isArray(body.operations) || body.operations.length === 0) {
    return Response.json({ error: "operations must be a non-empty array." }, { status: 400 });
  }
  if (body.operations.length > 50) {
    return Response.json({ error: "changesets accept at most 50 operations." }, { status: 400 });
  }

  const writeTypes = collectChangesetWriteTypes(body.operations);
  if ("error" in writeTypes) {
    return Response.json({ error: writeTypes.error }, { status: 400 });
  }
  const denied = await requireDocoTypeWritesForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
    writeTypes.types,
    "apply this changeset",
  );
  if (denied) return denied;

  const aliases = new Map<string, string>();
  const results: OperationResult[] = [];
  const footerLines: string[] = [];
  const createdIds: string[] = [];
  const ctx: ChangesetContext = {
    dir,
    docoId: meta.docoId,
    ownerSlug,
    docoSlug,
    docoHost: new URL(request.url).origin,
    handle: params.docoHandle,
    actorId: me.id,
    authoring: await authoringContextForRequest(request),
    me: { id: me.id, username: me.username },
    request,
  };

  for (let i = 0; i < body.operations.length; i++) {
    const op = body.operations[i] as Operation;
    const result = await applyOperation(op, i, ctx, aliases);
    results.push(result);
    if (result.footer_lines) footerLines.push(...result.footer_lines);
    if (
      result.ok &&
      result.id &&
      (result.op === "create" || result.op === "append" || result.op === "supersede")
    ) {
      createdIds.push(result.id);
    }
    if (!result.ok) {
      return Response.json(
        {
          ok: false,
          partial: footerLines.length > 0 || results.some((r) => r.ok && !r.skipped),
          error: result.error,
          results,
          footer_lines: footerLines,
        },
        { status: 400 },
      );
    }
  }

  const validateAgainst =
    typeof body.validate_against === "string" ? body.validate_against.trim() : "";
  const integrity = validateAgainst
    ? await summarizeIntegrity(meta.docoId, validateAgainst, createdIds)
    : null;

  return Response.json({
    ok: true,
    results,
    aliases: Object.fromEntries(aliases.entries()),
    footer_lines: footerLines,
    ...(integrity ? { integrity } : {}),
  });
}

function collectChangesetWriteTypes(
  operations: unknown[],
): { types: string[] } | { error: string } {
  const types = new Set<string>();
  // Alias → node_type, so activate/queue/retire/supersede targeting a node created
  // earlier in the same batch can be type-checked before anything runs.
  const aliasTypes = new Map<string, string>();
  for (const raw of operations) {
    const op = raw as CreateOperation | AppendOperation | SupersedeOperation;
    if (!op || typeof op !== "object" || !("op" in op)) continue;
    if ((op.op === "create" || op.op === "append" || op.op === "supersede") && op.alias) {
      const nodeType = normalizeNodeType(op.node_type);
      if (nodeType) aliasTypes.set(cleanAlias(op.alias), nodeType);
    }
  }
  const targetType = (target: unknown): string | null => {
    const t = String(target ?? "").trim();
    if (!t) return null;
    return t.startsWith("$") ? (aliasTypes.get(cleanAlias(t)) ?? null) : nodeTypeFromId(t);
  };
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i] as Operation;
    if (!op || typeof op !== "object" || !("op" in op)) continue;
    if (op.op === "create") {
      const nodeType = normalizeNodeType(op.node_type);
      if (!nodeType) return { error: `Unsupported create node_type "${op.node_type}".` };
      types.add(nodeType);
      continue;
    }
    if (op.op === "append") {
      const nodeType = normalizeNodeType(op.node_type);
      if (!nodeType) return { error: `Unsupported append node_type "${op.node_type}".` };
      types.add(nodeType);
      const spec = relationKind(op.relation_kind);
      if (!spec) return { error: `Unknown relation_kind "${op.relation_kind}".` };
      types.add(spec.kind);
      continue;
    }
    if (op.op === "relate") {
      const kind = op.relation_kind ?? op.kind ?? "";
      const spec = relationKind(kind);
      if (!spec) return { error: `Unknown relation_kind "${kind}".` };
      types.add(spec.kind);
      continue;
    }
    if (op.op === "relate_many") {
      if (!Array.isArray(op.relations)) continue;
      for (const relation of op.relations) {
        const kind = relation.relation_kind ?? relation.kind ?? "";
        const spec = relationKind(kind);
        if (!spec) return { error: `Unknown relation_kind "${kind}".` };
        types.add(spec.kind);
      }
      continue;
    }
    if (op.op === "activate" || op.op === "queue" || op.op === "retire") {
      const nodeType = targetType(op.target);
      if (!nodeType) {
        return { error: `Cannot ${op.op}: unrecognized node id/alias "${op.target}".` };
      }
      types.add(nodeType);
      continue;
    }
    if (op.op === "supersede") {
      const newType = normalizeNodeType(op.node_type);
      if (!newType) return { error: `Unsupported supersede node_type "${op.node_type}".` };
      types.add(newType);
      const oldType = targetType(op.target);
      if (!oldType) return { error: `Cannot supersede: unrecognized target "${op.target}".` };
      types.add(oldType);
      const spec = relationKind("replaces");
      if (spec) types.add(spec.kind);
    }
  }
  return { types: [...types] };
}

async function applyOperation(
  op: Operation,
  index: number,
  ctx: ChangesetContext,
  aliases: Map<string, string>,
): Promise<OperationResult> {
  if (!op || typeof op !== "object" || !("op" in op)) {
    return { op_index: index, op: "create", ok: false, error: "Operation must be an object." };
  }
  if (op.op === "create") {
    return createNode(op, index, ctx, aliases);
  }
  if (op.op === "relate") {
    return relateNodes(op, index, ctx, aliases);
  }
  if (op.op === "relate_many") {
    return relateMany(op, index, ctx, aliases);
  }
  if (op.op === "append") {
    const created = await createNode(
      { op: "create", node_type: op.node_type, alias: op.alias, body: op.body },
      index,
      ctx,
      aliases,
    );
    if (!created.ok || !created.id) return created;
    const related = await relateNodes(
      {
        op: "relate",
        relation_kind: op.relation_kind,
        from: op.after,
        to: created.id,
        ...(op.label ? { label: op.label } : {}),
        ...(op.condition ? { condition: op.condition } : {}),
        ...(op.relation_props ? { relation_props: op.relation_props } : {}),
      },
      index,
      ctx,
      aliases,
    );
    return {
      ...created,
      op: "append",
      ok: related.ok,
      error: related.error,
      relation: related.relation,
      footer_lines: [...(created.footer_lines ?? []), ...(related.footer_lines ?? [])],
    };
  }
  if (op.op === "activate") {
    return transitionNode(op.target, "active", "activate", index, ctx, aliases, false);
  }
  if (op.op === "queue") {
    return transitionNode(
      op.target,
      "queued",
      "queue",
      index,
      ctx,
      aliases,
      op.retire_active_edges === true,
    );
  }
  if (op.op === "retire") {
    return transitionNode(
      op.target,
      "retired",
      "retire",
      index,
      ctx,
      aliases,
      op.retire_active_edges === true,
    );
  }
  if (op.op === "supersede") {
    return supersedeNode(op, index, ctx, aliases);
  }
  return {
    op_index: index,
    op: (op as { op?: Operation["op"] }).op ?? "create",
    ok: false,
    error: `Unknown operation "${String((op as { op?: unknown }).op)}".`,
  };
}

// Lifecycle transition (activate → active, queue → queued, retire → retired) via
// updateEntity, the same primitive the per-entity PATCH routes use. `target`
// resolves an id or a `$alias` created earlier in the batch; the entity type
// comes from the id.
async function transitionNode(
  target: string,
  lifecycle: "queued" | "active" | "retired",
  opName: "activate" | "queue" | "retire",
  index: number,
  ctx: ChangesetContext,
  aliases: Map<string, string>,
  retireActiveEdges: boolean,
): Promise<OperationResult> {
  const id = resolveRef(target, aliases);
  if (!id) {
    return {
      op_index: index,
      op: opName,
      ok: false,
      error: `Could not resolve ${opName} target "${target}".`,
    };
  }
  // Opt-in cascade: when demoting a node out of `active`, retire its active
  // edges first so the node carries no active edges. A no-op if it has none.
  const cascadeLines: string[] = [];
  if (retireActiveEdges && lifecycle !== "active") {
    const cascade = await retireActiveEdgesRequest({
      docoId: ctx.docoId,
      actorId: ctx.actorId,
      nodeId: id,
      reason: `retire active edges of ${opName}d node`,
      docoHost: ctx.docoHost,
      handle: ctx.handle,
      ...(ctx.authoring.source ? { source: ctx.authoring.source } : {}),
      ...(ctx.authoring.metadata ? { metadata: ctx.authoring.metadata } : {}),
    });
    cascadeLines.push(...cascade.footer_lines);
  }
  const result = await applyLifecyclePatch(id, { lifecycle }, opName, index, ctx);
  if (!result.ok) return result;
  return { ...result, footer_lines: [...cascadeLines, ...(result.footer_lines ?? [])] };
}

async function applyLifecyclePatch(
  id: string,
  patch: EntityPatch,
  opName: Operation["op"],
  index: number,
  ctx: ChangesetContext,
): Promise<OperationResult> {
  const nodeType = nodeTypeFromId(id);
  const segment = nodeType ? NODE_CATALOG[nodeType as keyof typeof NODE_CATALOG]?.segment : null;
  if (!nodeType || !segment) {
    return {
      op_index: index,
      op: opName,
      ok: false,
      error: `Cannot ${opName} "${id}": unrecognized node id.`,
    };
  }
  const result = await updateEntity({
    docoDir: ctx.dir,
    docoId: ctx.docoId,
    ownerSlug: ctx.ownerSlug,
    docoSlug: ctx.docoSlug,
    nodeType: nodeType as Parameters<typeof updateEntity>[0]["nodeType"],
    pluralDir: segment,
    id,
    patch,
    docoHost: ctx.docoHost,
    actorId: ctx.actorId,
    authoring: ctx.authoring,
  });
  // A node already in the lifecycle asked for (a Log is born retired) is
  // where the op wants it: done, not a failure.
  if ("error" in result && result.error === NO_FIELDS_CHANGED) {
    return { op_index: index, op: opName, ok: true, id, skipped: true, footer_lines: [] };
  }
  if ("error" in result) {
    return { op_index: index, op: opName, ok: false, error: result.error };
  }
  return { op_index: index, op: opName, ok: true, id, footer_lines: result.footer_lines };
}

// Replace a node: create the replacement (same path as a create op, so aliases
// and authoring policies apply), retire the old node, and link them with a
// first-class `replaces` edge. (superseded_by can't live in node JSON — graph
// links are edge rows only — so the relationship is the edge.)
async function supersedeNode(
  op: SupersedeOperation,
  index: number,
  ctx: ChangesetContext,
  aliases: Map<string, string>,
): Promise<OperationResult> {
  const oldId = resolveRef(op.target, aliases);
  if (!oldId) {
    return {
      op_index: index,
      op: "supersede",
      ok: false,
      error: `Could not resolve supersede target "${op.target}".`,
    };
  }
  const created = await createNode(
    { op: "create", node_type: op.node_type, alias: op.alias, body: op.body },
    index,
    ctx,
    aliases,
  );
  if (!created.ok || !created.id) {
    return { ...created, op: "supersede" };
  }
  // Retire before relating: retiring keys off active references, and we don't
  // want the just-added `replaces` edge to look like one. The edge then points
  // at the retired (superseded) node.
  const retired = await applyLifecyclePatch(
    oldId,
    { lifecycle: "retired" },
    "supersede",
    index,
    ctx,
  );
  if (!retired.ok) {
    return { op_index: index, op: "supersede", ok: false, error: retired.error };
  }
  const related = await relateNodes(
    { op: "relate", relation_kind: "replaces", from: created.id, to: oldId },
    index,
    ctx,
    aliases,
  );
  if (!related.ok) {
    return { op_index: index, op: "supersede", ok: false, error: related.error };
  }
  return {
    op_index: index,
    op: "supersede",
    ok: true,
    id: created.id,
    ...(op.alias ? { alias: cleanAlias(op.alias) } : {}),
    ...(related.relation ? { relation: related.relation } : {}),
    footer_lines: [
      ...(created.footer_lines ?? []),
      ...(retired.footer_lines ?? []),
      ...(related.footer_lines ?? []),
    ],
  };
}

async function createNode(
  op: CreateOperation,
  index: number,
  ctx: ChangesetContext,
  aliases: Map<string, string>,
): Promise<OperationResult> {
  const nodeType = normalizeNodeType(op.node_type);
  const entry = nodeType ? CAPTURE_REGISTRY_BY_NODE_TYPE[nodeType] : null;
  if (!entry) {
    return {
      op_index: index,
      op: "create",
      ok: false,
      error: `Unsupported create node_type "${op.node_type}".`,
    };
  }
  if (!op.body || typeof op.body !== "object" || Array.isArray(op.body)) {
    return { op_index: index, op: "create", ok: false, error: "create.body must be an object." };
  }
  // Resolve `$alias` refs in ordinary create body values. Relations are
  // created by `relate` / `relate_many` ops, where aliases are resolved
  // separately.
  const resolvedBody = resolveAliasesInBody(op.body as Record<string, unknown>, aliases);
  if ("error" in resolvedBody) {
    return { op_index: index, op: "create", ok: false, error: resolvedBody.error };
  }
  const body = resolvedBody.body;
  const nodeJsonEdgeKeyError = unsupportedNodeJsonEdgeKeyError(entry.nodeType, body);
  if (nodeJsonEdgeKeyError) {
    return { op_index: index, op: "create", ok: false, error: nodeJsonEdgeKeyError };
  }
  const draft = stampAuthenticatedCreator({ ...body }, ctx.actorId);
  if (entry.fillFromAuth) {
    await entry.fillFromAuth(draft, ctx.me, ctx.docoId);
  }
  const result = await entry.captureFn(
    ctx.dir,
    ctx.docoId,
    ctx.ownerSlug,
    ctx.docoSlug,
    draft,
    ctx.docoHost,
    ctx.authoring,
  );
  if ("error" in result) {
    // Pave the draft-first path: if an activating node blocked on a missing
    // required edge, point the author at the two ways to fix it.
    const hint =
      /missing required/i.test(result.error) && /edge|field/i.test(result.error)
        ? " (tip: create the node with an alias, then add a `relate` or `relate_many` op in the same changeset before activating it.)"
        : "";
    return { op_index: index, op: "create", ok: false, error: `${result.error}${hint}` };
  }
  if (op.alias) aliases.set(cleanAlias(op.alias), result.id);
  return {
    op_index: index,
    op: "create",
    ok: true,
    id: result.id,
    ...(op.alias ? { alias: cleanAlias(op.alias) } : {}),
    footer_lines: result.footer_lines,
  };
}

async function relateMany(
  op: RelateManyOperation,
  index: number,
  ctx: ChangesetContext,
  aliases: Map<string, string>,
): Promise<OperationResult> {
  if (!Array.isArray(op.relations) || op.relations.length === 0) {
    return {
      op_index: index,
      op: "relate_many",
      ok: false,
      error: "relate_many.relations must be a non-empty array.",
    };
  }
  if (op.relations.length > 50) {
    return {
      op_index: index,
      op: "relate_many",
      ok: false,
      error: "relate_many accepts at most 50 relations.",
    };
  }

  const edgeFooterLines: string[] = [];
  const edgeRelations: NonNullable<OperationResult["relations"]> = [];

  for (const relation of op.relations) {
    const kind = relation.relation_kind ?? relation.kind ?? "";
    const spec = relationKind(kind);
    if (!spec) {
      return {
        op_index: index,
        op: "relate_many",
        ok: false,
        error: `Unknown relation_kind "${kind}".`,
      };
    }
    const from = resolveRef(relation.from, aliases);
    const to = resolveRef(relation.to, aliases);
    if (!from || !to) {
      return {
        op_index: index,
        op: "relate_many",
        ok: false,
        error: `Could not resolve relation endpoints from="${relation.from}" to="${relation.to}".`,
      };
    }

    const meta = relationMetadata(spec, relation);
    const captured = await captureRelationEdge(
      ctx,
      spec,
      from,
      to,
      meta,
      parseEdgeLifecycle(relation.lifecycle),
    );
    if ("error" in captured) {
      return {
        op_index: index,
        op: "relate_many",
        ok: false,
        error: captured.error,
      };
    }
    edgeFooterLines.push(...captured.footer_lines);
    edgeRelations.push({
      kind: spec.kind,
      from,
      to,
      ...(captured.id ? { edge_id: captured.id } : {}),
    });
  }

  const footerLines: string[] = [...edgeFooterLines];
  const relations: NonNullable<OperationResult["relations"]> = [...edgeRelations];

  return {
    op_index: index,
    op: "relate_many",
    ok: true,
    relations,
    ...(footerLines.length === 0 ? { skipped: true } : {}),
    footer_lines: footerLines,
  };
}

async function relateNodes(
  op: RelateOperation,
  index: number,
  ctx: ChangesetContext,
  aliases: Map<string, string>,
): Promise<OperationResult> {
  const kind = op.relation_kind ?? op.kind ?? "";
  const spec = relationKind(kind);
  if (!spec) {
    return {
      op_index: index,
      op: "relate",
      ok: false,
      error: `Unknown relation_kind "${kind}".`,
    };
  }
  const from = resolveRef(op.from, aliases);
  const to = resolveRef(op.to, aliases);
  if (!from || !to) {
    return {
      op_index: index,
      op: "relate",
      ok: false,
      error: `Could not resolve relation endpoints from="${op.from}" to="${op.to}".`,
    };
  }
  const meta = relationMetadata(spec, op);
  const captured = await captureRelationEdge(
    ctx,
    spec,
    from,
    to,
    meta,
    parseEdgeLifecycle(op.lifecycle),
  );
  if ("error" in captured) {
    return {
      op_index: index,
      op: "relate",
      ok: false,
      error: captured.error,
    };
  }
  return {
    op_index: index,
    op: "relate",
    ok: true,
    ...(captured.skipped ? { skipped: true } : {}),
    relation: {
      kind: spec.kind,
      from,
      to,
      ...(captured.id ? { edge_id: captured.id } : {}),
    },
    footer_lines: captured.footer_lines,
  };
}

/** A creatable edge stage (drafting | queued | active) from request input, or
 *  undefined to let captureEdge pick the default. `retired` is not creatable. */
function parseEdgeLifecycle(value: unknown): "drafting" | "queued" | "active" | undefined {
  return value === "drafting" || value === "queued" || value === "active" ? value : undefined;
}

async function captureRelationEdge(
  ctx: ChangesetContext,
  spec: RelationKindSpec,
  from: string,
  to: string,
  meta: { label: string | null; condition: string | null; kind: string | null },
  lifecycle: "drafting" | "queued" | "active" | undefined,
): Promise<
  { ok: true; id?: string; skipped?: boolean; footer_lines: string[] } | { error: string }
> {
  const edgeFrom = spec.owner === "from" ? from : to;
  const edgeTo = spec.value === "from" ? from : to;
  if (await edgeExists(ctx.docoId, spec.kind, edgeFrom, edgeTo)) {
    return { ok: true, skipped: true, footer_lines: [] };
  }
  const result = await captureEdge({
    docoId: ctx.docoId,
    actorId: ctx.actorId,
    edgeType: spec.kind,
    fromId: edgeFrom,
    toId: edgeTo,
    label: meta.label,
    condition: meta.condition,
    kind: meta.kind,
    ...(lifecycle ? { lifecycle } : {}),
    reason: `create ${spec.kind} relation`,
    docoHost: ctx.docoHost,
    handle: ctx.handle,
    ...(ctx.authoring.source ? { source: ctx.authoring.source } : {}),
    ...(ctx.authoring.metadata ? { metadata: ctx.authoring.metadata } : {}),
  });
  if ("error" in result) return { error: result.error };
  return { ok: true, id: result.id, footer_lines: result.footer_lines };
}

function resolveRef(value: unknown, aliases: Map<string, string>): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("$")) return aliases.get(cleanAlias(trimmed)) ?? null;
  return aliases.get(cleanAlias(trimmed)) ?? trimmed;
}

/**
 * Resolve `$alias` references inside ordinary create-body values.
 *
 * Only a string whose ENTIRE trimmed value is a `$`-prefixed token is
 * treated as a reference (so prose like "Charge $5" is untouched). Walks
 * arrays and nested objects.
 * An unknown `$alias` is a hard error — it almost always means a typo or a
 * forward reference to an op that hasn't run yet.
 */
function resolveAliasesInBody(
  body: Record<string, unknown>,
  aliases: Map<string, string>,
): { body: Record<string, unknown> } | { error: string } {
  const unresolved = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("$")) {
        const id = aliases.get(cleanAlias(t));
        if (!id) {
          unresolved.add(t);
          return v;
        }
        return id;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const resolved = walk(body) as Record<string, unknown>;
  if (unresolved.size > 0) {
    return {
      error: `create.body references unknown alias(es): ${[...unresolved].join(", ")}. Define each with an earlier create op (its \`alias\`) before referencing it.`,
    };
  }
  return { body: resolved };
}

function cleanAlias(alias: string): string {
  return alias.trim().replace(/^\$/, "");
}

function relationMetadata(
  spec: RelationKindSpec,
  op: Pick<RelateOperation, "label" | "condition" | "relation_props">,
): { label: string | null; condition: string | null; kind: string | null } {
  const allowed = new Set(spec.acceptsProps ?? []);
  const bag =
    op.relation_props && typeof op.relation_props === "object"
      ? (op.relation_props as Record<string, unknown>)
      : {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const field = (key: string, explicit?: unknown): string | null =>
    allowed.has(key) ? (str(explicit) ?? str(bag[key])) : null;
  return {
    label: field("label", op.label),
    condition: field("condition", op.condition),
    kind: field("kind"),
  };
}

function normalizeNodeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (CAPTURE_REGISTRY_BY_NODE_TYPE[trimmed]) return trimmed;
  if (trimmed.endsWith("s")) {
    const singular = trimmed.slice(0, -1);
    if (CAPTURE_REGISTRY_BY_NODE_TYPE[singular]) return singular;
  }
  return null;
}

function nodeTypeFromId(id: string): string | null {
  const m = ENTITY_ID_RE.exec(id);
  return m?.[1] ?? null;
}

async function summarizeIntegrity(docoId: string, perspective: string, createdIds: string[]) {
  const contract = PERSPECTIVE_CONTRACTS[perspective];
  if (!contract?.primary_relation || createdIds.length === 0) {
    return {
      checked_against: perspective,
      ok: true,
      created_without_incoming: [],
      open_frontiers: [],
    };
  }
  const nodeTypes = new Set(contract.node_types);
  const primary = contract.primary_relation;
  const counts = await withClient(async (c) => {
    const { rows } = await c.query<{ id: string; incoming: string; outgoing: string }>(
      `SELECT ids.id,
              count(*) FILTER (WHERE s.to_id = ids.id)::text AS incoming,
              count(*) FILTER (WHERE s.from_id = ids.id)::text AS outgoing
         FROM unnest($2::text[]) AS ids(id)
         LEFT JOIN edges s
           ON s.doco_id = $1
          AND s.edge_type = $3
          AND (s.to_id = ids.id OR s.from_id = ids.id)
        GROUP BY ids.id`,
      [docoId, createdIds, primary],
    );
    return new Map(rows.map((row) => [row.id, row]));
  });
  const entities = new Map<string, Awaited<ReturnType<typeof getEntity>>>();
  for (const id of createdIds) {
    const nodeType = nodeTypeFromId(id);
    if (!nodeType) continue;
    const entity = await getEntity(nodeType, id);
    if (!entity || entity.doco_id !== docoId) continue;
    entities.set(id, entity);
  }
  const createdWithoutIncoming: string[] = [];
  const openFrontiers: string[] = [];
  for (const id of createdIds) {
    const entity = entities.get(id);
    if (!entity) continue;
    if (nodeTypes.size > 0 && !nodeTypes.has(entity.node_type)) continue;
    const count = counts.get(id);
    const incoming = Number(count?.incoming ?? 0);
    const outgoing = Number(count?.outgoing ?? 0);
    const isInitial = entity.node_type === "state" && entity.kind === "initial";
    const isTerminal = entity.node_type === "state" && entity.kind === "terminal";
    if (incoming === 0 && !isInitial) createdWithoutIncoming.push(id);
    if (outgoing === 0 && !isTerminal) openFrontiers.push(id);
  }
  return {
    checked_against: perspective,
    ok: createdWithoutIncoming.length === 0,
    created_without_incoming: createdWithoutIncoming,
    open_frontiers: openFrontiers,
  };
}
