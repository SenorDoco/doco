import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";

export const COLLABORATION_INVITE_DESCRIPTION =
  "This single invite URL works for humans and agents.";

export function buildCollaborationInvitePrompt(inviteUrl: string): string {
  return [
    "Let's collaborate with Doco on this project. Please redeem this invite URL:",
    "",
    inviteUrl,
  ].join("\n");
}

export function CollaborationInvitePrompt({
  inviteUrl,
  continueTo,
  continueLabel = "Continue to Doco →",
  note = "Single-use invite, expires in 7 days. Each agent gets its own credential.",
  showDescription = false,
  testId,
  promptTestId,
  copyButtonTestId,
  className,
}: {
  inviteUrl: string;
  continueTo?: string;
  continueLabel?: string;
  note?: ReactNode;
  showDescription?: boolean;
  testId?: string;
  promptTestId?: string;
  copyButtonTestId?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const prompt = buildCollaborationInvitePrompt(inviteUrl);

  return (
    <div className={["space-y-2", className].filter(Boolean).join(" ")} data-testid={testId}>
      {showDescription ? (
        <p className="text-sm text-muted-foreground">{COLLABORATION_INVITE_DESCRIPTION}</p>
      ) : null}
      <pre
        className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words"
        data-testid={promptTestId}
      >
        {prompt}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={copyButtonTestId}
          onClick={async () => {
            await navigator.clipboard.writeText(prompt);
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
      <p className="text-[11px] text-muted-foreground">{note}</p>
    </div>
  );
}
