import { getPublicBaseUrl } from "@doco/shared";
import { normalizeDocoParams } from "~/lib/doco-access.server";

/**
 * Parametrized .txt spec endpoint for the per-Doco capture/settings APIs.
 *
 *   GET /<doco-handle>/api/<type>.txt
 *
 * `type` is one of the capture types, plus primitives and settings.
 * Returns plain-prose spec for the corresponding .json endpoint.
 *
 * Note: primitives (`guidance_primitive`, `neuron_authoring_primitive`)
 * are NOT neurons and do not have per-type capture routes. The dedicated
 * primitives endpoint lives at /<handle>/api/primitives.json and is
 * documented under `primitives` here.
 */

type SpecRenderer = (baseUrl: string, handle: string) => string;

const PRINCIPAL_ID_CONVENTION = `PRINCIPAL ID FIELDS
  API request bodies use principal ids only. Use *_principal_id for one
  principal and *_principal_ids for arrays. Do not send usernames,
  *_username fields, or comma-separated strings; there are no aliases.

  Read responses may expose stored graph fields such as wanted_by,
  actors, stakeholders, actor_id, decided_by, and created_by. When you
  POST or PATCH through this API, use the API-facing principal-id fields
  documented here. For arrays, even one principal is an array:
    "actors_principal_ids": ["principal_01..."]
`;

