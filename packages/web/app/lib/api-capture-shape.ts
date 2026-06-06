// The read helper that lets the node API speak the canonical row shape —
// `{prose, kind?, attributes}` — for every node type. There is no type-named
// key: a node's text is `prose`, full stop.
//
// Kept dependency-free (only types) so it unit-tests without dragging the
// route factory's server-only imports (`@vercel/functions`, `@doco/db`, …).

/** Minimal read-record shape `buildEntityGetResponse` needs. Structurally a
 *  subset of `@doco/db`'s `EntityRecord`, inlined to avoid the import. */
export interface EntityGetRecord {
  id: string;
  entity_type: string;
  doco_id: string;
  lifecycle?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  data: Record<string, unknown>;
  attributes?: Record<string, unknown> | null;
}

/**
 * Build the GET response body for a node/policy entity. Node rows expose the
 * canonical shape (`prose` + `attributes`); a policy carries its structured
 * fields in `data`.
 */
export function buildEntityGetResponse(rec: EntityGetRecord): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: rec.id,
    entity_type: rec.entity_type,
    doco_id: rec.doco_id,
    lifecycle: rec.lifecycle ?? null,
    created_at: rec.created_at ?? null,
    updated_at: rec.updated_at ?? null,
    data: rec.data,
  };

  if (rec.entity_type !== "policy") {
    response.prose = typeof rec.data.prose === "string" ? rec.data.prose : "";
    response.attributes = rec.attributes ?? {};
  }

  return response;
}
