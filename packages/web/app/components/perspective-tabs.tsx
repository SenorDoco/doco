// Perspective tabs row that sits above the active perspective body.
//
// The tabs are the ONLY thing in this row — nothing (search box, etc.)
// is allowed inside, because anything that wraps to a second line would
// push the canvas down and break the visual "tabs attached to canvas"
// connection. Page-level chrome (search, action buttons) lives in the
// title row above the perspective area.

import { ChevronDown, Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { cn } from "~/lib/cn";
import type { AttachedPerspective, Perspective } from "~/lib/perspectives.server";

interface PerspectiveTabsProps {
  handle: string;
  perspectives: AttachedPerspective[];
  availablePerspectives: Perspective[];
  activeSlug: string;
  canAdmin: boolean;
}

export function PerspectiveTabs({
  handle,
  perspectives,
  availablePerspectives,
  activeSlug,
  canAdmin,
}: PerspectiveTabsProps) {
  return (
    <nav
      aria-label="Visualization perspectives"
      role="tablist"
      className="-mb-px flex min-w-0 flex-wrap items-end"
    >
      {perspectives.map((p, i) => (
        <PerspectiveTab
          key={p.id}
          handle={handle}
          perspective={p}
          active={p.slug === activeSlug}
          isFirst={i === 0}
          // Last perspective tab only rounds its top-right when the
          // settings chevron-tab ISN'T rendered after it. When canAdmin
          // is true, the settings tab is the visually-last cell and
          // owns the rounded outer corner.
          isLast={i === perspectives.length - 1 && !canAdmin}
        />
      ))}
      {canAdmin ? (
        <PerspectiveSettingsMenu
          handle={handle}
          perspectives={perspectives}
          availablePerspectives={availablePerspectives}
          activeSlug={activeSlug}
        />
      ) : null}
    </nav>
  );
}

interface PerspectiveTabProps {
  handle: string;
  perspective: AttachedPerspective;
  active: boolean;
  isFirst: boolean;
  isLast: boolean;
}

function PerspectiveTab({ handle, perspective, active, isFirst, isLast }: PerspectiveTabProps) {
  const href = `/${handle}?perspective=${encodeURIComponent(perspective.slug)}`;
  // Real tab-strip styling:
  //   * Tabs sit edge-to-edge. `-ml-px first:ml-0` lets each tab's left
  //     border overlap the previous tab's right border so adjacent tabs
  //     share one 1px line instead of stacking two.
  //   * Only the OUTER corners are rounded (first tab top-left, last
  //     tab top-right). Inner corners stay square so adjacent tabs
  //     don't create visible dips where their rounded tops curve away
  //     from each other.
  //   * Active tab has z-10 so its borders win the overlap.
  //   * The row above is pulled down 1px (`-mb-px`) so the active tab's
  //     `border-b-transparent` lands exactly on top of the canvas's top
  //     border, dissolving the seam between the tab and the canvas.
  const tabClass = cn(
    "relative -ml-px first:ml-0 inline-flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium",
    isFirst && "rounded-tl-md",
    isLast && "rounded-tr-md",
    active
      ? // The active tab's bg + bottom border match the perspective
        // canvas (bg-background) so the tab visually flows into the
        // canvas without a visible seam. border-b-background occludes
        // the canvas's top border at the tab's footprint.
        "z-10 border-b-background bg-background text-foreground"
      : // border-b-transparent on inactive tabs so the tab's bottom
        // border (22%-alpha border-border) doesn't STACK on top of
        // the canvas's top border (also 22% alpha) and render as a
        // ~39%-alpha darker line where they overlap.
        "border-b-transparent bg-input/40 text-muted-foreground hover:bg-input/60 hover:text-foreground",
  );
  const title = perspective.ownerHandle
    ? `${perspective.name} — by ${perspective.ownerHandle}`
    : perspective.name;

  return (
    <Link to={href} role="tab" aria-selected={active} className={tabClass} title={title}>
      {perspective.icon ? (
        <span aria-hidden className="text-sm leading-none">
          {perspective.icon}
        </span>
      ) : null}
      <span>{perspective.name}</span>
    </Link>
  );
}

interface PerspectiveSettingsMenuProps {
  handle: string;
  perspectives: AttachedPerspective[];
  availablePerspectives: Perspective[];
  activeSlug: string;
}

function PerspectiveSettingsMenu({
  handle,
  perspectives,
  availablePerspectives,
  activeSlug,
}: PerspectiveSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const isPosting = fetcher.state === "submitting";

  // Close on click outside / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const attachedIds = new Set(perspectives.map((p) => p.id));
  const unattached = availablePerspectives.filter((p) => !attachedIds.has(p.id));
  const canDetachAny = perspectives.length > 1;
  const apiAction = `/${handle}/api/perspectives.json`;

  return (
    // The wrapper has to be `relative` so the dropdown menu can
    // position-absolute against it. But as a flex child of the tab
    // nav, the wrapper picked up the page's inherited 1.55 line-height
    // and computed ~0.8px taller than the button inside, leaving the
    // chevron's bottom 0.8px above the perspective tabs' bottoms.
    // `flex items-end` alone didn't kill that gap — the inherited
    // line-height contributes to the wrapper's CONTENT height, not
    // just leading inside text. Force `leading-none` (line-height:1)
    // on the wrapper so it shrinks to exactly the button's box.
    <div ref={wrapperRef} className="relative inline-flex items-end leading-none align-bottom">
      <button
        type="button"
        aria-label="Perspective settings"
        title="Perspective settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // Styled to match an inactive perspective tab so it reads as
        // part of the tab strip — same padding / border / colours,
        // left-border overlap (`-ml-px`) so the last tab's right edge
        // is shared. `rounded-tr-md` because this is now the visually
        // last cell on the strip. `border-b-transparent` matches the
        // inactive-tab treatment.
        className="relative -ml-px inline-flex items-center gap-1.5 rounded-tr-md border border-border border-b-transparent bg-input/40 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-input/60 hover:text-foreground"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      {open ? (
        <div
          aria-label="Perspectives"
          className="neu-floating absolute left-0 top-full z-40 mt-1 w-80 rounded-md bg-card p-2"
        >
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Attached
          </p>
          {perspectives.map((p) => {
            const isActive = p.slug === activeSlug;
            return (
              <div
                key={p.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-input/40"
              >
                <fetcher.Form method="post" action={apiAction}>
                  <input type="hidden" name="_action" value="set_default" />
                  <input type="hidden" name="perspective_id" value={p.id} />
                  <button
                    type="submit"
                    aria-label={
                      p.isDefault ? "Pinned (default perspective)" : "Pin as default perspective"
                    }
                    title={
                      p.isDefault ? "Pinned (default perspective)" : "Pin as default perspective"
                    }
                    className={cn(
                      "inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-primary",
                      p.isDefault && "text-primary",
                    )}
                    disabled={isPosting || p.isDefault}
                  >
                    <Pin className={cn("h-3.5 w-3.5", p.isDefault && "fill-current")} />
                  </button>
                </fetcher.Form>
                {p.icon ? (
                  <span aria-hidden className="text-sm leading-none">
                    {p.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate" title={p.name}>
                  {p.name}
                </span>
                {!p.isDefault && canDetachAny ? (
                  <fetcher.Form
                    method="post"
                    action={apiAction}
                    onSubmit={(event) => {
                      if (isActive) {
                        event.preventDefault();
                        const formData = new FormData(event.currentTarget);
                        fetcher.submit(formData, { method: "post", action: apiAction });
                        navigate(`/${handle}`, { replace: true });
                      }
                    }}
                  >
                    <input type="hidden" name="_action" value="detach" />
                    <input type="hidden" name="perspective_id" value={p.id} />
                    <button
                      type="submit"
                      className="neu-button rounded px-2 py-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                      disabled={isPosting}
                    >
                      Remove
                    </button>
                  </fetcher.Form>
                ) : (
                  <span className="text-[10px] italic text-muted-foreground/60">
                    {p.isDefault ? "default" : ""}
                  </span>
                )}
              </div>
            );
          })}
          {unattached.length > 0 ? (
            <>
              <p className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Available
              </p>
              {unattached.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-input/40"
                >
                  <span aria-hidden className="inline-block h-5 w-5" />
                  {p.icon ? (
                    <span aria-hidden className="text-sm leading-none">
                      {p.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate" title={p.name}>
                    {p.name}
                  </span>
                  <fetcher.Form method="post" action={apiAction}>
                    <input type="hidden" name="_action" value="attach" />
                    <input type="hidden" name="perspective_id" value={p.id} />
                    <button
                      type="submit"
                      className="neu-button rounded px-2 py-0.5 text-[11px] font-semibold text-primary"
                      disabled={isPosting}
                    >
                      Add
                    </button>
                  </fetcher.Form>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
