import { useState } from "react";

export function buildAgentOAuthPrompt(host: string): string {
  const recipeUrl = `${host}/protocol/agent-oauth-recipe`;
  const deviceUrl = `${host}/device`;
  return [
    `Let's collaborate with Doco on this project. The host is ${host}.`,
    "",
    `To get programmatic access, follow the OAuth recipe at ${recipeUrl}. If you can bind a local TCP port and open a browser, use Recipe A (localhost-loopback). If you can't (chat-only / sandboxed runtimes), use Recipe B (RFC 8628 Device Authorization Grant) — you'll show me a short code and I'll approve at ${deviceUrl}.`,
    "",
    "At the approve screen I'll pick which orgs and docos you can read/write and at what role (reader / author / approver / owner) per org or doco, so no scoping is needed up front.",
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
