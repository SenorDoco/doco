import { NavLink } from "react-router";
import { cn } from "~/lib/cn";

interface SiteHeaderProps {
  evaloSlug: string;
}

const NAV = [
  { to: "/", label: "Recent" },
  { to: "/e/intent", label: "Intents" },
  { to: "/e/rule", label: "Rules" },
  { to: "/e/decision", label: "Decisions" },
  { to: "/e/action", label: "Actions" },
  { to: "/search", label: "Search" },
  { to: "/lint", label: "Lint" },
];

export function SiteHeader({ evaloSlug }: SiteHeaderProps) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <h1 className="m-0 leading-none tracking-tight">
          <NavLink to="/" className="inline-flex items-center hover:opacity-80" aria-label="Evalo home">
            <img src="/wordmark.svg" alt="Evalo" className="block h-7 w-auto" />
          </NavLink>
          <span className="ml-3 font-normal text-xs text-muted-foreground align-middle">/ {evaloSlug}</span>
        </h1>
        <nav className="flex items-center gap-4 text-xs">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
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
