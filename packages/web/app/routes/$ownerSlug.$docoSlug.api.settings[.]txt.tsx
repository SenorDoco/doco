import { getPublicBaseUrl } from "@doco/shared";

export function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const baseUrl = getPublicBaseUrl(request);
  const { ownerSlug, docoSlug } = params;
  const body = render(baseUrl, ownerSlug, docoSlug);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function render(baseUrl: string, owner: string, doco: string): string {
  return `# Doco — Settings (read + patch)

Per-Doco settings endpoint. Two methods:

  GET   ${baseUrl}/${owner}/${doco}/api/settings.json
    Returns the current settings. Read-gated: anonymous on public Docos,
    owner/org-members on private Docos, 404 otherwise.

  POST  ${baseUrl}/${owner}/${doco}/api/settings.json
    (PATCH is also accepted.) Updates fields. Admin-gated (owner or org
    admin). Only the keys you include are touched.

AUTH
  Cookie session OR \`Authorization: Bearer <DOCO_TOKEN>\`. Read returns
  404 if you can't access; write returns 403 if you can read but not
  admin.

BODY (JSON) — write
  slug           optional   new slug (lowercase kebab-case). If different
                            from current, the Doco's directory is moved
                            on disk and the response carries the new slug
                            so you can update bookmarks.
  display_name   optional   string. Empty string clears.
  description    optional   string. Empty string clears.
  visibility     optional   "private" or "public".

SUCCESS RESPONSE — write (HTTP 200, application/json)
  {
    "ok": true,
    "owner_slug": "...",
    "doco_slug": "<possibly-new-slug>",
    "doco_id": "doco_...",
    "display_name": "...",
    "description": "...",
    "visibility": "private" | "public"
  }

ERROR RESPONSE
  { "error": "<reason>" }

  Common errors:
    - HTTP 404 — you can't read this Doco (private + non-member, or doesn't exist).
    - HTTP 403 — you can read it but you're not its owner / org admin.
    - "Doco \\"<owner>/<new>\\" already exists." — pick a different slug.
    - "slug must be lowercase kebab-case ([a-z0-9_-]+)." — fix the name.

EXAMPLE — read current settings
  curl -sS ${baseUrl}/${owner}/${doco}/api/settings.json \\
    -H "Authorization: Bearer $DOCO_TOKEN"

EXAMPLE — flip to public + edit description
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_TOKEN" \\
    ${baseUrl}/${owner}/${doco}/api/settings.json \\
    -d '{ "visibility": "public", "description": "Now open-source." }'

EXAMPLE — rename the slug
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_TOKEN" \\
    ${baseUrl}/${owner}/${doco}/api/settings.json \\
    -d '{ "slug": "renamed-project" }'
  # subsequent requests should use the new URL: /<owner>/renamed-project/...

RELATED
  GET  ${baseUrl}/${owner}/${doco}/status.json    freshness + counts
  POST ${baseUrl}/${owner}/${doco}/api/decisions.json   capture a decision
`;
}
