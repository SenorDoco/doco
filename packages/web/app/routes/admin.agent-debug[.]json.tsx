// /admin/agent-debug.json — torrenegra-only raw-row dump for
// diagnosing specific stuck-turn / failed-turn incidents.
//
// Where /admin/agent-health.json aggregates ("X% error rate over the
// last hour"), this endpoint returns the actual rows behind those
// numbers so a human or another agent can read off "this turn
// failed at this phase with this error." Same auth gate as the
// dashboard.
//
// Sections:
//   - recent_turns:    last N agent_turn_metrics rows with phases
//                      JSONB so we can see anthropic_calls /
//                      tool_calls breakdown.
//   - stuck_conversations: rows in chat_conversations where
//                      `active_turn_started_at` is older than 2 min
//                      — those are the "Señor Doco is replying…"
//                      bubbles that never resolved.
//   - recent_capture_errors: last N capture_timings rows where
//                      status_code is null or >= 400.
//   - recent_openai_errors: last N openai_usage_log rows with
//                      ok = false.
//
// Use it like: open /admin/agent-debug.json?limit=10 to see the last
// 10 of each. Defaults to 20.

import { withClient } from "@doco/db";
import { redirect } from "react-router";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

interface TurnRow {
  id: string;
  conversation_id: string;
  collaborator_id: string;
  model: string;
  started_at: string;
  total_ms: number;
  first_text_token_ms: number | null;
  num_anthropic_calls: number;
  num_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string | null;
  error: string | null;
  phases: unknown;
}

interface StuckConv {
  id: string;
  collaborator_id: string;
  active_turn_started_at: string;
  age_seconds: number;
}

interface CaptureErr {
  id: string;
  started_at: string;
  doco_id: string;
  entity_type: string;
  http_method: string;
  status_code: number | null;
  total_ms: number;
  error: string | null;
}

interface OpenAiErr {
  id: string;
  occurred_at: string;
  model: string;
  input_count: number;
  request_ms: number | null;
  error: string | null;
}

export async function loader({ request }: { request: Request }) {
  // `getCurrentPrincipalAsync` accepts both the browser session
  // cookie AND `Authorization: Bearer <oauth-access-token>`. The
  // bearer path lets an out-of-band agent (running with a
  // device-flow-issued token in its .env) hit this endpoint to
  // diagnose a stuck turn without needing to share session cookies.
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    // No credential at all → redirect interactive callers; API
    // callers (Bearer-missing) just see the redirect status, which
    // is the same auth-required signal.
    throw redirect(`/sign-in?next=${encodeURIComponent("/admin/agent-debug.json")}`);
  }
  if (me.username !== "torrenegra") {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.round(limitRaw))) : 20;

  const data = await withClient(async (c) => {
    const [turns, stuck, captures, openai] = await Promise.all([
      c.query<TurnRow>(
        `SELECT id, conversation_id, collaborator_id, model,
                started_at::text AS started_at, total_ms,
                first_text_token_ms, num_anthropic_calls, num_tool_calls,
                input_tokens, output_tokens, stop_reason, error, phases
           FROM agent_turn_metrics
          ORDER BY started_at DESC
          LIMIT $1`,
        [limit],
      ),
      c.query<StuckConv>(
        `SELECT id, collaborator_id,
                active_turn_started_at::text AS active_turn_started_at,
                EXTRACT(EPOCH FROM (now() - active_turn_started_at))::int AS age_seconds
           FROM chat_conversations
          WHERE active_turn_started_at IS NOT NULL
          ORDER BY active_turn_started_at ASC
          LIMIT $1`,
        [limit],
      ),
      c.query<CaptureErr>(
        `SELECT id, started_at::text AS started_at, doco_id, entity_type,
                http_method, status_code, total_ms, error
           FROM capture_timings
          WHERE status_code IS NULL OR status_code >= 400
          ORDER BY started_at DESC
          LIMIT $1`,
        [limit],
      ),
      c.query<OpenAiErr>(
        `SELECT id, occurred_at::text AS occurred_at, model, input_count,
                request_ms, error
           FROM openai_usage_log
          WHERE NOT ok
          ORDER BY occurred_at DESC
          LIMIT $1`,
        [limit],
      ),
    ]);

    return {
      recent_turns: turns.rows,
      stuck_conversations: stuck.rows,
      recent_capture_errors: captures.rows,
      recent_openai_errors: openai.rows,
    };
  });

  return Response.json(
    {
      generated_at: new Date().toISOString(),
      limit,
      ...data,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
