import { getPublicBaseUrl } from "@doco/shared";
import { normalizeDocoParams } from "~/lib/doco-access.server";

/**
 * Parametrized .txt spec endpoint for the per-Doco capture/settings APIs.
 *
 *   GET /<doco-handle>/api/<type>.txt
 *
 * `type` is one of the capture types, plus policies and settings.
 * Returns plain-prose spec for the corresponding .json endpoint.
 *
 * Note: policies (`guidance_policy`, `neuron_authoring_policy`)
 * are NOT neurons and do not have per-type capture routes. The dedicated
 * policies endpoint lives at /<handle>/api/policies.json and is
 * documented under `policies` here.
 */

type SpecRenderer = (baseUrl: string, handle: string) => string;

const PRINCIPAL_ID_CONVENTION = `PRINCIPAL ID FIELDS
  API request bodies use principal ids only. Use *_principal_id for one
  principal and *_principal_ids for arrays. Do not send principal names,
  *_name fields, or comma-separated strings; there are no aliases.

  Read responses may expose stored graph fields such as wanted_by,
  actors, stakeholders, actor_id, and decided_by. created_by is
  user/API-key provenance derived from the authenticated session
  or token. Never send created_by; use the API-facing principal-id fields
  documented here only for domain actors. For arrays, even one principal
  is an array:
    "actors_principal_ids": ["principal_01..."]

  LIFECYCLE NOTE
  The lifecycle value "active" was renamed to "accepted". "active" is
  still accepted on input as a deprecated alias (coerced to "accepted")
  for one release; prefer "accepted" in new clients.
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
  decision           required   full prose of the decision — narrative,
                                  chosen path, why, multi-line ok.
  question           required   the question the Decision answers
  chosen             required   chosen resolution (multi-line ok)
  alternatives       required   non-empty [{ "name": "...", "rejected_because": "..." }, ...]
  intent_ids         optional   ["intent_01...", ...]; ULID references to Intents
  sequence_to        optional   BPMN forward flow targets: ["action_01..."] or
                                  [{ "target": "action_01...", "label": "Yes" }]
  decided_by_principal_id optional  principal id who made the decision; auth fills this
  born_from          optional   reference id (e.g. born_from a bugfix decision)
  lifecycle          optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted"
  deprecated         optional   boolean warning label; lifecycle is unchanged
  outcome            optional   "succeeded" | "failed"
  superseded_by      optional   id of the Decision that replaces this one; pair with lifecycle="retired"

  Note: Projects that want ADR-style identifiers can mention them in
  the decision text. The framework provides no native ADR field.

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "decision_<ULID>",
    "path": "docos/<doco-handle>/decisions/decision_<ULID>.md",
    "footer_lines": ["[🔮 Doco] <icon> <action>: [<Neuron>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"],
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
    decision / question / chosen / alternatives / lifecycle
    deprecated / outcome / superseded_by
    intent_ids / intent_ids_add / intent_ids_remove / sequence_to
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
  idea                required   full prose: the idea, context, tradeoffs
  promoted_to         optional   entity id once the idea is picked up
  rejection_reason    optional   why the idea was rejected or parked
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "drafting"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "idea_<ULID>",
    "path": "<postgres>:ideas/idea_<ULID>",
    "footer_lines": ["[🔮 Doco] ✍️ Idea added: [<first-line-of-idea>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

UPDATE AN EXISTING IDEA
  PATCH ${baseUrl}/${handle}/api/ideas/<id>.json
  Content-Type: application/json

  Body fields are all optional:
    idea / lifecycle / deprecated / outcome
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
  intent              required   full prose: what someone wants, why, success criteria.
  wanted_by_principal_id optional principal id who wants this; auth fills this.
  actors_principal_ids optional  principal ids expected to act in the process.
  stakeholders_principal_ids optional principal ids with a say in the outcome.
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted".
  deprecated          optional   boolean warning label; lifecycle is unchanged.
  outcome             optional   "succeeded" | "failed".

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "intent_<ULID>",
    "path": "docos/<doco-handle>/intents/intent_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Intent added: [<first-line-of-intent>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
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
      "intent": "Agent capture friction is bounded to a few seconds end-to-end.\\n\\nBackground: writing two ADRs by hand took >5 minutes (70% plumbing). This Intent motivates the single-call capture endpoints.",
      "wanted_by_principal_id": "principal_01...",
      "actors_principal_ids": ["principal_01..."],
      "stakeholders_principal_ids": ["principal_01..."]
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
  action              required   full prose: past-tense verb phrase describing what was done + context
  verb                required   short verb such as "refactor", "migrate", "deploy"
  intent_ids          optional   ["intent_01...", ...]
  decision_ids        optional   ["decision_01...", ...]
  preceded_by         optional   entity ids that precede this action (causally or chronologically)
  sequence_to         optional   BPMN forward flow targets: ["action_01..."] or
                                  [{ "target": "decision_01...", "label": "complete" }]
  gated_by            optional   ["rule_01...", ...] rule ids that gate this action (BPMN-style policy guards)
  inputs              optional   verb-specific input object or value
  outputs             optional   verb-specific output object or value
  actor_principal_id  optional   principal id who performs the action; auth fills this
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "retired"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"; default "succeeded"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "action_<ULID>",
    "path": "docos/<doco-handle>/actions/action_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Action added: [<first-line-of-action>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/actions.json \\
    -d '{
      "action": "Use principal-id fields in the capture API.",
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

  Other patchable fields include action, lifecycle, deprecated,
  outcome, superseded_by, intent_ids/add/remove, verb,
  outputs, preceded_by, sequence_to, decision_ids, and performed_at.
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
  log                 required   full prose: what happened, when, in what state
  verb                required   past-tense verb such as "pushed", "deployed", "verified"
  happened_at         required   ISO 8601 timestamp
  outputs             required   non-empty object with concrete results
  template_id         optional   Action id this Log instances
  intent_ids          optional   ["intent_01...", ...]
  decision_ids        optional   ["decision_01...", ...]
  preceded_by         optional   entity ids that precede this Log
  inputs              optional   event input object or value
  actor_principal_id  optional   principal id who performed it; auth fills this
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "retired"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"; default "succeeded"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "log_<ULID>",
    "path": "docos/<doco-handle>/logs/log_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Log added: [<first-line-of-log>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/logs.json \\
    -d '{
      "log": "Pushed principal-id capture docs.",
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
  rule                required   full prose: the rule statement, rationale, scope, exceptions
  predicate           required   machine-checkable or prose predicate
  intent_ids          optional   ["intent_01...", ...]
  enforced_by         optional   "runtime" | "review" | "manual"
  severity            optional   "hard" | "soft"
  born_from           optional   Decision id this Rule came from
  authored_by_principal_id optional principal id who authored it; auth fills this
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "rule_<ULID>",
    "path": "docos/<doco-handle>/rules/rule_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Rule added: [<first-line-of-rule>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/rules.json \\
    -d '{
      "rule": "Capture API requests identify principals by id.",
      "predicate": "POST and PATCH request bodies use *_principal_id fields, never usernames.",
      "authored_by_principal_id": "principal_01...",
      "severity": "hard",
      "enforced_by": "review"
    }'

UPDATE AN EXISTING RULE
  PATCH ${baseUrl}/${handle}/api/rules/<id>.json
  Content-Type: application/json

  Body fields are all optional. Patchable fields include rule,
  lifecycle, deprecated, outcome, superseded_by, intent_ids/add/remove,
  kind, predicate, modality, severity, phase, expected,
  on_violation, and applies_to.
`,

  evals: (baseUrl, handle) => `# Doco — Capture an Eval (single call)

Evals define checks for behavior, documentation consistency, or process
quality.

ENDPOINT
  POST ${baseUrl}/${handle}/api/evals.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  eval                required   full prose: what's being checked, plus rationale
  criterion           required   { "kind": "exact" | "shape" | "llm-judge", "spec": "..." }
  kind                optional   "unit" | "integration" | "eval" | "process" | "doc-consistency"
  expected_status     optional   "pass" | "fail"; default "pass"
  how_to_run          optional   reproduction steps
  input               optional   input value, any JSON shape
  expected            optional   expected outcome, any JSON shape
  target_ref          optional   id of the entity this Eval tests
  intent_ids          optional   ["intent_01...", ...]
  authored_by_principal_id optional principal id who authored it; auth fills this
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "eval_<ULID>",
    "path": "docos/<doco-handle>/evals/eval_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Eval added: [<first-line-of-eval>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/evals.json \\
    -d '{
      "eval": "Intent capture body shape — verify intents accept the new fields.",
      "criterion": {
        "kind": "shape",
        "spec": "Intents use wanted_by_principal_id and actors_principal_ids."
      },
      "authored_by_principal_id": "principal_01..."
    }'

UPDATE AN EXISTING EVAL
  PATCH ${baseUrl}/${handle}/api/evals/<id>.json
  Content-Type: application/json

  Body fields are all optional. Patchable fields include eval,
  lifecycle, deprecated, outcome, superseded_by, intent_ids/add/remove,
  criterion, kind, expected_status, how_to_run, input, expected, and
  target_ref.
`,

  references: (baseUrl, handle) => `# Doco — Capture a Reference (single call)

References point to external or repository artifacts such as URLs,
files, commits, documents, and tickets.

ENDPOINT
  POST ${baseUrl}/${handle}/api/references.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

BODY (JSON)
  reference           required   full prose: human-readable label for the external thing
  ref_type            required   "file" | "url" | "ticket" | "commit" | "document" | "other"
  locator             required   path, URL, ticket id, commit sha, or other locator
  content_hash        optional   content hash when available
  intent_ids          optional   ["intent_01...", ...]
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "reference_<ULID>",
    "path": "docos/<doco-handle>/references/reference_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Reference added: [<first-line-of-reference>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/references.json \\
    -d '{
      "reference": "Plain-text capture API specs",
      "ref_type": "file",
      "locator": "packages/web/app/routes/$docoHandle.api.$type[.]txt.tsx"
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
  state               required   full prose: state description, invariants explained
  kind                required   "initial" | "intermediate" | "terminal"
  intent_ids          optional   ["intent_01...", ...]
  invariants          optional   ["condition true while in this state", ...]
  preceded_by         optional   entity ids that precede this state
  sequence_to         optional   BPMN forward flow targets: ["action_01..."] or
                                  [{ "target": "action_01...", "label": "start" }]
  lifecycle           optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted"
  deprecated          optional   boolean warning label; lifecycle is unchanged
  outcome             optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "state_<ULID>",
    "path": "docos/<doco-handle>/states/state_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ State added: [<first-line-of-state>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/states.json \\
    -d '{
      "state": "Capture API contract documented",
      "kind": "terminal",
      "invariants": ["Agents can discover the expected body shape."]
    }'

UPDATE AN EXISTING STATE
  PATCH ${baseUrl}/${handle}/api/states/<id>.json
  Content-Type: application/json

  Body fields are all optional. Patchable fields include state,
  lifecycle, deprecated, outcome, superseded_by, intent_ids/add/remove,
  kind, invariants, preceded_by, and sequence_to.
`,

  principals: (baseUrl, handle) => `# Doco — Principals (create, edit, retire)

Principals are the role-personas a Doco references via Action.actor_id,
Intent.actors[], Decision.decided_by, etc. Principals are *records*
per the "frozen claims, mutable records" Decision — descriptive fields
stay editable across the lifecycle. \`name\` is a display label; other
neurons reference Principals by id.

CREATE
  POST ${baseUrl}/${handle}/api/principals.json
  Content-Type: application/json

BODY (JSON)
  name                required   display name for the Principal. Stored
                                  after trimming surrounding whitespace;
                                  not required to be slug-shaped or unique.
  body_md             optional   markdown body — the only narrative field
                                  on a Principal post-migration 037
                                  (\`summary\` was dropped). Defaults to
                                  empty.
                                  The org-chart template expects person-
                                  vs-agent to be declared here in prose
                                  ("Operates under: @alice", "Autonomous
                                  research agent", "Human director of …");
                                  the org-tree perspective infers the icon
                                  from these signals.
  reports_to          optional   principal id (principal_<ULID>) of the
                                  manager. Materializes a \`reports_to\`
                                  synapse — used by the \`org-chart\`
                                  template to build the reporting tree.
                                  Omit for top-of-chain Principals.

SUCCESS RESPONSE — create (HTTP 201, application/json)
  {
    "ok": true,
    "id": "principal_<ULID>",
    "name": "<name>",
    "existed": false,
    "footer_lines": ["[🔮 Doco] 👤 Principal added: [<name>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

ERROR RESPONSES
  HTTP 400  missing name or invalid reports_to
  HTTP 401  authentication required
  HTTP 403  author role required
  HTTP 422  authoring policy violation (e.g. org-chart template
            requires body_md to declare person vs agent)

EXAMPLE — create
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/principals.json \\
    -d '{
      "name": "alice",
      "body_md": "Human director of engineering. Owns roadmap planning and hiring for the engineering org.",
      "reports_to": "principal_01HTOP..."
    }'

EDIT
  PATCH ${baseUrl}/${handle}/api/principals/<id>.json
  Content-Type: application/json

  Update descriptive fields and rewire reporting in place. \`name\` is
  the only field that can't be patched. Pass \`reports_to: null\` to
  clear the manager (make this Principal top-of-chain).

BODY (JSON) — at least one field required
  body_md             optional   markdown body. Replaces \`summary\`
                                  (dropped by migration 037) — the only
                                  narrative field on a Principal.
  reports_to          optional   principal id, or \`null\` to clear.
                                  Must reference a Principal in this
                                  Doco; self-reference is rejected.
  lifecycle           optional   only "retired" accepted; see RETIRE.

SUCCESS RESPONSE — edit (HTTP 200, application/json)
  {
    "ok": true,
    "id": "principal_<ULID>",
    "lifecycle": "accepted",
    "footer_lines": ["[🔮 Doco] 👤 Principal updated: [<name>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

ERROR RESPONSES
  HTTP 400  empty body, unknown/immutable field (e.g. \`name\`),
            invalid \`type\`, invalid \`reports_to\` shape, self-
            reference, or missing manager Principal in this Doco
  HTTP 401  authentication required
  HTTP 403  author role required
  HTTP 404  principal not found in this Doco
  HTTP 422  authoring policy violation

EXAMPLE — edit
  curl -sS -X PATCH \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/principals/principal_01...json \\
    -d '{ "body_md": "Updated bio prose.", "reports_to": "principal_01HTOP..." }'

RETIRE
  PATCH ${baseUrl}/${handle}/api/principals/<id>.json
  Content-Type: application/json

  Retirement is a one-way lifecycle transition with an active-references
  guard: a Principal still referenced by an active Action, Log, or
  Intent can't be retired until those neurons are retired or superseded.

BODY (JSON)
  lifecycle           required   must be the literal string "retired".
                                  Combine with other patchable fields
                                  to edit + retire in one request.

SUCCESS RESPONSE — retire (HTTP 200, application/json)
  {
    "ok": true,
    "id": "principal_<ULID>",
    "lifecycle": "retired",
    "footer_lines": ["[🔮 Doco] 👤 Principal retired: [<name>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

SUCCESS RESPONSE — already retired (HTTP 200, idempotent)
  {
    "ok": true,
    "id": "principal_<ULID>",
    "already_retired": true,
    "footer_lines": ["[🔮 Doco] 👤 Principal already retired: [<name>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

ERROR RESPONSES
  HTTP 400  lifecycle value other than "retired"
  HTTP 401  authentication required
  HTTP 403  author role required
  HTTP 404  principal not found in this Doco
  HTTP 409  active neurons still reference this principal — retire or
            supersede those first. Response body:
            {
              "error": "Cannot retire principal: active neurons still reference it. …",
              "active_references": [
                { "id": "action_<ULID>", "neuron_type": "action",
                  "summary": "…", "synapse_type": "performed_by" },
                ...
              ]
            }

EXAMPLE — retire
  curl -sS -X PATCH \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/principals/principal_01...json \\
    -d '{ "lifecycle": "retired" }'

LIST / READ
  GET ${baseUrl}/${handle}/api/principals.json
  GET ${baseUrl}/${handle}/api/principals/<id>.json

  The list response returns two arrays:
    - "principals" / "users" — OAuth users on this Doco
      (humans + agents with a role grant). Legacy field name is
      "principals"; "users" is the clearer alias.
    - "principal_neurons" — actual Principal neurons in this Doco
      (what swim-lane / BPMN / org-tree views render). Mutate these
      via the create + edit + retire endpoints above.

RELATED
  POST ${baseUrl}/${handle}/api/intents.json   actors_principal_ids points at principal ids
  POST ${baseUrl}/${handle}/api/actions.json   actor_principal_id points at a principal id
`,

  policies: (baseUrl, handle) => `# Doco — Policies

Policies are **not neurons**. They govern how a Doco is authored,
and they live on a dedicated endpoint — separate from the generic
neuron-capture API.

Two kinds:
  - guidance         contributor-facing prose; not engine-evaluated.
  - neuron_authoring engine-evaluated capture-time checks
                     (deterministic predicate or probabilistic spec).

ENDPOINT (list)
  GET ${baseUrl}/${handle}/api/policies.json

  Returns every policy in the Doco, both kinds, with a
  \`policy_kind\` discriminator:

  {
    "doco_id": "doco_...",
    "doco_handle": "<handle>",
    "count": <int>,
    "guidance_count": <int>,
    "neuron_authoring_count": <int>,
    "items": [
      {
        "policy_kind": "guidance",
        "id": "guidance_policy_<ULID>",
        "policy": "...",
        "lifecycle": "accepted",
        "body_md": "...",
        "created_at": "...",
        "updated_at": "..."
      },
      ...
    ]
  }

ENDPOINT (capture)
  POST ${baseUrl}/${handle}/api/policies.json
  Content-Type: application/json

${PRINCIPAL_ID_CONVENTION}

  Body MUST include \`policy_kind\` to disambiguate; remaining
  fields match the per-kind draft below.

BODY — policy_kind = "guidance"
  policy_kind          required   "guidance"
  policy                required   one-line policy rule (renamed from
                                    \`summary\` by migration 038)
  body_md               optional   markdown policy body
  authored_by_principal_id optional principal id; auth fills this
  lifecycle             optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted"
  deprecated            optional   boolean warning label; lifecycle is unchanged
  outcome               optional   "succeeded" | "failed"

BODY — policy_kind = "neuron_authoring"
  policy_kind          required   "neuron_authoring"
  policy                required   one-line policy rule (renamed from
                                    \`summary\` by migration 038)
  evaluation_kind       required   "deterministic" | "probabilistic"
  predicate             required*  deterministic AuthoringPredicate object
                                  or JSON string. Must not have
                                  kind="probabilistic".
  spec                  required*  probabilistic spec; stored as
                                  {kind:"probabilistic", spec}
  fires_when_neuron_lifecycle optional ["accepted", ...]
  on_violation          optional   "block" | "warn" | "log"; default "block"
  body_md               optional   markdown policy body
  authored_by_principal_id optional principal id; auth fills this
  lifecycle             optional   one of "drafting" | "proposed" | "accepted" | "retired"; default "accepted"
  deprecated            optional   boolean warning label; lifecycle is unchanged
  outcome               optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201)
  {
    "ok": true,
    "id": "guidance_policy_<ULID>" | "neuron_authoring_policy_<ULID>",
    "footer_lines": ["[🔮 Doco] ✍️ ... Policy added: ... (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE — guidance
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "policy_kind": "guidance",
      "policy": "Prefer concrete examples over abstract prose."
    }'

EXAMPLE — neuron_authoring (deterministic)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "policy_kind": "neuron_authoring",
      "policy": "Every Decision cites at least one Intent.",
      "evaluation_kind": "deterministic",
      "predicate": {
        "kind": "requires_synapse",
        "synapse_type": "serves",
        "target_neuron_type": "intent",
        "when_neuron_type": ["decision"]
      }
    }'

EXAMPLE — neuron_authoring (unique field)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "policy_kind": "neuron_authoring",
      "policy": "No two active glossary terms use the same canonical term.",
      "evaluation_kind": "deterministic",
      "predicate": {
        "kind": "unique_field",
        "field": "chosen",
        "case_fold": true,
        "when_neuron_type": ["decision"]
      },
      "fires_when_neuron_lifecycle": ["accepted"]
    }'

EXAMPLE — neuron_authoring (probabilistic)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "policy_kind": "neuron_authoring",
      "policy": "Decision rationale names the rejected alternatives.",
      "evaluation_kind": "probabilistic",
      "spec": "Pass when the Decision explains at least one alternative and why it was rejected."
    }'

UPDATE A SPECIFIC POLICY
  PATCH ${baseUrl}/${handle}/api/guidance_policies/<id>.json
  PATCH ${baseUrl}/${handle}/api/neuron_authoring_policies/<id>.json
  Content-Type: application/json

  Per-id endpoints remain available for editing existing policies.
  Body shape mirrors the relevant capture draft.

RELATED
  GET  ${baseUrl}/${handle}/policies             HTML view of the policies
  GET  ${baseUrl}/api/v1/agent-bootstrap.json      bootstrap payload includes policies
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
  visibility     optional   "private" or "public".
  goal           optional   string.

SUCCESS RESPONSE — write (HTTP 200, application/json)
  {
    "ok": true,
    "doco_id": "doco_...",
    "doco_handle": "<possibly-new-handle>",
    "visibility": "private" | "public",
    "goal": "..."
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
