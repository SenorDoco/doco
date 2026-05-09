import { Form, NavLink } from "react-router";
import { cn } from "~/lib/cn";
import { EvaloMark } from "~/components/evalo-mark";
import type { CurrentPrincipal } from "~/lib/session";

interface SiteHeaderProps {
  /** Used for breadcrumb. In single-evalo mode this is the Evalo slug; in host mode it's the host name. */
  context: string;
  /** When set, renders the per-Evalo nav scoped to this Evalo (host mode). */
  evaloScope?: { ownerSlug: string; evaloSlug: string };
  mode: "host" | "single-evalo";
  /** Currently signed-in Principal (host mode only). */
  me?: CurrentPrincipal | null;
}

export function SiteHeader({ context, evaloScope, mode, me }: SiteHeaderProps) {
  const nav = evaloScope
    ? [
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}`, label: "Recent" },
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}/e/intent`, label: "Intents" },
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}/e/rule`, label: "Rules" },
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}/e/decision`, label: "Decisions" },
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}/e/action`, label: "Actions" },
        { to: `/${evaloScope.ownerSlug}/${evaloScope.evaloSlug}/search`, label: "Search" },
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
            <EvaloMark height={28} />
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
        <div className="ml-auto flex items-center gap-3 text-xs">
          {mode === "host" ? (
            me ? (
              <>
                <NavLink
                  to="/new-evalo"
                  className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input"
                >
                  + Evalo
                </NavLink>
                <NavLink
                  to="/new-org"
                  className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input"
                >
                  + Org
                </NavLink>
                <NavLink
                  to={`/${me.username}`}
                  className="rounded-full border border-border bg-input px-3 py-1 font-semibold text-foreground hover:border-primary"
                >
                  {me.username}
                </NavLink>
                <Form method="post" action="/sign-out">
                  <button
                    type="submit"
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Sign out
                  </button>
                </Form>
              </>
            ) : (
              <NavLink
                to="/sign-in"
                className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground hover:opacity-90"
              >
                Sign in
              </NavLink>
            )
          ) : null}
        </div>
      </div>
    </header>
  );
}
