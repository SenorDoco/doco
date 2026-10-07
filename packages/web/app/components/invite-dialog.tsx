// The dialog an invite opens in (Alexander, 2026-10-06, so the invite isn't
// confused with anything else on the page): what to send, a copy button named
// for who it goes to ("Copy invite" for a person, "Copy prompt" for an agent)
// and a way out. Escape, the close button and a click outside all close it.
//
// An agent's invite takes the two steps a workspace's setup gives an invitee
// (Alexander, 2026-10-07): connect Doco to the agent, with the same per-agent
// guide, then send it the prompt.

import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ConnectAgentGuide } from "~/components/connect-agent-guide";
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
    <InviteDialog title="Send this invite to the person" onClose={onClose}>
      <MessageWell message={message} />
      <Footer note={note}>
        <CopyMessageButton message={message} label="Copy invite" />
      </Footer>
    </InviteDialog>
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
      <InviteDialog
        title={`Step 1 of 2: ${STEP_TITLES.mcp}`}
        description={`Add Doco to the agent you use, so it can read and write in ${workspaceHandle}. When Doco asks what the agent may reach, include ${workspaceHandle}.`}
        focusKey={step}
        onClose={onClose}
      >
        <div className="-mx-1 min-h-0 overflow-y-auto px-1 py-1">
          <ConnectAgentGuide guides={agentConnectGuides(baseUrl)} />
        </div>
        <Footer note="Already connected? Go on to step 2.">
          <button type="button" data-autofocus onClick={() => setStep(2)} className={PRIMARY}>
            Next
          </button>
        </Footer>
      </InviteDialog>
    );
  }
  const message = agentInstructionsForWorkspace(baseUrl, workspaceHandle);
  return (
    <InviteDialog
      title={`Step 2 of 2: ${STEP_TITLES.agent}`}
      description={`Copy this prompt and send it to your agent. It has your agent start using Doco in ${workspaceHandle}.`}
      focusKey={step}
      onClose={onClose}
    >
      <MessageWell message={message} />
      <Footer>
        <button
          type="button"
          onClick={() => setStep(1)}
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold hover:opacity-90"
        >
          Back
        </button>
        <CopyMessageButton message={message} label="Copy prompt" />
      </Footer>
    </InviteDialog>
  );
}

/** The modal itself. It focuses its `data-autofocus` control on opening and
 *  whenever `focusKey` changes (an agent invite's next step). */
function InviteDialog({
  title,
  description,
  focusKey,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  focusKey?: unknown;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey says when the control to focus changed.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // It opens on what it's for, so Enter does it.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [focusKey]);
  const close = () => ref.current?.close();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes it; Escape already does natively.
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="neu-floating m-auto w-[calc(100%-2rem)] max-w-xl rounded-lg bg-card text-card-foreground backdrop:bg-foreground/20"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 p-5">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="neu-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function MessageWell({ message }: { message: string }) {
  return (
    <pre className="neu-well min-h-0 overflow-y-auto whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-input p-4 font-mono text-xs leading-relaxed">
      {message}
    </pre>
  );
}

function Footer({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[11px] text-muted-foreground">{note}</p>
      <div className="flex gap-2">{children}</div>
    </div>
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
