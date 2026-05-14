import { getPublicBaseUrl } from "@doco/shared";

/**
 * /<owner>/<doco>/api/decisions.txt — plain-prose spec for the
 * single-call Decision capture endpoint. Sibling of decisions.json.
 */
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
  return `# Doco — Capture a Decision (single call)

Single POST. Server resolves names/usernames to ids, generates the
ULID, writes the file, and reindexes. Replaces the multi-step recon
(find scope ids, find principal ids, generate ULID, write yaml, reindex)
with one request.

ENDPOINT
  POST ${baseUrl}/${owner}/${doco}/api/decisions.json
  Content-Type: application/json

BODY (JSON)
  question           required   the question the Decision answers
  chosen             required   chosen resolution (multi-line ok)
  scope_names        required   non-empty array of bare scope names (e.g.
                                ["user-flows", "framework"]) — must match
                                existing scopes on this Doco. Bare names;
                                no \`scope_\` prefix.
  summary            optional   one-line summary; derived from chosen if omitted
  alternatives       optional   [{ "name": "...", "rejected_because": "..." }, ...]
  intent_ids         optional   ["intent_01...", ...]; ULID references to Intents
  decided_by_username optional  host-level username; resolved to principal id
  created_by_id      optional   principal id; defaults to decided_by
  body_md            optional   markdown body appended after the frontmatter
  born_from          optional   reference id (e.g. born_from a bugfix decision)
  lifecycle          optional   default "active"

  Note: Projects that want ADR-style identifiers can mention them in
  the summary or body_md. The framework provides no native ADR field.

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "decision_<ULID>",
    "path": "docos/<owner>/<doco>/decisions/decision_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ..."],
    "duration_ms": 432
  }

ERROR RESPONSE (HTTP 400 / 404 / 405, application/json)
  { "error": "<reason>" }

  Common errors:
    - "Unknown scope name(s): X. Available in this Doco: ..."  (typo or missing scope; create it at /scopes/new first)
    - "Unknown principal username: ..."                        (typo or not yet registered)
    - "scope_names must be a non-empty array."                 (you owe at least one tag — for user-flow changes, "user-flows")

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    "${baseUrl}/${owner}/${doco}/api/decisions.json" \\
    -d '{
      "question": "Where should the Doco-created confirmation live?",
      "chosen": "Each creation entry point renders its own success card; scopes page is purely about scopes.",
      "scope_names": ["user-flows", "framework"],
      "decided_by_username": "torrenegra",
      "alternatives": [
        { "name": "Keep the banner on /scopes/new", "rejected_because": "Content belongs to the creation flow, not the next-step page." }
      ]
    }'

WHEN TO CALL THIS
  See the "Before you declare a task done — capture checklist" in the
  canonical instructions. If your turn changed user-facing flow
  (routing, redirects, forms, banner placement, link destinations),
  call this with scope_names including "user-flows" BEFORE you
  declare the work done. Don't write the YAML by hand — that's what
  this endpoint exists to skip.

UPDATE AN EXISTING DECISION
  PATCH ${baseUrl}/${owner}/${doco}/api/decisions/<id>.json
  Content-Type: application/json

  Body fields are all optional (only the keys you include are touched):
    summary / question / chosen / alternatives / body_md / lifecycle
    scope_names / scope_names_add / scope_names_remove
    intent_ids / intent_ids_add / intent_ids_remove
    decided_by_username / born_from

  Response is the same shape as the capture endpoint (ok, id, path,
  footer_lines) plus a \`changed: string[]\` listing the fields
  that actually changed.

RELATED
  GET ${baseUrl}/${owner}/${doco}/status.json   freshness + counts (footer)
  POST /api/v1/agent-bootstrap                  canonical instructions
`;
}
