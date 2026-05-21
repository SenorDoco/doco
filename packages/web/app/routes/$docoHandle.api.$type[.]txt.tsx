import { getPublicBaseUrl } from "@doco/shared";
import { normalizeDocoParams } from "~/lib/doco-access.server";

/**
 * Parametrized .txt spec endpoint for the per-Doco capture/settings APIs.
 *
 *   GET /<doco-handle>/api/<type>.txt
 *
 * `type` is one of: decisions, intents, guidance_articles,
 * node_authoring_articles, scopes, settings.
 * Returns plain-prose spec for the corresponding .json endpoint.
 */

type SpecRenderer = (baseUrl: string, handle: string) => string;

const SPECS: Record<string, SpecRenderer> = {
  decisions: (baseUrl, handle) => `# Doco — Capture a Decision (single call)

Single POST. Server resolves names/usernames to ids, generates the
ULID, writes the file, and reindexes. Replaces the multi-step recon
(find scope ids, find principal ids, generate ULID, write yaml, reindex)
with one request.

ENDPOINT
  POST ${baseUrl}/${handle}/api/decisions.json
  Content-Type: application/json

BODY (JSON)
  question           required   the question the Decision answers
  chosen             required   chosen resolution (multi-line ok)
  scope_names        required   non-empty array of hashtag-shaped scope
                                names (e.g. ["#user-flows", "#framework"])
                                — must match existing scopes on this Doco.
                                Every name starts with "#"; no \`scope_\`
                                prefix.
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
    - "Unknown scope name(s): X. Available in this Doco: ..."  (typo or missing scope; create it at /scopes/new first)
    - "Unknown principal username: ..."                        (typo or not yet registered)
    - "scope_names must be a non-empty array."                 (you owe at least one tag — for user-flow changes, "#user-flows")

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    "${baseUrl}/${handle}/api/decisions.json" \\
    -d '{
      "question": "Where should the Doco-created confirmation live?",
      "chosen": "Each creation entry point renders its own success card; scopes page is purely about scopes.",
      "scope_names": ["#user-flows", "#framework"],
      "decided_by_username": "torrenegra",
      "alternatives": [
        { "name": "Keep the banner on /scopes/new", "rejected_because": "Content belongs to the creation flow, not the next-step page." }
      ]
    }'

WHEN TO CALL THIS
  See the "Before you declare a task done — capture checklist" in the
  canonical instructions. If your turn changed user-facing flow
  (routing, redirects, forms, banner placement, link destinations),
  call this with scope_names including "#user-flows" BEFORE you
  declare the work done. Don't write the YAML by hand — that's what
  this endpoint exists to skip.

UPDATE AN EXISTING DECISION
  PATCH ${baseUrl}/${handle}/api/decisions/<id>.json
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
  scope_names         required   non-empty array.
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
      "scope_names": ["#framework"],
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

  scopes: (baseUrl, handle) => `# Doco — Create a Scope (single call)

Per ADR-137bis every scope-creation call MUST declare whether the new
scope is "watched" — a soft attention signal for contributors. No
silent default on any surface.

A WATCHED scope tells contributors (person or agent): "when capturing
work that touches this topic, scan against this scope and tag the new
node into it." Not enforced at capture time — purely a prompt to think
about the topic. For HARD enforcement ("every node must list this
scope or capture is rejected"), use a \`mandatory_scope\` authoring rule
on the Global scope (your doco's constitution) instead, via the Rules
editor at /scopes/<id>. The two mechanisms are independent.

ENDPOINT
  POST ${baseUrl}/${handle}/api/scopes.json
  Content-Type: application/json

BODY (JSON)
  watched        REQUIRED   boolean. true → contributors should
                            proactively look for opportunities to
                            document into this scope. false → available
                            but no extra attention prompt. Soft signal,
                            not enforcement.
  template_name  optional   install a default template by name. The
                            framework ships two: "#global" (auto-installed
                            on Doco create) and "#user-flows" (opt-in
                            here). The legacy bare forms ("global" /
                            "user-flows") are still accepted as aliases.
                            Mutually exclusive with the custom fields
                            below. The install seeds the template's
                            purpose text onto Scope.purpose, its
                            allowed_node_types onto the row's YAML, and
                            N Rules (one per template rule). No
                            "primary intent" Intent is created.
  name           required*  starts with "#" followed by a lowercase
                            letter, then lowercase letters / digits /
                            hyphens / underscores (e.g. "#payments",
                            "#user-flows"). No slashes (use parent_id).
                            *if template_name is absent.
  purpose        required*  description text rendered under the scope
                            name on every surface (list card, detail
                            page, bootstrap manifest). Replaces the
                            former \`intent_summary\` body parameter
                            *if template_name is absent.
  icon           optional   single emoji.
  parent_id      optional   id of an existing scope to nest this one
                            under.

  Scope creation deliberately does not accept first-rule fields.
  Create the scope first, then add rules with
  \`POST /api/scopes/<scope_id>/rules.json\`.

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "id": "scope_<ULID>",
    "name": "...",
    "purpose": "...",
    "watched": true | false,
    "footer_lines": ["[🔮 Doco] ✍️ Scope added: ... — <icon> <name>", ...]
  }

  Use \`footer_lines\` verbatim in your next user-facing message.

ERROR RESPONSES
  400  Missing/invalid \`watched\`, bad name, unknown template, missing parent,
       or create-time rule fields.
  409  Scope with this name already exists.

EXAMPLE — install the #user-flows template as watched
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/scopes.json \\
    -d '{ "template_name": "#user-flows", "watched": true }'

EXAMPLE — custom scope, not watched, nested under an existing parent
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/scopes.json \\
    -d '{
      "name": "#payments",
      "icon": "💳",
      "purpose": "Anything touching Stripe / billing flows stays visible and consistently documented.",
      "parent_id": "scope_<ULID-of-parent>",
      "watched": false
    }'

WHEN TO CALL THIS
  Whenever you need to add a scope. The protocol's capture triggers
  occasionally name scopes that may not be installed on a given Doco
  ("create the scope at /scopes/new first") — this endpoint is the
  API equivalent of that flow.

HOW AGENTS USE WATCHED SCOPES
  When authoring any new node, fetch /status.json or the bootstrap
  payload, scan the watched scopes (\`is_watched: true\` in the scope
  manifest), and ask: "does my work touch any of these topics?" If
  yes, include that scope in the node's \`scopes\` list. This is a
  soft prompt — not a blocker — and applies to every node type
  (Decision, Intent, Action, Rule, ...).

ADDING RULES IN PLAIN ENGLISH
  Once a scope exists, add rules by POSTing prose plus the caller's
  intended rule kind. Two kinds exist:

    - \`doco-node-authoring\` (preferred) — a capture-gate rule with a
      machine-checkable predicate the framework evaluates against an
      incoming Doco-node POST. The predicate operates on the node
      being captured (its fields, scopes, edges) and rejects the POST
      when it returns false. These rules apply ONLY at capture; they
      do NOT govern agent behavior between captures.
    - \`guidance\` — a reminder the agent surfaces during work; no
      machine enforcement. Workflow conventions, dev policies,
      narration discipline. The vast majority of real-project rules
      are guidance.

  For back-compat, the legacy short alias \`authoring\` is also
  accepted on the wire (the host classifier and storage still use the
  short identifier internally).

    POST ${baseUrl}/${handle}/api/scopes/<scope_id>/rules.json
    Content-Type: application/json
    { "kind": "doco-node-authoring", "prose": "Every Decision should have an Intent." }

  For \`kind: "doco-node-authoring"\` (or legacy \`"authoring"\`), the
  server runs the prose through an LLM classifier that:
    - splits the prose into separate atomic Doco-node-authoring rules,
    - maps each to the most-fitting deterministic predicate
      (requires_edge / forbids_edge / requires_field /
      forbids_field / mandatory_scope) when one fits — these
      block writes at capture time,
    - falls back to {kind: "probabilistic", spec: <verbatim>}
      for prose no deterministic predicate captures — these are
      LLM-judged at capture time and reject the write on a
      no verdict.

  For \`kind: "guidance"\`, the server does not classify or split the
  prose. It saves the submitted prose as one guidance Rule, exactly as
  contributors should read it.

  Response (HTTP 201):
    {
      "added": [
        {
          "id": "rule_<ULID>",
          "bucket": "authoring" | "guidance",
          "summary": "...",
          "url": "${baseUrl}/${handle}/rule/rule_<ULID>",
          "text": "...",
          "rule": { "kind": "...", ... } // authoring only
        }
      ],
      "added_authoring": <count>,
      "added_guidance": <count>,
      "footer_lines": [ "[🔮 Doco] ✍️ Rule added: ...", ... ]
    }

  Rule-creation footer lines link to the created Rule entities. Do not
  describe a Scope footer link as the Rule link; if a response returns
  Rule ids/URLs, use those direct links when explaining where the new
  authoring rule lives.

  Errors:
    400  kind missing/invalid, prose missing/empty, JSON malformed.
    404  scope id not found.
    503  authoring classifier unavailable (host can't reach OpenAI).
         The host's OPENAI_API_KEY is load-bearing for Doco-node-authoring rules —
         failures REJECT the operation rather than silently saving the
         prose as probabilistic.

  Example:
    curl -sS -X POST \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer $DOCO_ACCESS" \\
      ${baseUrl}/${handle}/api/scopes/scope_<ULID>/rules.json \\
      -d '{ "kind": "doco-node-authoring", "prose": "Every Decision should have an Intent, and bugs should link to a Rule." }'

RELATED
  POST ${baseUrl}/${handle}/api/intents.json     capture an Intent
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
