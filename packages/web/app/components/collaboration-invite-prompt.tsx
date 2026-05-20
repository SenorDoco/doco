import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";

/**
 * Build the prompt to share with a human collaborator. Clicking the
 * invite URL in a GitHub-signed-in browser adds the recipient to the
 * Doco's users.
 */
export function buildHumanInvitePrompt(inviteUrl: string): string {
  return [
    "You're invited to collaborate on a Doco. Open this URL in your browser, sign in with GitHub, click Accept:",
    "",
    inviteUrl,
  ].join("\n");
}

/**
 * Renders the human-collaborator invite prompt with a Copy button.
 *
 * The agent-collaborator path is deferred: it relied on installing the
 * Doco MCP connector, and the MCP server has been removed for now (see
 * the MCP-removal Decision). It returns when the connector goes back
 * in.
 */
export function CollaborationInvitePrompt({
  inviteUrl,
  continueTo,
  continueLabel = "Continue to Doco →",
  note,
  testId,
  promptTestId,
  copyButtonTestId,
  className,
}: {
  inviteUrl: string;
  continueTo?: string;
  continueLabel?: string;
  note?: ReactNode;
  testId?: string;
  promptTestId?: string;
  copyButtonTestId?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const body = buildHumanInvitePrompt(inviteUrl);
  return (
    <div
      className={["space-y-2", className].filter(Boolean).join(" ")}
      data-testid={testId}
    >
      <p className="text-xs font-semibold text-foreground">Invite for humans</p>
      <pre
        className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words"
        data-testid={promptTestId}
      >
        {body}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={copyButtonTestId}
          onClick={async () => {
            await navigator.clipboard.writeText(body);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-input"
        >
          {copied ? "Copied!" : "Copy prompt"}
        </button>
        {continueTo ? (
          <Link
            to={continueTo}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            {continueLabel}
          </Link>
        ) : null}
      </div>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
