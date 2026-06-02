import { useState } from "react";

const AGENT_INVITE_HELP_TEXT =
  "Copy this into your AI agent, in the project you want it to work on.";

export function buildAgentOAuthPrompt(host: string, workspaceId?: string): string {
  const url = `${host}/${workspaceId ?? "<workspace-id>"}/mcp`;
  const hint = workspaceId
    ? ""
    : " (replace <workspace-id> with the id from the workspace's Settings page)";
  return `Let's use Doco on this project. Add a custom MCP connector pointing at ${url}${hint} and run its OAuth flow — I'll approve in my browser. The connector is bound to that one workspace.`;
}

export function AgentInvitePrompt({
  host,
  workspaceId,
  promptTestId = "invite-agent-prompt",
  copyButtonTestId = "invite-agent-copy",
}: {
  host: string;
  /** When the user has exactly one workspace, bake its id into the URL. */
  workspaceId?: string;
  promptTestId?: string;
  copyButtonTestId?: string;
}) {
  return (
    <AgentPromptBlock
      body={buildAgentOAuthPrompt(host, workspaceId)}
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
