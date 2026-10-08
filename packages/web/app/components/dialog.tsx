// Doco's one modal: a title, an optional line under it, a close button, and
// what it is for. Escape, the close button and a click outside all close it.
// Invites open in it, and so does the end of a workspace's setup.

import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";

/** The modal itself. It focuses its `data-autofocus` control on opening. A
 *  control inside it closes it with `closeDialog`. */
export function Dialog({
  title,
  description,
  onClose,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // It opens on what it's for, so Enter does it.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
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
        {children}
      </div>
    </dialog>
  );
}

/** Close the dialog a control sits in, as its close button does. */
export function closeDialog(e: { currentTarget: Element }) {
  e.currentTarget.closest("dialog")?.close();
}

/** A note on the left, the dialog's buttons on the right. */
export function DialogFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[11px] text-muted-foreground">{note}</p>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}