const SPECS: Record<string, SpecRenderer> = {
  decisions: (baseUrl, handle) => `# Doco — Capture a Decision (single call)

Single POST. Server accepts principal ids, generates the ULID, writes
the row, and reindexes.

ENDPOINT
  POST ${baseUrl}/${handle}/api/decisions.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  question           required   the question the Decision answers
  chosen             required   chosen resolution (multi-line ok)
  summary            optional   one-line summary; derived from chosen if omitted
  alternatives       required   non-empty [{ "name": "...", "rejected_because": "..." }, ...]
  intent_ids         optional   ["intent_01...", ...]; ULID references to Intents
  decided_by_principal_id optional  principal id who made the decision; auth fills this
  created_by_principal_id optional  principal id; defaults to decided_by
  body_md            optional   markdown body appended after the frontmatter
  born_from          optional   reference id (e.g. born_from a bugfix decision)
  lifecycle          optional   one of "drafting" | "proposed" | "active" | "retired"; default "active"
  deprecated         optional   boolean warning label; lifecycle is unchanged
  outcome            optional   "succeeded" | "failed"
  superseded_by      optional   id of the Decision that replaces this one; pair with lifecycle="retired"

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

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    "${baseUrl}/${handle}/api/decisions.json" \\
    -d '{
      "question": "Where should the Doco-created confirmation live?",
      "chosen": "Each creation entry point renders its own success card.",
      "decided_by_principal_id": "principal_01...",
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
    deprecated / outcome / superseded_by
    intent_ids / intent_ids_add / intent_ids_remove
    decided_by_principal_id / born_from

  Response is the same shape as the capture endpoint (ok, id, path,
  footer_lines) plus a \`changed: string[]\` listing the fields
  that actually changed.

RELATED
  GET ${baseUrl}/${handle}/status.json   freshness + counts (footer)
  GET ${baseUrl}/api/v1/agent-bootstrap.json    canonical instructions
`,

  ideas: (baseUrl, handle) => `# Doco — Capture an Idea (single call)

Ideas are lightweight possibilities. They default to drafting and can
later be promoted by linking \`promoted_to\` to the entity they became.

ENDPOINT
  POST ${baseUrl}/${handle}/api/ideas.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  summary             required   one-line idea summary
  body_md             optional   markdown body with context or tradeoffs
  created_by_principal_id optional principal id; auth fills this
  promoted_to         optional   entity id once the idea is picked up
  rejection_reason    optional   why the idea was rejected or parked
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "drafting"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "idea_<ULID>",
    "path": "<postgres>:ideas/idea_<ULID>",
    "footer_lines": ["[🔮 Doco] ✍️ Idea added: [<summary>](<url>)"]
  }

UPDATE AN EXISTING IDEA
  PATCH ${baseUrl}/${handle}/api/ideas/<id>.json
  Content-Type: application/json

  Body fields are all optional:
    summary / body_md / lifecycle / deprecated / outcome
    proposer_id / promoted_to / rejection_reason
`,

  intents: (baseUrl, handle) => `# Doco — Capture an Intent (single call)

Intents are the source of every downstream Decision/Action. Capture an
Intent **before** writing the first Decision that depends on it — that
way the Decision can reference it via \`intent_ids\`.

ENDPOINT
  POST ${baseUrl}/${handle}/api/intents.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  summary             required   "What someone wants" — one-line.
  title               optional   short title (defaults to summary).
  body_md             optional   markdown body — context, non-goals, success criteria.
  wanted_by_principal_id optional principal id who wants this; auth fills this.
  actors_principal_ids optional  principal ids expected to act in the process.
  stakeholders_principal_ids optional principal ids with a say in the outcome.
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "active".
  deprecated          optional   boolean warning label; lifecycle is unchanged.
  outcome             optional   "succeeded" | "failed".

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
      "wanted_by_principal_id": "principal_01...",
      "actors_principal_ids": ["principal_01..."],
      "stakeholders_principal_ids": ["principal_01..."],
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

  actions: (baseUrl, handle) => `# Doco — Capture an Action (single call)

Actions are reusable or completed units of work that serve Intents and
can enact Decisions. They default to lifecycle="retired" and
outcome="succeeded" because a capture usually records work already done.

ENDPOINT
  POST ${baseUrl}/${handle}/api/actions.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  summary             required   one-line summary of what was done
  verb                required   short verb such as "refactor", "migrate", "deploy"
  intent_ids          optional   ["intent_01...", ...]
  decision_ids        optional   ["decision_01...", ...]
  follows             optional   entity ids this action follows causally or chronologically
  inputs              optional   verb-specific input object or value
  outputs             optional   verb-specific output object or value
  actor_principal_id  optional   principal id who performs the action; auth fills this
  created_by_principal_id optional principal id; defaults to actor_principal_id
  body_md             optional   markdown body appended after frontmatter
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "retired"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"; default "succeeded"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "action_<ULID>",
    "path": "docos/<doco-handle>/actions/action_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Action added: [<summary>](<url>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/actions.json \\
    -d '{
      "summary": "Use principal-id fields in the capture API.",
      "verb": "update",
      "actor_principal_id": "principal_01...",
      "intent_ids": ["intent_01..."],
      "outputs": { "commit": "abc123" }
    }'

UPDATE AN EXISTING ACTION
  PATCH ${baseUrl}/${handle}/api/actions/<id>.json
  Content-Type: application/json

  Body fields are all optional. API-facing principal input:
    actor_principal_id -> stored actor_id

  Other patchable fields include summary, lifecycle, deprecated,
  outcome, superseded_by, intent_ids/add/remove, body_md/body_md_append,
  slug, verb, outputs, follows, decision_ids, and performed_at.
`,

  logs: (baseUrl, handle) => `# Doco — Capture a Log (single call)

Logs record concrete happenings: a deploy that ran, a commit that
pushed, or an eval that verified. They are frozen from creation, so
capture the exact event shape up front.

