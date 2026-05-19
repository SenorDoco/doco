import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";

export const COLLABORATION_INVITE_DESCRIPTION =
  "The invite URL is for a human collaborator to accept in their browser. Agents authenticate by installing the Doco MCP connector for the Doco — separately, per runtime.";

/**
 * Build the prompt a project owner pastes into their agent to start
 * collaborating. Under MCP-OAuth (decision_01KS14CW9ZN23FF5CGG0Z7TH4G)
 * the prompt is dual-path: the invite URL is human-only (accept in
 * browser → `doco_users` grant); agents authenticate by installing
 * the Doco MCP connector. We name both paths explicitly so an agent
 * reading this knows which one it can act on.
 */
export function buildCollaborationInvitePrompt(inviteUrl: string, mcpUrl: string): string {
  return [
    "Let's collaborate with Doco on this project.",
    "",
    `If you're an AI agent runtime that supports MCP (Claude Code, Claude Desktop,`,
    `Claude.ai Connectors, ChatGPT Connectors, Cursor, Codex CLI, Gemini Code Assist):`,
    `install the Doco MCP connector at ${mcpUrl} — on first use it opens a browser`,
    `tab for OAuth sign-in + Doco approval. Once approved, Doco tools (search,`,
    `capture_decision, list_scopes, …) are available natively.`,
    "",
    `If you're a human collaborator: open this invite URL in a browser, sign in`,
    `with GitHub, click Accept. That adds you to the Doco's users. After that,`,
    `your AI runtime — if it supports MCP — can install the connector above and`,
    `inherit your access.`,
    "",
    inviteUrl,
  ].join("\n");
}

/**
 * Derive the Doco's MCP install URL from the invite URL. Invite URLs
 * look like `https://doco.to/invite/<code>` and don't carry the handle
 * directly, so the caller can also pass `mcpUrl` explicitly. When
 * `mcpUrl` is omitted, we render only the invite half of the prompt
 * (back-compat for callers that don't yet know the handle).
 */
export function CollaborationInvitePrompt({
  inviteUrl,
  mcpUrl,
  continueTo,
  continueLabel = "Continue to Doco →",
  note = "Single-use invite, expires in 7 days. The invite is for the human user; agents come in through the MCP connector.",
  showDescription = false,
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
  showDescription?: boolean;
  testId?: string;
  promptTestId?: string;
  copyButtonTestId?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const prompt = mcpUrl
    ? buildCollaborationInvitePrompt(inviteUrl, mcpUrl)
    : buildLegacyPrompt(inviteUrl);

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

/**
 * Single-URL fallback used when the caller didn't supply the MCP URL.
 * Still names the dual-path reality but only ships the invite URL the
 * caller actually has on hand. Removed once every caller threads the
 * Doco handle through.
 */
function buildLegacyPrompt(inviteUrl: string): string {
  return [
    "Let's collaborate with Doco on this project. Please open this invite URL in a browser, sign in with GitHub, click Accept:",
    "",
    inviteUrl,
    "",
    "(After accepting, you can install Doco's MCP connector in your agent runtime to give it access too. The invite URL itself is for the human accept step.)",
  ].join("\n");
}
