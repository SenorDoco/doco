// Perspective tabs row that sits above the active perspective body: a row
// of keys, the active one pressed.
//
// The tabs are the ONLY thing in this row — nothing (search box, etc.)
// is allowed inside, because anything that wraps to a second line would
// push the canvas down. Page-level chrome (search, action buttons) lives
// in the title row above the perspective area.

import { Pin } from "lucide-react";
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
    <div className="relative mb-3 flex min-w-0 items-end justify-between gap-3">
      <nav
        aria-label="Visualization perspectives"
        role="tablist"
        // `self-start` keeps the nav shrink-to-fit horizontally instead
        // of stretching to fill the aside's width. `relative` so the
        // chevron's dropdown menu can position-absolute against this nav
        // element; the chevron is a direct child of the nav.
        className="relative flex min-w-0 flex-wrap items-center gap-2 self-start"
      >
        {perspectives.map((p) => (
          <PerspectiveTab
            key={p.id}
            handle={handle}
            perspective={p}
            active={p.slug === activeSlug}
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
    </div>
  );
}

interface PerspectiveTabProps {
  handle: string;
  perspective: AttachedPerspective;
  active: boolean;
}

function PerspectiveTab({ handle, perspective, active }: PerspectiveTabProps) {
  const href = `/${handle}?perspective=${encodeURIComponent(perspective.slug)}`;
  const tabClass = cn(
    "neu-button inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium",
    active && "neu-pressed",
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
  // Two refs (button + menu) instead of a wrapper ref. Any DOM
  // wrapper around the button breaks pixel-perfect flex alignment
  // with the Link tabs in Safari (display:contents in particular).
  // Skipping the wrapper means the click-outside detector tests both
  // button and menu separately.
  const btnRef = useRef<HTMLAnchorElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const isPosting = fetcher.state === "submitting";

  // Close on click outside / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
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
    // No wrapper element. The chevron is an `<a>` (the same element
    // type as the perspective tabs, which render as `<Link>` =
    // anchor) — so browsers (Safari especially) use the same
    // intrinsic sizing for it as for the perspective tabs. With a
    // `<button>` we kept hitting Safari-specific min-height quirks
    // that left the chevron a fraction of a pixel above the others
    // no matter what padding/height we set.
    <>
      {/* biome-ignore lint/a11y/useAnchorContent: The chevron tab is named by aria-label; the glyph is decorative. */}
      {/* biome-ignore lint/a11y/useValidAnchor: This intentionally uses an anchor to match Link tab sizing in Safari. */}
      <a
        ref={btnRef}
        href="#perspective-settings"
        aria-label="Perspective settings"
        title="Perspective settings"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        // `self-stretch` ties this tab's height to the perspective tabs'
        // height, the one alignment knob that doesn't depend on line-box
        // math, so Safari can't render it shorter than them.
        className="neu-button inline-flex cursor-pointer items-center justify-center self-stretch gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
      >
        <span aria-hidden className="text-sm leading-none">
          ⌵
        </span>
      </a>
      {open ? (
        <div
          ref={menuRef}
          aria-label="Perspectives"
          // Absolute against the nav (its `relative` ancestor). Anchored
          // left-0 top-full so a w-60 menu opens rightward into the wide
          // canvas. right-0 made the menu overhang the narrow nav's left
          // edge, past the page's overflow-y-auto <main> (whose overflow-x
          // then computes to auto) — which clipped the menu's left ~31px.
          className="neu-floating absolute left-0 top-full z-[70] mt-1 w-60 rounded-md bg-card p-2"
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
                    className="inline-flex h-5 w-5 items-center justify-center rounded"
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
                      className="neu-button rounded px-2 py-0.5 text-[11px] font-semibold"
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
                      className="neu-button rounded px-2 py-0.5 text-[11px] font-semibold"
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
    </>
  );
}
