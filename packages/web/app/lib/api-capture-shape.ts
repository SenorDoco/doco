// Node-shape slim-down (raw-schema phase). Two pure helpers that let the node
// capture/read API speak the row shape directly — `{prose, kind?, attributes}`
// — instead of the per-type translated shape (`{decision, question, …}`).
//
// Kept dependency-free (only types) so they unit-test without dragging the
// route factory's server-only imports (`@vercel/functions`, `@doco/db`, …).
//
// This phase is ADDITIVE: the legacy type-named field still works. A later
// contract phase removes the aliasing once every client/test has moved over.

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
 * Normalize an incoming capture draft so the existing per-type capture
 * functions (which read `draft.<entityType>` for prose and `draft.<field>`
 * for the rest) see what they expect, while clients may POST the raw row
 * shape `{prose, attributes:{…}}`.
 *
 *  - `prose`        → the type-named field, unless that field is already set
 *                     explicitly (an explicit type-named field always wins).
 *  - `attributes`   → its own keys are flattened onto the draft; an explicit
 *                     top-level key always wins over the same key inside
 *                     `attributes`.
 *
 * The `prose` / `attributes` wrapper keys are then removed so they don't leak
 * into the stored `data` jsonb. Mutates and returns the same object.
 */
export function normalizeRawCaptureDraft<T>(draft: T, proseField: string): T {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return draft;
  const d = draft as Record<string, unknown>;

  if (typeof d.prose === "string" && d[proseField] === undefined) {
    d[proseField] = d.prose;
  }

  const attrs = d.attributes;
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
      if (d[k] === undefined) d[k] = v;
    }
  }

  // Return a copy without the `prose` / `attributes` wrapper keys so they
  // don't leak into the stored `data` jsonb.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === "prose" || k === "attributes") continue;
    out[k] = v;
  }
  return out as T;
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
