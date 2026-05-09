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
        <h1 className="text-base font-bold tracking-tight">
          <NavLink to="/" className="text-foreground hover:text-primary">
            Evalo
          </NavLink>
          <span className="ml-2 font-normal text-xs text-muted-foreground">/ {evaloSlug}</span>
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
