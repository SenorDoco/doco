// The dialog an invite opens in (Alexander, 2026-10-06, so the invite isn't
// confused with anything else on the page): what to send, a copy button named
// for who it goes to ("Copy invite" for a person, "Copy prompt" for an agent)
// and a way out (components/dialog.tsx).
//
// An agent's invite takes the two steps a workspace's setup gives an invitee
// (Alexander, 2026-10-07): connect Doco to the agent, with the same per-agent
// guide, then send it the prompt.

import { type ReactNode, useState } from "react";
import { ConnectAgentGuide } from "~/components/connect-agent-guide";
import { Dialog, DialogFooter } from "~/components/dialog";
import { agentConnectGuides } from "~/lib/agent-connect-guides";
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

/** Invite an agent to a workspace: connect Doco to it, then send it the prompt. */
export function AgentInviteDialog({
  workspaceHandle,
  baseUrl,
  onClose,
}: {
  workspaceHandle: string;
  /** Doco's public URL, which the guide and the prompt point at. */
  baseUrl: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  if (step === 1) {
    return (
      <Dialog
        title={`Step 1 of 2: ${STEP_TITLES.mcp}`}
        description={`Add Doco to the agent you use, so it can read and write in ${workspaceHandle}. When Doco asks what the agent may reach, include ${workspaceHandle}.`}
        focusKey={step}
        onClose={onClose}
      >
        <div className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
          <ConnectAgentGuide guides={agentConnectGuides(baseUrl)} />
        </div>
        <DialogFooter note="Already connected? Go on to step 2.">
          <button type="button" data-autofocus onClick={() => setStep(2)} className={PRIMARY}>
            Next
          </button>
        </DialogFooter>
      </Dialog>
    );
  }
  const message = agentInstructionsForWorkspace(baseUrl, workspaceHandle);
  return (
    <Dialog
      title={`Step 2 of 2: ${STEP_TITLES.agent}`}
      description={`Copy this prompt and send it to your agent. It has your agent start using Doco in ${workspaceHandle}.`}
      focusKey={step}
      onClose={onClose}
    >
      <MessageWell message={message} />
      <DialogFooter>
        <button
          type="button"
          onClick={() => setStep(1)}
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold hover:opacity-90"
        >
          Back
        </button>
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
