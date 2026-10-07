// The dialog an invite opens in (Alexander, 2026-10-06, so the invite isn't
// confused with anything else on the page): what to send, a copy button named
// for who it goes to ("Copy invite" for a person, "Copy prompt" for an agent)
// and a way out. Escape, the close button and a click outside all close it.

import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { buildHumanInvitePrompt } from "~/lib/invite-prompts";

export function InviteDialog({
  title,
  description,
  message,
  copyLabel,
  note,
  onClose,
}: {
  title: string;
  description?: ReactNode;
  message: string;
  copyLabel: "Copy invite" | "Copy prompt";
  note?: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // It opens on what it's for, so Enter copies.
    copyRef.current?.focus();
  }, []);
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
        <pre className="neu-well min-h-0 overflow-y-auto whitespace-pre-wrap rounded-lg [overflow-wrap:anywhere] bg-input p-4 font-mono text-xs leading-relaxed">
          {message}
        </pre>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">{note}</p>
          <button
            type="button"
            ref={copyRef}
            onClick={async () => {
              await navigator.clipboard.writeText(message);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            {copied ? "Copied!" : copyLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

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
  return (
    <InviteDialog
      title="Send this invite to the person"
      message={buildHumanInvitePrompt(inviteUrl)}
      copyLabel="Copy invite"
      note={note}
      onClose={onClose}
    />
  );
}