ENDPOINT
  POST ${baseUrl}/${handle}/api/logs.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  summary             required   one-line summary of what happened
  verb                required   past-tense verb such as "pushed", "deployed", "verified"
  happened_at         required   ISO 8601 timestamp
  outputs             required   non-empty object with concrete results
  template_id         optional   Action id this Log instances
  intent_ids          optional   ["intent_01...", ...]
  decision_ids        optional   ["decision_01...", ...]
  follows             optional   entity ids this Log follows
  inputs              optional   event input object or value
  actor_principal_id  optional   principal id who performed it; auth fills this
  created_by_principal_id optional principal id; defaults to actor_principal_id
  body_md             optional   markdown body appended after frontmatter
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "retired"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"; default "succeeded"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "log_<ULID>",
    "path": "docos/<doco-handle>/logs/log_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Log added: [<summary>](<url>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/logs.json \\
    -d '{
      "summary": "Pushed principal-id capture docs.",
      "verb": "pushed",
      "happened_at": "2026-05-23T12:00:00.000Z",
      "actor_principal_id": "principal_01...",
      "outputs": { "branch": "main", "commit": "abc123" }
    }'

UPDATE AN EXISTING LOG
  PATCH ${baseUrl}/${handle}/api/logs/<id>.json
  Content-Type: application/json

  Logs are frozen from creation. In practice, patch lifecycle metadata,
  superseded_by, or additive intent_ids via intent_ids_add. For a
  corrected event body, capture a superseding Log.
`,

  rules: (baseUrl, handle) => `# Doco — Capture a Rule (single call)

Rules state policies or invariants the project should keep true.

ENDPOINT
  POST ${baseUrl}/${handle}/api/rules.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  summary             required   one-line policy summary
  predicate           required   machine-checkable or prose predicate
  intent_ids          optional   ["intent_01...", ...]
  enforced_by         optional   "runtime" | "review" | "manual"
  severity            optional   "hard" | "soft"
  born_from           optional   Decision id this Rule came from
  authored_by_principal_id optional principal id who authored it; auth fills this
  created_by_principal_id  optional principal id; defaults to authored_by_principal_id
  body_md             optional   markdown body appended after frontmatter
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "active"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "rule_<ULID>",
    "path": "docos/<doco-handle>/rules/rule_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Rule added: [<summary>](<url>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/rules.json \\
    -d '{
      "summary": "Capture API requests identify principals by id.",
      "predicate": "POST and PATCH request bodies use *_principal_id fields, never usernames.",
      "authored_by_principal_id": "principal_01...",
      "severity": "hard",
      "enforced_by": "review"
    }'

UPDATE AN EXISTING RULE
  PATCH ${baseUrl}/${handle}/api/rules/<id>.json
  Content-Type: application/json

  Body fields are all optional. Patchable fields include summary,
  lifecycle, deprecated, outcome, superseded_by, intent_ids/add/remove,
  body_md/body_md_append, slug, kind, predicate, modality, severity,
  phase, expected, on_violation, and applies_to.
`,

  evals: (baseUrl, handle) => `# Doco — Capture an Eval (single call)

Evals define checks for behavior, documentation consistency, or process
quality.

ENDPOINT
  POST ${baseUrl}/${handle}/api/evals.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  name                required   short readable name
  criterion           required   { "kind": "exact" | "shape" | "llm-judge", "spec": "..." }
  summary             optional   one-line summary; derived from description/name if omitted
  kind                optional   "unit" | "integration" | "eval" | "process" | "doc-consistency"
  description         optional   free-form description
  expected_status     optional   "pass" | "fail"; default "pass"
  how_to_run          optional   reproduction steps
  input               optional   input value, any JSON shape
  expected            optional   expected outcome, any JSON shape
  target_ref          optional   id of the entity this Eval tests
  intent_ids          optional   ["intent_01...", ...]
  authored_by_principal_id optional principal id who authored it; auth fills this
  body_md             optional   markdown body appended after frontmatter
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "active"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "eval_<ULID>",
    "path": "docos/<doco-handle>/evals/eval_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Eval added: [<name>](<url>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/evals.json \\
    -d '{
      "name": "Intent capture body shape",
      "criterion": {
        "kind": "shape",
        "spec": "Intents use wanted_by_principal_id and actors_principal_ids."
      },
      "authored_by_principal_id": "principal_01..."
    }'

