type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface RuleRow {
  id: string;
  rule: string;
  lifecycle: string | null;
  created_at: string | null;
  created_by: string | null;
  data: Record<string, unknown> | null;
}

interface EvalRow {
  id: string;
  eval: string;
  lifecycle: string | null;
  created_at: string | null;
  data: Record<string, unknown> | null;
}

interface ReferenceRow {
  id: string;
  reference: string;
  ref_type: string | null;
  locator: string | null;
  title: string | null;
  lifecycle: string | null;
  created_at: string | null;
  data: Record<string, unknown> | null;
}

interface ActionRow {
  id: string;
  action: string;
  lifecycle: string | null;
  created_at: string | null;
  data: Record<string, unknown> | null;
}

interface DecisionRow {
  id: string;
  decision: string;
  lifecycle: string | null;
  created_at: string | null;
  data: Record<string, unknown> | null;
}

interface PrincipalRow {
  id: string;
  name: string;
  lifecycle: string | null;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  props?: Record<string, unknown> | null;
}

interface SlaLoadOptions {
  limit?: number;
}

export interface SlaLink {
  id: string;
  label: string;
  href: string;
  lifecycle: string | null;
}

export interface SlaCommitment {
  id: string;
  href: string;
  title: string;
  lifecycle: string;
  promise: string;
  owner: SlaLink | null;
  metric: string | null;
  target: string | null;
  measurementWindow: string | null;
  scope: string | null;
  exclusions: string | null;
  remedy: string | null;
  reviewDate: string | null;
  sourceRefs: SlaLink[];
  evals: (SlaLink & { status: string | null; runAt: string | null })[];
  responseActions: SlaLink[];
  changeDecisions: SlaLink[];
  warnings: string[];
}

export interface SlaPerspectiveData {
  commitments: SlaCommitment[];
  stats: {
    commitments: number;
    evidenceLinked: number;
    missingOwner: number;
    missingRemedy: number;
    reviewDue: number;
    externalRefs: number;
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeLimit(value: number | null | undefined): number | null {
  if (value == null) return null;
  const limit = Math.floor(value);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

function firstLine(value: string | null | undefined): string {
  const line = String(value ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
  return line || "(untitled SLA commitment)";
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstString(
  data: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!data) return null;
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      const parts = value.map(asString).filter((v): v is string => Boolean(v));
      if (parts.length > 0) return parts.join(", ");
      continue;
    }
    const str = asString(value);
    if (str) return str;
  }
  return null;
}

function stringArray(data: Record<string, unknown> | null | undefined, keys: string[]): string[] {
  if (!data) return [];
  const out: string[] = [];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const str = asString(entry);
        if (str) out.push(str);
      }
    } else {
      const str = asString(value);
      if (str) out.push(str);
    }
  }
  return out;
}

function isDue(date: string | null): boolean {
  if (!date) return false;
  const time = Date.parse(date);
  if (!Number.isFinite(time)) return false;
  return time <= Date.now();
}

function href(handle: string, entityType: string, id: string): string {
  return `/${handle}/${entityType}/${id}`;
}

function linkFor(
  handle: string,
  entityType: string,
  row: { id: string; lifecycle: string | null },
  label: string,
): SlaLink {
  return {
    id: row.id,
    label: firstLine(label),
    href: href(handle, entityType, row.id),
    lifecycle: row.lifecycle ?? "asserted",
  };
}

function extractTarget(rule: string): string | null {
  const match = rule.match(
    /\b(\d+(?:\.\d+)?\s*%|p\d+\s*[<≤]\s*[^,.;]+|[<≤]\s*[^,.;]+|\d+\s*(?:ms|s|sec|seconds|minutes|mins|hours|hrs|days)\b)/i,
  );
  return match?.[1]?.trim() ?? null;
}

function extractWindow(rule: string): string | null {
  const match = rule.match(
    /\b(monthly|calendar month|rolling\s+\d+\s*(?:days?|hours?)|business days?|24\/7|daily|weekly|quarterly|annually|per\s+month|per\s+week)\b/i,
  );
  return match?.[1]?.trim() ?? null;
}

