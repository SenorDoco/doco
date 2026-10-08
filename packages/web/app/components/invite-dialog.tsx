// The dialog an invite opens in (Alexander, 2026-10-06, so the invite isn't
// confused with anything else on the page): what to send, a copy button named
// for who it goes to ("Copy invite" for a person, "Copy prompt" for an agent)
// and a way out (components/dialog.tsx).
//
// An agent's invite is the one step a workspace's setup gives an invitee: send
// the agent the prompt, and it connects itself to Doco (Alexander,
// 2026-10-07).

import { type ReactNode, useState } from "react";
import { Dialog, DialogFooter } from "~/components/dialog";
import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import { buildHumanInvitePrompt } from "~/lib/invite-prompts";
import { STEP_TITLES } from "~/lib/onboarding-steps";

const PRIMARY =
  "neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90";

/** A fresh invite for a person: the invite link with what to do with it. */
export function PersonInviteDialog({
  inviteUrl,
  note,
  onClose,
}: {
  inviteUrl: string;
  note: ReactNode;
  onClose: () => void;
}) {
  const message = buildHumanInvitePrompt(inviteUrl);
  return (
    <Dialog title="Send this invite to the person" onClose={onClose}>
      <MessageWell message={message} />
      <DialogFooter note={note}>
        <CopyMessageButton message={message} label="Copy invite" />
      </DialogFooter>
    </Dialog>
  );
}

/** Invite an agent to a workspace: send it the prompt, which connects it. */
export function AgentInviteDialog({
  workspaceHandle,
  baseUrl,
  onClose,
}: {
  workspaceHandle: string;
  /** Doco's public URL, which the prompt points at. */
  baseUrl: string;
  onClose: () => void;
}) {
  const message = agentInstructionsForWorkspace(baseUrl, workspaceHandle);
  return (
    <Dialog
      title={STEP_TITLES.agent}
      description={`Copy this prompt and send it to Claude Code, Codex or Gemini CLI in your project. Your agent adds Doco to itself (sign in to Doco when it asks) and starts using it in ${workspaceHandle}.`}
      onClose={onClose}
    >
      <MessageWell message={message} />
      <DialogFooter>
        <CopyMessageButton message={message} label="Copy prompt" />
      </DialogFooter>
    </Dialog>
  );
}

function MessageWell({ message }: { message: string }) {
  return (
    <pre className="neu-well min-h-0 overflow-y-auto whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-input p-4 font-mono text-xs leading-relaxed">
      {message}
    </pre>
  );
}

function CopyMessageButton({
  message,
  label,
}: {
  message: string;
  label: "Copy invite" | "Copy prompt";
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-autofocus
      onClick={async () => {
        await navigator.clipboard.writeText(message);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={PRIMARY}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}
