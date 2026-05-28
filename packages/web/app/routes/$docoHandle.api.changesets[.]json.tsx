// Generic graph-authoring changesets.
//
// This endpoint is deliberately not BPMN-specific. It lets agents create
// neurons and add typed relations in one request; perspective-specific
// contracts then interpret those relations for rendering.

import { getEntity, roleAtLeast, withClient } from "@doco/db";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import {
  type CaptureError,
  type EntityPatch,
  type NodeTypeName,
  type UpdateResult,
  updateDecision,
  updateEntity,
} from "~/lib/capture.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  PERSPECTIVE_CONTRACTS,
  type RelationKindSpec,
  relationKind,
} from "~/lib/graph-authoring-contract.server";
import { CAPTURE_REGISTRY_BY_ENTITY_TYPE, type MeLike } from "~/lib/neuron-capture-registry.server";

type Operation = CreateOperation | RelateOperation | RelateManyOperation | AppendOperation;

interface CreateOperation {
  op: "create";
  entity_type: string;
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
  entity_type: string;
  alias?: string;
  body: Record<string, unknown>;
  after: string;
  relation_kind: string;
  label?: string;
  condition?: string;
  relation_props?: Record<string, unknown>;
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
  actorId: string | null;
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
    stored_on: string;
    field: string;
  };
  relations?: {
    kind: string;
    from: string;
    to: string;
    stored_on: string;
    field: string;
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
    "author",
  );
  if (!me) {
    return Response.json({ error: "Authentication required to write." }, { status: 401 });
  }
  const docoRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!docoRole || !roleAtLeast(docoRole, "author")) {
    return Response.json({ error: "Forbidden: author role required to write." }, { status: 403 });
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
    actorId: me.id,
    me: { id: me.id, username: me.username },
    request,
  };

  for (let i = 0; i < body.operations.length; i++) {
    const op = body.operations[i] as Operation;
    const result = await applyOperation(op, i, ctx, aliases);
    results.push(result);
    if (result.footer_lines) footerLines.push(...result.footer_lines);
    if (result.ok && result.id && (result.op === "create" || result.op === "append")) {
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
    return createNeuron(op, index, ctx, aliases);
  }
  if (op.op === "relate") {
    return relateNeurons(op, index, ctx, aliases);
  }
  if (op.op === "relate_many") {
    return relateMany(op, index, ctx, aliases);
  }
  if (op.op === "append") {
    const created = await createNeuron(
      { op: "create", entity_type: op.entity_type, alias: op.alias, body: op.body },
      index,
      ctx,
      aliases,
    );
    if (!created.ok || !created.id) return created;
    const related = await relateNeurons(
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
  return {
    op_index: index,
    op: (op as { op?: Operation["op"] }).op ?? "create",
    ok: false,
    error: `Unknown operation "${String((op as { op?: unknown }).op)}".`,
  };
}

async function createNeuron(
  op: CreateOperation,
  index: number,
  ctx: ChangesetContext,
  aliases: Map<string, string>,
): Promise<OperationResult> {
  const entityType = normalizeEntityType(op.entity_type);
  const entry = entityType ? CAPTURE_REGISTRY_BY_ENTITY_TYPE[entityType] : null;
  if (!entry) {
    return {
      op_index: index,
      op: "create",
      ok: false,
      error: `Unsupported create entity_type "${op.entity_type}".`,
    };
  }
  if (!op.body || typeof op.body !== "object" || Array.isArray(op.body)) {
    return { op_index: index, op: "create", ok: false, error: "create.body must be an object." };
  }
  const draft = stampAuthenticatedCreator({ ...op.body }, ctx.actorId);
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
  );
  if ("error" in result) {
    return { op_index: index, op: "create", ok: false, error: result.error };
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

  const owners = new Map<
    string,
    {
      ownerType: string;
      data: Record<string, unknown>;
      patch: EntityPatch;
      relations: NonNullable<OperationResult["relations"]>;
    }
  >();

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

    const props = relationProps(spec, relation);
    const ownerId = spec.owner === "from" ? from : to;
    const valueId = spec.value === "from" ? from : to;
    const ownerType = entityTypeFromId(ownerId);
    if (!ownerType) {
      return {
        op_index: index,
        op: "relate_many",
        ok: false,
        error: `Invalid relation owner id: ${ownerId}.`,
      };
    }

    let ownerDraft = owners.get(ownerId);
    if (!ownerDraft) {
      const owner = await getEntity(ownerType, ownerId);
      if (!owner || owner.doco_id !== ctx.docoId) {
        return {
          op_index: index,
          op: "relate_many",
          ok: false,
          error: `Relation owner not found in this doco: ${ownerId}.`,
        };
      }
      ownerDraft = {
        ownerType,
        data: { ...(owner.data ?? {}) },
        patch: {},
        relations: [],
      };
      owners.set(ownerId, ownerDraft);
    }

    const target = await getEntity(entityTypeFromId(valueId) ?? "", valueId);
    if (!target || target.doco_id !== ctx.docoId) {
      return {
        op_index: index,
        op: "relate_many",
        ok: false,
        error: `Relation target not found in this doco: ${valueId}.`,
      };
    }

    const patch = buildRelationPatch(ownerDraft.data, spec, valueId, props);
    if (patch) {
      Object.assign(ownerDraft.data, patch);
      Object.assign(ownerDraft.patch, patch);
    }
    ownerDraft.relations.push({
      kind: spec.kind,
      from,
      to,
      stored_on: ownerId,
      field: spec.field,
    });
  }

  const footerLines: string[] = [];
  const relations: NonNullable<OperationResult["relations"]> = [];
  for (const [ownerId, ownerDraft] of owners) {
    relations.push(...ownerDraft.relations);
    if (Object.keys(ownerDraft.patch).length === 0) continue;
    const patched = await patchRelationOwner(ctx, ownerDraft.ownerType, ownerId, ownerDraft.patch);
    if ("error" in patched) {
      return {
        op_index: index,
        op: "relate_many",
        ok: false,
        error: patched.error,
      };
    }
    footerLines.push(...patched.footer_lines);
  }

  return {
    op_index: index,
    op: "relate_many",
    ok: true,
    relations,
    ...(footerLines.length === 0 ? { skipped: true } : {}),
    footer_lines: footerLines,
  };
}

async function relateNeurons(
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
  const props = relationProps(spec, op);
  const ownerId = spec.owner === "from" ? from : to;
  const valueId = spec.value === "from" ? from : to;
  const ownerType = entityTypeFromId(ownerId);
  if (!ownerType) {
    return {
      op_index: index,
      op: "relate",
      ok: false,
      error: `Invalid relation owner id: ${ownerId}.`,
    };
  }
  const owner = await getEntity(ownerType, ownerId);
  if (!owner || owner.doco_id !== ctx.docoId) {
    return {
      op_index: index,
      op: "relate",
      ok: false,
      error: `Relation owner not found in this doco: ${ownerId}.`,
    };
  }
  const target = await getEntity(entityTypeFromId(valueId) ?? "", valueId);
  if (!target || target.doco_id !== ctx.docoId) {
    return {
      op_index: index,
      op: "relate",
      ok: false,
      error: `Relation target not found in this doco: ${valueId}.`,
    };
  }

  const patch = buildRelationPatch(owner.data ?? {}, spec, valueId, props);
  if (!patch) {
    return {
      op_index: index,
      op: "relate",
      ok: true,
      skipped: true,
      relation: { kind: spec.kind, from, to, stored_on: ownerId, field: spec.field },
      footer_lines: [],
    };
  }

  const patched = await patchRelationOwner(ctx, ownerType, ownerId, patch);
  if ("error" in patched) {
    return {
      op_index: index,
      op: "relate",
      ok: false,
      error: patched.error,
    };
  }
  return {
    op_index: index,
    op: "relate",
    ok: true,
    relation: { kind: spec.kind, from, to, stored_on: ownerId, field: spec.field },
    footer_lines: patched.footer_lines,
  };
}

function buildRelationPatch(
  data: Record<string, unknown>,
  spec: RelationKindSpec,
  valueId: string,
  props: Record<string, unknown>,
): EntityPatch | null {
  if (spec.cardinality === "one") {
    return data[spec.field] === valueId ? null : { [spec.field]: valueId };
  }
  const current = Array.isArray(data[spec.field]) ? [...(data[spec.field] as unknown[])] : [];
  const nextEntry =
    spec.field === "sequence_to" && Object.keys(props).length > 0
      ? { target: valueId, ...props }
      : valueId;
  const foundIndex = current.findIndex((entry) => relationTarget(entry) === valueId);
  if (foundIndex < 0) {
    return { [spec.field]: [...current, nextEntry] };
  }
  if (JSON.stringify(current[foundIndex]) === JSON.stringify(nextEntry)) return null;
  current[foundIndex] = nextEntry;
  return { [spec.field]: current };
}

async function patchRelationOwner(
  ctx: ChangesetContext,
  ownerType: string,
  ownerId: string,
  patch: EntityPatch,
): Promise<UpdateResult | CaptureError> {
  if (ownerType === "decision") {
    return updateDecision(
      ctx.dir,
      ctx.docoId,
      ctx.ownerSlug,
      ctx.docoSlug,
      ownerId,
      patch,
      ctx.docoHost,
      ctx.actorId,
    );
  }
  if (ownerType === "principal") {
    if (!("reports_to" in patch) || Object.keys(patch).length !== 1) {
      return { error: "Changesets can only patch Principal reports_to relations." };
    }
    return patchPrincipal(ctx, ownerId, patch);
  }
  if (!CAPTURE_REGISTRY_BY_ENTITY_TYPE[ownerType]) {
    return {
      error: `Changesets cannot patch ${ownerType} relations yet; use that type's dedicated endpoint.`,
    };
  }
  return updateEntity({
    docoDir: ctx.dir,
    docoId: ctx.docoId,
    ownerSlug: ctx.ownerSlug,
    docoSlug: ctx.docoSlug,
    entityType: ownerType as NodeTypeName,
    pluralDir: `${ownerType}s`,
    id: ownerId,
    patch,
    allowedFields: undefined,
    docoHost: ctx.docoHost,
    actorId: ctx.actorId,
  });
}

async function patchPrincipal(
  ctx: ChangesetContext,
  ownerId: string,
  patch: EntityPatch,
): Promise<UpdateResult | CaptureError> {
  const { action } = await import("~/routes/$docoHandle.api.principals.$id[.]json");
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const cookie = ctx.request.headers.get("cookie");
  const authorization = ctx.request.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);
  const response = await action({
    request: new Request(`${ctx.docoHost}/${ctx.docoSlug}/api/principals/${ownerId}.json`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    }),
    params: { docoHandle: ctx.docoSlug, id: ownerId },
  });
  const body = (await response.json()) as {
    ok?: boolean;
    id?: string;
    error?: string;
    footer_lines?: string[];
    duration_ms?: number;
  };
  if (!response.ok || body.error) {
    return { error: body.error ?? `Principal patch failed with ${response.status}` };
  }
  return {
    ok: true,
    id: body.id ?? ownerId,
    path: `<postgres>:principals/${ownerId}`,
    footer_lines: body.footer_lines ?? [],
    changed: Object.keys(patch),
    duration_ms: body.duration_ms ?? 0,
  };
}