UPDATE AN EXISTING EVAL
  PATCH ${baseUrl}/${handle}/api/evals/<id>.json
  Content-Type: application/json

  Body fields are all optional. Patchable fields include summary,
  lifecycle, deprecated, outcome, superseded_by, intent_ids/add/remove,
  body_md/body_md_append, name, criterion, kind, description,
  expected_status, how_to_run, input, expected, and target_ref.
`,

  references: (baseUrl, handle) => `# Doco — Capture a Reference (single call)

References point to external or repository artifacts such as URLs,
files, commits, documents, and tickets.

ENDPOINT
  POST ${baseUrl}/${handle}/api/references.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  ref_type            required   "file" | "url" | "ticket" | "commit" | "document" | "other"
  locator             required   path, URL, ticket id, commit sha, or other locator
  summary             optional   one-line summary; derived from ref_type/locator if omitted
  body_md             optional   markdown context
  content_hash        optional   content hash when available
  intent_ids          optional   ["intent_01...", ...]
  created_by_principal_id optional principal id; auth fills this
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "active"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "reference_<ULID>",
    "path": "docos/<doco-handle>/references/reference_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Reference added: [<summary>](<url>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/references.json \\
    -d '{
      "ref_type": "file",
      "locator": "packages/web/app/routes/$docoHandle.api.$type[.]txt.tsx",
      "summary": "Plain-text capture API specs",
      "created_by_principal_id": "principal_01..."
    }'

UPDATE AN EXISTING REFERENCE
  PATCH ${baseUrl}/${handle}/api/references/<id>.json
  Content-Type: application/json

  References are frozen from creation. In practice, patch lifecycle
  metadata, superseded_by, or additive intent_ids via intent_ids_add.
  For a corrected locator/body, capture a superseding Reference.
`,

  states: (baseUrl, handle) => `# Doco — Capture a State (single call)

States name meaningful process states such as initial, intermediate, or
terminal conditions.

ENDPOINT
  POST ${baseUrl}/${handle}/api/states.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  summary             required   one-line state name or summary
  kind                required   "initial" | "intermediate" | "terminal"
  invariants          optional   ["condition true while in this state", ...]
  follows             optional   entity ids this state follows
  created_by_principal_id optional principal id; auth fills this
  body_md             optional   markdown body appended after frontmatter
  lifecycle           optional   one of "drafting" | "proposed" | "active" | "retired"; default "active"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "state_<ULID>",
    "path": "docos/<doco-handle>/states/state_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ State added: [<summary>](<url>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/states.json \\
    -d '{
      "summary": "Capture API contract documented",
      "kind": "terminal",
      "created_by_principal_id": "principal_01...",
      "invariants": ["Agents can discover the expected body shape."]
    }'

UPDATE AN EXISTING STATE
  PATCH ${baseUrl}/${handle}/api/states/<id>.json
  Content-Type: application/json

  Body fields are all optional. Patchable fields include summary,
  lifecycle, deprecated, outcome, superseded_by, intent_ids/add/remove,
  body_md/body_md_append, kind, invariants, and follows.
`,

  primitives: (baseUrl, handle) => `# Doco — Primitives

Primitives are **not neurons**. They govern how a Doco is authored,
and they live on a dedicated endpoint — separate from the generic
neuron-capture API.

Two kinds:
  - guidance         contributor-facing prose; not engine-evaluated.
  - neuron_authoring engine-evaluated capture-time checks
                     (deterministic predicate or probabilistic spec).

