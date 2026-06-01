import { getPublicBaseUrl, renderCaptureBodyFields, renderCapturePatchFields } from "@doco/shared";
import { normalizeDocoParams } from "~/lib/doco-access.server";

/**
 * Parametrized .txt spec endpoint for the per-Doco capture/settings APIs.
 *
 *   GET /<doco-handle>/api/<type>.txt
 *
 * `type` is one of the capture types, plus policies and settings.
 * Returns plain-prose spec for the corresponding .json endpoint.
 *
 * Note: policies (`guidance_policy`, `node_authoring_policy`)
 * are NOT nodes and do not have per-type capture routes. The dedicated
 * policies endpoint lives at /<handle>/api/policies.json and is
 * documented under `policies` here.
 */

type SpecRenderer = (baseUrl: string, handle: string) => string;

const RELATION_API_NOTE = `RELATIONSHIPS
  Node capture bodies accept node prose and scalar metadata only. Create
  relationships as first-class edges with POST /<handle>/api/changesets.json
  (relate / relate_many) or POST /<handle>/api/edges.json.

  Common relationship edge types: flows_to, supports, constrained_by,
  attributed_to, has_parent, derived_from, replaces, relates_to. When a
  perspective needs a narrower meaning, put it in edge props as role
  metadata (for example: serves, performed_by, reports_to).

  created_by / updated_by are user/API-key provenance derived from the
  authenticated session or token. Never send created_by.

  LIFECYCLE NOTE
  A node has three life stages: drafting -> asserted -> retired.
  Before you capture, ask your client whether they are DRAFTING or
  ASSERTING this node:
    - drafting  — tentative, a work in progress that may still change.
    - asserted  — committed as fact, the settled state (the default).
  Removal is never a hard delete; transition lifecycle to "retired"
  instead — the full history is preserved in the audit trail.
`;

