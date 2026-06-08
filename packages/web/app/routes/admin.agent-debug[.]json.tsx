// /admin/agent-debug.json — torrenegra-only raw-row dump for
// diagnosing specific stuck-turn / failed-turn incidents.
//
// Where /admin/agent-health.json aggregates ("X% error rate over the
// last hour"), this endpoint returns the actual rows behind those
// numbers so a human or another agent can read off "this turn
// failed at this phase with this error." Same auth gate as the
// dashboard.
//
// The data is gathered by `~/lib/agent-debug.server` (`gatherAgentDebug`),
// which is ALSO what the `doco_agent_debug` MCP tool calls — so the browser
// surface and every connected agent read the exact same shape. See that module
// for the section breakdown (recent_turns, stuck_conversations, capture/openai
// errors), plus the two diagnostic extras:
//   - ?search=<phrase>            find a conversation from a remembered quote.
//   - ?conversation=<id>          tail its messages AND get a replay-window
//     [&messages=N]               analysis: per attached file, whether the
//                                 model still sees it or it was evicted by the
//                                 message/token cap or the 30-day purge.
//
// Use it like: open /admin/agent-debug.json?limit=10 for the last 10 of each;
// /admin/agent-debug.json?search=BPMN to locate a thread; then
// /admin/agent-debug.json?conversation=conversation_01…&messages=200 to see
// exactly why an attachment went missing.

import { redirect } from "react-router";
import { gatherAgentDebug } from "~/lib/agent-debug.server";
import { getCurrentPrincipalAsync, isSuperadmin } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  // `getCurrentPrincipalAsync` accepts both the browser session
  // cookie AND `Authorization: Bearer <oauth-access-token>`. The
  // bearer path lets an out-of-band agent (running with a
  // device-flow-issued token in its .env) hit this endpoint to
  // diagnose a stuck turn without needing to share session cookies.
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    throw redirect(`/sign-in?next=${encodeURIComponent("/admin/agent-debug.json")}`);
  }
  if (!isSuperadmin(me.username)) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const data = await gatherAgentDebug({
    limit: Number(url.searchParams.get("limit") ?? "20"),
    conversation: url.searchParams.get("conversation"),
    messages: Number(url.searchParams.get("messages") ?? "30"),
    search: url.searchParams.get("search"),
  });

  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
