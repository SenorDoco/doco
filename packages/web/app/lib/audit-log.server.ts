// Per-Doco audit-events log (decision_01KRKESCBTYG4005VMPKYNYR53).
//
// Postgres-backed `audit_events` table. Five op types cover the
// mutation surface: entity.create, entity.update, entity.delete,
// lifecycle.transition, edge.add.

import { generateUlid } from "@doco/shared";
import { appendAuditEventRow, readAuditEventRows } from "@doco/db";

export type AuditOp =
  | "entity.create"
  | "entity.update"
  | "entity.delete"
  | "lifecycle.transition"
  | "edge.add";

export interface AuditEvent {
  event_id: string;
  at: string;
  by: string | null;
  /** Exactly one of doco_id or org_id is set. Org-constitution articles
   *  travel under org_id; per-Doco entities under doco_id. */
  doco_id: string | null;
  org_id: string | null;
  entity_type: string;
  entity_id: string;
  op: AuditOp;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string | null;
}

export interface AppendEventInput {
  docoDir: string;
  /** Set when the event is per-Doco; leave undefined for org-scope events. */
  docoId?: string | null;
  /** Set when the event is org-scope (org constitution articles). */
  orgId?: string | null;
  by: string | null;
  entity_type: string;
  entity_id: string;
  op: AuditOp;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string | null;
}

/**
 * Append a single audit event. Sync-returning so callers don't have to
 * await — the Postgres INSERT runs fire-and-forget. Failures are logged.
 */
export function appendAuditEvent(input: AppendEventInput): AuditEvent {
  const event: AuditEvent = {
    event_id: `evt_${generateUlid()}`,
    at: new Date().toISOString(),
    by: input.by,
    doco_id: input.docoId ?? null,
    org_id: input.orgId ?? null,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    op: input.op,
  };
  if (input.before !== undefined) event.before = input.before;
  if (input.after !== undefined) event.after = input.after;
  if (input.reason !== undefined && input.reason !== null) event.reason = input.reason;

  appendAuditEventRow({
    event_id: event.event_id,
    at: event.at,
    by_principal: event.by,
    doco_id: event.doco_id,
    org_id: event.org_id,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    op: event.op,
    before_json: event.before ?? null,
    after_json: event.after ?? null,
    reason: event.reason ?? null,
  }).catch((err) => {
    console.error("audit-log: postgres append failed", err);
  });

  return event;
}

export interface ReadAuditFilters {
  entity_id?: string;
  entity_type?: string;
  op?: AuditOp | AuditOp[];
  by?: string;
  since?: string;
  until?: string;
  limit?: number;
}

/**
 * Read the audit log, optionally filtered. Returns events newest-first.
 */
export async function readAuditEvents(
  _docoDir: string,
  filters: ReadAuditFilters = {},
  docoIdHint?: string,
): Promise<AuditEvent[]> {
  const ops = filters.op ? (Array.isArray(filters.op) ? filters.op : [filters.op]) : undefined;
  const rows = await readAuditEventRows({
    doco_id: docoIdHint,
    entity_id: filters.entity_id,
    entity_type: filters.entity_type,
    op: ops,
    by: filters.by,
    since: filters.since,
    until: filters.until,
    limit: filters.limit,
  });
  return rows.map((r) => {
    const evt: AuditEvent = {
      event_id: r.event_id,
      at: r.at,
      by: r.by_principal,
      doco_id: r.doco_id,
      org_id: r.org_id ?? null,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      op: r.op as AuditOp,
    };
    if (r.before_json) evt.before = r.before_json;
    if (r.after_json) evt.after = r.after_json;
    if (r.reason) evt.reason = r.reason;
    return evt;
  });
}

/**
 * Convenience: read a single entity's history.
 */
export async function readEntityHistory(
  docoDir: string,
  entityId: string,
  limit?: number,
  docoIdHint?: string,
): Promise<AuditEvent[]> {
  return readAuditEvents(docoDir, { entity_id: entityId, limit }, docoIdHint);
}
