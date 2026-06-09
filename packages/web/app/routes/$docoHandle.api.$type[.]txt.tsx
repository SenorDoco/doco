import {
  DETERMINISTIC_SUB_KINDS,
  getPublicBaseUrl,
  renderCaptureBodyFields,
  renderCapturePatchFields,
} from "@doco/shared";
import { normalizeDocoParams } from "~/lib/doco-access.server";

/**
 * Parametrized .txt spec endpoint for the per-Doco capture/settings APIs.
 *
 *   GET /<doco-handle>/api/<type>.txt
 *
 * `type` is one of the capture types, plus policies and settings.
 * Returns plain-prose spec for the corresponding .json endpoint.
 *
 * Note: policies (a single `policy` entity type) are NOT nodes and do
 * not have per-type capture routes. The dedicated policies endpoint
 * lives at /<handle>/api/policies.json and is documented under
 * `policies` here.
 */

type SpecRenderer = (baseUrl: string, handle: string) => string;

const RELATION_API_NOTE = `RELATIONSHIPS
  Node capture bodies accept node prose and scalar metadata only. Create
  relationships as first-class edges with POST /<handle>/api/changesets.json
  (relate / relate_many) or POST /<handle>/api/edges.json.

  Common relationship edge types: flows_to, supports, constrained_by,
  attributed_to, has_parent, derived_from, replaces, relates_to. An edge's
  specific meaning comes from its type plus the node types it connects — e.g.
  an Action's attributed_to to a Principal is its performer, a flow node's
  supports to an Intent places it in that pool.

  created_by / updated_by are user/API-key provenance derived from the
  authenticated session or token. Never send created_by.

  LIFECYCLE NOTE
  A node has four life stages: drafting -> queued -> active -> retired.
  Before you capture, ask your client which stage this node is in:
    - drafting  — tentative, a work in progress that may still change.
    - queued    — ready, awaiting activation (e.g. an open PR under review).
    - active    — committed as fact, the settled state in force (the default).
    - retired   — no longer in use.
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
      "prose": "Render success cards at each creation entry point.",
      "extra": {
        "question": "Where should the Doco-created confirmation live?",
        "chosen": "Each creation entry point renders its own success card.",
        "alternatives": [
          { "name": "Keep the banner on the next-step page", "rejected_because": "Content belongs to the creation flow." }
        ]
      }
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
link the Decision to the Intent with a \`supports\` edge.

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
      "prose": "Agent capture friction is bounded to a few seconds end-to-end.\\n\\nBackground: writing two ADRs by hand took >5 minutes (70% plumbing). This Intent motivates the single-call capture endpoints."
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
      "prose": "Use first-class edges in the capture API.",
      "extra": { "verb": "update", "outputs": { "commit": "abc123" } }
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
      "prose": "Pushed edge-only capture docs.",
      "extra": {
        "verb": "pushed",
        "happened_at": "2026-05-23T12:00:00.000Z",
        "outputs": { "branch": "main", "commit": "abc123" }
      }
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
      "prose": "Capture API requests put relationships in edges.",
      "extra": {
        "predicate": "POST and PATCH request bodies use first-class edges for relationships.",
        "enforced_by": "review"
      }
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
      "prose": "Intent capture body shape — verify intents reject graph relationship keys.",
      "extra": {
        "criterion": {
          "kind": "shape",
          "spec": "Intents put relationships in first-class edges."
        }
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
      "prose": "Plain-text capture API specs",
      "extra": {
        "locator": "packages/web/app/routes/$docoHandle.api.$type[.]txt.tsx"
      }
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
      "prose": "Capture API contract documented",
      "kind": "terminal",
      "extra": { "invariants": ["Agents can discover the expected body shape."] }
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
Principal's fields — \`name\`, \`kind\`, lifecycle — stay editable across
its lifecycle. Other nodes reference Principals by id, so a rename never
breaks edges.

CREATE
  POST ${baseUrl}/${handle}/api/principals.json
  Content-Type: application/json

BODY (JSON)
  name                required   display name for the Principal — its only
                                  text. Stored after trimming surrounding
                                  whitespace; not required to be slug-shaped
                                  or unique. A vacant org-chart seat states
                                  its vacancy here (e.g. "Vacant — budgeted
                                  Staff Engineer seat").
  kind                optional   "human" or "agent". A filled org-chart seat
                                  declares which; a vacant seat omits it. The
                                  org-tree perspective draws the icon from it.

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
            requires the seat to declare person vs agent)

EXAMPLE — create
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/principals.json \\
    -d '{
      "name": "Alice — Director of Engineering",
      "kind": "human"
    }'

EDIT
  PATCH ${baseUrl}/${handle}/api/principals/<id>.json
  Content-Type: application/json

  Update fields including \`name\` (renames are tracked in the audit log).
  Use changesets/edges for reporting relationships.

BODY (JSON) — at least one field required
  name                optional   new display name. Trimmed; must be
                                  non-empty. Not required to be unique.
  lifecycle           optional   only "retired" accepted; see RETIRE.

SUCCESS RESPONSE — edit (HTTP 200, application/json)
  {
    "ok": true,
    "id": "principal_<ULID>",
    "lifecycle": "active",
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
    -d '{ "name": "Alice — VP of Engineering" }'

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

There is ONE policy entity type, \`policy\`, living in one table.
Every policy carries a standalone \`kind\`:
  - suggestion       contributor-facing instruction; not block-enforced.
  - deterministic    engine-evaluated capture-time predicate check.
  - probabilistic    engine-evaluated capture-time check the host
                     judges with an LLM.

ENDPOINT (list)
  GET ${baseUrl}/${handle}/api/policies.json

  Returns every policy in the Doco, each with its \`kind\` and
  \`predicate\`:

  {
    "doco_id": "doco_...",
    "doco_handle": "<handle>",
    "count": <int>,
    "items": [
      {
        "id": "policy_<ULID>",
        "kind": "suggestion",
        "agent_instruction": "...",
        "predicate": null,
        "lifecycle": "active",
        "created_at": "...",
        "updated_at": "..."
      },
      ...
    ]
  }

ENDPOINT (capture)
  POST ${baseUrl}/${handle}/api/policies.json
  Content-Type: application/json
  (owner role required)

${RELATION_API_NOTE}

  Body MUST include \`kind\` to disambiguate; remaining fields match
  the per-kind draft below.

BODY — common (every kind)
  kind                  required   "suggestion" | "deterministic" | "probabilistic"
  fires_when_node_lifecycle optional ["active", ...]
  on_violation          optional   "block" | "warn" | "log"; default "block".
                                  Not used for kind="suggestion".
  authored_by_principal_id optional principal id; auth fills this

BODY — kind = "suggestion"
  agent_instruction     required   the single natural-language instruction.

BODY — kind = "probabilistic"
  agent_instruction     required   the single natural-language instruction.
  when_node_type        optional   ["decision", ...]

BODY — kind = "deterministic"
  predicate             required   predicate object (or JSON string) shaped
                                  { "sub_kind": <check>, ...params }.
                                  sub_kind is one of: ${DETERMINISTIC_SUB_KINDS.join(", ")}.
                                  The params are unchanged; only the
                                  discriminator field was renamed from
                                  \`kind\` to \`sub_kind\`.

SUCCESS RESPONSE (HTTP 201)
  {
    "ok": true,
    "id": "policy_<ULID>",
    "footer_lines": ["[🔮 Doco] ✍️ Policy added: ... (✅ <n> authoring policies passed in <X.Xs>)"]
  }

EXAMPLE — suggestion
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "kind": "suggestion",
      "agent_instruction": "Prefer concrete examples over abstract prose."
    }'

EXAMPLE — probabilistic
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "kind": "probabilistic",
      "agent_instruction": "Pass when the Decision explains at least one alternative and why it was rejected.",
      "on_violation": "warn"
    }'

EXAMPLE — deterministic
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_ACCESS" \\
    ${baseUrl}/${handle}/api/policies.json \\
    -d '{
      "kind": "deterministic",
      "predicate": {
        "sub_kind": "requires_edge",
        "edge_type": "attributed_to",
        "target_node_type": "principal",
        "when_node_type": ["action"]
      },
      "on_violation": "block"
    }'

MODIFY A SPECIFIC POLICY (owner role required)
  PATCH ${baseUrl}/${handle}/api/policies/<id>.json
  Content-Type: application/json

  Two body shapes:

  • A full policy draft (must include \`kind\`, same shape as the capture
    body above) SUPERSEDES the policy: a new policy is captured from the
    draft and this one is retired with \`superseded_by: <new id>\`, so the
    enforcement history stays intact in the audit trail. The response is:
      { "ok": true, "id": "policy_<new ULID>", "superseded": "policy_<id>",
        "footer_lines": [...] }

  • { "lifecycle": "retired" } retires the policy in place (stops enforcing
    it); { "lifecycle": "active" } re-activates a retired policy. The
    response is:
      { "ok": true, "id": "policy_<id>", "lifecycle": "retired" | "active" }

  GET ${baseUrl}/${handle}/api/policies/<id>.json returns the stored draft
  + lifecycle for one policy.

RELATED
  GET  ${baseUrl}/${handle}/policies             HTML view of the policies
  GET  ${baseUrl}/api/v1/agent-bootstrap.json      bootstrap payload includes policies
`,

  settings: (baseUrl, handle) => `# Doco — Settings (read + patch)

Per-Doco settings endpoint. Two methods:

  GET   ${baseUrl}/${handle}/api/settings.json
    Returns the current settings. Read-gated: anonymous on public docos,
    owner/workspace-members on private docos, 404 otherwise.

  POST  ${baseUrl}/${handle}/api/settings.json
    (PATCH is also accepted.) Updates fields. Admin-gated (owner or workspace
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
    - HTTP 403 — you can read it but you're not its owner / workspace admin.
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
