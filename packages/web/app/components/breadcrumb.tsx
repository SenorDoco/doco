import { Fragment } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/cn";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export function Breadcrumb({
  items,
  className,
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={cn("text-xs text-muted-foreground", className)}>
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <Fragment key={`${item.label}-${index}`}>
              <li>
                {item.to && !isLast ? (
                  <Link
                    to={item.to}
                    className="hover:text-foreground hover:underline transition-colors"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span aria-current={isLast ? "page" : undefined}>{item.label}</span>
                )}
              </li>
              {!isLast ? (
                <li aria-hidden="true" className="text-muted-foreground/60">
                  ›
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Build the breadcrumb trail for a doco-scoped page.
 * Trail: `[ownerSlug] › [docoShortName] › [parent?] › [pageLabel?]`.
 * The doco short name strips a leading `<ownerSlug>-` prefix from the
 * handle so the org name doesn't repeat (e.g. handle `torrenegra-doco`
 * with owner `torrenegra` displays as `doco`).
 *
 * Every non-current segment is a link. `ownerSlug` points to the
 * owner's org home page (`/orgs/<slug>`) — every Principal has a
 * personal Organization with `handle = username`, so the route exists
 * for both user-owned and org-owned docos. The doco short name points
 * to the doco home (`/<handle>`).
 *
 * Pass `parent` for subpages like `.../policies/guidance/new`:
 * `parent: { label: "Policies", to: "/<handle>/policies" }`.
 */
export function docoBreadcrumb({
  ownerSlug,
  handle,
  parent,
  pageLabel,
}: {
  ownerSlug: string;
  handle: string;
  parent?: BreadcrumbItem;
  pageLabel?: string;
}): BreadcrumbItem[] {
  const prefix = `${ownerSlug}-`;
  const shortDoco = handle.startsWith(prefix) ? handle.slice(prefix.length) : handle;
  const items: BreadcrumbItem[] = [
    { label: ownerSlug, to: `/orgs/${ownerSlug}` },
    { label: shortDoco, to: `/${handle}` },
  ];
  if (parent) items.push(parent);
  if (pageLabel) items.push({ label: pageLabel });
  return items;
}

/**
 * Build the breadcrumb trail for an org-scoped page.
 * Trail: `Orgs › [orgSlug] › [parent?] › [pageLabel?]`.
 *
 * Every non-current segment is a link. `orgSlug` points to the org
 * home page (`/orgs/<slug>`).
 */
export function orgBreadcrumb({
  orgSlug,
  parent,
  pageLabel,
}: {
  orgSlug: string;
  parent?: BreadcrumbItem;
  pageLabel?: string;
}): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [
    { label: "Orgs", to: "/orgs" },
    { label: orgSlug, to: `/orgs/${orgSlug}` },
  ];
  if (parent) items.push(parent);
  if (pageLabel) items.push({ label: pageLabel });
  return items;
}

/**
 * Build the breadcrumb trail for a top-level (host-scoped) page.
 * Trail: `Home › [section?] › [pageLabel]`.
 *
 * `Home` links to `/` (the host landing / signed-in dashboard).
 * Use `section` for sub-pages of a top-level section (e.g. `New doco`
 * lives under `Docos`).
 */
export function hostBreadcrumb({
  section,
  pageLabel,
}: {
  section?: BreadcrumbItem;
  pageLabel: string;
}): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [{ label: "Home", to: "/" }];
  if (section) items.push(section);
  items.push({ label: pageLabel });
  return items;
}
