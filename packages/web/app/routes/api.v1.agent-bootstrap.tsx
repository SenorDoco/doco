// GET /api/v1/agent-bootstrap[?id=<doco_handle-or-id>] — slim agent bootstrap.
//
// Returns the slim daily-use `canonical_instructions` (~1,200 tokens),
// plus a per-Doco `code_map` and `constitution` (Doco-specific
// load-bearing rules) when `?id=` is provided so the agent jumps
// straight to the right files and knows which rules will block a
// capture before drafting. When `id` is omitted, a bound DOCO_ACCESS
// bearer credential can provide the Doco id.
//
// This endpoint is for REFRESH calls — later sessions re-reading the
// canonical to detect drift. The per-Doco context fields it returns
// (constitution, scopes, onboarding_overlay) are also bundled into
// the POST /api/v1/docos.json and POST /api/v1/invites/<code>/redeem.json
// responses, so first-session agents do not need to call this right
// after redemption. See `lib/agent-bootstrap-response.server.ts` for
// why the post-redeem second-fetch pattern is avoided.
//
// For the long-form reference, fetch `/api/v1/agent-reference`. For
// per-Doco context (scopes, freshness), `/<doco_handle>/status.json`.

import { getDocoByIdOrHandle } from "@doco/db";
import {
  type BootstrapContext,
  type ConstitutionSnapshot,
  loadBootstrapContext,
} from "~/lib/bootstrap-context.server";
import { docoPath, rootDir } from "~/lib/db.server";
import { canAccessDoco } from "~/lib/doco-access.server";
import { etaggedJson } from "~/lib/etag.server";
import { loadHostConfig } from "~/lib/host";
import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";
import {
  type MissingDocoGuidance,
  buildMissingDocoGuidance,
  formatMissingDocoLine,
  hostFromRequest,
} from "~/lib/missing-doco-guidance.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { extractCredential, getCurrentPrincipalAsync } from "~/lib/session";
import { TokenStore } from "~/lib/tokens.server";

// Re-export so callers that previously imported the type from this
// route can keep working.
export type { ConstitutionSnapshot };

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  // Per-Doco context comes from `?id=<doco_id-or-handle>`. The legacy
  // `?slug=<owner>/<doco>` query param was retired with the slug
  // columns (phase 3 of slug-removal). Pin the doco_handle in
  // `doco.md` and pass it as `?id=` — `getDocoByIdOrHandle` accepts
  // both ULIDs and handles.
  let id = (url.searchParams.get("id") ?? "").trim();
  if (!id) {
    const credential = extractCredential(request);
    if (credential) {
      const session = await TokenStore.forDoco(rootDir()).resolve(credential);
      id = session?.bound_doco_id ?? "";
    }
  }
  const host = hostFromRequest(request);
  let context: BootstrapContext = {
    constitution: null,
    scopes: [],
    onboarding_overlay: null,
  };
  let docoIdPath: string | null = null;
  let docoHandlePath: string | null = null;
  let warning: string | null = null;
  let missingDocoGuidance: MissingDocoGuidance | null = null;

  // When the caller's id/slug doesn't resolve (or resolves to a Doco
  // they can't access) we set `missingDocoGuidance` to the structured
  // recovery actions and mirror its single-line summary into `warning`
  // for older clients that only read the warning string. Three states
  // collapse into two recovery shapes: not_found (typo / never
  // created) and no_access (exists, wrong credentials).
  function flagMissing(state: "not_found" | "no_access", identifier: string) {
    missingDocoGuidance = buildMissingDocoGuidance({ state, identifier, host });
    warning = formatMissingDocoLine(missingDocoGuidance);
  }

  if (id) {
    const row = await getDocoByIdOrHandle(id);
    if (!row) {
      flagMissing("not_found", id);
    } else {
      const dir = docoPath(row.handle);
      const meta = await readDocoMetadata(dir);
      if (!meta) {
        flagMissing("not_found", id);
      } else {
        // Apply the same privacy gate the per-Doco data routes use,
        // so bootstrap can't quietly report scopes/code_map for a
        // Doco the caller will then 404 on at search.json /
        // api/*.json. The previous gap was a misleading-success
        // signal — bootstrap said yes while data routes said no.
        const me = await getCurrentPrincipalAsync(request);
        if (!(await canAccessDoco(meta, me?.id ?? null))) {
          flagMissing("no_access", id);
        } else {
          const reqUrl = new URL(request.url);
          const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
          context = await loadBootstrapContext({
            docoDir: dir,
            docoId: meta.docoId,
            handle: row.handle,
            baseUrl,
          });
          docoIdPath = row.id;
          docoHandlePath = row.handle;
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
    doco_id: docoIdPath,
    /** Public, globally-unique URL identifier — what `doco.md` pins
     *  and what every Doco URL is built from. */
    doco_handle: docoHandlePath,
    // code_map.yaml is gone (alpha forbids back-compat); keep the
    // field in the response for client compatibility.
    code_map: null,
    constitution: context.constitution,
    scopes: context.scopes,
    onboarding_overlay: context.onboarding_overlay,
    warning,
    missing_doco_guidance: missingDocoGuidance,
    note: "Slim bootstrap. For deep reference fetch /api/v1/agent-reference. For per-Doco status, call /<doco_handle>/status.json. Pass ?id=<doco_id> to receive `code_map` + `constitution` (Doco-specific load-bearing rules enforced at capture time) + `scopes` (active/proposed manifest entries only; abandoned scopes are omitted). When `onboarding_overlay` is non-null the Doco has only the Constitution scope — run STEP 1 (scope_setup) and STEP 2 (scope_population) before treating onboarding as done; the overlay disappears the moment the project owner accepts a first project-specific scope. The same per-Doco context fields are bundled into POST /api/v1/docos.json and POST /api/v1/invites/<code>/redeem.json so first-session agents do not need to call this right after redemption. When `missing_doco_guidance` is non-null the caller's id/handle didn't resolve OR resolved to a Doco they can't access — read the structured `actions` to pick the right recovery (create vs ask-for-access). `warning` carries a single-line version of the same.",
  });
}
