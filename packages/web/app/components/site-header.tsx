import { NavLink } from "react-router";
import { cn } from "~/lib/cn";

interface SiteHeaderProps {
  /** Used for breadcrumb. In single-evalo mode this is the Evalo slug; in host mode it's the host name. */
  context: string;
  /** When set, renders the per-Evalo nav scoped to this Evalo (host mode). */
  evaloScope?: { ownerSlug: string; evaloSlug: string };
  mode: "host" | "single-evalo";
}

export function SiteHeader({ context, evaloScope, mode }: SiteHeaderProps) {
  const nav = evaloScope
    ? [
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}`, label: "Recent" },
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}/lint`, label: "Lint" },
      ]
    : mode === "host"
      ? [{ to: "/", label: "Evalos" }]
      : [
          { to: "/", label: "Recent" },
          { to: "/e/intent", label: "Intents" },
          { to: "/e/rule", label: "Rules" },
          { to: "/e/decision", label: "Decisions" },
          { to: "/e/action", label: "Actions" },
          { to: "/search", label: "Search" },
          { to: "/lint", label: "Lint" },
        ];

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <h1 className="m-0 leading-none tracking-tight">
          <NavLink to="/" className="inline-flex items-center hover:opacity-80" aria-label="Evalo home">
            <img src="/wordmark.svg" alt="Evalo" className="block h-7 w-auto" />
          </NavLink>
          <span className="ml-3 font-normal text-xs text-muted-foreground align-middle">
            / {context}
            {evaloScope ? (
              <>
                {" / "}
                <NavLink to={`/${evaloScope.ownerSlug}`} className="hover:text-foreground">
                  {evaloScope.ownerSlug}
                </NavLink>
                {" / "}
                <NavLink
                  to={`/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}`}
                  className="hover:text-foreground"
                >
                  {evaloScope.evaloSlug}
                </NavLink>
              </>
            ) : null}
          </span>
        </h1>
        <nav className="flex items-center gap-4 text-xs">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/" || n.to === `/${evaloScope?.ownerSlug}/${evaloScope?.evaloSlug}`}
              className={({ isActive }) =>
                cn(
                  "transition-colors",
                  isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
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
