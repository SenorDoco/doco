// GET /api/v1/agent-bootstrap[?slug=<owner>/<doco>] — slim agent bootstrap.
//
// Returns the slim daily-use `canonical_instructions` (~1,200 tokens),
// plus a per-Doco `code_map` and `constitution` (Doco-specific
// load-bearing rules) when `?slug=` is provided so the agent jumps
// straight to the right files and knows which rules will block a
// capture before drafting.
//
// For the long-form reference, fetch `/api/v1/agent-reference`. For
// per-Doco context (scopes, lint, freshness), `/<owner>/<doco>/status.json`.

import { CANONICAL_INSTRUCTIONS } from "@doco/api";
import type { ScopeRule } from "@doco/shared";
import { getDocoById, listEntitiesByDoco } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { canAccessDoco } from "~/lib/doco-access.server";
import { resolveDocoSlugAlias } from "~/lib/doco-aliases.server";
import { etaggedJson } from "~/lib/etag.server";
import { loadHostConfig } from "~/lib/host";
import {
  listScopeManifest,
  readDocoMetadata,
  type ScopeManifestEntry,
} from "~/lib/scope-helpers.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

/**
 * Shape of the Constitution scope as exposed to agents on the bootstrap.
 */
export interface ConstitutionSnapshot {
  id: string;
  name: string;
  icon: string | null;
  purpose: string;
  guidelines: string;
  rules: ScopeRule[];
}

/**
 * Read the Constitution scope from Postgres (`scopes` table). Returns
 * null when no Constitution scope exists (fresh Docos pre-seed).
 * Filesystem walk of `<doco>/scopes/*.yaml` is gone
 * (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
 */
async function loadConstitution(docoId: string): Promise<ConstitutionSnapshot | null> {
  const rows = await listEntitiesByDoco("scope", docoId);
  for (const r of rows) {
    if (r.name !== "constitution") continue;
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(r.raw_yaml) as Record<string, unknown>;
    } catch {}
    return {
      id: r.id,
      name: r.name,
      icon: typeof fm.icon === "string" ? fm.icon : null,
      purpose: typeof fm.purpose === "string" ? fm.purpose : "",
      guidelines: typeof fm.guidelines === "string" ? fm.guidelines : "",
      rules: Array.isArray(fm.rules) ? (fm.rules as ScopeRule[]) : [],
    };
  }
  return null;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("slug") ?? "").trim();
  const id = (url.searchParams.get("id") ?? "").trim();
  let codeMap: unknown | null = null;
  let constitution: ConstitutionSnapshot | null = null;
  let scopes: ScopeManifestEntry[] = [];
  let docoSlugPath: string | null = null;
  let docoIdPath: string | null = null;
  let warning: string | null = null;

  // Accept either `?slug=<owner>/<doco>` or `?id=doco_<ulid>`. The ID
  // is immortal across renames; agents that want a stable identifier
  // pin to it instead of the slug. If both are supplied, ID wins.
  let effectiveOwner: string | null = null;
  let effectiveDoco: string | null = null;
  let effectiveDocoId: string | null = null;
  if (id) {
    const row = await getDocoById(id);
    if (!row) {
      warning = `Doco id "${id}" doesn't resolve to a Doco on this host.`;
    } else {
      effectiveOwner = row.owner_slug;
      effectiveDoco = row.doco_slug;
      effectiveDocoId = row.id;
    }
  } else if (slug && slug.includes("/")) {
    const [reqOwner, reqDoco] = slug.split("/", 2);
    if (reqOwner && reqDoco) {
      effectiveOwner = reqOwner;
      effectiveDoco = reqDoco;
    }
  }

  if (effectiveOwner && effectiveDoco && !warning) {
    // Resolve slug aliases (D-019: renames leave the old slug as an
    // alias to the canonical current one). When the caller used
    // `?id=`, the slug is already canonical — the resolver returns
    // `redirected: false` and this is a no-op.
    const resolved = resolveDocoSlugAlias(effectiveOwner, effectiveDoco);
    if (!resolved) {
      warning = `Slug "${effectiveOwner}/${effectiveDoco}" doesn't resolve to a Doco on this host. Check DOCO_SLUG in .env.`;
    } else {
      const dir = docoPath(resolved.ownerSlug, resolved.docoSlug);
      const meta = readDocoMetadata(dir);
      if (!meta) {
        warning = `Doco "${effectiveOwner}/${effectiveDoco}" not found.`;
      } else {
        // Apply the same privacy gate the per-Doco data routes use,
        // so bootstrap can't quietly report scopes/code_map for a
        // Doco the caller will then 404 on at search.json /
        // api/*.json. The previous gap was a misleading-success
        // signal — bootstrap said yes while data routes said no.
        const me = await getCurrentPrincipalAsync(request);
        if (!await canAccessDoco(meta, me?.id ?? null)) {
          warning = `Doco "${effectiveOwner}/${effectiveDoco}" exists but isn't accessible with the supplied credentials. The bearer token resolves to a principal that isn't the Doco's owner or a member of the owning org.`;
        } else {
          // code_map.yaml is gone (alpha forbids back-compat); keep
          // the field in the response for client compatibility.
          codeMap = null;
          constitution = await loadConstitution(meta.docoId);
          scopes = await listScopeManifest(dir);
          docoSlugPath = `${resolved.ownerSlug}/${resolved.docoSlug}`;
          docoIdPath = effectiveDocoId ?? meta.docoId;
          if (resolved.redirected) {
            warning = `Slug "${effectiveOwner}/${effectiveDoco}" is an alias for "${docoSlugPath}". Update DOCO_SLUG in .env to silence this notice.`;
          }
        }
      }
    }
  }

  return etaggedJson(request, {
    canonical_instructions: CANONICAL_INSTRUCTIONS,
    reference_url: "/api/v1/agent-reference",
    host: {
      name: (await loadHostConfig()).name,
      mode: "host",
    },
    doco_slug: docoSlugPath,
    doco_id: docoIdPath,
    code_map: codeMap,
    constitution,
    scopes,
    warning,
    note:
      "Slim bootstrap. For deep reference fetch /api/v1/agent-reference. For per-Doco lint/status, call $DOCO_HOST/<owner>/<doco>/status.json. Pass ?slug=<owner>/<doco> to receive `code_map` + `constitution` (Doco-specific load-bearing rules enforced at capture time) + `scopes` (manifest with mandatory vs optional flag).",
  });
}
