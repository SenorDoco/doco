// /by-id/:docoId/* — splat redirect from ID-keyed URL to canonical slug-keyed
// URL. GitHub's `/repositories/{id}/*` plays the same role: agents that
// hold an immortal doco_id never have to track slug changes, and the
// redirect lets them learn the canonical at request time.
//
// Status 308 preserves request method, so POST/PATCH at /by-id/<id>/api/...
// retry cleanly at /<owner>/<slug>/api/... on the same call.
//
// Failure modes are de-conflated: a missing id returns 404 with
// "no Doco with this id exists" guidance, a real-but-private Doco
// returns 403 with "ask the owner for access" guidance. Probing for
// existence isn't a meaningful enumeration attack — ULIDs are 128-bit
// (effectively unguessable), and telling an inaccessible-but-real
// caller to `doco login --create` would fork a duplicate Doco when
// the real one is right there.

import { redirect } from "react-router";
import { getDocoById } from "@doco/db";
import { isEntityType } from "@doco/shared";
import { canAccessDoco } from "~/lib/doco-access.server";
import {
  hostFromRequest,
  missingDocoResponse,
} from "~/lib/missing-doco-guidance.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

// Singular node type → URL plural (matches the `/<owner>/<doco>/api/<plural>/<id>.json` route shape).
// The canonical's POST endpoints already use these plurals, so the JSON-read URL matches.
const TYPE_TO_API_PLURAL: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  rule: "rules",
  action: "actions",
  log: "logs",
  reference: "references",
  scope: "scopes",
  eval: "evals",
};

// Matches a typed ULID, optionally with a file extension. The agent-facing
// short form `/by-id/<doco_id>/<typed_ulid>(.json)?` leans on this: the ULID
// already encodes its type, so the URL stays short even though the slug-form
// destination route demands an explicit type segment.
const TYPED_ULID_RE = /^([a-z]+)_[0-9A-HJKMNP-TV-Z]{26}(?:\.([a-z]+))?$/;

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; "*": string | undefined };
}) {
  const host = hostFromRequest(request);
  const row = await getDocoById(params.docoId);
  if (!row) {
    return missingDocoResponse({
      state: "not_found",
      identifier: params.docoId,
      host,
    });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (
    !await canAccessDoco(
      { ownerId: row.owner_id, visibility: row.visibility, docoId: row.id },
      me?.id ?? null,
    )
  ) {
    return missingDocoResponse({
      state: "no_access",
      identifier: params.docoId,
      host,
    });
  }
  const url = new URL(request.url);
  const prefix = `/by-id/${params.docoId}`;
  const rest = url.pathname.startsWith(`${prefix}/`)
    ? url.pathname.slice(prefix.length + 1)
    : params["*"] ?? "";

  // If the rest is a single segment shaped like a typed ULID
  // (e.g. `decision_01K...` or `decision_01K....json`), inject the
  // segments the slug-form destination route requires. Without this,
  // `/by-id/<doco_id>/decision_01K....json` redirects to
  // `/<owner>/<doco>/decision_01K....json` and the entity route's
  // `$type` guard rejects it as "Unknown type".
  let target: string;
  if (rest.indexOf("/") < 0 && TYPED_ULID_RE.test(rest)) {
    const m = TYPED_ULID_RE.exec(rest)!;
    const [, type, ext] = m;
    const typedId = rest.replace(/\.[a-z]+$/, "");
    if (isEntityType(type)) {
      if (ext === "json") {
        const plural = TYPE_TO_API_PLURAL[type];
        target = plural
          ? `/${row.owner_slug}/${row.doco_slug}/api/${plural}/${typedId}.json${url.search}`
          : `/${row.owner_slug}/${row.doco_slug}/${rest}${url.search}`;
      } else if (!ext) {
        // HTML view — scopes use the plural URL segment per decision_01KRPNZY7W6CCMYNKGND67BP0B.
        const seg = type === "scope" ? "scopes" : type;
        target = `/${row.owner_slug}/${row.doco_slug}/${seg}/${typedId}${url.search}`;
      } else {
        target = `/${row.owner_slug}/${row.doco_slug}/${rest}${url.search}`;
      }
    } else {
      target = `/${row.owner_slug}/${row.doco_slug}/${rest}${url.search}`;
    }
  } else {
    target = `/${row.owner_slug}/${row.doco_slug}${rest ? `/${rest}` : ""}${url.search}`;
  }
  throw redirect(target, { status: 308 });
}

// Action mirrors loader so POST/PATCH/DELETE also redirect.
export const action = loader;
