// The read helper that lets the node API speak the canonical row shape —
// `{ prose, extra, kind?, … }` — for every node type. There is no `data`
// envelope and no type-named key: a node's text is `prose`, full stop.
//
// Kept dependency-free (only a structural type) so it unit-tests without
// dragging the route factory's server-only imports (`@vercel/functions`,
// `@doco/db`, …). The shape below is structurally a `@doco/db` `NodeRow`.

/** Minimal node-row shape `buildEntityGetResponse` needs (a structural NodeRow). */
export interface EntityGetRecord {
  id: string;
  node_type: string;
  doco_id: string;
  lifecycle: string | null;
  prose: string;
  extra: Record<string, unknown>;
  kind: string | null;
  locator: string | null;
  proposer_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
  updated_by: string | null;
}

/**
 * Build the GET response body for a node entity: the honest row — `prose`, the
 * `extra` bag, the promoted columns it carries, identity + audit. One shape;
 * no synthetic `data` envelope.
 */
export function buildEntityGetResponse(rec: EntityGetRecord): Record<string, unknown> {
  return {
    id: rec.id,
    entity_type: rec.node_type,
    doco_id: rec.doco_id,
    lifecycle: rec.lifecycle,
    prose: rec.prose,
    extra: rec.extra,
    ...(rec.kind != null ? { kind: rec.kind } : {}),
    ...(rec.locator != null ? { locator: rec.locator } : {}),
    ...(rec.proposer_id != null ? { proposer_id: rec.proposer_id } : {}),
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    created_by: rec.created_by,
    updated_by: rec.updated_by,
  };
}