function resolveRef(value: unknown, aliases: Map<string, string>): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("$")) return aliases.get(cleanAlias(trimmed)) ?? null;
  return aliases.get(cleanAlias(trimmed)) ?? trimmed;
}

function cleanAlias(alias: string): string {
  return alias.trim().replace(/^\$/, "");
}

function relationProps(
  spec: RelationKindSpec,
  op: Pick<RelateOperation, "label" | "condition" | "relation_props">,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const allowed = new Set(spec.acceptsProps ?? []);
  if (op.relation_props && typeof op.relation_props === "object") {
    for (const [key, value] of Object.entries(op.relation_props)) {
      if (allowed.has(key)) props[key] = value;
    }
  }
  if (op.label && allowed.has("label")) props.label = op.label;
  if (op.condition && allowed.has("condition")) props.condition = op.condition;
  return props;
}

function relationTarget(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (
    entry &&
    typeof entry === "object" &&
    typeof (entry as { target?: unknown }).target === "string"
  ) {
    return (entry as { target: string }).target;
  }
  return null;
}

function normalizeEntityType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (CAPTURE_REGISTRY_BY_ENTITY_TYPE[trimmed]) return trimmed;
  if (trimmed.endsWith("s")) {
    const singular = trimmed.slice(0, -1);
    if (CAPTURE_REGISTRY_BY_ENTITY_TYPE[singular]) return singular;
  }
  return null;
}

function entityTypeFromId(id: string): string | null {
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
         LEFT JOIN synapses s
           ON s.doco_id = $1
          AND s.synapse_type = $3
          AND (s.to_id = ids.id OR s.from_id = ids.id)
        GROUP BY ids.id`,
      [docoId, createdIds, primary],
    );
    return new Map(rows.map((row) => [row.id, row]));
  });
  const createdWithoutIncoming: string[] = [];
  const openFrontiers: string[] = [];
  for (const id of createdIds) {
    const entityType = entityTypeFromId(id);
    if (!entityType) continue;
    const entity = await getEntity(entityType, id);
    if (!entity || entity.doco_id !== docoId) continue;
    if (nodeTypes.size > 0 && !nodeTypes.has(entity.entity_type)) continue;
    const count = counts.get(id);
    const incoming = Number(count?.incoming ?? 0);
    const outgoing = Number(count?.outgoing ?? 0);
    const isInitial = entity.entity_type === "state" && entity.data?.kind === "initial";
    const isTerminal = entity.entity_type === "state" && entity.data?.kind === "terminal";
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
