// Node-shape slim-down (raw-schema phase). The read helper that lets the node
// API speak the row shape directly — `{prose, kind?, attributes}` — instead of
// the per-type translated shape (`{decision, question, …}`).
//
// Kept dependency-free (only types) so it unit-tests without dragging the
// route factory's server-only imports (`@vercel/functions`, `@doco/db`, …).
//
// The WRITE side no longer needs a translation shim: `captureGenericNode`
// accepts `{prose, kind?, attributes}` directly (the legacy type-named field
// still works as a `prose` alias). The old `normalizeRawCaptureDraft` that
// re-shaped the draft into the per-type flat form was that pure translation —
// it's gone now that there is one generic writer.

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
  type_named_value?: string | null;
  body_md?: string;
  attributes?: Record<string, unknown> | null;
}

/**
 * Build the GET response body for a node/policy entity. Preserves the legacy
 * type-named prose key (and the policy `body_md` branch) and additively
 * exposes the raw row shape (`prose` + `attributes`) for node rows.
 */
export function buildEntityGetResponse(
  rec: EntityGetRecord,
  entityType: string,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: rec.id,
    entity_type: rec.entity_type,
    doco_id: rec.doco_id,
    lifecycle: rec.lifecycle ?? null,
    created_at: rec.created_at ?? null,
    updated_at: rec.updated_at ?? null,
    data: rec.data,
  };

  // Legacy aliasing — unchanged from the pre-slim-down behaviour.
  if (rec.type_named_value !== undefined && rec.type_named_value !== null) {
    response[entityType] = rec.type_named_value;
  } else if (rec.entity_type === "policy") {
    response.body_md = rec.body_md ?? null;
  } else {
    response[entityType] = "";
  }

  // Raw-schema phase (additive): node rows also expose the row shape directly.
  // Policies stay on their own `policy` + `body_md` shape.
  if (rec.entity_type !== "policy") {
    response.prose = rec.type_named_value ?? "";
    response.attributes = rec.attributes ?? {};
  }

  return response;
}
