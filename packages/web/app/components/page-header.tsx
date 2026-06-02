import type { ReactNode } from "react";
import { Breadcrumb, type BreadcrumbItem } from "~/components/breadcrumb";
import { cn } from "~/lib/cn";

/**
 * Shared header for doco- and workspace-scoped pages.
 *
 * Owns the top-of-page rhythm so every page lines up: the fishbone
 * breadcrumb trail, then the page title, then any description. Two things
 * are deliberately uniform across every page that uses it:
 *
 * - the title renders at one shared, large size (`text-2xl`), and
 * - action buttons (Policies, Settings, …) sit on the title's row, to its
 *   right — vertically centered with the title rather than floating up to
 *   the breadcrumb.
 */
export function PageHeader({
  breadcrumb,
  title,
  actions,
  children,
  className,
}: {
  /** Fishbone breadcrumb trail rendered above the title. */
  breadcrumb?: BreadcrumbItem[];
  /** Page title. Pass a plain string, or a node (e.g. a linked handle). */
  title: ReactNode;
  /** Buttons rendered to the right of the title, on the same row. */
  actions?: ReactNode;
  /** Description / subtitle content rendered beneath the title row. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      {breadcrumb && breadcrumb.length > 0 ? <Breadcrumb items={breadcrumb} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
