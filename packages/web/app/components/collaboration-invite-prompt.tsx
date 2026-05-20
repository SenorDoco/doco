import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";

/**
 * Build the prompt to share with a HUMAN collaborator. The invite URL
 * is browser-only — clicking it through a GitHub-signed-in browser
 * adds the recipient to the Doco's users.
 */
export function buildHumanInvitePrompt(inviteUrl: string): string {
  return [
    "You're invited to collaborate on a Doco. Open this URL in your browser, sign in with GitHub, click Accept:",
    "",
    inviteUrl,
  ].join("\n");
}

/**
 * Build the prompt to paste into an AI AGENT. Names the per-Doco MCP
 * install URL — once installed, the runtime kicks off the OAuth dance
 * on first call and Doco tools become available natively.
 */
export function buildAgentInvitePrompt(mcpUrl: string): string {
  return [
    "Let's collaborate with Doco on this project. Install the Doco MCP connector at:",
    "",
    mcpUrl,
    "",
    "On first use, your runtime opens a browser tab for OAuth sign-in and Doco approval. Once approved, Doco tools (search, capture_decision, list_scopes, …) become available natively.",
  ].join("\n");
}

/**
 * Two-box prompt for a fresh invite: one box for humans (the invite
 * URL), one box for agents (the per-Doco MCP install URL). Each has
 * its own copy button so the project owner copies exactly the prompt
 * matching where they're pasting.
 *
 * `mcpUrl` is required for the agent box. If it's omitted, the agent
 * box is hidden (back-compat for callers that don't yet know the
 * Doco handle).
 */
export function CollaborationInvitePrompt({
  inviteUrl,
  mcpUrl,
  continueTo,
  continueLabel = "Continue to Doco →",
  note,
  testId,
  promptTestId,
  copyButtonTestId,
  className,
}: {
  inviteUrl: string;
  mcpUrl?: string;
  continueTo?: string;
  continueLabel?: string;
  note?: ReactNode;
  testId?: string;
  promptTestId?: string;
  copyButtonTestId?: string;
  className?: string;
}) {
  return (
    <div
      className={["space-y-4", className].filter(Boolean).join(" ")}
      data-testid={testId}
    >
      <PromptBox
        title="Invite for humans"
        body={buildHumanInvitePrompt(inviteUrl)}
        promptTestId={promptTestId}
        copyButtonTestId={copyButtonTestId}
      />
      {mcpUrl ? (
        <PromptBox
          title="Invite for AI agents"
          body={buildAgentInvitePrompt(mcpUrl)}
          promptTestId={promptTestId ? `${promptTestId}-agent` : undefined}
          copyButtonTestId={copyButtonTestId ? `${copyButtonTestId}-agent` : undefined}
        />
      ) : null}
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      {continueTo ? (
        <Link
          to={continueTo}
          className="inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
        >
          {continueLabel}
        </Link>
      ) : null}
    </div>
  );
}

function PromptBox({
  title,
  body,
  promptTestId,
  copyButtonTestId,
}: {
  title: string;
  body: string;
  promptTestId?: string;
  copyButtonTestId?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-foreground">{title}</p>
      <pre
        className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words"
        data-testid={promptTestId}
      >
        {body}
      </pre>
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
    </div>
  );
}
