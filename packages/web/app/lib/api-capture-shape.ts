// The ONE serializer that turns a stored node row into its API JSON shape —
// `{ id, node_type, doco_id, lifecycle, prose, extra, kind?, locator?,
// proposer_id?, …audit }`. There is no `data` envelope and no type-named key.
// Every node-returning surface (GET by id, list endpoints, the Slack mirror)
// runs rows through this so the wire shape can't drift between them.
//
// Kept dependency-free (only a structural type) so it unit-tests without
// dragging server-only imports (`@vercel/functions`, `@doco/db`, …). The shape
// below is structurally a `@doco/db` `NodeRow`, so a `NodeRow` is accepted
// directly.

/** Structural `@doco/db` `NodeRow` — the input `nodeToApi` serializes. */
export interface NodeApiRow {
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
 * Serialize a node row to its API JSON: the honest row — `prose`, the `extra`
 * bag, whichever promoted columns it carries, identity + audit. One shape for
 * every node-returning endpoint; no synthetic `data` envelope, no type-named
 * key. `node_type` is the node's public type discriminator (peer to an edge's
 * `edge_type`).
 */
export function nodeToApi(rec: NodeApiRow): Record<string, unknown> {
  return {
    id: rec.id,
    node_type: rec.node_type,
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
