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
  return `# Doco — Create a Scope (single call)

Per ADR-137bis every scope-creation call MUST declare whether the new
scope is "watched" — a soft attention signal for contributors. No
silent default on any surface.

A WATCHED scope tells contributors (person or agent): "when capturing
work that touches this topic, scan against this scope and tag the new
node into it." Not enforced at capture time — purely a prompt to think
about the topic. For HARD enforcement ("every node must list this
scope or capture is rejected"), use a \`mandatory_scope\` rule on the
Constitution scope instead, via the Rules editor at
/scopes/<id>/edit. The two mechanisms are independent.

ENDPOINT
  POST ${baseUrl}/${owner}/${doco}/api/scopes.json
  Content-Type: application/json

BODY (JSON)
  watched        REQUIRED   boolean. true → contributors should
                            proactively look for opportunities to
                            document into this scope. false → available
                            but no extra attention prompt. Soft signal,
                            not enforcement.
  template_name  optional   install a default template by name (e.g.
                            "user-flows", "bugs"). Mutually exclusive
                            with the custom fields below.
  name           required*  lowercase, starts with a letter, no slashes.
                            *if template_name is absent.
  icon           optional   single emoji.
  purpose        optional   why this scope exists. Agents read this
                            before authoring into it.
  guidelines     optional   markdown guidance for authors.
  parent_id      optional   id of an existing scope to nest this one
                            under.
  rules          optional   pre-seeded checks (predicates the engine
                            runs on every capture into this scope —
                            requires_edge / requires_field /
                            mandatory_scope / forbids_* / probabilistic).
                            Add more later on /scopes/<id>/edit.

SUCCESS RESPONSE (HTTP 201, application/json)
  {
    "id": "scope_<ULID>",
    "name": "...",
    "watched": true | false,
    "footer_lines": ["[🔮 Doco] ✍️ Scope added: ... — <icon> <name>", ...]
  }

  Use \`footer_lines\` verbatim in your next user-facing message.

ERROR RESPONSES
  400  Missing/invalid \`watched\`, bad name, unknown template, missing parent.
  409  Scope with this name already exists.

EXAMPLE — install the bugs template as watched
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_TOKEN" \\
    ${baseUrl}/${owner}/${doco}/api/scopes.json \\
    -d '{ "template_name": "bugs", "watched": true }'

EXAMPLE — custom scope, not watched, nested under an existing parent
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_TOKEN" \\
    ${baseUrl}/${owner}/${doco}/api/scopes.json \\
    -d '{
      "name": "payments",
      "icon": "💳",
      "purpose": "Anything touching Stripe / billing flows.",
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

RELATED
  POST ${baseUrl}/${owner}/${doco}/api/intents.json     capture an Intent
  POST ${baseUrl}/${owner}/${doco}/api/decisions.json   capture a Decision
  GET  ${baseUrl}/${owner}/${doco}/status.json          freshness + counts
`;
}
