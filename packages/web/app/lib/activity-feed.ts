export interface ActivityFeedDelta {
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

const STRUCK_ACTIVITY_LIFECYCLES: ReadonlySet<string> = new Set(["retired"]);

export function verbFromAuditOp(op: string): string {
  if (op === "entity.create") return "added";
  if (op === "entity.update") return "updated";
  if (op === "entity.delete") return "deleted";
  if (op === "lifecycle.transition") return "transitioned";
  if (op === "synapse.add") return "linked";
  return op;
}

export function iconFromAuditOp(op: string): string {
  if (op === "entity.create") return "✍️";
  if (op === "entity.update") return "📝";
  if (op === "entity.delete") return "🗑️";
  if (op === "lifecycle.transition") return "🔁";
  if (op === "synapse.add") return "➕";
  return "•";
}

export function capNodeType(t: string): string {
  return t
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function lifecycleTransitionText(event: { op: string } & ActivityFeedDelta): string | null {
  if (event.op !== "lifecycle.transition") return null;
  const before = stringField(event.before, "lifecycle");
  const after = stringField(event.after, "lifecycle");
  if (before && after && before !== after) return `.lifecycle ${before} → ${after}`;
  if (after) return `.lifecycle set to "${after}"`;
  if (before) return `.lifecycle cleared from "${before}"`;
  return ".lifecycle changed";
}

export function shouldStrikeActivityTarget(
  event: { op?: string; lifecycle?: unknown } & ActivityFeedDelta,
): boolean {
  const transitionLifecycle =
    event.op === "lifecycle.transition" ? stringField(event.after, "lifecycle") : null;
  const currentLifecycle = typeof event.lifecycle === "string" ? event.lifecycle : null;
  const afterLifecycle = stringField(event.after, "lifecycle");
  const lifecycle = transitionLifecycle ?? currentLifecycle ?? afterLifecycle;
  return lifecycle != null && STRUCK_ACTIVITY_LIFECYCLES.has(lifecycle);
}

export function auditSummaryFallback(entityType: string, id: string): string {
  return `${entityType}_${id.slice(-6)}`;
}

function stringField(
  obj: Record<string, unknown> | null | undefined,
  field: string,
): string | null {
  const value = obj?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}
