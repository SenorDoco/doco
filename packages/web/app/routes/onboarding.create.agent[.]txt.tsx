// /onboarding/create/agent.txt — plain-text companion to the HTML page.
// Agents discovering the host via the AGENTS.md convention may curl this
// for the no-chrome instructions.
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = [
    "Create a Doco from the CLI (agent flow).",
    "",
    "  doco login --host " + baseUrl + " --create <slug>",
    "",
    "What happens:",
    "  1. CLI opens " + baseUrl + "/cli/authorize in the project owner's browser.",
    "  2. They sign in (if not already) and review a one-screen identity card",
    "     showing CLI version, hostname, IP, timestamp, and a short code.",
    "  3. They click Authorize. Server creates an agent Principal owned by",
    "     them + a session token + the Doco at " + baseUrl + "/<their-username>/<slug>.",
    "  4. CLI captures the token via polling and writes DOCO_HOST + DOCO_TOKEN +",
    "     DOCO_SLUG to ./.env. Restart your agent session afterwards.",
    "",
    "If `doco` is not on PATH:",
    "  npm i -g @doco/cli      (global install)",
    "  npx @doco/cli login …   (one-shot, no install)",
    "",
    "First-run permissions (Claude Code and similar):",
    "  Auto-mode classifiers may block the very first `doco` call as an",
    "  unverified external CLI. Either click Allow when prompted, or",
    "  pre-authorize once at the user level in ~/.claude/settings.json:",
    "    {\"permissions\":{\"allow\":[\"Bash(doco:*)\",\"Bash(npx @doco/cli:*)\"]}}",
    "  After the first successful `doco login`, the bootstrap that lands",
    "  in this repo's .claude/settings.json allowlists the same entries,",
    "  so future calls run unprompted.",
    "",
    "If the project owner denies the prompt, the CLI exits non-zero and",
    "nothing is written. Don't retry on a loop — stop and ask what they",
    "want to do.",
    "",
    "The previous HTTP-POST 'agent creates an unclaimed Doco' form +",
    "/claim/<token> handoff is retired (decision_01KRKZM14WNA1685GN0F12WCKM).",
    "Docos are bound to the project owner from creation; no temporary",
    "host-bootstrap owner, no follow-up URL to chase.",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
