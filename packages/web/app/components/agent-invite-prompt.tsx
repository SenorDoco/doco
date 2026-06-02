import { useState } from "react";

const AGENT_INVITE_HELP_TEXT =
  "Doco will teach your agent to collaborate consistently. Copy this prompt into your AI agent in the project you want to work on. The easiest path is the hosted MCP connector — your agent connects, you approve in your browser, and read/write access follows the permissions you grant (no re-auth to step up).";

export function buildAgentOAuthPrompt(host: string): string {
  const connectUrl = `${host}/mcp`;
  const recipeUrl = `${host}/protocol/agent-oauth-recipe`;
  const deviceUrl = `${host}/device`;
  return [
    `Let's collaborate with Doco on this project. The host is ${host}.`,
    "",
    `Easiest: add Doco as a custom MCP connector pointing at ${connectUrl} — your client runs the OAuth flow and I approve in my browser. The connector is read + write: doco_search (read), doco_capture + doco_relate (write), and doco_request_access (ask me for more). Read vs write is a permission I grant on the same token, not a re-login.`,
    "",
    `If your runtime can't use a remote MCP connector, drive OAuth directly via the recipe at ${recipeUrl}: Recipe A (localhost-loopback) if you can bind a port and open a browser, otherwise Recipe B (device flow) — you'll show me a short code and I'll approve at ${deviceUrl}.`,
    "",
    `At the approve screen I'll pick "Full access" (follows my live permissions — you can read/write whatever I can, and read→write upgrades apply with no reconnect) or scope you to specific docos.`,
  ].join("\n");
}

export function AgentInvitePrompt({
  host,
  promptTestId = "invite-agent-prompt",
  copyButtonTestId = "invite-agent-copy",
}: {
  host: string;
  promptTestId?: string;
  copyButtonTestId?: string;
}) {
  return (
    <AgentPromptBlock
      body={buildAgentOAuthPrompt(host)}
      promptTestId={promptTestId}
      copyButtonTestId={copyButtonTestId}
    />
  );
}

function AgentPromptBlock({
  body,
  promptTestId,
  copyButtonTestId,
}: {
  body: string;
  promptTestId: string;
  copyButtonTestId: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <p className="max-w-5xl text-sm font-semibold leading-6 text-foreground">
        {AGENT_INVITE_HELP_TEXT}
      </p>
      <pre
        className="neu-surface rounded-md bg-card p-3 text-[11px] whitespace-pre-wrap break-words"
        data-testid={promptTestId}
      >
        {body}
      </pre>
      <div className="flex justify-end">
        <button
          type="button"
          data-testid={copyButtonTestId}
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              void navigator.clipboard.writeText(body).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }
          }}
          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
        >
          {copied ? "Copied!" : "Copy prompt"}
        </button>
      </div>
    </div>
  );
}
