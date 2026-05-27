// Perspective tabs row that sits above the active perspective body.
//
// The tabs are the ONLY thing in this row — nothing (search box, etc.)
// is allowed inside, because anything that wraps to a second line would
// push the canvas down and break the visual "tabs attached to canvas"
// connection. Page-level chrome (search, action buttons) lives in the
// title row above the perspective area.

import { Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { cn } from "~/lib/cn";
import { lifecycleColor } from "~/lib/neuron-colors";
import type { AttachedPerspective, Perspective } from "~/lib/perspectives.server";

interface PerspectiveTabsProps {
  handle: string;
  perspectives: AttachedPerspective[];
  availablePerspectives: Perspective[];
  activeSlug: string;
  canAdmin: boolean;
  proposedCount?: number;
}

export function PerspectiveTabs({
  handle,
  perspectives,
  availablePerspectives,
  activeSlug,
  canAdmin,
  proposedCount = 0,
}: PerspectiveTabsProps) {
  const mainPerspectives = perspectives.filter((p) => p.kind !== "approval");
  const approvalPerspectives = perspectives.filter((p) => p.kind === "approval");

  return (
    <div className="relative flex min-w-0 items-end justify-between gap-3">
      <nav
        aria-label="Visualization perspectives"
        role="tablist"
        // `self-start` keeps the nav shrink-to-fit horizontally instead
        // of stretching to fill the aside's width — so `right-0` on the
        // chevron dropdown anchors to the chevron's right edge, not the
        // aside's far-right edge.
        // `relative` so the chevron's dropdown menu can position-absolute
        // against this nav element. The chevron is a direct child of
        // the nav, dropping the wrapper that previously caused
        // sub-pixel vertical misalignment with the Link tabs.
        className="relative flex min-w-0 flex-wrap items-end self-start"
      >
        {mainPerspectives.map((p, i) => (
          <PerspectiveTab
            key={p.id}
            handle={handle}
            perspective={p}
            proposedCount={proposedCount}
            active={p.slug === activeSlug}
            isFirst={i === 0}
            // Last perspective tab only rounds its top-right when the
            // settings chevron-tab ISN'T rendered after it. When canAdmin
            // is true, the settings tab is the visually-last cell and
            // owns the rounded outer corner.
            isLast={i === mainPerspectives.length - 1 && !canAdmin}
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
      {approvalPerspectives.length > 0 ? (
        <nav
          aria-label="Proposed perspective"
          role="tablist"
          className="ml-auto flex shrink-0 items-end self-start"
        >
          {approvalPerspectives.map((p) => (
            <PerspectiveTab
              key={p.id}
              handle={handle}
              perspective={p}
              proposedCount={proposedCount}
              active={p.slug === activeSlug}
              isFirst
              isLast
              variant="proposed"
            />
          ))}
        </nav>
      ) : null}
    </div>
  );
}

interface PerspectiveTabProps {
  handle: string;
  perspective: AttachedPerspective;
  proposedCount: number;
  active: boolean;
  isFirst: boolean;
  isLast: boolean;
  variant?: "strip" | "proposed";
}

function PerspectiveTab({
  handle,
  perspective,
  proposedCount,
  active,
  isFirst,
  isLast,
  variant = "strip",
}: PerspectiveTabProps) {
  const href = `/${handle}?perspective=${encodeURIComponent(perspective.slug)}`;
  const isProposedTab = variant === "proposed";
  const proposedBlue = lifecycleColor("proposed");
  // Real tab-strip styling:
  //   * Tabs sit edge-to-edge. `-ml-px first:ml-0` lets each tab's left
  //     border overlap the previous tab's right border so adjacent tabs
  //     share one 1px line instead of stacking two.
  //   * Only the OUTER corners are rounded (first tab top-left, last
  //     tab top-right). Inner corners stay square so adjacent tabs
  //     don't create visible dips where their rounded tops curve away
  //     from each other.
  //   * Every tab gets the same open-bottom etched surface. The tabs
  //     sit 2px lower; inactive tabs remain under the raised frame
  //     border, while the active tab rises above it to own the join.
  const tabClass = cn(
    "neu-surface-open-bottom relative top-[2px] inline-flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium",
    active ? "z-[60]" : "z-40",
    isProposedTab
      ? active
        ? "rounded-t-md border-border bg-card text-foreground"
        : "rounded-t-md border-border bg-input/60 hover:bg-input/80"
      : "-ml-px first:ml-0 border-border text-foreground",
    !isProposedTab && isFirst && "rounded-tl-md",
    !isProposedTab && isLast && "rounded-tr-md",
    !isProposedTab && (active ? "bg-card" : "bg-input/60 hover:bg-input/80"),
  );
  const tabStyle =
    isProposedTab && !active
      ? {
          color: proposedBlue,
        }
      : undefined;
  const name = isProposedTab ? "Proposed" : perspective.name;
  const title = perspective.ownerHandle ? `${name} — by ${perspective.ownerHandle}` : name;
  const label = perspective.kind === "approval" ? `${name} (${proposedCount})` : name;

  return (
    <Link
      to={href}
      role="tab"
      aria-selected={active}
      className={tabClass}
      style={tabStyle}
      title={title}
    >
      {!isProposedTab && perspective.icon ? (
        <span aria-hidden className="text-sm leading-none">
          {perspective.icon}
        </span>
      ) : null}
      <span>{label}</span>
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
        // `self-stretch` makes this tab take the full row height
        // (set by the tallest perspective tab) regardless of how the
        // browser computes our intrinsic content height. This is the
        // ONLY alignment knob that doesn't depend on line-box math —
        // it ties the chevron tab's height directly to the
        // perspective tabs' height, so Safari can't render us shorter
        // than them. Without this, `items-end` on the nav was
        // bottom-aligning a naturally-shorter chevron tab.
        className="neu-surface-open-bottom relative top-[2px] z-40 -ml-px inline-flex cursor-pointer items-center justify-center self-stretch gap-1.5 rounded-tr-md border border-border bg-input/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-input/60"
      >
        <span aria-hidden className="text-sm leading-none">
          ⌵
        </span>
      </a>
      {open ? (
        <div
          ref={menuRef}
          aria-label="Perspectives"
          // Absolute positions against the nav (its `relative`
          // ancestor). right-0 top-full anchors bottom-right of the
          // nav, directly under the chevron tab. w-60 keeps the menu
          // narrow enough to fit inside the aside even when the
          // chevron sits at the right edge of a narrow nav.
          className="neu-floating absolute right-0 top-full z-[70] mt-1 w-60 rounded-md bg-card p-2"
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
    </>
  );
}
