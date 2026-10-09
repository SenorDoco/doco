// The dialog an invite opens in (Alexander, 2026-10-06, so the invite isn't
// confused with anything else on the page): what to send, a copy button named
// for who it goes to ("Copy invite" for a person, "Copy prompt" for an agent)
// and a way out (components/dialog.tsx).
//
// An agent's invite is the last step a workspace's setup gives an invitee:
// connect Doco to the agent (as /agents/connect shows), then send it the
// prompt (Alexander, 2026-10-09: the person connects first, and the prompt
// stays short).

import { type ReactNode, useState } from "react";
import { Dialog, DialogFooter } from "~/components/dialog";
import { CONNECT_AGENT_PATH, agentInstructionsForWorkspace } from "~/lib/agent-instructions";
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

/** Invite an agent to a workspace: connect Doco to it, then send it the prompt. */
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
      description={
        <>
          First connect Doco to your agent, as{" "}
          <a href={CONNECT_AGENT_PATH} className="font-semibold">
            Connect Doco to your agent
          </a>{" "}
          shows. Then copy this prompt and send it to your agent in your project: it starts using
          Doco in {workspaceHandle}.
        </>
      }
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
