import { getPublicBaseUrl } from "@doco/shared";
import { normalizeDocoParams } from "~/lib/doco-access.server";

/**
 * Parametrized .txt spec endpoint for the per-Doco capture/settings APIs.
 *
 *   GET /<doco-handle>/api/<type>.txt
 *
 * `type` is one of: decisions, intents, guidance_articles,
 * node_authoring_articles, settings.
 * Returns plain-prose spec for the corresponding .json endpoint.
 */

type SpecRenderer = (baseUrl: string, handle: string) => string;

const SPECS: Record<string, SpecRenderer> = {
  decisions: (baseUrl, handle) => `# Doco — Capture a Decision (single call)

Single POST. Server resolves usernames to ids, generates the
ULID, writes the row, and reindexes.

ENDPOINT
  POST ${baseUrl}/${handle}/api/decisions.json
  Content-Type: application/json

BODY (JSON)
  question           required   the question the Decision answers
  chosen             required   chosen resolution (multi-line ok)
  summary            optional   one-line summary; derived from chosen if omitted
  alternatives       required   non-empty [{ "name": "...", "rejected_because": "..." }, ...]
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
    "path": "docos/<doco-handle>/decisions/decision_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ..."],
    "duration_ms": 432
  }

ERROR RESPONSE (HTTP 400 / 404 / 405, application/json)
  { "error": "<reason>" }

  Common errors:
    - "Unknown principal username: ..."  (typo or not yet registered)

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    "${baseUrl}/${handle}/api/decisions.json" \\
    -d '{
      "question": "Where should the Doco-created confirmation live?",
      "chosen": "Each creation entry point renders its own success card.",
      "decided_by_username": "torrenegra",
      "alternatives": [
        { "name": "Keep the banner on the next-step page", "rejected_because": "Content belongs to the creation flow." }
      ]
    }'

WHEN TO CALL THIS
  See the "Before you declare a task done — capture checklist" in the
  canonical instructions. Don't write the YAML by hand — that's what
  this endpoint exists to skip.

UPDATE AN EXISTING DECISION
  PATCH ${baseUrl}/${handle}/api/decisions/<id>.json
  Content-Type: application/json

  Body fields are all optional (only the keys you include are touched):
    summary / question / chosen / alternatives / body_md / lifecycle
    intent_ids / intent_ids_add / intent_ids_remove
    decided_by_username / born_from

  Response is the same shape as the capture endpoint (ok, id, path,
  footer_lines) plus a \`changed: string[]\` listing the fields
  that actually changed.

RELATED
  GET ${baseUrl}/${handle}/status.json   freshness + counts (footer)
  POST /api/v1/agent-bootstrap                  canonical instructions
`,

  intents: (baseUrl, handle) => `# Doco — Capture an Intent (single call)

Intents are the source of every downstream Decision/Action. Capture an
Intent **before** writing the first Decision that depends on it — that
way the Decision can reference it via \`intent_ids\`.

ENDPOINT
  POST ${baseUrl}/${handle}/api/intents.json
  Content-Type: application/json

BODY (JSON)
  summary             required   "What someone wants" — one-line.
  title               optional   short title (defaults to summary).
  body_md             optional   markdown body — context, non-goals, success criteria.
  wanted_by_username  optional   host-level username; resolved to principal id.
  lifecycle           optional   default "active".

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "intent_<ULID>",
    "path": "docos/<doco-handle>/intents/intent_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Intent added: [<summary>](<url>)"]
  }

  Emit each entry of \`footer_lines\` verbatim, one per line.

ERROR RESPONSE
  { "error": "<reason>" }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/intents.json \\
    -d '{
      "summary": "Agent capture friction is bounded to a few seconds end-to-end.",
      "wanted_by_username": "torrenegra",
      "body_md": "Background: writing two ADRs by hand took >5 minutes (70% plumbing). This Intent motivates the single-call capture endpoints."
    }'

WHEN TO CALL THIS
  Before writing a Decision whose motivating Intent doesn't already
  exist on this Doco. The capture checklist (see canonical_instructions)
  treats "no matching Intent" as a missing capture, not a license to
  skip the connection.

RELATED
  POST ${baseUrl}/${handle}/api/decisions.json   capture a Decision
  GET  ${baseUrl}/${handle}/status.json          freshness + counts
`,

  guidance_articles: (baseUrl, handle) => `# Doco — Capture a Guidance Article

Guidance Articles are constitution articles contributors read while
working. They are not evaluated by the capture engine.

ENDPOINT
  POST ${baseUrl}/${handle}/api/guidance_articles.json
  Content-Type: application/json

BODY (JSON)
  summary               required   one-line article summary
  body_md               optional   markdown article body
  authored_by_username  optional   host-level username; auth fills this
  lifecycle             optional   default "active"

SUCCESS RESPONSE (HTTP 201)
  {
    "ok": true,
    "id": "guidance_article_<ULID>",
    "footer_lines": ["[🔮 Doco] ✍️ Guidance Article added: ..."]
  }

RELATED
  GET  ${baseUrl}/${handle}/constitution
  POST ${baseUrl}/${handle}/api/node_authoring_articles.json
`,

  node_authoring_articles: (baseUrl, handle) => `# Doco — Capture a Node Authoring Article

Node Authoring Articles are constitution articles the engine evaluates
when nodes are captured. \`evaluation_kind\` is either deterministic
(structured predicate) or probabilistic (LLM-judged spec).

ENDPOINT
  POST ${baseUrl}/${handle}/api/node_authoring_articles.json
  Content-Type: application/json

BODY (JSON)
  summary               required   one-line article summary
  evaluation_kind       required   "deterministic" | "probabilistic"
  predicate             required*  deterministic AuthoringPredicate object
                                  or JSON string. Must not have
                                  kind="probabilistic".
  spec                  required*  probabilistic spec; stored as
                                  {kind:"probabilistic", spec}
  fires_when_node_lifecycle optional ["active", ...]
  on_violation          optional   "block" | "warn" | "log"; default "block"
  body_md               optional   markdown article body
  authored_by_username  optional   host-level username; auth fills this
  lifecycle             optional   default "active"

SUCCESS RESPONSE (HTTP 201)
  {
    "ok": true,
    "id": "node_authoring_article_<ULID>",
    "footer_lines": ["[🔮 Doco] ✍️ Node Authoring Article added: ..."]
  }

EXAMPLE — deterministic
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/node_authoring_articles.json \\
    -d '{
      "summary": "Every Decision cites at least one Intent.",
      "evaluation_kind": "deterministic",
      "predicate": {
        "kind": "requires_edge",
        "edge_type": "serves",
        "target_node_type": "intent",
        "when_node_type": ["decision"]
      }
    }'

EXAMPLE — probabilistic
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/node_authoring_articles.json \\
    -d '{
      "summary": "Decision rationale names the rejected alternatives.",
      "evaluation_kind": "probabilistic",
      "spec": "Pass when the Decision explains at least one alternative and why it was rejected."
    }'

RELATED
  GET  ${baseUrl}/${handle}/constitution
  POST ${baseUrl}/${handle}/api/guidance_articles.json
`,

  settings: (baseUrl, handle) => `# Doco — Settings (read + patch)

Per-Doco settings endpoint. Two methods:

  GET   ${baseUrl}/${handle}/api/settings.json
    Returns the current settings. Read-gated: anonymous on public docos,
    owner/org-members on private docos, 404 otherwise.

  POST  ${baseUrl}/${handle}/api/settings.json
    (PATCH is also accepted.) Updates fields. Admin-gated (owner or org
    admin). Only the keys you include are touched.

AUTH
  Cookie session OR \`Authorization: Bearer <DOCO_ACCESS>\`. Read returns
  404 if you can't access; write returns 403 if you can read but not
  admin.

BODY (JSON) — write
  handle         optional   new handle (lowercase kebab-case). If different
                            from current, the rename takes effect
                            immediately and the response carries the new
                            handle so you can update bookmarks.
  display_name   optional   string. Empty string clears.
  description    optional   string. Empty string clears.
  visibility     optional   "private" or "public".

SUCCESS RESPONSE — write (HTTP 200, application/json)
  {
    "ok": true,
    "doco_id": "doco_...",
    "doco_handle": "<possibly-new-handle>",
    "display_name": "...",
    "description": "...",
    "visibility": "private" | "public"
  }

ERROR RESPONSE
  { "error": "<reason>" }

  Common errors:
    - HTTP 404 — you can't read this Doco (private + non-member, or doesn't exist).
    - HTTP 403 — you can read it but you're not its owner / org admin.
    - "Doco \\"<handle>\\" already exists." — pick a different handle.
    - "handle must be lowercase kebab-case ([a-z0-9_-]+)." — fix the name.

EXAMPLE — read current settings
  curl -sS ${baseUrl}/${handle}/api/settings.json \\
    -H "Authorization: Bearer $DOCO_ACCESS"

EXAMPLE — flip to public + edit description
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/settings.json \\
    -d '{ "visibility": "public", "description": "Now open-source." }'

EXAMPLE — rename the handle
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/settings.json \\
    -d '{ "handle": "renamed-project" }'
  # subsequent requests should use the new URL: /renamed-project/...

RELATED
  GET  ${baseUrl}/${handle}/status.json    freshness + counts
  POST ${baseUrl}/${handle}/api/decisions.json   capture a decision
`,
};

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; type: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { type } = params;
  const renderer = SPECS[type];
  if (!renderer) {
    return new Response(`Unknown spec: ${type}. Known: ${Object.keys(SPECS).join(", ")}.\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const body = renderer(getPublicBaseUrl(request), handle);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
