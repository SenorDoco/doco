// Perspective tabs row that sits above the active perspective body.
//
// Layout: tabs on the left, the search box on the right. The trailing
// "+" tab links to the picker page where additional perspectives can
// be attached.
//
// A tab is `<Link>` (navigation), but its trailing star and detach
// affordances post forms to /api/perspectives.json — the star toggles
// default, the detach button removes the tab. Both are gated by
// `canAdmin` (owner or approver) and hidden otherwise.

import type { ReactNode } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { cn } from "~/lib/cn";
import type { AttachedPerspective } from "~/lib/perspectives.server";

interface PerspectiveTabsProps {
  handle: string;
  perspectives: AttachedPerspective[];
  activeSlug: string;
  canAdmin: boolean;
  search?: ReactNode;
}

export function PerspectiveTabs({
  handle,
  perspectives,
  activeSlug,
  canAdmin,
  search,
}: PerspectiveTabsProps) {
  return (
    <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
      <nav
        aria-label="Visualization perspectives"
        className="flex min-w-0 flex-wrap items-center gap-1"
      >
        {perspectives.map((p) => (
          <PerspectiveTab
            key={p.id}
            handle={handle}
            perspective={p}
            active={p.slug === activeSlug}
            canAdmin={canAdmin}
            totalAttached={perspectives.length}
          />
        ))}
        <Link
          to={`/${handle}/perspectives`}
          aria-label="Add perspective"
          title="Add perspective"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:bg-input hover:text-foreground"
        >
          <span aria-hidden className="text-base leading-none">
            +
          </span>
        </Link>
      </nav>
      {search ? <div className="w-full sm:w-72 sm:flex-none">{search}</div> : null}
    </div>
  );
}

interface PerspectiveTabProps {
  handle: string;
  perspective: AttachedPerspective;
  active: boolean;
  canAdmin: boolean;
  totalAttached: number;
}

function PerspectiveTab({
  handle,
  perspective,
  active,
  canAdmin,
  totalAttached,
}: PerspectiveTabProps) {
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const href = `/${handle}?perspective=${encodeURIComponent(perspective.slug)}`;
  // Setting default and detaching post to the resource route; on success
  // we revalidate the page (React Router does this automatically for
  // fetcher.Form). Detach also navigates away if the user removed the
  // active tab.
  const isPosting = fetcher.state === "submitting";
  const tabClass = cn(
    "group inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
    active
      ? "border-foreground/40 bg-input text-foreground"
      : "border-border text-muted-foreground hover:bg-input hover:text-foreground",
    isPosting && "opacity-50",
  );
  const title = perspective.ownerHandle
    ? `${perspective.name} — by ${perspective.ownerHandle}`
    : perspective.name;

  return (
    <div className={tabClass} title={title}>
      <Link to={href} className="inline-flex items-center gap-1.5">
        {perspective.icon ? (
          <span aria-hidden className="text-sm leading-none">
            {perspective.icon}
          </span>
        ) : null}
        <span>{perspective.name}</span>
      </Link>
      {canAdmin ? (
        <>
          <fetcher.Form method="post" action={`/${handle}/api/perspectives.json`}>
            <input type="hidden" name="_action" value="set_default" />
            <input type="hidden" name="perspective_id" value={perspective.id} />
            <button
              type="submit"
              aria-label={
                perspective.isDefault ? "Default perspective" : "Set as default perspective"
              }
              title={
                perspective.isDefault ? "Default perspective" : "Set as default perspective"
              }
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center text-[14px] leading-none",
                perspective.isDefault
                  ? "text-amber-500"
                  : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-amber-500",
              )}
              disabled={isPosting || perspective.isDefault}
            >
              {perspective.isDefault ? "★" : "☆"}
            </button>
          </fetcher.Form>
          {!perspective.isDefault && totalAttached > 1 ? (
            <fetcher.Form
              method="post"
              action={`/${handle}/api/perspectives.json`}
              onSubmit={(event) => {
                if (active) {
                  // Pre-navigate to the doco root so the user doesn't
                  // stay on a now-missing perspective slug after detach.
                  event.preventDefault();
                  const formData = new FormData(event.currentTarget);
                  fetcher.submit(formData, {
                    method: "post",
                    action: `/${handle}/api/perspectives.json`,
                  });
                  navigate(`/${handle}`, { replace: true });
                }
              }}
            >
              <input type="hidden" name="_action" value="detach" />
              <input type="hidden" name="perspective_id" value={perspective.id} />
              <button
                type="submit"
                aria-label="Detach perspective"
                title="Detach perspective"
                className="inline-flex h-4 w-4 items-center justify-center text-xs leading-none text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-foreground"
                disabled={isPosting}
              >
                ×
              </button>
            </fetcher.Form>
          ) : null}
        </>
      ) : perspective.isDefault ? (
        // Show the star (non-interactive) to non-admins so they can see
        // which perspective is the default.
        <span aria-label="Default perspective" className="text-[14px] leading-none text-amber-500">
          ★
        </span>
      ) : null}
    </div>
  );
}
