export interface ActivityFeedDelta {
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export function verbFromAuditOp(op: string): string {
  if (op === "entity.create") return "added";
  if (op === "entity.update") return "updated";
  if (op === "entity.delete") return "deleted";
  if (op === "lifecycle.transition") return "transitioned";
  if (op === "edge.add") return "linked";
  return op;
}

export function iconFromAuditOp(op: string): string {
  if (op === "entity.create") return "✍️";
  if (op === "entity.update") return "📝";
  if (op === "entity.delete") return "🗑️";
  if (op === "lifecycle.transition") return "🔁";
  if (op === "edge.add") return "➕";
  return "•";
}

export function capNodeType(t: string): string {
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
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

export function auditSummaryFallback(nodeType: string, id: string): string {
  return `${nodeType}_${id.slice(-6)}`;
}

function stringField(
  obj: Record<string, unknown> | null | undefined,
  field: string,
): string | null {
  const value = obj?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}
