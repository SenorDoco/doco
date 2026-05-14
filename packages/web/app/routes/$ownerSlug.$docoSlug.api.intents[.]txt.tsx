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
  return `# Doco — Capture an Intent (single call)

Intents are the source of every downstream Decision/Action. Capture an
Intent **before** writing the first Decision that depends on it — that
way the Decision can reference it via \`intent_ids\`.

ENDPOINT
  POST ${baseUrl}/${owner}/${doco}/api/intents.json
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
    "path": "docos/<owner>/<doco>/intents/intent_<ULID>.md",
    "footer_lines": ["[🔮 Doco] ✍️ Intent added: [<summary>](<url>)"]
  }

  Emit each entry of \`footer_lines\` verbatim, one per line.

ERROR RESPONSE
  { "error": "<reason>" }

EXAMPLE
  curl -sS -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer $DOCO_TOKEN" \\
    ${baseUrl}/${owner}/${doco}/api/intents.json \\
    -d '{
      "summary": "Agent capture friction is bounded to a few seconds end-to-end.",
      "scope_names": ["framework"],
      "wanted_by_username": "torrenegra",
      "body_md": "Background: writing two ADRs by hand took >5 minutes (70% plumbing). This Intent motivates the single-call capture endpoints."
    }'

WHEN TO CALL THIS
  Before writing a Decision whose motivating Intent doesn't already
  exist on this Doco. The capture checklist (see canonical_instructions)
  treats "no matching Intent" as a missing capture, not a license to
  skip the connection.

RELATED
  POST ${baseUrl}/${owner}/${doco}/api/decisions.json   capture a Decision
  GET  ${baseUrl}/${owner}/${doco}/status.json          freshness + counts
`;
}
