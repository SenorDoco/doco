// Principal create — the shared core behind BOTH the bespoke
// /<doco>/api/principals.json route AND the generic capture machinery
// (registry → changeset, authoring contract). Principals are a real
// NODE_CATALOG node type (role-personas / process actors), but their body is
// `name` + `body_md` rather than the shared `prose` column, so they get a
// captureFn of their own here instead of a generic one. Same CaptureResult |
// CaptureError contract as every other captureFn, so changeset, the route, and
// the contract all treat principal as just another node type.

import { getDocoById, upsertEntity } from "@doco/db";
import { BLOCKED_NODE_JSON_EDGE_FIELD_SET, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { appendAuditEvent } from "~/lib/audit-log.server";
import { runAuthoringPolicies } from "~/lib/authoring-runner.server";
import {
  type AuthoringWriteContext,
  type CaptureError,
  type CaptureResult,
  appendOperationTiming,
  authoringPoliciesPassed,
  reindexAndScheduleAttach,
} from "~/lib/capture.server";

export interface PrincipalDraft {
  name?: string;
  body_md?: string;
  lifecycle?: string;
  created_by?: string | null;
}

const VALID_PRINCIPAL_LIFECYCLES = new Set(["drafting", "asserted", "retired"]);

function principalLinkLabel(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

// `name (id)` rendered as a markdown link to the principal's perspective view,
// so the agent's pasted footer line becomes a one-click jump instead of a raw
// 30-char ULID.
export function principalFooterLine(
  emoji: string,
  verb: string,
  name: string,
  id: string,
  docoHost: string,
  docoHandle: string,
): string {
  const url = `${docoHost}/${docoHandle}/principal/${id}`;
  return `[🔮 Doco] ${emoji} Principal ${verb}: [${principalLinkLabel(name)}](${url})`;
}

export async function capturePrincipal(
  docoDir: string,
  docoId: string,
  _ownerSlug: string,
  docoSlug: string,
  draft: PrincipalDraft,
  docoHost?: string,
  _authoring?: AuthoringWriteContext,
): Promise<CaptureResult | CaptureError> {
  const startedAt = performance.now();

  for (const [field, value] of Object.entries(draft)) {
    if (field === "created_by") continue; // internal, set by the caller — not a client field
    if (value !== undefined && value !== null && BLOCKED_NODE_JSON_EDGE_FIELD_SET.has(field)) {
      return {
        error: `${field} is not a node JSON field. Create a first-class edge instead.`,
        status: 400,
      };
    }
  }

  const name = String(draft.name ?? "").trim();
  if (!name) return { error: "name is required.", status: 400 };

  // Resolve lifecycle: explicit value wins, then the Doco's template default,
  // then `asserted`. EXCEPTION — business-processes lane actors must be
  // resolvable the moment they're created (active flow policies only accept
  // non-retired/asserted principals), so they ignore a `drafting` template
  // default. (Unchanged from the original route logic.)
  let lifecycle = "asserted";
  if (draft.lifecycle !== undefined) {
    if (typeof draft.lifecycle !== "string" || !VALID_PRINCIPAL_LIFECYCLES.has(draft.lifecycle)) {
      return { error: "lifecycle must be one of: drafting, asserted, retired.", status: 400 };
    }
    lifecycle = draft.lifecycle;
  } else {
    const doco = await getDocoById(docoId);
    const templateHandle =
      typeof doco?.data?.template_handle === "string" ? doco.data.template_handle : null;
    const dflt = doco?.default_node_lifecycle;
    if (templateHandle !== "business-processes" && dflt && VALID_PRINCIPAL_LIFECYCLES.has(dflt)) {
      lifecycle = dflt;
    }
  }

  const id = makeEntityId("principal", generateUlid());
  const now = nowIso();
  const bodyMd = draft.body_md?.trim() || "";
  const createdBy = draft.created_by ?? null;
  const raw = {
    id,
    doco_id: docoId,
    node_type: "principal",
    name,
    body_md: bodyMd,
    created_at: now,
    created_by: createdBy,
    lifecycle,
  };

  const pred = await runAuthoringPolicies({
    docoId,
    candidate: raw as Parameters<typeof runAuthoringPolicies>[0]["candidate"],
  });
  if (pred.blocking) {
    return {
      error: `Authoring policy violation: ${pred.blocking.reason}`,
      status: 422,
      policy_id: pred.blocking.policy_id,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    };
  }

  await upsertEntity({
    id,
    doco_id: docoId,
    entity_type: "principal",
    data: raw,
    body_md: bodyMd,
    lifecycle,
    created_at: now,
    created_by: createdBy,
    updated_at: now,
    updated_by: createdBy,
  });

  await reindexAndScheduleAttach(docoDir, docoId, id);
  appendAuditEvent({
    docoDir,
    docoId,
    by: createdBy,
    entity_type: "principal",
    entity_id: id,
    op: "entity.create",
    after: { name, body_md: bodyMd, lifecycle },
  });

  const duration_ms = Math.round(performance.now() - startedAt);
  const warningFooters = pred.warnings.map((w) => `[🔮 Doco] ⚠️ Authoring warning: ${w.reason}`);
  return {
    ok: true,
    id,
    path: `${docoSlug}/principal/${id}`,
    duration_ms,
    footer_lines: [
      appendOperationTiming(
        principalFooterLine("👤", "added", name, id, docoHost ?? "", docoSlug),
        { duration_ms, authoringPoliciesPassed: authoringPoliciesPassed(pred) },
      ),
      ...warningFooters,
    ],
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  };
}
