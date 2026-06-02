import { Fragment } from "react";
import { Link, useLocation } from "react-router";
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
  // The current page's path, used to keep the trailing (current) crumb
  // clickable on every page — even leaf labels like "Access tokens" that
  // carry no explicit `to`. It self-links to the page you are already on.
  const { pathname } = useLocation();
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={cn("text-xs text-muted-foreground", className)}>
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          // Every crumb with a destination is a link; the current crumb always
          // gets one — its own `to`, or the current path as a self-link — so
          // the trailing item is clickable everywhere. Earlier crumbs without a
          // `to` have no natural target and stay plain text.
          const href = item.to ?? (isLast ? pathname : undefined);
          return (
            <Fragment key={`${item.label}-${index}`}>
              <li>
                {href ? (
                  <Link
                    to={href}
                    aria-current={isLast ? "page" : undefined}
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
 * Trail: `Home › [owner?] › [docoHandle] › [parent?] › [pageLabel?]`.
 *
 * Every non-current segment is a link. The owner segment points to the
 * owning workspace home when the loader provides it.
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
  ownerSlug?: string;
  handle: string;
  parent?: BreadcrumbItem;
  pageLabel?: string;
}): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [{ label: "Home", to: "/" }];
  if (ownerSlug) items.push({ label: ownerSlug, to: `/workspaces/${ownerSlug}` });
  items.push({ label: handle, to: `/${handle}` });
  if (parent) items.push(parent);
  if (pageLabel) items.push({ label: pageLabel });
  return items;
}

/**
 * Build the breadcrumb trail for an workspace-scoped page.
 * Trail: `Workspaces › [workspaceSlug] › [parent?] › [pageLabel?]`.
 *
 * Every non-current segment is a link. `workspaceSlug` points to the workspace
 * home page (`/workspaces/<slug>`).
 */
export function workspaceBreadcrumb({
  workspaceSlug,
  parent,
  pageLabel,
}: {
  workspaceSlug: string;
  parent?: BreadcrumbItem;
  pageLabel?: string;
}): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [
    { label: "Workspaces", to: "/workspaces" },
    { label: workspaceSlug, to: `/workspaces/${workspaceSlug}` },
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
