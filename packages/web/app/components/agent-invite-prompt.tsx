import { useState } from "react";

const AGENT_INVITE_HELP_TEXT =
  "Copy this into your AI agent, in the project you want it to work on.";

export function buildAgentOAuthPrompt(host: string): string {
  return `Let's use Doco on this project. Add a custom MCP connector pointing at ${host}/mcp and run its OAuth flow — I'll approve in my browser.`;
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