ENDPOINT (list)
  GET ${baseUrl}/${handle}/api/primitives.json

  Returns every primitive in the Doco, both kinds, with a
  \`primitive_kind\` discriminator:

  {
    "doco_id": "doco_...",
    "doco_handle": "<handle>",
    "count": <int>,
    "guidance_count": <int>,
    "neuron_authoring_count": <int>,
    "items": [
      {
        "primitive_kind": "guidance",
        "id": "guidance_primitive_<ULID>",
        "summary": "...",
        "lifecycle": "active",
        "body_md": "...",
        "created_at": "...",
        "updated_at": "..."
      },
      ...
    ]
  }

ENDPOINT (capture)
  POST ${baseUrl}/${handle}/api/primitives.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

  Body MUST include \`primitive_kind\` to disambiguate; remaining
  fields match the per-kind draft below.

BODY — primitive_kind = "guidance"
  primitive_kind          required   "guidance"
  summary               required   one-line primitive summary
  body_md               optional   markdown primitive body
  authored_by_principal_id optional principal id; auth fills this
  created_by_principal_id  optional principal id; defaults to authored_by_principal_id
  lifecycle             optional   one of "drafting" | "proposed" | "active" | "retired"; default "active"
  deprecated            optional   boolean warning label; lifecycle is unchanged
  outcome               optional   "succeeded" | "failed"

BODY — primitive_kind = "neuron_authoring"
  primitive_kind          required   "neuron_authoring"
  summary               required   one-line primitive summary
  evaluation_kind       required   "deterministic" | "probabilistic"
  predicate             required*  deterministic AuthoringPredicate object
                                  or JSON string. Must not have
                                  kind="probabilistic".
  spec                  required*  probabilistic spec; stored as
                                  {kind:"probabilistic", spec}
  fires_when_neuron_lifecycle optional ["active", ...]
  on_violation          optional   "block" | "warn" | "log"; default "block"
  body_md               optional   markdown primitive body
  authored_by_principal_id optional principal id; auth fills this
  created_by_principal_id  optional principal id; defaults to authored_by_principal_id
  lifecycle             optional   one of "drafting" | "proposed" | "active" | "retired"; default "active"
  deprecated            optional   boolean warning label; lifecycle is unchanged
  outcome               optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201)
  {
    "ok": true,
    "id": "guidance_primitive_<ULID>" | "neuron_authoring_primitive_<ULID>",
    "footer_lines": ["[🔮 Doco] ✍️ ... Primitive added: ..."]
  }

EXAMPLE — guidance
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/primitives.json \\
    -d '{
      "primitive_kind": "guidance",
      "summary": "Prefer concrete examples over abstract prose."
    }'

EXAMPLE — neuron_authoring (deterministic)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/primitives.json \\
    -d '{
      "primitive_kind": "neuron_authoring",
      "summary": "Every Decision cites at least one Intent.",
      "evaluation_kind": "deterministic",
      "predicate": {
        "kind": "requires_synapse",
        "synapse_type": "serves",
        "target_neuron_type": "intent",
        "when_neuron_type": ["decision"]
      }
    }'

EXAMPLE — neuron_authoring (probabilistic)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/primitives.json \\
    -d '{
      "primitive_kind": "neuron_authoring",
      "summary": "Decision rationale names the rejected alternatives.",
      "evaluation_kind": "probabilistic",
      "spec": "Pass when the Decision explains at least one alternative and why it was rejected."
    }'

UPDATE A SPECIFIC PRIMITIVE
  PATCH ${baseUrl}/${handle}/api/guidance_primitives/<id>.json
  PATCH ${baseUrl}/${handle}/api/neuron_authoring_primitives/<id>.json
  Content-Type: application/json

  Per-id endpoints remain available for editing existing primitives.
  Body shape mirrors the relevant capture draft.

RELATED
  GET  ${baseUrl}/${handle}/primitives             HTML view of the primitives
  GET  ${baseUrl}/api/v1/agent-bootstrap.json      bootstrap payload includes primitives
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
  visibility     optional   "private" or "public".

SUCCESS RESPONSE — write (HTTP 200, application/json)
  {
    "ok": true,
    "doco_id": "doco_...",
    "doco_handle": "<possibly-new-handle>",
    "display_name": "...",
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

EXAMPLE — flip to public
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/settings.json \\
    -d '{ "visibility": "public" }'

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