const SPECS: Record<string, SpecRenderer> = {
  decisions: (baseUrl, handle) => `# Doco — Capture a Decision (single call)

Single POST. Server accepts principal ids, generates the ULID, writes
the row, and reindexes.

ENDPOINT
  POST ${baseUrl}/${handle}/api/decisions.json
  Content-Type: application/json

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("decision")}
  relationships      use changesets/edges for supports, attributed_to,
                                  derived_from, replaces, and BPMN flows_to

  Note: Projects that want ADR-style identifiers can mention them in
  the decision text. The framework provides no native ADR field.

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "ok": true,
    "id": "decision_<ULID>",
    "path": "docos/<doco-handle>/decisions/decision_<ULID>.md",
    "footer_lines": ["[🔮 Doco] <icon> <action>: [<Node>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"],
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
${renderCapturePatchFields("decision")}
    Use changesets/edges for relationship changes.

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

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("idea")}

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
${renderCapturePatchFields("idea")}
`,

  intents: (baseUrl, handle) => `# Doco — Capture an Intent (single call)

Intents are the source of every downstream Decision/Action. Capture an
Intent **before** writing the first Decision that depends on it, then
link the Decision to the Intent with a \`supports\` edge carrying
\`role: "serves"\`.

ENDPOINT
  POST ${baseUrl}/${handle}/api/intents.json
  Content-Type: application/json

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("intent")}
  relationships      use changesets/edges for attributed_to and has_parent

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
      "intent": "Agent capture friction is bounded to a few seconds end-to-end.\\n\\nBackground: writing two ADRs by hand took >5 minutes (70% plumbing). This Intent motivates the single-call capture endpoints."
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

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("action")}
  relationships      use changesets/edges for supports, flows_to,
                                  constrained_by, attributed_to, and derived_from

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
      "action": "Use first-class edges in the capture API.",
      "verb": "update",
      "outputs": { "commit": "abc123" }
    }'

UPDATE AN EXISTING ACTION
  PATCH ${baseUrl}/${handle}/api/actions/<id>.json
  Content-Type: application/json

  Body fields are all optional:
${renderCapturePatchFields("action")}
  Use changesets/edges for relationship changes.
`,

  logs: (baseUrl, handle) => `# Doco — Capture a Log (single call)

Logs record concrete happenings: a deploy that ran, a commit that
pushed, or an eval that verified. Capture the exact event shape up front —
a Log is the historical record of what happened.

ENDPOINT
  POST ${baseUrl}/${handle}/api/logs.json
  Content-Type: application/json

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("log")}
  relationships      use changesets/edges for derived_from, supports,
                                  flows_to, and attributed_to

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
      "log": "Pushed edge-only capture docs.",
      "verb": "pushed",
      "happened_at": "2026-05-23T12:00:00.000Z",
      "outputs": { "branch": "main", "commit": "abc123" }
    }'

UPDATE AN EXISTING LOG
  PATCH ${baseUrl}/${handle}/api/logs/<id>.json
  Content-Type: application/json

  Body fields are all optional:
${renderCapturePatchFields("log")}
  To preserve a clean record of what was first observed, capture a
  superseding Log and link it with a replaces edge.
`,

  rules: (baseUrl, handle) => `# Doco — Capture a Rule (single call)

Rules state policies or invariants the project should keep true.

ENDPOINT
  POST ${baseUrl}/${handle}/api/rules.json
  Content-Type: application/json

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("rule")}
  relationships      use changesets/edges for supports, derived_from,
                                  attributed_to, and constrained_by

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
      "rule": "Capture API requests put relationships in edges.",
      "predicate": "POST and PATCH request bodies use first-class edges for relationships.",
      "severity": "hard",
      "enforced_by": "review"
    }'

UPDATE AN EXISTING RULE
  PATCH ${baseUrl}/${handle}/api/rules/<id>.json
  Content-Type: application/json

  Body fields are all optional:
${renderCapturePatchFields("rule")}
  Use changesets/edges for relationship changes.
`,

  evals: (baseUrl, handle) => `# Doco — Capture an Eval (single call)

Evals define checks for behavior, documentation consistency, or process
quality.

ENDPOINT
  POST ${baseUrl}/${handle}/api/evals.json
  Content-Type: application/json

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("eval")}
  relationships      use changesets/edges for supports and attributed_to

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
      "eval": "Intent capture body shape — verify intents reject graph relationship keys.",
      "criterion": {
        "kind": "shape",
        "spec": "Intents put relationships in first-class edges."
      }
    }'

UPDATE AN EXISTING EVAL
  PATCH ${baseUrl}/${handle}/api/evals/<id>.json
  Content-Type: application/json

  Body fields are all optional:
${renderCapturePatchFields("eval")}
  Use changesets/edges for relationship changes.
`,

  references: (baseUrl, handle) => `# Doco — Capture a Reference (single call)

References point to external or repository artifacts such as URLs,
files, commits, documents, and tickets.

ENDPOINT
  POST ${baseUrl}/${handle}/api/references.json
  Content-Type: application/json

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("reference")}
  relationships      use changesets/edges for supports and replaces

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

  Body fields are all optional:
${renderCapturePatchFields("reference")}
  To preserve a record of what
  was originally cited, you can instead capture a superseding Reference and
  link it with a replaces edge.
`,

  states: (baseUrl, handle) => `# Doco — Capture a State (single call)

States name meaningful process states such as initial, intermediate, or
terminal conditions.

ENDPOINT
  POST ${baseUrl}/${handle}/api/states.json
  Content-Type: application/json

${RELATION_API_NOTE}

BODY (JSON)
${renderCaptureBodyFields("state")}
  relationships      use changesets/edges for supports, flows_to, and replaces

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

  Body fields are all optional:
${renderCapturePatchFields("state")}
  Use changesets/edges for relationship changes.
`,

  principals: (baseUrl, handle) => `# Doco — Principals (create, edit, retire)

Principals are the role-personas a Doco links to through attributed_to
and has_parent edges. A
Principal's fields — \`name\`, body_md, lifecycle — stay editable across
its lifecycle. Other nodes reference Principals by id, so a rename never
breaks edges.

CREATE
  POST ${baseUrl}/${handle}/api/principals.json
  Content-Type: application/json

BODY (JSON)
  name                required   display name for the Principal. Stored
                                  after trimming surrounding whitespace;
                                  not required to be slug-shaped or unique.
  body_md             optional   markdown body — the only narrative field
                                  on a Principal. Defaults to empty.
                                  The org-chart template expects person-
                                  vs-agent to be declared here in prose
                                  ("Operates under: @alice", "Autonomous
                                  research agent", "Human director of …");
                                  the org-tree perspective infers the icon
                                  from these signals.

SUCCESS RESPONSE — create (HTTP 201, application/json)
  {
    "ok": true,
    "id": "principal_<ULID>",
    "name": "<name>",
    "existed": false,
    "footer_lines": ["[🔮 Doco] 👤 Principal added: [<name>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

ERROR RESPONSES
  HTTP 400  missing name or graph-link JSON key
  HTTP 401  authentication required
  HTTP 403  write access required
  HTTP 422  authoring policy violation (e.g. org-chart template
            requires body_md to declare person vs agent)

EXAMPLE — create
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/principals.json \\
    -d '{
      "name": "alice",
      "body_md": "Human director of engineering. Owns roadmap planning and hiring for the engineering org."
    }'

EDIT
  PATCH ${baseUrl}/${handle}/api/principals/<id>.json
  Content-Type: application/json

  Update fields including \`name\` (renames are tracked in the audit log).
  Use changesets/edges for reporting relationships.

BODY (JSON) — at least one field required
  name                optional   new display name. Trimmed; must be
                                  non-empty. Not required to be unique.
  body_md             optional   markdown body — the only narrative
                                  field on a Principal.
  lifecycle           optional   only "retired" accepted; see RETIRE.

SUCCESS RESPONSE — edit (HTTP 200, application/json)
  {
    "ok": true,
    "id": "principal_<ULID>",
    "lifecycle": "asserted",
    "footer_lines": ["[🔮 Doco] 👤 Principal updated: [<name>](<url>) (✅ <n> authoring policies passed in <X.Xs>)"]
  }

ERROR RESPONSES
  HTTP 400  empty body, unknown field, blank \`name\`, graph-link JSON key,
            or invalid lifecycle
  HTTP 401  authentication required
  HTTP 403  write access required
  HTTP 404  principal not found in this Doco
  HTTP 422  authoring policy violation

EXAMPLE — edit
  curl -sS -X PATCH \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/principals/principal_01...json \\
    -d '{ "body_md": "Updated bio prose." }'

RETIRE
  PATCH ${baseUrl}/${handle}/api/principals/<id>.json
  Content-Type: application/json

  Retirement is a one-way lifecycle transition with an active-references
  guard: a Principal still referenced by an active Action, Log, or
  Intent can't be retired until those nodes are retired or superseded.

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
  HTTP 403  write access required
  HTTP 404  principal not found in this Doco
  HTTP 409  active nodes still reference this principal — retire or
            supersede those first. Response body:
            {
              "error": "Cannot retire principal: active nodes still reference it. …",
              "active_references": [
                { "id": "action_<ULID>", "node_type": "action",
                  "summary": "…", "edge_type": "attributed_to" },
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
    - "users" — OAuth users on this Doco
      (people with a role grant).
    - "principal_nodes" — actual Principal nodes in this Doco
      (what swim-lane / BPMN / org-tree views render). Mutate these
      via the create + edit + retire endpoints above.

RELATED
  POST ${baseUrl}/${handle}/api/changesets.json   create relationship edges
  POST ${baseUrl}/${handle}/api/edges.json        create one edge directly
`,

  policies: (baseUrl, handle) => `# Doco — Policies

Policies are **not nodes**. They govern how a Doco is authored,
and they live on a dedicated endpoint — separate from the generic
node-capture API.

Two kinds:
  - guidance         contributor-facing prose; not engine-evaluated.
  - node_authoring engine-evaluated capture-time checks
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
    "node_authoring_count": <int>,
    "items": [
      {
        "policy_kind": "guidance",
        "id": "guidance_policy_<ULID>",
        "policy": "...",
        "lifecycle": "asserted",
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

${RELATION_API_NOTE}

  Body MUST include \`policy_kind\` to disambiguate; remaining
  fields match the per-kind draft below.

BODY — policy_kind = "guidance"
  policy_kind          required   "guidance"
  policy                required   one-line policy rule
  body_md               optional   markdown policy body
  authored_by_principal_id optional principal id; auth fills this
  lifecycle             optional   one of "drafting" | "asserted" | "retired"; default "asserted"
  deprecated            optional   boolean warning label; lifecycle is unchanged
  outcome               optional   "succeeded" | "failed"

BODY — policy_kind = "node_authoring"
  policy_kind          required   "node_authoring"
  policy                required   one-line policy rule
  evaluation_kind       required   "deterministic" | "probabilistic"
  predicate             required*  deterministic AuthoringPredicate object
                                  or JSON string. Must not have
                                  kind="probabilistic".
  spec                  required*  probabilistic spec; stored as
                                  {kind:"probabilistic", spec}
  fires_when_node_lifecycle optional ["asserted", ...]
  on_violation          optional   "block" | "warn" | "log"; default "block"
  body_md               optional   markdown policy body
  authored_by_principal_id optional principal id; auth fills this
  lifecycle             optional   one of "drafting" | "asserted" | "retired"; default "asserted"
  deprecated            optional   boolean warning label; lifecycle is unchanged
  outcome               optional   "succeeded" | "failed"

SUCCESS RESPONSE (HTTP 201)
  {
    "ok": true,
    "id": "guidance_policy_<ULID>" | "node_authoring_policy_<ULID>",
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

EXAMPLE — node_authoring (deterministic)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "policy_kind": "node_authoring",
      "policy": "Every Decision cites at least one Intent.",
      "evaluation_kind": "deterministic",
      "predicate": {
        "kind": "requires_edge",
      "edge_type": "supports",
        "target_node_type": "intent",
        "when_node_type": ["decision"]
      }
    }'

EXAMPLE — node_authoring (unique field)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "policy_kind": "node_authoring",
      "policy": "No two active glossary terms use the same canonical term.",
      "evaluation_kind": "deterministic",
      "predicate": {
        "kind": "unique_field",
        "field": "chosen",
        "case_fold": true,
        "when_node_type": ["decision"]
      },
      "fires_when_node_lifecycle": ["asserted"]
    }'

EXAMPLE — node_authoring (probabilistic)
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "policy_kind": "node_authoring",
      "policy": "Decision rationale names the rejected alternatives.",
      "evaluation_kind": "probabilistic",
      "spec": "Pass when the Decision explains at least one alternative and why it was rejected."
    }'

UPDATE A SPECIFIC POLICY
  PATCH ${baseUrl}/${handle}/api/guidance_policies/<id>.json
  PATCH ${baseUrl}/${handle}/api/node_authoring_policies/<id>.json
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
