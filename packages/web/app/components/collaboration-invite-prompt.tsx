import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";

/**
 * Build the prompt to share with a human collaborator. Clicking the
 * invite URL in a signed-in browser adds the recipient to the Doco's
 * users.
 */
export function buildHumanInvitePrompt(inviteUrl: string): string {
  return [
    "You're invited to collaborate on a Doco. Open this URL in your browser, sign in, and click Accept:",
    "",
    inviteUrl,
  ].join("\n");
}

/**
 * Build the prompt to paste into an AI agent. Points the agent at
 * the OAuth recipe and names the per-Doco URL + Device-Flow approval
 * page so the agent can drive auth itself.
 */
export function buildAgentInvitePrompt(args: {
  docoUrl: string;
  recipeUrl: string;
  deviceUrl: string;
}): string {
  return [
    `Let's collaborate with Doco on this project. The Doco is at ${args.docoUrl}.`,
    "",
    `To get programmatic access, follow the OAuth recipe at ${args.recipeUrl}. If you can bind a local TCP port and open a browser, use Recipe A (localhost-loopback). If you can't (chat-only / sandboxed runtimes), use Recipe B (RFC 8628 Device Authorization Grant) — you'll show me a short code and I'll approve at ${args.deviceUrl}.`,
    "",
    `Either way you end up with a Bearer token you can use against ${args.docoUrl}.`,
  ].join("\n");
}

/**
 * Two-box prompt for a fresh invite: one box the project owner copies
 * to a human collaborator, one box they copy to their AI agent. Each
 * has its own Copy button so the right text goes to the right place.
 *
 * The agent box requires both `docoUrl` and `recipeUrl`. If either is
 * omitted, only the human box renders.
 */
export function CollaborationInvitePrompt({
  inviteUrl,
  docoUrl,
  recipeUrl,
  deviceUrl,
  continueTo,
  continueLabel = "Continue to Doco →",
  note,
  testId,
  promptTestId,
  copyButtonTestId,
  className,
}: {
  inviteUrl: string;
  docoUrl?: string;
  recipeUrl?: string;
  deviceUrl?: string;
  continueTo?: string;
  continueLabel?: string;
  note?: ReactNode;
  testId?: string;
  promptTestId?: string;
  copyButtonTestId?: string;
  className?: string;
}) {
  const showAgent = Boolean(docoUrl && recipeUrl && deviceUrl);
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
      {showAgent ? (
        <PromptBox
          title="Invite for AI agents"
          body={buildAgentInvitePrompt({
            docoUrl: docoUrl!,
            recipeUrl: recipeUrl!,
            deviceUrl: deviceUrl!,
          })}
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
