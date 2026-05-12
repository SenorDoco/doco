import { NavLink } from "react-router";
import { cn } from "~/lib/cn";
import { DocoMark } from "~/components/doco-mark";

interface SiteHeaderProps {
  /** Used for breadcrumb (the Doco slug). */
  context: string;
}

/**
 * Site header (local-solo shape per ADR-087, sub-bar nav per ADR-088).
 *
 * Two rows:
 *   1. App bar: brand + breadcrumb (and any future workspace-level actions).
 *   2. Sub-bar: per-Doco navigation (Recent / Scopes / Intents / ... / Search / Lint).
 *
 * Sub-bar separation gives the per-Doco nav room to breathe and stays
 * comfortable as Doco surface grows. The brand and breadcrumb stay sticky
 * at the top; the nav becomes its own scannable strip.
 */
export function SiteHeader({ context }: SiteHeaderProps) {
  const nav: { to: string; label: string }[] = [
    { to: "/", label: "Recent" },
    { to: "/e/scope", label: "Scopes" },
    { to: "/e/intent", label: "Intents" },
    { to: "/e/idea", label: "Ideas" },
    { to: "/e/rule", label: "Rules" },
    { to: "/e/decision", label: "Decisions" },
    { to: "/e/action", label: "Actions" },
    { to: "/search", label: "Search" },
    { to: "/lint", label: "Lint" },
    { to: "/coverage", label: "Coverage" },
  ];

  return (
    <header className="border-b border-border bg-card">
      {/* Row 1: brand + breadcrumb. */}
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <h1 className="m-0 leading-none tracking-tight">
          <NavLink
            to="/"
            className="inline-flex items-center hover:opacity-80"
            aria-label="Doco home"
          >
            <DocoMark height={28} />
          </NavLink>
          <span className="ml-3 font-normal text-xs text-muted-foreground align-middle">
            / {context}
          </span>
        </h1>
      </div>

      {/* Row 2: per-Doco nav (ADR-088). */}
      <div className="border-t border-border/60">
        <nav className="mx-auto flex max-w-6xl items-center gap-5 px-6 py-2 text-xs">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                cn(
                  "transition-colors",
                  isActive
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