function hasText(value: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

function edgeRole(edge: EdgeRow): string {
  return typeof edge.props?.role === "string" ? edge.props.role : edge.edge_type;
}

export async function loadSlaPerspectiveData(
  c: QueryClient,
  docoId: string,
  handle: string,
  options: SlaLoadOptions = {},
): Promise<SlaPerspectiveData> {
  const limit = normalizeLimit(options.limit);
  const params: unknown[] = [docoId];
  if (limit != null) params.push(limit);
  const [rules, evals, references, actions, decisions, principals] = await Promise.all([
    c.query<RuleRow>(
      `SELECT id, prose AS rule, COALESCE(lifecycle, 'asserted') AS lifecycle,
              created_at::text AS created_at, created_by, data
         FROM nodes
        WHERE node_type = 'rule'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
        ORDER BY created_at DESC
        ${limit != null ? "LIMIT $2" : ""}`,
      params,
    ),
    c.query<EvalRow>(
      `SELECT id, prose AS eval, COALESCE(lifecycle, 'asserted') AS lifecycle,
              created_at::text AS created_at, data
         FROM nodes
        WHERE node_type = 'eval'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
        ORDER BY created_at DESC
        ${limit != null ? "LIMIT $2" : ""}`,
      params,
    ),
    c.query<ReferenceRow>(
      `SELECT id, prose AS reference, ref_type, locator, title,
              COALESCE(lifecycle, 'asserted') AS lifecycle,
              created_at::text AS created_at, data
         FROM nodes
        WHERE node_type = 'reference'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
        ORDER BY created_at DESC
        ${limit != null ? "LIMIT $2" : ""}`,
      params,
    ),
    c.query<ActionRow>(
      `SELECT id, prose AS action, COALESCE(lifecycle, 'asserted') AS lifecycle,
              created_at::text AS created_at, data
         FROM nodes
        WHERE node_type = 'action'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
        ORDER BY created_at DESC
        ${limit != null ? "LIMIT $2" : ""}`,
      params,
    ),
    c.query<DecisionRow>(
      `SELECT id, prose AS decision, COALESCE(lifecycle, 'asserted') AS lifecycle,
              created_at::text AS created_at, data
         FROM nodes
        WHERE node_type = 'decision'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
        ORDER BY created_at DESC
        ${limit != null ? "LIMIT $2" : ""}`,
      params,
    ),
    c.query<PrincipalRow>(
      `SELECT id, name, COALESCE(lifecycle, 'asserted') AS lifecycle
         FROM nodes
        WHERE node_type = 'principal'
          AND doco_id = $1
          AND COALESCE(lifecycle, 'asserted') <> 'retired'
        ORDER BY created_at DESC
        ${limit != null ? "LIMIT $2" : ""}`,
      params,
    ),
  ]);

  const ruleIds = rules.rows.map((row) => row.id);
  const edges =
    ruleIds.length === 0
      ? []
      : (
          await c.query<EdgeRow>(
            `SELECT from_id, to_id, edge_type, props
               FROM edges
              WHERE doco_id = $1
                AND (from_id = ANY($2::text[]) OR to_id = ANY($2::text[]))`,
            [docoId, ruleIds],
          )
        ).rows;

  const principalsById = new Map(principals.rows.map((row) => [row.id, row]));
  const evalsById = new Map(evals.rows.map((row) => [row.id, row]));
  const referencesById = new Map(references.rows.map((row) => [row.id, row]));
  const actionsById = new Map(actions.rows.map((row) => [row.id, row]));
  const decisionsById = new Map(decisions.rows.map((row) => [row.id, row]));

  const incoming = new Map<string, EdgeRow[]>();
  const outgoing = new Map<string, EdgeRow[]>();
  for (const s of edges) {
    if (!incoming.has(s.to_id)) incoming.set(s.to_id, []);
    incoming.get(s.to_id)?.push(s);
    if (!outgoing.has(s.from_id)) outgoing.set(s.from_id, []);
    outgoing.get(s.from_id)?.push(s);
  }

  const commitments: SlaCommitment[] = rules.rows.map((rule) => {
    const data = rule.data ?? {};
    const title = firstLine(rule.rule);
    const ownerId =
      outgoing.get(rule.id)?.find((s) => edgeRole(s) === "owned_by" && principalsById.has(s.to_id))
        ?.to_id ??
      (rule.created_by && principalsById.has(rule.created_by) ? rule.created_by : null);
    const ownerRow = ownerId ? principalsById.get(ownerId) : null;
    const owner = ownerRow ? linkFor(handle, "principal", ownerRow, ownerRow.name) : null;

    const incomingToRule = incoming.get(rule.id) ?? [];
    const outgoingFromRule = outgoing.get(rule.id) ?? [];
    const linkedEvalIds = new Set([
      ...incomingToRule
        .filter((s) => edgeRole(s) === "tests" && evalsById.has(s.from_id))
        .map((s) => s.from_id),
    ]);
    const linkedReferenceIds = new Set([
      ...incomingToRule.filter((s) => referencesById.has(s.from_id)).map((s) => s.from_id),
      ...outgoingFromRule.filter((s) => referencesById.has(s.to_id)).map((s) => s.to_id),
      ...stringArray(data, ["source_ref", "source_refs", "reference_ids"]).filter((id) =>
        referencesById.has(id),
      ),
    ]);
    const linkedActionIds = new Set(
      incomingToRule
        .filter(
          (s) =>
            (edgeRole(s) === "gated_by" || edgeRole(s) === "acts_on") && actionsById.has(s.from_id),
        )
        .map((s) => s.from_id),
    );
    const linkedDecisionIds = new Set([
      ...incomingToRule
        .filter((s) => edgeRole(s) === "consults" && decisionsById.has(s.from_id))
        .map((s) => s.from_id),
      ...outgoingFromRule.filter((s) => decisionsById.has(s.to_id)).map((s) => s.to_id),
    ]);

    const evalLinks = [...linkedEvalIds].flatMap((id) => {
      const row = evalsById.get(id);
      if (!row) return [];
      return [
        {
          ...linkFor(handle, "eval", row, row.eval),
          status: asString(row.data?.last_status) ?? asString(row.data?.expected_status),
          runAt: toIso(asString(row.data?.last_run_at)),
        },
      ];
    });
    const sourceRefs = [...linkedReferenceIds].flatMap((id) => {
      const row = referencesById.get(id);
      if (!row) return [];
      return [linkFor(handle, "reference", row, row.title ?? row.reference)];
    });
    const responseActions = [...linkedActionIds].flatMap((id) => {
      const row = actionsById.get(id);
      if (!row) return [];
      return [linkFor(handle, "action", row, row.action)];
    });
    const changeDecisions = [...linkedDecisionIds].flatMap((id) => {
      const row = decisionsById.get(id);
      if (!row) return [];
      return [linkFor(handle, "decision", row, row.decision)];
    });

    const target =
      firstString(data, ["target", "sla_target", "objective"]) ?? extractTarget(rule.rule);
    const measurementWindow =
      firstString(data, ["measurement_window", "window", "calendar", "period"]) ??
      extractWindow(rule.rule);
    const metric = firstString(data, ["metric", "sli", "indicator", "measurement"]);
    const scope = firstString(data, ["scope", "tier", "population", "eligible_population"]);
    const exclusions = firstString(data, ["exclusions", "excluded", "exceptions"]);
    const remedy = firstString(data, ["remedy", "service_credit", "credit", "claim_procedure"]);
    const reviewDate = firstString(data, ["review_date", "review_at", "next_review_at"]);
    const warnings = [
      ...(owner ? [] : ["No owner"]),
      ...(evalLinks.length > 0 ? [] : ["No Eval"]),
      ...(sourceRefs.length > 0 ? [] : ["No source Reference"]),
      ...(hasText(target) ? [] : ["No target"]),
      ...(hasText(measurementWindow) ? [] : ["No window"]),
      ...(hasText(remedy) ? [] : ["No remedy"]),
      ...(isDue(reviewDate) ? ["Review due"] : []),
    ];

    return {
      id: rule.id,
      href: href(handle, "rule", rule.id),
      title,
      lifecycle: rule.lifecycle ?? "asserted",
      promise: rule.rule,
      owner,
      metric,
      target,
      measurementWindow,
      scope,
      exclusions,
      remedy,
      reviewDate,
      sourceRefs,
      evals: evalLinks,
      responseActions,
      changeDecisions,
      warnings,
    };
  });

  const stats = {
    commitments: commitments.length,
    evidenceLinked: commitments.filter((cmt) => cmt.evals.length > 0 || cmt.sourceRefs.length > 0)
      .length,
    missingOwner: commitments.filter((cmt) => !cmt.owner).length,
    missingRemedy: commitments.filter((cmt) => !cmt.remedy).length,
    reviewDue: commitments.filter((cmt) => isDue(cmt.reviewDate)).length,
    externalRefs: references.rows.filter((row) => row.locator || row.ref_type === "url").length,
  };

  return { commitments, stats };
}
